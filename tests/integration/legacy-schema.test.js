// @vitest-environment node
//
// ISSUE-40 R2 (Bun half) — a Bun DB created under the PRE-due-date 4-column
// schema (id, text, completed, position; no due_date) must gain `due_date` on
// the server's next boot via the idempotent `ALTER TABLE ... ADD COLUMN`
// (server/index.js), not via `CREATE TABLE IF NOT EXISTS` (which is a no-op on an
// existing file and would otherwise leave the column permanently missing).
//
// The legacy DB file is built with a throwaway `bun -e` subprocess (bun:sqlite is
// only resolvable inside a real Bun process, not this Vitest/Vite-transformed
// test file — see tests/integration/helpers/server.js's spawn-based approach for
// the same constraint) BEFORE the real server/index.js is spawned against that
// same file. A real HTTP PUT/GET round-trip through the spawned server then
// proves the column exists and marshals `dueDate` correctly for both the
// pre-existing legacy row and a freshly-set date.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const READY_MARKER_PREFIX = 'todos API listening on http://127.0.0.1:';
const READY_DEADLINE_MS = 5000;

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

// Build a DB file at `dbPath` under the OLD 4-column schema (no due_date column
// at all — not even NULL-valued), seeded with one legacy row. Runs as a REAL Bun
// process (not this test's own Vite-transformed module graph) so `bun:sqlite` is
// resolvable.
function seedLegacySchema(dbPath) {
  const script = `
    import { Database } from 'bun:sqlite';
    const db = new Database(${JSON.stringify(dbPath)});
    db.exec(\`CREATE TABLE todos (
      id        TEXT    PRIMARY KEY,
      text      TEXT    NOT NULL CHECK (length(text) > 0),
      completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
      position  INTEGER NOT NULL
    );\`);
    db.run(
      'INSERT INTO todos (id, text, completed, position) VALUES (?, ?, ?, ?)',
      ['legacy1', 'pre-existing legacy item', 0, 0]
    );
  `;
  const result = spawnSync('bun', ['-e', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `failed to seed legacy-schema DB: ${result.stderr || result.error}`
    );
  }
  // Sanity: table_info must show exactly the OLD 4 columns (no due_date), so the
  // later assertion genuinely proves the server ADDED it rather than it having
  // been there all along.
  const probe = spawnSync('bun', [
    '-e',
    `
      import { Database } from 'bun:sqlite';
      const db = new Database(${JSON.stringify(dbPath)});
      const cols = db.query('PRAGMA table_info(todos)').all().map((c) => c.name);
      console.log(JSON.stringify(cols));
    `,
  ], { encoding: 'utf8' });
  const cols = JSON.parse(probe.stdout.trim());
  if (cols.includes('due_date')) {
    throw new Error('seedLegacySchema: due_date unexpectedly already present');
  }
}

function spawnServer(port, dbPath) {
  return new Promise((resolve, reject) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    const child = spawn('bun', ['server/index.js'], {
      env: { ...process.env, TODOS_PORT: String(port), TODOS_DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `server never printed readiness marker within ${READY_DEADLINE_MS}ms. stderr:\n${stderrBuffer}`
        )
      );
    }, READY_DEADLINE_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      if (!settled && stdoutBuffer.includes(READY_MARKER_PREFIX)) {
        settled = true;
        clearTimeout(deadline);
        resolve(child);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk;
    });
    child.on('exit', () => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        reject(new Error(`server exited before ready. stderr:\n${stderrBuffer}`));
      }
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 2000);
  });
}

describe('Bun legacy 4-column schema boots and gains due_date (R2)', () => {
  let dir;
  let dbPath;
  let port;
  let child;
  let baseUrl;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'todos-legacy-'));
    dbPath = join(dir, 'db.sqlite');
    seedLegacySchema(dbPath);
    port = await pickCandidatePort();
    child = await spawnServer(port, dbPath);
    baseUrl = `http://127.0.0.1:${port}`;
  }, 20_000);

  afterAll(async () => {
    await stopServer(child);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('boots with zero errors and the pre-existing legacy row reads back dueDate:null', async () => {
    const res = await fetch(`${baseUrl}/api/todos`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { id: 'legacy1', text: 'pre-existing legacy item', completed: false, dueDate: null },
    ]);
  });

  it('a PUT setting a dueDate on the ADD COLUMN-ed schema round-trips it', async () => {
    const withDate = [
      { id: 'legacy1', text: 'pre-existing legacy item', completed: false, dueDate: '2026-07-20' },
    ];
    const put = await fetch(`${baseUrl}/api/todos`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withDate),
    });
    expect(put.status).toBe(200);

    const got = await fetch(`${baseUrl}/api/todos`);
    expect(await got.json()).toEqual(withDate);
  });
});
