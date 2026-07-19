// ISSUE-31 — cloud-contract test fixture (D-TESTS / R-CLOUDTEST).
//
// Drives the REAL Worker/D1 adapter (worker/index.js) over `wrangler dev` in LOCAL
// mode (a file-backed miniflare D1, NO Cloudflare credentials, F4: --local, never
// --remote). This is the deliberate, minimal-blast-radius counterpart to the
// ISSUE-19 Bun fixture: rather than fork that hardened bun:sqlite fixture, the
// cloud runtime gets its own small fixture targeting `wrangler dev`.
//
// Lifecycle per fixture:
//   1. mkdtemp a throwaway working dir under os.tmpdir() (isolated D1 state + a
//      minimal dist/ so the Static Assets binding can boot).
//   2. Render a temp wrangler config pointing `main` at the repo's worker/index.js,
//      the committed migrations/ dir, and the temp local D1 (--persist-to state).
//   3. `wrangler d1 migrations apply DB --local` — apply the committed migration so
//      the todos table exists before the Worker serves a request.
//   4. Spawn `wrangler dev --local` on an ephemeral port; ready when GET /api/todos
//      answers 200 (the actual serving signal), bounded by a deadline.
//   5. stop(): SIGTERM→SIGKILL the child tree, rm the temp dir.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root = two levels up from tests/cloud/helpers/.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKER_MAIN = join(REPO_ROOT, 'worker', 'index.js');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');
const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');

const READY_DEADLINE_MS = 120_000; // cold workerd boot can be slow in CI
const POLL_INTERVAL_MS = 250;
const KILL_FALLBACK_MS = 4000;

// Ask the OS for a likely-free ephemeral port (a collision-avoidance HINT, not a
// guarantee — same tolerance the ISSUE-19 fixture documents).
function pickCandidatePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createWorkerFixture() {
  const fixture = {
    start,
    stop,
    baseUrl: '',
    port: 0,
    workDir: '',
    getTodos,
    putTodos,
    rawPut,
  };

  let child = null;
  let logBuffer = '';
  let exitNet = null;
  let stopped = false;

  async function start() {
    fixture.workDir = await mkdtemp(join(tmpdir(), 'todos-cloud-'));
    const stateDir = join(fixture.workDir, 'state');
    const distDir = join(fixture.workDir, 'dist');
    const configPath = join(fixture.workDir, 'wrangler.test.json');

    // Minimal dist/ so the ASSETS binding boots; non-/api GETs return this shell.
    await mkdir(distDir, { recursive: true });
    await writeFile(
      join(distDir, 'index.html'),
      '<!doctype html><title>todo cloud test</title>'
    );

    // Temp wrangler config — same shape as wrangler.jsonc but with absolute paths
    // and a local-only D1 (the database_id is a placeholder; local D1 is keyed by
    // binding/state, so the id is irrelevant off --remote).
    const config = {
      name: 'todo-app-cloudtest',
      main: WORKER_MAIN,
      compatibility_date: '2024-11-06',
      assets: {
        directory: distDir,
        binding: 'ASSETS',
        not_found_handling: 'single-page-application',
        run_worker_first: ['/api/*'],
      },
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'todo-cloudtest',
          database_id: '11111111-1111-1111-1111-111111111111',
          migrations_dir: MIGRATIONS_DIR,
        },
      ],
    };
    await writeFile(configPath, JSON.stringify(config, null, 2));

    // Crash-safety net: kill the child and SYNC-remove the temp dir even if
    // afterAll never runs (an exit handler cannot await a promise).
    exitNet = () => {
      try {
        if (child && child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
      } catch {
        // best-effort
      }
      try {
        if (fixture.workDir) rmSync(fixture.workDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };
    process.once('exit', exitNet);

    // Apply the committed migration to the LOCAL D1 (F4: --local, never --remote).
    const applied = spawnSync(
      WRANGLER_BIN,
      [
        'd1',
        'migrations',
        'apply',
        'DB',
        '--local',
        '-c',
        configPath,
        '--persist-to',
        stateDir,
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
        encoding: 'utf8',
      }
    );
    if (applied.status !== 0) {
      await stop();
      throw new Error(
        `wrangler d1 migrations apply (local) failed:\n${applied.stdout}\n${applied.stderr}`
      );
    }

    const port = await pickCandidatePort();
    fixture.port = port;
    fixture.baseUrl = `http://127.0.0.1:${port}`;

    child = spawn(
      WRANGLER_BIN,
      [
        'dev',
        '-c',
        configPath,
        '--local',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--persist-to',
        stateDir,
      ],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (logBuffer += c));
    child.stderr.on('data', (c) => (logBuffer += c));

    let childExited = false;
    child.on('exit', () => (childExited = true));

    // Ready when the Worker actually serves GET /api/todos (200). Bounded.
    const deadline = Date.now() + READY_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (childExited) {
        await stop();
        throw new Error(
          `wrangler dev exited before becoming ready. Captured log:\n${logBuffer}`
        );
      }
      try {
        const res = await fetch(`${fixture.baseUrl}/api/todos`);
        if (res.status === 200) {
          await res.text();
          return;
        }
        await res.text();
      } catch {
        // not up yet
      }
      await sleep(POLL_INTERVAL_MS);
    }
    await stop();
    throw new Error(
      `wrangler dev never served /api/todos within ${READY_DEADLINE_MS}ms. Captured log:\n${logBuffer}`
    );
  }

  async function stop() {
    if (stopped) return;
    stopped = true;

    if (child && child.exitCode === null && !child.killed) {
      await new Promise((resolve) => {
        let killTimer = null;
        const onExit = () => {
          if (killTimer) clearTimeout(killTimer);
          resolve();
        };
        child.once('exit', onExit);
        try {
          child.kill('SIGTERM');
        } catch {
          onExit();
          return;
        }
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
        }, KILL_FALLBACK_MS);
      });
    }
    child = null;

    if (fixture.workDir) {
      await rm(fixture.workDir, { recursive: true, force: true });
    }
    if (exitNet) {
      process.removeListener('exit', exitNet);
      exitNet = null;
    }
  }

  // --- request helpers ---------------------------------------------------------

  async function getTodos() {
    const res = await fetch(`${fixture.baseUrl}/api/todos`);
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  async function putTodos(list, { headers } = {}) {
    const res = await fetch(`${fixture.baseUrl}/api/todos`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(list),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  async function rawPut(bodyString, headers = {}) {
    const res = await fetch(`${fixture.baseUrl}/api/todos`, {
      method: 'PUT',
      headers,
      body: bodyString,
    });
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  return fixture;
}
