// ISSUE-15 — dev launcher (plan §3.2 / F65). Dev-only orchestration, NOT app logic.
//
// Starts the Bun API server, WAITS until it is actually listening, and only then
// starts Vite. If the server dies (e.g. EADDRINUSE) or never becomes ready, this
// prints the error and exits NON-ZERO WITHOUT starting Vite — a port clash is a
// visible hard failure, never a silently non-persisting app (the naive
// `bun server/index.js & vite` is rejected because `&` swallows the exit status).
//
// Uses only Node/Bun built-ins (node:child_process, global fetch) — no new dep.

import { spawn } from 'node:child_process';

const PORT = Number(process.env.TODOS_PORT) || 8787;
const READY_URL = `http://127.0.0.1:${PORT}/api/todos`;
const READY_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;

let shuttingDown = false;
const children = [];

function killAll(signal = 'SIGTERM') {
  for (const child of children) {
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill(signal);
      } catch {
        // ignore — best-effort teardown
      }
    }
  }
}

function fail(message, code = 1) {
  if (message) console.error(`[dev] ${message}`);
  shuttingDown = true;
  killAll();
  process.exit(code);
}

// Spawn the API server, inheriting stdio so its logs/errors are visible.
const serverProc = spawn('bun', ['server/index.js'], {
  stdio: 'inherit',
  env: process.env,
});
children.push(serverProc);

let serverExited = false;
serverProc.on('exit', (code, signal) => {
  serverExited = true;
  if (!shuttingDown) {
    fail(
      `API server exited before readiness (code=${code}, signal=${signal}). ` +
        'Not starting Vite. Is the port in use?',
      code == null ? 1 : code || 1
    );
  }
});

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverExited) return false; // child died; exit handler already fired
    try {
      const res = await fetch(READY_URL);
      if (res.ok) return true;
    } catch {
      // not listening yet — keep polling
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

const ready = await waitForReady();
if (!ready) {
  if (!serverExited) {
    fail(`API server did not become ready within ${READY_TIMEOUT_MS}ms.`);
  }
  // If it exited, the exit handler already called fail(); nothing more to do.
} else {
  // Only on confirmed readiness do we start Vite.
  const viteProc = spawn('vite', [], { stdio: 'inherit', env: process.env });
  children.push(viteProc);

  viteProc.on('exit', (code, signal) => {
    if (!shuttingDown) {
      shuttingDown = true;
      killAll();
      process.exit(code == null ? (signal ? 1 : 0) : code);
    }
  });
}

// Tear down BOTH children on Ctrl-C / termination and propagate exit.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    killAll(sig);
    process.exit(0);
  });
}
