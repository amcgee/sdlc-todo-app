// ISSUE-19 — integration-test fixture: spawn the REAL server/index.js as a Bun
// subprocess against a throwaway SQLite DB, drive it over real HTTP, reap it.
//
// This is scaffolding, NOT a *.test.js file, so Vitest does not treat it as a
// suite. It is the load-bearing helper every integration file depends on.
//
// Design pins (from docs/specs/ISSUE-19-plan.md §4):
//   - Race-safe port acquisition: OS port-0 pick (collision avoidance) + a bounded
//     retry-on-EADDRINUSE spawn loop keyed on the child's `exit` event (F3).
//   - Readiness gated FIRST on OUR child's own stdout marker (server/index.js:289),
//     which no foreign parallel-worker server can forge into our captured stdout
//     (F8); a GET is only an optional post-marker secondary confirmation.
//   - Temp DB: a unique mkdtemp() directory under os.tmpdir(); whole-dir teardown
//     removes db + -wal + -shm in one shot (INV-B).
//   - Reap: SIGTERM -> SIGKILL fallback + async rm() in stop(), and a crash-safety
//     process.once('exit') net using the SYNC fs.rmSync() (F7 — exit handlers cannot
//     await a promise).
//   - rawRequest(): a raw node:net socket helper (§4.7) for the forged/absent-Host
//     and mid-stream-cap cases that fetch/undici cannot express (F4/F5). node:net is
//     a built-in, so no new dependency (INV-G).

import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The exact readiness prefix server/index.js:289 prints to ITS OWN stdout.
const READY_MARKER_PREFIX = 'todos API listening on http://127.0.0.1:';

const MAX_SPAWN_ATTEMPTS = 5;
const READY_DEADLINE_MS = 5000; // bound the marker/exit race
const SECONDARY_GET_DEADLINE_MS = 2000; // bound the optional post-marker GET
const KILL_FALLBACK_MS = 2000; // SIGTERM -> SIGKILL escalation window

/**
 * Ask the OS for a likely-free ephemeral port by binding port 0 on a throwaway
 * server and reading the assigned port. This is a HINT for collision avoidance
 * (INV-C), NOT a guarantee — the close->bind window is the TOCTOU race the retry
 * loop (§4.3) tolerates.
 * @returns {Promise<number>}
 */
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

/**
 * Create an integration-test server fixture.
 *
 * @returns {{
 *   start: () => Promise<void>,
 *   stop: () => Promise<void>,
 *   baseUrl: string,
 *   port: number,
 *   dbDir: string,
 *   dbPath: string,
 *   getTodos: () => Promise<{status:number, body:any}>,
 *   putTodos: (list:any, opts?:{headers?:object}) => Promise<{status:number, body:any}>,
 *   rawPut: (body:string, headers?:object) => Promise<{status:number, body:any}>,
 *   rawRequest: (opts:object) => Promise<{statusCode:number, headers:object, body:string}>,
 * }}
 */
