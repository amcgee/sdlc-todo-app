// @vitest-environment node
//
// ISSUE-19 — server-contract integration tests (T1–T5, plan §6). Drives the REAL
// spawned server/index.js over real HTTP against a throwaway SQLite DB. Nothing is
// mocked below the test: real Bun.serve handler, real bun:sqlite, real file.
//
// One server per file (spawned in beforeAll, reaped in afterAll); tests reset DB
// state via PUT so they are order-independent within the file (plan §3). The lone
// exception is T2 (fresh empty DB), which spawns its OWN short-lived fixture in a
// nested describe so no prior PUT can contaminate it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServerFixture } from './helpers/server.js';

describe('server contract', () => {
  const server = createServerFixture();

  beforeAll(async () => {
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });

  // T1 -> R1, R2, R3
  it('round-trips a known ordered list with mixed completed', async () => {
    const list = [
      { id: 'a', text: 'A', completed: false, dueDate: null },
      { id: 'b', text: 'B', completed: true, dueDate: null },
      { id: 'c', text: 'C', completed: false, dueDate: null },
    ];
    const put = await server.putTodos(list);
    expect(put.status).toBe(200);

    const got = await server.getTodos();
    expect(got.status).toBe(200);
    // R1 + R2: same items, same insertion order (not id/text sorted).
    expect(got.body).toEqual(list);
    // R3: completed is a real JSON boolean (not 0/1, not "true"/"false").
    for (const todo of got.body) {
      expect(typeof todo.completed).toBe('boolean');
    }
    expect(got.body[0].completed).toBe(false);
    expect(got.body[1].completed).toBe(true);
    expect(got.body[2].completed).toBe(false);
  });

  // T3 -> R5
  it('a second PUT fully replaces the first list', async () => {
    await server.putTodos([
      { id: 'a', text: 'A', completed: false },
      { id: 'b', text: 'B', completed: false },
    ]);
    const put = await server.putTodos([{ id: 'c', text: 'C', completed: true }]);
    expect(put.status).toBe(200);

    const got = await server.getTodos();
    // Whole-list swap: no leftover a/b rows.
    expect(got.body).toEqual([{ id: 'c', text: 'C', completed: true, dueDate: null }]);
  });

  // T4a -> R6a — SHAPE-REJECTION at validation, NOT rollback (F1).
  it('empty-id and empty-text PUTs are refused at validation, DB untouched', async () => {
    const seeded = [{ id: 'seed', text: 'Seed', completed: false, dueDate: null }];
    await server.putTodos(seeded);

    // empty-string id: fails isConformingList (server:95) BEFORE replaceAll runs —
    // no DELETE occurs, so the DB is untouched by CONSTRUCTION, not by rollback (F1).
    const emptyId = await server.putTodos([
      { id: '', text: 'x', completed: false },
    ]);
    expect(emptyId.status).toBe(400);
    expect((await server.getTodos()).body).toEqual(seeded);

    // empty-string text: fails isConformingList (server:96), same shape-rejection.
    const emptyText = await server.putTodos([
      { id: 'x', text: '', completed: false },
    ]);
    expect(emptyText.status).toBe(400);
    expect((await server.getTodos()).body).toEqual(seeded);

    // Server still responsive after the rejections.
    const alive = await server.getTodos();
    expect(alive.status).toBe(200);
  });

  // T4b -> R6b — the ONLY test that enters replaceAll's DELETE-then-rollback path (F1).
  it('a duplicate-id PUT rolls back, leaving the OLD list intact', async () => {
    const seeded = [{ id: 'a', text: 'A', completed: false, dueDate: null }];
    await server.putTodos(seeded);

    // Shape-valid (each element has non-empty id/text + boolean completed), so it
    // PASSES isConformingList and REACHES replaceAll: the DELETE runs, then the
    // duplicate 'd' trips the id PRIMARY KEY on the second INSERT, bun:sqlite throws
    // "constraint", the transaction auto-rolls-back the DELETE, handler returns 400
    // (server:250-256). INV-K.
    const dup = await server.putTodos([
      { id: 'd', text: 'D1', completed: false },
      { id: 'd', text: 'D2', completed: true },
    ]);
    expect(dup.status).toBe(400);

    // The rollback restored the original list (not emptied, not partially written).
    expect((await server.getTodos()).body).toEqual(seeded);
    expect((await server.getTodos()).status).toBe(200);
  });

  // T5 -> R7
  it('malformed / wrong-shape / wrong-method are rejected cleanly', async () => {
    const seeded = [{ id: 's', text: 'S', completed: false, dueDate: null }];
    await server.putTodos(seeded);

    // (a) non-JSON body -> 400 (JSON.parse failure, server:242).
    const notJson = await server.rawPut('not json', {
      'Content-Type': 'application/json',
    });
    expect(notJson.status).toBe(400);

    // (b) JSON that is not an array -> 400 (isConformingList false, server:245).
    const notArray = await server.putTodos({ not: 'an array' });
    expect(notArray.status).toBe(400);

    // (c) non-boolean completed -> 400 (isConformingList line 97).
    const badBool = await server.putTodos([
      { id: 'a', text: 'A', completed: 'yes' },
    ]);
    expect(badBool.status).toBe(400);

    // (d) unsupported methods on /api/todos -> 405 (server:265).
    const del = await fetch(`${server.baseUrl}/api/todos`, { method: 'DELETE' });
    expect(del.status).toBe(405);
    const post = await fetch(`${server.baseUrl}/api/todos`, { method: 'POST' });
    expect(post.status).toBe(405);

    // DB unmutated and process alive after every rejection.
    const got = await server.getTodos();
    expect(got.status).toBe(200);
    expect(got.body).toEqual(seeded);
  });
});

// T2 -> R4 — a genuinely fresh empty DB. Its OWN fixture (a second short-lived
// server on its own temp DB) so no PUT from the suite above can contaminate it,
// regardless of file/test execution order.
describe('server contract — fresh empty DB', () => {
  const fresh = createServerFixture();

  beforeAll(async () => {
    await fresh.start();
  });
  afterAll(async () => {
    await fresh.stop();
  });

  it('a fresh empty DB returns 200 []', async () => {
    const got = await fresh.getTodos();
    expect(got.status).toBe(200);
    expect(got.body).toEqual([]);
  });
});
