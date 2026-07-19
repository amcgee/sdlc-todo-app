// @vitest-environment node
//
// ISSUE-19 — storage-seam integration tests (T8, plan §5/§6). Drives the REAL
// src/storage.js loadTodos()/saveTodos() against the spawned server over a REAL
// socket. Nothing below the test is stubbed (INV-F).
//
// src/storage.js posts to the RELATIVE '/api/todos', which has no origin under
// node. We install a base-URL-prepending fetch wrapper that rewrites only
// root-relative URLs and then performs a REAL network call to the spawned server.
// It does NOT fabricate a Response (that would be the forbidden stub, INV-F).
//
// Kept as a SEPARATE file from the pure-HTTP tests because it mutates globalThis.fetch;
// Vitest runs files in separate workers, but restoring is still correct hygiene.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadTodos, saveTodos } from '../../src/storage.js';
import { createServerFixture } from './helpers/server.js';

describe('storage seam vs real server', () => {
  const server = createServerFixture();
  let realFetch;

  beforeAll(async () => {
    await server.start();
    // Base-URL-prepending wrapper over the REAL fetch. Rewrites only root-relative
    // URLs (storage.js's '/api/todos') to the spawned server's origin; the call is
    // a real network call. No Response is fabricated (INV-F).
    realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      realFetch(
        typeof input === 'string' && input.startsWith('/')
          ? server.baseUrl + input
          : input,
        init
      );
  });

  afterAll(async () => {
    // Restore BEFORE stop so no other file inherits the wrapper.
    globalThis.fetch = realFetch;
    await server.stop();
  });

  // Reset to a known-empty DB before each test so ordering does not matter.
  afterEach(async () => {
    // Best-effort clear via the real wrapper; ignore failures (dead-server test).
    try {
      await saveTodos([]);
    } catch {
      // the T8b test stops the server; a failed clear here is expected & harmless.
    }
  });

  // T8a -> R10(a), INV-C
  it('saveTodos then loadTodos round-trips shape and order', async () => {
    const list = [
      { id: 'a', text: 'A', completed: false, dueDate: null },
      { id: 'b', text: 'B', completed: true, dueDate: null },
    ];
    // Single, non-coalesced save -> MAY assert its true return.
    const ok = await saveTodos(list);
    expect(ok).toBe(true);

    const back = await loadTodos();
    // Fixtures use unique-id, non-empty, boolean-completed lists so the load path's
    // sanitizeTodos is an identity and this is a clean deep-equal in order.
    expect(back).toEqual(list);
    for (const todo of back) {
      expect(typeof todo.id).toBe('string');
      expect(typeof todo.text).toBe('string');
      expect(typeof todo.completed).toBe('boolean');
    }
  });

  // T8c -> R10(c), INV-J (F2)
  it('rapid save(v1), save(v2) leaves the server holding v2', async () => {
    const v1 = [{ id: 'a', text: 'V1', completed: false }];
    const v2 = [{ id: 'a', text: 'V2', completed: true, dueDate: null }];

    // Fire back-to-back; await BOTH to settle. Under coalescing the second call may
    // return false while the drain loop still commits v2 — that false is CORRECT
    // behavior (F2), so we do NOT assert on the second call's boolean.
    const p1 = saveTodos(v1);
    const p2 = saveTodos(v2);
    await Promise.all([p1, p2]);

    // The BINDING assertion is the SERVER's final GET state == v2 (via the fixture's
    // real getTodos, not the wrapped storage path), per F2/R10(c).
    const got = await server.getTodos();
    expect(got.body).toEqual(v2);
  });
});

// T8b -> R10(b), INV-F — totality against a REAL dead socket (its own fixture so
// stopping the server does not disturb the round-trip suite above).
describe('storage seam vs DEAD server', () => {
  const dead = createServerFixture();
  let realFetch;
  let unhandled;

  beforeAll(async () => {
    await dead.start();
    realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      realFetch(
        typeof input === 'string' && input.startsWith('/')
          ? dead.baseUrl + input
          : input,
        init
      );
    // Any unhandled rejection while the seam runs against a dead socket is a defect.
    unhandled = null;
    process.on('unhandledRejection', captureUnhandled);
    // Kill the server so the seam hits a REAL refused connection (not a stub).
    await dead.stop();
  });

  afterAll(() => {
    process.removeListener('unhandledRejection', captureUnhandled);
    globalThis.fetch = realFetch;
  });

  function captureUnhandled(err) {
    unhandled = err;
  }

  it('loadTodos()===[] and saveTodos()===false against a dead server, no unhandled rejection', async () => {
    // storage.js is TOTAL: every failure maps to the fallback and NEVER rejects.
    expect(await loadTodos()).toEqual([]);
    expect(await saveTodos([{ id: 'a', text: 'A', completed: false }])).toBe(
      false
    );
    // Give any stray microtask/rejection a tick to surface.
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toBeNull();
  });
});
