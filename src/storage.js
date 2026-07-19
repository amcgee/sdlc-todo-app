// Side-effect boundary: the persistence adapter (plan §4.1). Previously the only
// module naming `localStorage`; now the only module talking to the server-side API
// over `fetch`. Both functions are TOTAL — they never reject (INV-F): every failure
// (network error, non-2xx, non-JSON body, 3000 ms timeout) is caught and mapped to
// the defined fallback (`[]` / `false`).
//
// Server responses are re-sanitized through `sanitizeTodos` before returning to the
// caller (INV-C, defense in depth) — so App.jsx does NOT need to import or call it
// (F68).

import { sanitizeTodos } from './todos.js';

// Same-origin relative URL — works in dev (Vite proxy) and preview/prod (Bun
// server serves both /api and dist/ from one origin), D3/INV-I.
const API_URL = '/api/todos';
const TIMEOUT = 3000; // ms — hard load/save budget (§6, INV-F)

/**
 * Load the persisted todo list. NEVER rejects (INV-F): every failure path resolves
 * to the empty-list fallback `[]`. The value is passed through `sanitizeTodos` so
 * the caller receives exactly `Array<{ id, text, completed: boolean }>` (INV-C).
 * @returns {Promise<Array>}
 */
export async function loadTodos() {
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return []; // non-2xx incl. 404 -> fallback (§6)
    let data;
    try {
      data = await res.json(); // non-JSON body -> catch -> fallback
    } catch {
      return [];
    }
    return sanitizeTodos(data); // shape parity + array guard (INV-C)
  } catch {
    return []; // network error / timeout / abort
  }
}

// --- save serialization state (module-scoped, INV-J) -------------------------
let inFlight = null; // AbortController of the current in-flight PUT
let pending = null; // latest list awaiting send while one is in flight
let sending = false; // whether the drain loop is currently running
let drainResult = null; // Promise<boolean> resolving to the running drain's FINAL result

/**
 * Best-effort persist of the whole list. NEVER rejects (INV-F): every failure maps
 * to `false`. Newest-state-wins ordering (INV-J): a newer save aborts any stale
 * in-flight PUT and coalesces so the LAST body the server commits is the newest
 * `todos` state the client held, never an older one.
 *
 * R13 contract: a coalesced call (one that arrives while a drain is already
 * running) does NOT early-return a bare `false`. Its newest state IS handed to the
 * running drain via `pending`, so it resolves to that drain's EVENTUAL final result
 * — the PUT outcome of the newest state actually sent. After this, a `false`
 * resolution unambiguously means "the newest state failed to persist," which is
 * exactly what the App's save-failure notice keys on (no false-positive notice on a
 * rapid double-edit whose eventual send succeeds). Newest-wins ordering (INV-J) and
 * the never-rejects guarantee (INV-F) are unchanged.
 * @param {Array} list
 * @returns {Promise<boolean>} true on a 2xx, false otherwise
 */
export async function saveTodos(list) {
  pending = list; // coalesce: remember the newest state
  if (inFlight) inFlight.abort(); // cancel a now-stale in-flight PUT
  if (sending) return drainResult; // a drain is running; resolve to ITS final result
  sending = true;
  let resolveDrain;
  drainResult = new Promise((resolve) => {
    resolveDrain = resolve;
  });
  let lastResult = false;
  try {
    while (pending !== null) {
      const body = pending;
      pending = null;
      const ctrl = new AbortController();
      inFlight = ctrl;
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
      try {
        const res = await fetch(API_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        lastResult = res.ok; // success decided by status only (§6)
      } catch {
        lastResult = false; // network / timeout / abort -> false
      } finally {
        clearTimeout(timer);
        if (inFlight === ctrl) inFlight = null;
      }
    }
  } finally {
    sending = false;
    resolveDrain(lastResult); // unblock every coalesced caller with the true result
  }
  return lastResult;
}
