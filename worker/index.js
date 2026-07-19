// ISSUE-31 — Cloudflare Worker adapter (D-COMPUTE / D-STORE / D-SEAM).
//
// The deployed cloud runtime. A THIN adapter over the SAME runtime-agnostic
// handler the Bun server uses (server/handler.js), so there is no second copy of
// the HTTP contract to drift (INV-CONTRACT). This file owns only: a D1-backed
// storage port built from env.DB, the Worker-specific write-guard/body config,
// and the Static-Assets fallback for non-/api requests.
//
// Routing precedence (F5, belt-and-suspenders with wrangler.jsonc's
// run_worker_first): handleRequest is called FIRST and fully owns every /api/*
// path (returning JSON for unknown routes/methods, incl. 404/405), so /api/* can
// NEVER fall through to a 200 index.html that loadTodos() would coerce to []. Only
// when handleRequest returns null (a non-/api path) do we delegate to the Static
// Assets binding.

import { handleRequest, MAX_BODY_BYTES, MAX_LIST_LEN } from '../server/handler.js';

// The Worker's per-runtime config for the shared handler (D-GUARDS):
//   - requireLoopbackHost:false — loopback has no meaning on a public origin; the
//     edge routes to this Worker by hostname, so Host-confusion is not a vector.
//   - deriveSameOrigin:true — the permitted origin is new URL(request.url).origin,
//     carrying the CORRECT live scheme (https on *.workers.dev), never Host + an
//     assumed scheme. This needs ZERO per-preview config and cannot self-block (F7).
//   - requireContentLength:false — the edge may normalize away Content-Length, so a
//     hard 411 would risk self-blocking legitimate writes; 411 is dropped from the
//     Worker contract and stays Bun-only (F9). The streaming running-cap still
//     guarantees over-size → 413.
//   - allowedOrigins:[] — optional defence-in-depth pin; the same-origin rule stands
//     alone by default. env.ALLOWED_ORIGINS (comma-separated) may add to it.
function buildConfig(env) {
  const extraOrigins =
    typeof env.ALLOWED_ORIGINS === 'string' && env.ALLOWED_ORIGINS.length > 0
      ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : [];
  return {
    maxBodyBytes: MAX_BODY_BYTES,
    maxListLen: MAX_LIST_LEN,
    requireLoopbackHost: false,
    requireContentLength: false,
    deriveSameOrigin: true,
    allowedOrigins: extraOrigins,
  };
}

// --- D1 storage port (D-STORE) -----------------------------------------------
// Same TodoStore interface as the bun:sqlite port. Reads are position-ordered and
// marshal INTEGER → JS boolean; the whole-list replace is a single env.DB.batch,
// which D1 executes as ONE atomic transaction (all-or-nothing) — a rejected batch
// commits nothing, so the old list stays intact (INV-ATOMIC / R5 / R-GUARD-3). Any
// constraint error propagates so the shared handler's classifier maps it to 400.
function createD1Store(env) {
  return {
    async readAll() {
      const { results } = await env.DB.prepare(
        'SELECT id, text, completed, due_date, position FROM todos ORDER BY position ASC'
      ).all();
      return (results || []).map((row) => ({
        id: row.id,
        text: row.text,
        completed: row.completed === 1, // marshal INTEGER -> JS boolean (INV-E)
        dueDate: row.due_date ?? null, // column <-> field; null when absent
      }));
    },
    async replaceAll(rows) {
      const insert = env.DB.prepare(
        'INSERT INTO todos (id, text, completed, position, due_date) VALUES (?, ?, ?, ?, ?)'
      );
      const statements = [env.DB.prepare('DELETE FROM todos')];
      rows.forEach((t, i) => {
        statements.push(
          insert.bind(t.id, t.text, t.completed ? 1 : 0, i, t.dueDate ?? null)
        );
      });
      // Atomic: D1 runs the batch as a single transaction; a constraint rejection
      // rolls back the DELETE too, preserving the prior list (INV-ATOMIC).
      await env.DB.batch(statements);
    },
  };
}

export default {
  async fetch(request, env) {
    // The shared handler owns every /api/* path and returns a Response for it;
    // it returns null ONLY for non-/api paths (F5). We branch on that null.
    const apiResponse = await handleRequest(request, {
      store: createD1Store(env),
      config: buildConfig(env),
    });
    if (apiResponse) return apiResponse;

    // Non-/api request → the Static Assets binding serves the SPA (with
    // single-page-application not_found_handling from wrangler.jsonc).
    return env.ASSETS.fetch(request);
  },
};
