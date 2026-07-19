// @vitest-environment node
//
// ISSUE-19 — self-containment / isolation assertions (T9 -> R11, plan §6). Most of
// R11 is STRUCTURAL (satisfied by the fixture design in helpers/server.js: the
// EADDRINUSE-retry loop, the our-own-stdout-marker readiness gate, the SIGTERM->
// SIGKILL reap + the process.exit rmSync crash-net); the assertions this file makes
// executable are R11(a) (temp DB under os.tmpdir, never data/todos.sqlite) and the
// post-teardown removal of the temp dir (INV-B, no stray temp DB).

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServerFixture } from './helpers/server.js';

describe('suite self-containment (R11 / INV-B)', () => {
  const server = createServerFixture();
  // Capture the paths before teardown so the post-stop assertion can check removal.
  let capturedDbDir;
  let capturedDbPath;

  beforeAll(async () => {
    await server.start();
    capturedDbDir = server.dbDir;
    capturedDbPath = server.dbPath;
  });
  afterAll(async () => {
    await server.stop();
  });

  // R11(a) / INV-B: the throwaway DB lives under os.tmpdir() and is NEVER the repo
  // data/todos.sqlite.
  it('uses a temp DB under os.tmpdir, never data/todos.sqlite', () => {
    expect(server.dbPath.startsWith(tmpdir())).toBe(true);

    const repoDataDb = fileURLToPath(
      new URL('../../data/todos.sqlite', import.meta.url)
    );
    expect(server.dbPath).not.toBe(repoDataDb);
    // The temp dir exists while the server is live.
    expect(existsSync(server.dbDir)).toBe(true);
  });

  // R11 / INV-B: after teardown the whole temp dir (db + -wal + -shm) is gone — no
  // stray temp DB leaks. Asserted in a dedicated fixture stopped inside the test so
  // we can observe the post-stop state deterministically.
  it('removes the temp DB directory on teardown (no stray temp DB)', async () => {
    const ephemeral = createServerFixture();
    await ephemeral.start();
    const dir = ephemeral.dbDir;
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(ephemeral.dbPath)).toBe(true);
    await ephemeral.stop();
    // db + -wal + -shm all removed with the directory (INV-B).
    expect(existsSync(dir)).toBe(false);
  });

  // Reference the captured paths so the linter/reader sees they are the same ones
  // the fixture teardown will remove (documentation of the INV-B contract).
  it('temp paths are stable and consistent for teardown', () => {
    expect(capturedDbDir).toBe(server.dbDir);
    expect(capturedDbPath).toBe(server.dbPath);
    expect(capturedDbPath.startsWith(capturedDbDir)).toBe(true);
  });
});
