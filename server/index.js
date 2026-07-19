// ISSUE-15 / ISSUE-31 — local persistence API + static server (Bun adapter).
//
// Post-ISSUE-31 this file is a THIN Bun adapter over the runtime-agnostic shared
// handler (server/handler.js, D-SEAM): it owns only the bun:sqlite-backed storage
// port, the Bun-specific write-guard/body config, static-asset serving from dist/,
// the Bun.serve bind, and the stdout readiness marker. The HTTP contract itself —
// routing, guard, body-cap, parse, shape-validate, duplicate-id pre-check,
// MAX_LIST_LEN bound, transactional replace — lives ONCE in handleRequest and is
// shared byte-for-byte with the Worker/D1 adapter, so the two runtimes cannot
// drift (INV-CONTRACT). This refactor is a PURE extraction: the Bun adapter's
// observable behavior (status codes, headers, ordering, marker line, loopback
// bind, 411/403 semantics) is unchanged, proven by the unchanged ISSUE-19 suite.
//
// It binds to the literal loopback 127.0.0.1 only (INV-G), never 0.0.0.0/localhost.
// In preview/prod it ALSO serves the built dist/ static assets from the same origin
// so /api is always reachable (INV-I).

import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

import { handleRequest, MAX_BODY_BYTES, MAX_LIST_LEN } from './handler.js';

// --- Configuration (TODOS_PORT is the single source of truth, F67) -----------
const PORT = Number(process.env.TODOS_PORT) || 8787;

// Dev pins Vite to :5173 (server.strictPort, F66); the write guard's allowlist is
// derived from the configured ports, never hardcoded (F66).
const VITE_DEV_PORT = 5173;
const ALLOWED_ORIGINS = [
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${VITE_DEV_PORT}`,
  `http://localhost:${VITE_DEV_PORT}`,
];

// The Bun adapter's per-runtime config for the shared handler. It reproduces the
// exact ISSUE-19-pinned semantics: loopback Host required, an absent Content-Length
// is a hard 411, and the origin allowlist is the fixed loopback set (NOT derived
// from the request — that is the Worker's same-origin rule, F7).
const BUN_CONFIG = {
  maxBodyBytes: MAX_BODY_BYTES,
  maxListLen: MAX_LIST_LEN,
  requireLoopbackHost: true,
  requireContentLength: true,
  deriveSameOrigin: false,
  allowedOrigins: ALLOWED_ORIGINS,
};

// --- DB path: repo-root-relative data/todos.sqlite, stable regardless of cwd ---
// TODOS_DB_PATH is a test-affordance override (plan §7); the default is the pinned
// literal path (Q6/INV-G).
const dbPath =
  process.env.TODOS_DB_PATH ||
  fileURLToPath(new URL('../data/todos.sqlite', import.meta.url));

// Ensure the data/ directory exists before opening (idempotent).
mkdirSync(dirname(dbPath), { recursive: true });

// Open (creates the file on first run, §7).
const db = new Database(dbPath);
db.exec('PRAGMA journal_mode = WAL;');

// Schema — Form A, idempotent (§2.2). The DDL CHECKs give the constraints teeth:
// a non-0/1 completed, an empty text, or a duplicate/empty id each violate a
// constraint and roll the transactional replace back. due_date is a nullable
// "YYYY-MM-DD" day (no CHECK: validity is enforced by the shared handler, so both
// runtimes apply the one rule identically).
db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id        TEXT    PRIMARY KEY,
    text      TEXT    NOT NULL CHECK (length(text) > 0),
    completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
    position  INTEGER NOT NULL,
    due_date  TEXT
  );
`);

// A DB created under the pre-due-date 4-column schema keeps its old shape through
// CREATE TABLE IF NOT EXISTS, so add the column on boot if it is absent. The D1
// side gets this from migration 0002; the Bun side needs the explicit probe-and-add.
const hasDueDate = db
  .query('PRAGMA table_info(todos)')
  .all()
  .some((col) => col.name === 'due_date');
if (!hasDueDate) {
  db.exec('ALTER TABLE todos ADD COLUMN due_date TEXT');
}

// Prepared statements / transaction reused across requests.
const selectAll = db.query(
  'SELECT id, text, completed, due_date, position FROM todos ORDER BY position ASC'
);

// Transactional whole-list replace. bun:sqlite auto-rolls-back if the function
// throws, so a constraint violation thrown AFTER the DELETE rolls the DELETE back
// too — the DB retains the OLD list intact (INV-ATOMIC). Verified on Bun 1.3.11.
const replaceAllTx = db.transaction((rows) => {
  db.run('DELETE FROM todos');
  const insert = db.prepare(
    'INSERT INTO todos (id, text, completed, position, due_date) VALUES (?, ?, ?, ?, ?)'
  );
  rows.forEach((t, i) =>
    insert.run(t.id, t.text, t.completed ? 1 : 0, i, t.dueDate ?? null)
  );
});

// --- bun:sqlite storage port (D-SEAM) ----------------------------------------
// The runtime-specific half: reads position-ordered rows and marshals INTEGER →
// JS boolean; whole-list replace is atomic via the bun:sqlite transaction above.
// A constraint error propagates so the shared handler's classifier maps it to 400.
const store = {
  async readAll() {
    return selectAll.all().map((row) => ({
      id: row.id,
      text: row.text,
      completed: row.completed === 1, // marshal INTEGER -> JS boolean (INV-E)
      dueDate: row.due_date ?? null, // column <-> field; null when absent
    }));
  },
  async replaceAll(rows) {
    replaceAllTx(rows);
  },
};

// --- Static serving (preview/prod only, §2.5) --------------------------------
// The Bun server serves dist/ for any non-/api GET when a build exists, so the
// API and the SPA share one origin (INV-I). In dev this branch is dormant (Vite
// serves assets and proxies /api here).
const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const hasDist = existsSync(join(distDir, 'index.html'));

function serveStatic(pathname) {
  // Resolve within dist/ only; reject path traversal.
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(distDir, rel));
  if (!filePath.startsWith(distDir)) {
    return new Response('Not found', { status: 404 });
  }
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return new Response(readFileSync(filePath), {
      headers: { 'Content-Type': contentTypeFor(filePath) },
    });
  }
  // SPA fallback: serve index.html for unknown non-asset routes.
  const indexPath = join(distDir, 'index.html');
  if (existsSync(indexPath)) {
    return new Response(readFileSync(indexPath), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return new Response('Not found', { status: 404 });
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.ico')) return 'image/x-icon';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

// --- Request handler (thin adapter over the shared handler) -------------------
async function handler(req) {
  // The shared handler owns every /api/* path (returns a Response); it returns
  // null for non-/api paths, which we serve as static assets in preview/prod.
  const apiResponse = await handleRequest(req, { store, config: BUN_CONFIG });
  if (apiResponse) return apiResponse;

  // Non-API request: serve static assets in preview/prod, 404 otherwise.
  const { pathname } = new URL(req.url);
  if (req.method === 'GET' && hasDist) {
    return serveStatic(pathname);
  }
  return new Response('Not found', { status: 404 });
}

// --- Bind (INV-G) — fail loud on bind error (F65) ----------------------------
// Bun.serve throws synchronously on EADDRINUSE; we do NOT swallow it, so a port
// clash exits the process non-zero instead of degrading to a silent no-op.
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  fetch: handler,
});

// Readiness marker the dev launcher polls for (§3.2).
console.log(`todos API listening on http://127.0.0.1:${server.port}`);