export function createServerFixture() {
  const fixture = {
    start,
    stop,
    baseUrl: '',
    port: 0,
    dbDir: '',
    dbPath: '',
    getTodos,
    putTodos,
    rawPut,
    rawRequest,
  };

  let child = null; // the live Bun child process handle
  let stdoutBuffer = ''; // captured child stdout (the F8 marker source)
  let stderrBuffer = ''; // captured child stderr (diagnostics on failure)
  let exitNet = null; // the process.once('exit') crash-safety handler
  let stopped = false; // idempotency guard for stop()

  // --- lifecycle -------------------------------------------------------------

  async function start() {
    // Unique throwaway DB directory under the OS temp dir (Q5/INV-B). Deleting
    // the whole directory later takes db.sqlite + -wal + -shm in one shot.
    fixture.dbDir = await mkdtemp(join(tmpdir(), 'todos-int-'));
    fixture.dbPath = join(fixture.dbDir, 'db.sqlite');

    // Crash-safety net (F7): kill any stray child and SYNCHRONOUSLY remove the
    // temp dir even if afterAll never runs. rmSync (not async rm) because an exit
    // handler cannot await a promise. force:true makes it a no-op if already gone.
    exitNet = () => {
      try {
        if (child && child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
      } catch {
        // best-effort
      }
      try {
        if (fixture.dbDir) {
          rmSync(fixture.dbDir, { recursive: true, force: true });
        }
      } catch {
        // best-effort
      }
    };
    process.once('exit', exitNet);

    // Bounded retry-on-EADDRINUSE spawn loop (§4.3, F3).
    let lastPort = 0;
    for (let attempt = 1; attempt <= MAX_SPAWN_ATTEMPTS; attempt++) {
      const port = await pickCandidatePort();
      lastPort = port;
      const outcome = await spawnAndAwaitReady(port);

      if (outcome.ready) {
        fixture.port = port;
        fixture.baseUrl = `http://127.0.0.1:${port}`;
        return;
      }

      // A pre-marker child `exit` is the authoritative lost-race signal (F8): a
      // bind failure means the child never reached line 289, so the marker never
      // appeared. The dead child needs no kill; retry a fresh port.
      if (outcome.reason === 'exit' && attempt < MAX_SPAWN_ATTEMPTS) {
        continue;
      }

      // A missing `bun` binary is not a port race — do not retry it (§4.4).
      if (outcome.reason === 'enoent') {
        await stop();
        throw new Error(
          'bun not found on PATH — integration tests require Bun; install it or add it to PATH'
        );
      }

      // A bound-but-silent child (deadline elapsed, marker never printed) is a
      // genuine bug, not a port race — hard fail (§4.4).
      if (outcome.reason === 'timeout') {
        await stop();
        throw new Error(
          `Integration server never printed its readiness marker within ${READY_DEADLINE_MS}ms ` +
            `on port ${port}. Captured stderr:\n${stderrBuffer}`
        );
      }

      // Exhausted retries on repeated bind failures.
      if (attempt === MAX_SPAWN_ATTEMPTS) {
        await stop();
        throw new Error(
          `Integration server failed to bind after ${MAX_SPAWN_ATTEMPTS} attempts ` +
            `(last candidate port ${lastPort}). Captured stderr:\n${stderrBuffer}`
        );
      }
    }
  }

  /**
   * Spawn one child on `port` and race "our-own marker seen" against "child exit"
   * against a deadline. Resolves the outcome; never throws (the caller decides
   * retry vs hard-fail from the reason).
   * @param {number} port
   * @returns {Promise<{ready:boolean, reason?:'exit'|'timeout'|'enoent'}>}
   */
  function spawnAndAwaitReady(port) {
    return new Promise((resolve) => {
      stdoutBuffer = '';
      stderrBuffer = '';

      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        resolve(result);
      };

      child = spawn('bun', ['server/index.js'], {
        env: {
          ...process.env,
          TODOS_PORT: String(port),
          TODOS_DB_PATH: fixture.dbPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // spawn error (e.g. ENOENT: bun not on PATH) — distinct from a bind failure.
      child.on('error', (err) => {
        if (err && err.code === 'ENOENT') {
          done({ ready: false, reason: 'enoent' });
        } else {
          stderrBuffer += `\n[spawn error] ${err && err.message}`;
          done({ ready: false, reason: 'exit' });
        }
      });

      // PRIMARY readiness signal: our child's OWN stdout marker (F8). No other
      // process can write into this pipe, so matching the prefix proves the ready
      // server is ours, not a foreign squatter on the same port.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk;
        if (stdoutBuffer.includes(READY_MARKER_PREFIX)) {
          done({ ready: true });
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk;
      });

      // Bind-failure signal: the child exits BEFORE the marker appears. This is
      // the authoritative retry trigger (§4.3), not a stderr regex.
      child.on('exit', () => {
        done({ ready: false, reason: 'exit' });
      });

      // Bound the race — a child that is alive but silent past the deadline is a
      // hard failure, not a retry (§4.4).
      const deadlineTimer = setTimeout(() => {
        done({ ready: false, reason: 'timeout' });
      }, READY_DEADLINE_MS);
    }).then(async (result) => {
      // Optional SECONDARY confirmation (§4.4): only AFTER the marker proved the
      // process is ours may we probe GET. A failure here is a hard error (the
      // marker already told us our process bound the port), surfaced by the GET
      // helper's own error handling — we keep it best-effort/bounded here so a
      // transient socket hiccup right at startup does not wedge the suite.
      if (result.ready) {
        try {
          const controller = AbortSignal.timeout(SECONDARY_GET_DEADLINE_MS);
          const res = await fetch(`http://127.0.0.1:${port}/api/todos`, {
            signal: controller,
          });
          // Drain the body so the socket is not left half-open.
          await res.text();
        } catch {
          // The marker is the mandatory proof; the GET is belt-and-braces. Do not
          // downgrade a marker-confirmed ready to a failure on a transient probe.
        }
      }
      return result;
    });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;

    // Kill the child (SIGTERM, escalate to SIGKILL) and await its exit.
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

    // Remove the whole temp DB directory (db + -wal + -shm) — async here (INV-B).
    if (fixture.dbDir) {
      await rm(fixture.dbDir, { recursive: true, force: true });
    }

    // The crash-safety net is now redundant; drop it so it does not fire on a
    // clean exit (rmSync with force:true would no-op anyway, but keep it tidy).
    if (exitNet) {
      process.removeListener('exit', exitNet);
      exitNet = null;
    }
  }

  // --- request helpers (real fetch to the real baseUrl, §4.6) ----------------

  async function getTodos() {
    const res = await fetch(`${fixture.baseUrl}/api/todos`);
    const body = await res.json();
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

  // --- raw node:net socket helper (§4.7, F4) ---------------------------------
  // For the cases fetch/undici CANNOT express: a forged or absent Host header
  // (undici silently overrides Host, F4), and the length-less 411 branch. We
  // write the HTTP/1.1 request bytes by hand so Host is fully under our control.
  //
  // NOTE (F5): the server's TRUE mid-stream cap (server/index.js:234, readCappedBody
  // returning null) is UNREACHABLE via any real client request and is therefore
  // OUT OF SCOPE for this suite. The guard order makes this so: a Content-Length
  // that is absent -> 411 at server/index.js:217 BEFORE the body is read (a
  // chunked/no-length request never reaches readCappedBody); a Content-Length that
  // is present and over-cap -> 413 at server/index.js:222 (the declared branch,
  // proven by T6(a)); and a present-but-under-declared Content-Length makes the
  // server body reader stop at the declared length, so streamed extra bytes never
  // reach the running cap. Empirically confirmed on Bun 1.3.11. R8's observable
  // requirement (over-cap -> 413, not persisted) is fully proven by T6(a)'s real
  // >1 MB body; exercising line 234 is not required by R8.
  function rawRequest({
    method = 'PUT',
    path = '/api/todos',
    headers = {},
    body = '',
    omitHost = false,
    omitContentLength = false,
  } = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: fixture.port });
      socket.setTimeout(3000);

      let responseBuffer = Buffer.alloc(0);
      let settled = false;

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        fn();
      };

      socket.on('timeout', () => {
        finish(() => reject(new Error('rawRequest: socket timed out')));
      });
      socket.on('error', (err) => {
        finish(() => reject(err));
      });

      socket.on('data', (chunk) => {
        responseBuffer = Buffer.concat([responseBuffer, chunk]);
      });

      socket.on('end', () => {
        finish(() => resolve(parseRawResponse(responseBuffer)));
      });
      socket.on('close', () => {
        finish(() => resolve(parseRawResponse(responseBuffer)));
      });

      socket.on('connect', () => {
        // Build the header block by hand. Emit ONLY what the test dictates.
        const lines = [`${method} ${path} HTTP/1.1`];

        // Host: fully under our control here (that is the whole point, F4).
        if (!omitHost) {
          const hostHeader =
            headers.Host || headers.host || `127.0.0.1:${fixture.port}`;
          lines.push(`Host: ${hostHeader}`);
        }

        // Content-Length: from the real body byte length unless overridden.
        if (!omitContentLength) {
          const declaredLength =
            headers['Content-Length'] ??
            headers['content-length'] ??
            Buffer.byteLength(body);
          lines.push(`Content-Length: ${declaredLength}`);
        }

        // Any remaining caller headers (e.g. Content-Type), skipping the ones we
        // handled explicitly above.
        let callerSetConnection = false;
        for (const [name, value] of Object.entries(headers)) {
          const lower = name.toLowerCase();
          if (lower === 'host' || lower === 'content-length') continue;
          if (lower === 'connection') callerSetConnection = true;
          lines.push(`${name}: ${value}`);
        }
        // Force the server to close the socket after responding so our `end`/
        // `close` handlers fire — otherwise HTTP/1.1 keep-alive holds the socket
        // open and the read hangs until the idle timeout (a spurious failure).
        if (!callerSetConnection) {
          lines.push('Connection: close');
        }
        if (!('content-type' in lowerKeys(headers)) && body) {
          lines.push('Content-Type: application/json');
        }

        // Terminate the header block, then write the body.
        const headerBlock = lines.join('\r\n') + '\r\n\r\n';
        socket.write(headerBlock);
        if (body) socket.write(body);
      });
    });
  }

  return fixture;
}

