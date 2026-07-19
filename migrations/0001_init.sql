-- ISSUE-31 — D1 schema migration (D-IAC / D-STORE).
--
-- A verbatim port of the bun:sqlite schema (originally server/index.js). D1 IS
-- SQLite, so the CHECK constraints, PRIMARY KEY, position-ordered reads, and the
-- constraint-rollback contract survive unchanged. Applied idempotently via
--   wrangler d1 migrations apply DB --remote   (CI/deploy — never --local, F4)
--   wrangler d1 migrations apply DB --local     (local dev only)
-- The DB shape is code, not console clicks (R-IAC).

CREATE TABLE IF NOT EXISTS todos (
  id        TEXT    PRIMARY KEY,
  text      TEXT    NOT NULL CHECK (length(text) > 0),
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  position  INTEGER NOT NULL
);
