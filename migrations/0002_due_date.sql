-- ISSUE-40 — add the optional due date to the D1 schema (D-IAC / D-STORE).
--
-- A nullable "YYYY-MM-DD" day carried additively through the shared whole-list
-- contract. Validity is enforced by the runtime-agnostic handler (isValidDueDate),
-- so no CHECK here — both runtimes apply the one rule identically. Mirrors the
-- boot-time ADD COLUMN the Bun adapter runs against an existing DB. Applied via
--   wrangler d1 migrations apply DB --remote   (CI/deploy — never --local, F4)
--   wrangler d1 migrations apply DB --local     (local dev only)

ALTER TABLE todos ADD COLUMN due_date TEXT;
