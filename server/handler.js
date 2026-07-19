// ISSUE-31 — runtime-agnostic request handler (D-SEAM).
//
// This is the ONE implementation of the HTTP contract that both runtimes share:
// the Bun adapter (server/index.js, bun:sqlite) and the Worker adapter
// (worker/index.js, Cloudflare D1) each build a storage port + a per-adapter
// config and delegate here. There is therefore no second copy of the routing,
// guard, body-cap, parse, shape-validate, or transactional-replace logic to drift
// out of sync (the drift liability D-SEAM closes).
//
// NO bun:sqlite / Bun / D1 import here — only the Web platform primitives both
// runtimes provide (Request/Response, URL, TextDecoder, ReadableStream). All
// runtime-specific behaviour is carried by `config` (a pure function of the
// request → decision) and by the injected storage `store`.
//
//   handleRequest(request, { store, config }) -> Promise<Response|null>
//     - returns a Response for every /api/* path (incl. 404/405), so /api can
//       never fall through to static-asset resolution (F5).
//     - returns null for non-/api paths, so the adapter serves static assets in
//       the way native to its runtime (Bun dist/ read, Worker env.ASSETS.fetch).
//
// The storage port (TodoStore):
//   readAll(): Promise<Array<{id, text, completed:boolean}>>   // position-ordered
//   replaceAll(rows): Promise<void>   // atomic; throws (classified) on constraint

import { isItemTextWithinLimits, exceedsListGrowth } from '../src/limits.js';
import { isValidDueDate } from '../src/todos.js';

// --- shared config defaults (both adapters override the runtime-specific bits) --
export const MAX_BODY_BYTES = 1_048_576; // 1 MB streaming body cap (D-GUARDS-1)
export const MAX_LIST_LEN = 1000; // bounded list length in shared validation (F6)

// --- helpers -----------------------------------------------------------------

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A PUT body is a conforming list iff it is an array of objects each with a
// non-empty string id, a non-empty string text, and a boolean completed. An
// optional dueDate may be absent, null, or a valid "YYYY-MM-DD" day; any other
// type or a malformed date string rejects the list. This is NOT the todo business
// rules (N1); it only refuses shapes the schema declares impossible.
export function isConformingList(value) {
  if (!Array.isArray(value)) return false;
  for (const el of value) {
    if (typeof el !== 'object' || el === null || Array.isArray(el)) return false;
    if (typeof el.id !== 'string' || el.id.length === 0) return false;
    if (typeof el.text !== 'string' || el.text.length === 0) return false;
    if (typeof el.completed !== 'boolean') return false;
    if (el.dueDate !== undefined && el.dueDate !== null && !isValidDueDate(el.dueDate)) {
      return false;
    }
  }
  return true;
}

// Deterministic duplicate-id pre-check (F2/D-STORE layer 1). A shape-valid list
// with a duplicate id is the ONLY constraint a conforming list could trip, so we
// reject it in memory, driver-independently, BEFORE any DB call — making the
// duplicate-id → 400 outcome identical in bun:sqlite and D1 with zero dependence
// on either driver's constraint wording.
export function hasDuplicateIds(list) {
  const ids = list.map((t) => t.id);
  return ids.length !== new Set(ids).size;
}

// Backstop constraint classifier (F2/D-STORE layer 2). Defence in depth: if the
// DB itself rejects a write (e.g. a constraint reachable by a future schema
// change), map it to 400, never 500. Matches case-insensitively against any of
// the tokens both bun:sqlite AND D1 (local miniflare + real remote) may use —
// NOT a single lowercase "constraint" token, which D1 does not guarantee.
export function isConstraintError(err) {
  const parts = [];
  let cursor = err;
  // Walk message + cause chain so a wrapped D1_ERROR is still classified.
  for (let depth = 0; cursor && depth < 5; depth++) {
    if (typeof cursor === 'string') parts.push(cursor);
    else if (cursor.message) parts.push(String(cursor.message));
    cursor = cursor && cursor.cause;
  }
  const haystack = parts.join(' ').toLowerCase();
  return (
    haystack.includes('constraint') ||
    haystack.includes('unique') ||
    haystack.includes('primary key') ||
    haystack.includes('check') ||
    haystack.includes('sqlite_constraint')
  );
}

