// @vitest-environment node
//
// ISSUE-19 — body-cap + Origin/Host write-guard integration tests (T6, T7, plan §6).
// Drives the REAL spawned server over real HTTP. Cases that fetch/undici cannot
// express (forged/absent Host) use the fixture's raw node:net socket helper (§4.7).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServerFixture } from './helpers/server.js';

describe('body cap & write guard', () => {
  const server = createServerFixture();

  beforeAll(async () => {
    await server.start();
  });
  afterAll(async () => {
    await server.stop();
  });

  // T6 -> R8 (body-size cap).
  describe('T6 body-size cap', () => {
    it('a real over-1MB JSON body is rejected 413 and not persisted', async () => {
      const seeded = [{ id: 'seed', text: 'Seed', completed: false, dueDate: null }];
      await server.putTodos(seeded);

      // (a) ONE real >1 MB body. undici computes an ACCURATE Content-Length
      //     (> 1_048_576) from the real body and sends it, so the server rejects at
      //     the DECLARED-length branch (server:222) -> 413. We do NOT fabricate a
      //     mismatched Content-Length via fetch — undici rejects a length/body
      //     mismatch client-side and the request never reaches the server (F5).
      const bigTodo = { id: 'big', text: 'x'.repeat(1_100_000), completed: false };
      const over = await server.putTodos([bigTodo]);
      expect(over.status).toBe(413);

      // (c) not persisted: the prior seeded list is still intact.
      const got = await server.getTodos();
      expect(got.body).toEqual(seeded);
    });

    it('a PUT with no Content-Length is 411', async () => {
      // (b) 411 branch (server:217): a length-less PUT. undici forces a
      //     Content-Length on a string body, so we use the raw socket to send a
      //     deterministically length-less request (omitContentLength).
      const res = await server.rawRequest({
        method: 'PUT',
        path: '/api/todos',
        body: '[]',
        omitContentLength: true,
      });
      expect(res.statusCode).toBe(411);
    });

    // (d) The TRUE mid-stream cap (server:234, readCappedBody -> null) is OUT OF
    //     SCOPE for this suite, explicitly, per F5: it is unreachable via any real
    //     client request. A length-absent request hits 411 (server:217) before the
    //     body is read; a length-present request has its body reader stop at the
    //     declared length, so streamed extra bytes never reach the running cap;
    //     undici refuses to send a body that disagrees with Content-Length. R8's
    //     observable requirement (over-cap -> 413, not persisted) is fully proven by
    //     the real >1 MB body above; R8 does not require exercising every code path.
    //     (Empirically confirmed against Bun 1.3.11 while building this suite.)
  });

  // T7 -> R9 (Origin/Host write guard).
  describe('T7 Origin/Host write guard', () => {
    it('rejects foreign Origin (via fetch — capable)', async () => {
      // (a) baseline known state.
      const seeded = [{ id: 'seed', text: 'Seed', completed: false, dueDate: null }];
      await server.putTodos(seeded);

      // (b) a present Origin not in ALLOWED_ORIGINS -> 403 (server:149). A
      //     request-header Origin IS a passthrough, so fetch CAN produce this case.
      const foreign = await server.putTodos(
        [{ id: 'x', text: 'X', completed: false }],
        { headers: { Origin: 'https://evil.example' } }
      );
      expect(foreign.status).toBe(403);

      // DB unchanged by the rejected write.
      expect((await server.getTodos()).body).toEqual(seeded);
    });

    it('rejects forged and absent Host (via raw socket — fetch CANNOT do this)', async () => {
      // WHY the raw socket: undici silently OVERRIDES any user-set Host with the
      // real socket authority and ALWAYS sends one, so a forged/missing Host is
      // unproducible via fetch (F4). The raw node:net socket writes the HTTP/1.1
      // header bytes verbatim, so Host reaches the server exactly as we dictate.
      const seeded = [{ id: 'seed', text: 'Seed', completed: false, dueDate: null }];
      await server.putTodos(seeded);

      const bodyStr = '[{"id":"x","text":"X","completed":false}]';

      // (c1) non-loopback Host -> 403 (checkWriteGuard, server:142).
      const forged = await server.rawRequest({
        method: 'PUT',
        path: '/api/todos',
        headers: { Host: 'evil.example' },
        body: bodyStr,
      });
      expect(forged.statusCode).toBe(403);
      expect((await server.getTodos()).body).toEqual(seeded);

      // (c2) absent Host -> the write is BLOCKED (status >= 400) and not persisted.
      //      Per F9: Bun's HTTP/1.1 parser rejects a Host-less request at the
      //      PROTOCOL layer with 400 before checkWriteGuard's host===null branch
      //      (server:139) is ever reached — that branch is unreachable via any real
      //      request. R9's actual requirement (hostile write rejected) still holds,
      //      so we assert the blocked-write OUTCOME, not a specific status/line.
      const noHost = await server.rawRequest({
        method: 'PUT',
        path: '/api/todos',
        omitHost: true,
        body: bodyStr,
      });
      expect(noHost.statusCode).toBeGreaterThanOrEqual(400);
      expect((await server.getTodos()).body).toEqual(seeded);
    });

    it('does not self-block our own loopback write (no Origin)', async () => {
      // (d) a plain putTodos with NO Origin and undici's real loopback Host must
      //     SUCCEED — the guard is active but not self-blocking (server:147-151:
      //     a missing Origin is tolerated because the loopback Host already gated).
      const mine = [{ id: 'y', text: 'Y', completed: true, dueDate: null }];
      const put = await server.putTodos(mine);
      expect(put.status).toBe(200);
      expect((await server.getTodos()).body).toEqual(mine);
    });
  });
});