// --- module-level raw helpers -------------------------------------------------

function lowerKeys(obj) {
  const out = {};
  for (const key of Object.keys(obj)) out[key.toLowerCase()] = true;
  return out;
}

/**
 * Minimal hand-parse of a raw HTTP/1.1 response. The tests only need the status
 * code and (rarely) the body, so the parse surface is intentionally tiny (§4.7).
 * @param {Buffer} buffer
 * @returns {{statusCode:number, headers:object, body:string}}
 */
function parseRawResponse(buffer) {
  const text = buffer.toString('latin1');
  const headerEnd = text.indexOf('\r\n\r\n');
  const head = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const bodyRaw = headerEnd === -1 ? '' : text.slice(headerEnd + 4);

  const [statusLine, ...headerLines] = head.split('\r\n');
  const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine || '');
  const statusCode = match ? Number(match[1]) : 0;

  const headers = {};
  for (const line of headerLines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line
      .slice(idx + 1)
      .trim();
  }

  // Best-effort body: if chunked, strip the outermost chunk sizing; else raw.
  let body = bodyRaw;
  if ((headers['transfer-encoding'] || '').includes('chunked')) {
    body = dechunk(bodyRaw);
  }

  return { statusCode, headers, body };
}

function dechunk(raw) {
  let out = '';
  let rest = raw;
  while (rest.length > 0) {
    const nl = rest.indexOf('\r\n');
    if (nl === -1) break;
    const size = parseInt(rest.slice(0, nl).trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = nl + 2;
    out += rest.slice(start, start + size);
    rest = rest.slice(start + size + 2);
  }
  return out;
}