// Read the request body through a streaming reader, aborting the instant the
// running byte count exceeds the cap — the whole body is NEVER buffered first.
// Returns the collected bytes, or null if over-cap (caller returns 413). This is
// the authoritative over-size check in BOTH runtimes (Web Streams API). Ported
// from server/index.js:105-128.
async function readCappedBody(req, maxBodyBytes) {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Default-deny same-origin/loopback write guard (D-GUARDS-2). A pure function of
// (request, config). Returns an error Response to reject, or null to allow.
//
// The decision is entirely config-driven so ONE function reproduces BOTH runtimes:
//   - Bun: requireLoopbackHost:true + a fixed allowedOrigins allowlist (loopback
//     ports). A missing Origin is tolerated because Host was already gated.
//   - Worker: requireLoopbackHost:false + deriveSameOrigin:true, so the permitted
//     origin is new URL(request.url).origin — carrying the CORRECT scheme (https
//     on *.workers.dev) from the live request, never Host + an assumed scheme
//     (F7, the self-block trap). A missing Origin is tolerated (parity: a non-
//     browser client is not a CSRF vector; browsers attach Origin cross-origin).
function checkWriteGuard(req, config) {
  const origin = req.headers.get('Origin');
  const host = req.headers.get('Host');

  // Host must be present and loopback (Bun only). On a public origin the request
  // Host is authoritative (the edge routes to this Worker by hostname), so the
  // Worker does not gate on it.
  if (config.requireLoopbackHost) {
    if (host === null) {
      return json({ error: 'forbidden' }, 403);
    }
    const hostname = host.split(':')[0];
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      return json({ error: 'forbidden' }, 403);
    }
  }

  // Build the set of allowed origins from the explicit allowlist plus, on the
  // Worker, the request-derived same-origin (correct live scheme, zero per-preview
  // config, cannot self-block — F7).
  const allowed = new Set(config.allowedOrigins || []);
  if (config.deriveSameOrigin) {
    allowed.add(new URL(req.url).origin);
  }

  // A present Origin must be allowed; a missing Origin is tolerated.
  if (origin !== null && !allowed.has(origin)) {
    return json({ error: 'forbidden' }, 403);
  }

  return null;
}

// --- the shared handler ------------------------------------------------------

/**
 * Handle a request against the shared HTTP contract.
 * @param {Request} req
 * @param {{ store: {readAll:Function, replaceAll:Function}, config: object }} deps
 * @returns {Promise<Response|null>} a Response for every /api/* path; null for
 *   non-/api paths (the adapter serves static assets its own way).
 */
