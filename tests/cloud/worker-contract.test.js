// @vitest-environment node
//
// ISSUE-31 — cloud-runtime CONTRACT tests (D-TESTS / R-CLOUDTEST). Drives the REAL
// Worker/D1 adapter (worker/index.js over `wrangler dev` --local) and asserts the
// guard/persistence subset that could differ across runtimes: R3 (round-trip /
// order / boolean), R5 (atomic whole-list swap), R-GUARD-1 (413; NOT 411, F9),
// R-GUARD-2 (same-origin write guard derived from request.url, F7), R-GUARD-3
// (duplicate-id → 400 old-list-intact, driver-independent, F2), R-GUARD-4 (bounded
// list length, F6), and R-GUARD-5 (/api/* never returns the SPA shell, F5).
//
// This is the required cloud lane, invoked ONLY via `bun run test:cloud` =
// `vitest run --config vitest.cloud.config.js`. It is excluded from the default
// `bun run test` lane (which has no wrangler/workerd).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkerFixture } from './helpers/worker.js';

const BOOT_TIMEOUT_MS = 120_000;
const TEARDOWN_TIMEOUT_MS = 30_000;

describe('Worker/D1 cloud contract', () => {
  const worker = createWorkerFixture();

  beforeAll(async () => {
    await worker.start();
  }, BOOT_TIMEOUT_MS);
  afterAll(async () => {
    await worker.stop();
  }, TEARDOWN_TIMEOUT_MS);

  // R3 — round-trip / order / boolean parity in the Worker runtime.
  it('round-trips an ordered list with mixed completed (order + boolean)', async () => {
    const list = [
      { id: 'a', text: 'A', completed: false, dueDate: null },
      { id: 'b', text: 'B', completed: true, dueDate: null },
      { id: 'c', text: 'C', completed: false, dueDate: null },
    ];
    const put = await worker.putTodos(list);
    expect(put.status).toBe(200);

    const got = await worker.getTodos();
    expect(got.status).toBe(200);
    // Same items, same insertion order (position), not id/text sorted.
    expect(got.body).toEqual(list);
    // completed is a real JSON boolean (marshalled from the D1 INTEGER column).
    for (const todo of got.body) {
      expect(typeof todo.completed).toBe('boolean');
    }
    expect(got.body[0].completed).toBe(false);
    expect(got.body[1].completed).toBe(true);
  });

  // R1/R2 (D1 half) — a valid dueDate round-trips through the D1-backed Worker
  // unchanged, alongside an undated item (null) and a rejected malformed one.
  it('round-trips a dueDate through D1, keeps undated null, rejects a malformed date', async () => {
    const list = [
      { id: 'd1', text: 'dated', completed: false, dueDate: '2026-07-20' },
      { id: 'd2', text: 'undated', completed: false, dueDate: null },
    ];
    const put = await worker.putTodos(list);
    expect(put.status).toBe(200);

    const got = await worker.getTodos();
    expect(got.status).toBe(200);
    expect(got.body).toEqual(list);

    // A malformed date string is rejected 400, and the prior (valid) list survives
    // untouched — D1 must not silently coerce or persist it.
    const bad = await worker.putTodos([
      { id: 'd1', text: 'dated', completed: false, dueDate: 'banana' },
    ]);
    expect(bad.status).toBe(400);
    expect((await worker.getTodos()).body).toEqual(list);
  });

  // R5 — atomic whole-list swap in D1 (no residue from the first list).
  it('a second PUT fully replaces the first list (whole-list swap)', async () => {
    await worker.putTodos([
      { id: 'a', text: 'A', completed: false },
      { id: 'b', text: 'B', completed: false },
    ]);
    const put = await worker.putTodos([{ id: 'c', text: 'C', completed: true }]);
    expect(put.status).toBe(200);

    const got = await worker.getTodos();
    expect(got.body).toEqual([{ id: 'c', text: 'C', completed: true, dueDate: null }]);
  });

  // R-GUARD-3 — duplicate-id → 400, old list intact, driver-independently. The
  // shared pre-check rejects it BEFORE any D1 batch, so it never depends on D1's
  // constraint wording (F2).
  it('a duplicate-id PUT is 400 and leaves the OLD list intact', async () => {
    const seeded = [{ id: 's', text: 'S', completed: false, dueDate: null }];
    await worker.putTodos(seeded);

    const dup = await worker.putTodos([
      { id: 'd', text: 'D1', completed: false },
      { id: 'd', text: 'D2', completed: true },
    ]);
    expect(dup.status).toBe(400);

    // Not emptied, not partially written — the prior list survives.
    expect((await worker.getTodos()).body).toEqual(seeded);
  });

  // R-GUARD-4 — bounded list length (MAX_LIST_LEN = 1000) → 400, no DB write.
  // ISSUE-35: the product-level MAX_LIST_ITEMS = 10 cap now supersedes this legacy
  // 1000-item backstop for normal growth (R6), so any list this large is rejected
  // as "list full" well before the old 1000-item backstop could ever fire.
  it('a shape-valid list longer than MAX_LIST_LEN is 400, prior list intact', async () => {
    const seeded = [{ id: 's', text: 'S', completed: false, dueDate: null }];
    await worker.putTodos(seeded);

    const over = [];
    for (let i = 0; i < 1001; i++) {
      over.push({ id: `i${i}`, text: 't', completed: false });
    }
    const res = await worker.putTodos(over);
    expect(res.status).toBe(400);

    // Rejected before any DB call — prior list intact.
    expect((await worker.getTodos()).body).toEqual(seeded);

    // A list at the OLD bound (1000) is now rejected too — the ISSUE-35 10-item
    // cap (R6) fires first since 1000 both exceeds 10 and grows past the current
    // stored length, so it never reaches the legacy 1000-item backstop.
    const atBound = [];
    for (let i = 0; i < 1000; i++) {
      atBound.push({ id: `k${i}`, text: 't', completed: false });
    }
    const atBoundRes = await worker.putTodos(atBound);
    expect(atBoundRes.status).toBe(400);

    // Still rejected before any DB call — prior list intact.
    expect((await worker.getTodos()).body).toEqual(seeded);
  });

  // R-GUARD-1 — body cap (1 MB) in the Worker: over-cap → 413, not persisted; and
  // a legitimate length-declared write is NOT 411 (411 is dropped from the Worker
  // contract, F9).
  it('an over-1MB body is 413 and not persisted; a normal write is not 411', async () => {
    const seeded = [{ id: 's', text: 'S', completed: false, dueDate: null }];
    await worker.putTodos(seeded);

    const big = { id: 'big', text: 'x'.repeat(1_100_000), completed: false };
    const over = await worker.putTodos([big]);
    expect(over.status).toBe(413);
    // Not persisted: the prior list is intact.
    expect((await worker.getTodos()).body).toEqual(seeded);

    // A normal (length-declared by fetch) write succeeds — the Worker never 411s a
    // legitimate write.
    const normal = await worker.putTodos([{ id: 'ok', text: 'OK', completed: false }]);
    expect(normal.status).toBe(200);
  });

  // R-GUARD-2 — same-origin write guard derived from new URL(request.url).origin
  // (F7): foreign Origin → 403 (DB unmutated); same-origin (the app's own) → 2xx;
  // a missing Origin is tolerated (parity with Bun).
  it('foreign Origin → 403 (unmutated); same-origin and no-Origin → 2xx', async () => {
    const seeded = [{ id: 's', text: 'S', completed: false, dueDate: null }];
    await worker.putTodos(seeded);

    // (a) foreign Origin → 403, DB unchanged.
    const foreign = await worker.putTodos(
      [{ id: 'z', text: 'Z', completed: false }],
      { headers: { Origin: 'https://evil.example' } }
    );
    expect(foreign.status).toBe(403);
    expect((await worker.getTodos()).body).toEqual(seeded);

    // (b) same-origin (Origin === the live request origin) → 2xx. This is the F7
    //     falsifier: the guard must NOT self-block the app's own write.
    const mine = [{ id: 'm', text: 'M', completed: true, dueDate: null }];
    const sameOrigin = await worker.putTodos(mine, {
      headers: { Origin: worker.baseUrl },
    });
    expect(sameOrigin.status).toBe(200);
    expect((await worker.getTodos()).body).toEqual(mine);

    // (c) no Origin (a non-browser client) is tolerated.
    const noOrigin = [{ id: 'n', text: 'N', completed: false, dueDate: null }];
    const put = await worker.putTodos(noOrigin);
    expect(put.status).toBe(200);
    expect((await worker.getTodos()).body).toEqual(noOrigin);
  });

  // R-GUARD-5 — /api/* never returns the SPA shell: unknown/misrouted /api paths
  // and unsupported methods return a JSON error (404/405), never a 200 index.html
  // that loadTodos() would coerce to [] (F5).
  it('misrouted /api/* returns a JSON error, never 200 HTML', async () => {
    // (a) unknown /api route → 404 JSON.
    const nope = await fetch(`${worker.baseUrl}/api/nope`);
    expect(nope.status).toBe(404);
    expect(nope.headers.get('content-type')).toContain('application/json');
    const nopeBody = await nope.json();
    expect(nopeBody).toHaveProperty('error');

    // (b) unsupported method on /api/todos → 405 JSON.
    const post = await fetch(`${worker.baseUrl}/api/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    });
    expect(post.status).toBe(405);
    expect(post.headers.get('content-type')).toContain('application/json');

    // (c) a NON-/api unknown path DOES get the SPA shell (single-page-application
    //     fallback) — the contrast that proves /api is owned separately.
    const spa = await fetch(`${worker.baseUrl}/some/client/route`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get('content-type')).toContain('text/html');
  });
});