export async function handleRequest(req, { store, config }) {
  const url = new URL(req.url);
  const { pathname } = url;

  // The Worker/Bun adapter both call us BEFORE any static/asset delegation, and
  // we own EVERY /api/* path here — returning JSON for unknown routes/methods so
  // /api/* can never fall through to a 200 index.html (F5/R-GUARD-5).
  if (!pathname.startsWith('/api/')) {
    return null;
  }

  try {
    if (pathname !== '/api/todos') {
      return json({ error: 'not found' }, 404);
    }

    if (req.method === 'GET') {
      const list = await store.readAll();
      return json(list, 200);
    }

    if (req.method === 'PUT') {
      const maxBodyBytes = config.maxBodyBytes ?? MAX_BODY_BYTES;
      const maxListLen = config.maxListLen ?? MAX_LIST_LEN;

      // 1. Body-size ladder. A declared Content-Length over cap → 413 fast, in
      //    BOTH runtimes. An ABSENT Content-Length is a hard 411 ONLY when the
      //    adapter requires it (Bun); the Worker drops 411 (F9) because the edge
      //    may normalize away Content-Length and a hard 411 would self-block.
      const contentLength = req.headers.get('Content-Length');
      if (contentLength === null) {
        if (config.requireContentLength) {
          return json({ error: 'length required' }, 411);
        }
        // else: fall through to the streaming running-cap (the 413 guarantee).
      } else {
        const declared = Number(contentLength);
        if (!Number.isFinite(declared) || declared > maxBodyBytes) {
          return json({ error: 'payload too large' }, 413);
        }
      }

      // 2. Origin/Host guard (default-deny). Run before reading the body so a
      //    foreign request is rejected without work.
      const guardRejection = checkWriteGuard(req, config);
      if (guardRejection) return guardRejection;

      // 3. Stream the body with a running byte cap; abort mid-stream if a body
      //    actually exceeds the cap → 413 (never buffered whole first).
      const bytes = await readCappedBody(req, maxBodyBytes);
      if (bytes === null) {
        return json({ error: 'payload too large' }, 413);
      }

      // 4. Parse + shape-validate (never req.json(), which re-buffers).
      let parsed;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return json({ error: 'bad request' }, 400);
      }
      if (!isConformingList(parsed)) {
        return json({ error: 'bad request' }, 400);
      }

      // 5. Bounded list length (F6) — reject an oversized-but-shape-valid list
      //    identically in both runtimes, before any DB call, so bun:sqlite and
      //    D1 (whose per-batch() statement limit is far below a 26k-row list)
      //    cannot diverge.
      if (parsed.length > maxListLen) {
        return json({ error: 'list too long' }, 400);
      }

      // 6. Deterministic duplicate-id pre-check (F2 layer 1) — the only
      //    constraint a conforming list can trip, rejected driver-independently
      //    BEFORE any DB write so the outcome is identical in both runtimes.
      if (hasDuplicateIds(parsed)) {
        return json({ error: 'duplicate id' }, 400);
      }

      // 6a. ISSUE-35 list/item limits (R1/R6). Exactly ONE readAll feeds BOTH
      //     new checks: the grandfather carve-out (R1) needs each stored item's
      //     current text, and the growth rule (R6) needs the current length. The
      //     read comes FIRST so both checks depend on data that exists (fixes the
      //     ordering/grandfather dependency), and both run BEFORE replaceAll so a
      //     rejection commits nothing (INV-3).
      //
      // Step A — single read: derive storedById (id → stored text, for R1) and
      // current.length (for R6). Duplicate ids are already rejected upstream, so
      // the stored list is a well-formed id → text Map with no collision risk.
      const current = await store.readAll();
      const storedById = new Map(current.map((t) => [t.id, t.text]));

      // Step B — per-item text check with grandfather (R1/INV-1). An item is
      // rejected only if its text is over-limit AND it is new or its text changed
      // from what is stored for that id. An unchanged legacy (id, text) pair
      // (storedById.get(el.id) === el.text) passes through untouched (R11/INV-5).
      for (const el of parsed) {
        if (!isItemTextWithinLimits(el.text) && storedById.get(el.id) !== el.text) {
          return json({ error: 'item too long' }, 400);
        }
      }

      // Step C — list-growth check (R6). Reject only genuine growth past the cap;
      // an edit/toggle/delete on a legacy over-sized list is not growth (R8).
      if (exceedsListGrowth(parsed.length, current.length)) {
        return json({ error: 'list full' }, 400);
      }

      // 7. Atomic whole-list replace through the storage port. The classifier
      //    (F2 layer 2) is a backstop: any DB-level constraint error → 400,
      //    never 500. The store's atomicity (bun:sqlite transaction / D1 batch)
      //    guarantees a rejected write leaves the OLD list intact (INV-ATOMIC).
      try {
        await store.replaceAll(parsed);
      } catch (err) {
        if (isConstraintError(err)) {
          return json({ error: 'constraint violation' }, 400);
        }
        return json({ error: 'internal error' }, 500);
      }

      return json({ ok: true }, 200);
    }

    // Unsupported method on the API route.
    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    // The handler MUST NOT let an error escape unhandled.
    return json({ error: 'internal error' }, 500);
  }
}
