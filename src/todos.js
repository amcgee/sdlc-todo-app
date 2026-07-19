// PURE functional core for TODO-1 (R1-R12).
//
// This module is native ESM with zero third-party dependencies and zero browser
// globals (no window/document/localStorage, no Math.random/Date.now, no id
// generation from nondeterministic sources). Every exported list operation returns
// a NEW value and never mutates its arguments (INV3). It is imported identically by
// Vite (App.jsx) and by Node's test runner.

/**
 * Normalize todo text: trim leading/trailing whitespace. Non-strings are coerced
 * via String(...) first. This is the single home of the trim-then-validate rule,
 * used by addTodo, editTodo, and sanitizeTodos (R3, F3).
 * @param {*} t
 * @returns {string}
 */
function normalizeText(t) {
  return String(t).trim();
}

/**
 * True when v is a non-empty string. Used for id validation (R2, R12).
 * @param {*} v
 * @returns {boolean}
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * R2/R3 — Append one todo, rejecting duplicate or invalid ids and empty text.
 * No-op (returns the input list unchanged) if `id` is not a non-empty string, is
 * already present in `list`, or the normalized text is empty (INV1, INV2, F1).
 * @param {Array} list
 * @param {string} text
 * @param {string} id  caller-supplied id (R10: never generated here)
 * @returns {Array}
 */
export function addTodo(list, text, id) {
  if (!isNonEmptyString(id)) return list;
  if (list.some((t) => t.id === id)) return list;
  const normalized = normalizeText(text);
  if (normalized === '') return list;
  return [...list, { id, text: normalized, completed: false }];
}

/**
 * R4 — Flip exactly one todo's `completed` flag. Non-matching id is a no-op.
 * @param {Array} list
 * @param {string} id
 * @returns {Array}
 */
export function toggleTodo(list, id) {
  return list.map((t) =>
    t.id === id ? { ...t, completed: !t.completed } : t
  );
}

/**
 * R5 — Replace one todo's text with the normalized new text. Empty-after-trim text
 * is rejected (target unchanged, F3); non-matching id is a no-op. `id` and
 * `completed` are preserved.
 * @param {Array} list
 * @param {string} id
 * @param {string} text
 * @returns {Array}
 */
export function editTodo(list, id, text) {
  const normalized = normalizeText(text);
  if (normalized === '') return list;
  return list.map((t) => (t.id === id ? { ...t, text: normalized } : t));
}

/**
 * R6 — Remove the todo whose `id` matches. Non-matching id returns the list
 * unchanged (a new array). Order preserved.
 * @param {Array} list
 * @param {string} id
 * @returns {Array}
 */
export function deleteTodo(list, id) {
  return list.filter((t) => t.id !== id);
}

/**
 * R7 — Remove all completed todos, keeping active ones in order.
 * @param {Array} list
 * @returns {Array}
 */
export function clearCompleted(list) {
  return list.filter((t) => !t.completed);
}

/**
 * Non-destructive restore merge for Undo. Re-inserts each removed entry into `list`
 * at a best-effort position, but ONLY if its id is genuinely absent: an entry whose
 * id is already present in the running result is skipped (never overwritten or
 * duplicated), so a concurrent same-id recreation/edit is preserved. The captured
 * `item` is re-inserted verbatim (text and completed preserved; not re-normalized).
 *
 * Position per entry: immediately after `prevId` if that id is present, at the front
 * if `prevId` is null, else appended. Entries are processed in order, so a batch
 * whose earlier members were themselves removed find their re-inserted predecessor,
 * preserving the original clustering/order.
 * @param {Array} list  the current (freshly-refetched) list to merge into
 * @param {Array<{item: {id: string, text: string, completed: boolean}, prevId: string|null}>} entries
 * @returns {Array} a NEW array (input list never mutated)
 */
export function restoreTodos(list, entries) {
  const result = [...list];
  for (const { item, prevId } of entries) {
    if (result.some((t) => t.id === item.id)) continue; // present -> leave as-is
    let idx;
    if (prevId == null) {
      idx = 0; // was first -> front
    } else {
      const found = result.findIndex((t) => t.id === prevId);
      idx = found === -1 ? result.length : found + 1; // after prev, or append
    }
    result.splice(idx, 0, item);
  }
  return result;
}

/**
 * R8 — Select todos by status. "active" -> not completed; "completed" -> completed;
 * any other value (including "all") -> all (defensive default). Order preserved.
 * @param {Array} list
 * @param {string} filter
 * @returns {Array}
 */
export function filterTodos(list, filter) {
  if (filter === 'active') return list.filter((t) => !t.completed);
  if (filter === 'completed') return list.filter((t) => t.completed);
  return list.filter(() => true);
}

/**
 * R9 — Count active (not completed) todos.
 * @param {Array} list
 * @returns {number}
 */
export function remainingCount(list) {
  return list.filter((t) => !t.completed).length;
}

/**
 * A due date is a calendar day encoded as a `"YYYY-MM-DD"` string, or `null` for
 * "no date". True iff `value` is a string that matches the ISO day pattern AND is a
 * real calendar day (round-trips through `Date.UTC`, so `2026-02-30`/`2026-13-01`
 * are rejected). The `typeof` guard is load-bearing: without it a `String()`-
 * coercible non-string (e.g. `['2026-07-20']`) would pass the regex. This predicate
 * is the single home of the "valid date" rule — the client sanitize path and the
 * server shape gate both import it, so they cannot diverge.
 * @param {*} value
 * @returns {boolean}
 */
export function isValidDueDate(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * Set (or clear) one todo's due date. A valid `dueDate` is stored; `null` or any
 * non-valid value is coerced to `null` (clears the date). Non-matching id is a
 * no-op. Returns a new list; never mutates its input.
 * @param {Array} list
 * @param {string} id
 * @param {*} dueDate  a `"YYYY-MM-DD"` string, `null`, or anything (coerced to null)
 * @returns {Array}
 */
export function setDueDate(list, id, dueDate) {
  const value = isValidDueDate(dueDate) ? dueDate : null;
  return list.map((t) => (t.id === id ? { ...t, dueDate: value } : t));
}

/**
 * A todo is overdue iff it has a due date, is not completed, and that date is
 * strictly before `today` (an item due today is not overdue). `today` is the local
 * calendar day, threaded in from the UI so the core reads no clock. ISO day strings
 * compare lexically = chronologically, so this is a plain string comparison.
 * @param {{dueDate: (string|null), completed: boolean}} todo
 * @param {string} today  the local calendar day as `"YYYY-MM-DD"`
 * @returns {boolean}
 */
export function isOverdue(todo, today) {
  return todo.dueDate != null && !todo.completed && todo.dueDate < today;
}

/**
 * Order a list soonest-due-first: dated items ascending by `dueDate` (so overdue
 * items surface first), then undated items last. Relative order is preserved among
 * undated items (via the partition) and among equal dates (via stable sort). Returns
 * a new array; never mutates its input.
 * @param {Array} list
 * @returns {Array}
 */
export function sortByDueDate(list) {
  const dated = [];
  const undated = [];
  for (const t of list) {
    if (t.dueDate != null) dated.push(t);
    else undated.push(t);
  }
  dated.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
  return [...dated, ...undated];
}

/**
 * A short, human-readable label for a due date relative to `today` (both
 * `"YYYY-MM-DD"`), or `null` when `dueDate` is `null`. Bucketed by the whole-day
 * difference, computed via `Date.UTC` day arithmetic — no local `Date` parsing, no
 * clock read (both dates are threaded in). The past-tense buckets ("yesterday" / "N
 * days ago") are the label's own non-color-alone signal when a row is also overdue.
 * @param {(string|null)} dueDate  a `"YYYY-MM-DD"` string, or `null`
 * @param {string} today  the local calendar day as `"YYYY-MM-DD"`
 * @returns {(string|null)}
 */
export function dueDateLabel(dueDate, today) {
  if (dueDate == null) return null;
  const toUTCDays = (value) => {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    return Date.UTC(year, month - 1, day) / 86400000;
  };
  const diff = toUTCDays(dueDate) - toUTCDays(today);
  if (diff === 0) return 'due today';
  if (diff === 1) return 'due tomorrow';
  if (diff > 1) return `in ${diff} days`;
  if (diff === -1) return 'yesterday';
  return `${-diff} days ago`;
}

/**
 * R12 — Tolerant load. Takes an arbitrary parsed value and returns a valid Todo
 * list, applying the exact ordered pipeline:
 *   1. Drop non-objects (non-null object required).
 *   2. Validate id (non-empty string, never coerced/generated).
 *   3. Normalize then validate text (trim-then-validate; drop if empty).
 *   4. Coerce completed (=== true ? true : false; never dropped on completed).
 *   5. Coerce dueDate: a valid date is kept, missing/null/malformed degrades to
 *      null — a bad date never drops the item.
 *   6. De-duplicate id (keep first occurrence).
 * Non-array input -> []. Never throws.
 * @param {*} raw
 * @returns {Array}
 */
export function sanitizeTodos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const element of raw) {
    // 1. Drop non-objects (null, arrays, primitives).
    if (typeof element !== 'object' || element === null || Array.isArray(element)) {
      continue;
    }
    // 2. Validate id.
    if (!isNonEmptyString(element.id)) continue;
    // 3. Normalize then validate text (trim-then-validate, F3).
    const text = normalizeText(element.text);
    if (text === '') continue;
    // 4. Coerce completed — never validated, never dropped (F2).
    const completed = element.completed === true;
    // 5. Coerce dueDate — a bad/missing date degrades to null, never drops the item.
    const dueDate = isValidDueDate(element.dueDate) ? element.dueDate : null;
    // 6. De-duplicate id — keep first.
    if (seen.has(element.id)) continue;
    seen.add(element.id);
    out.push({ id: element.id, text, completed, dueDate });
  }
  return out;
}

/**
 * F6 / INV4 — Pure crash-recovery parse path. Takes the raw string (or null) read
 * from storage; returns a valid Todo list. `null`/non-array/bad-JSON -> []. NEVER
 * throws. This keeps the INV4 recovery logic out of the impure storage adapter so
 * it is unit-testable under node:test.
 * @param {string|null} raw
 * @returns {Array}
 */
export function parseStored(raw) {
  if (raw == null) return [];
  try {
    return sanitizeTodos(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * F9 / INV6 — Pure best-effort save. Calls the injected writer with the serialized
 * list; swallows any throw (quota/private mode) and returns false. Returns true on
 * success. NEVER throws. The throwing-writer case is unit-testable without
 * localStorage.
 * @param {(serialized: string) => void} writer
 * @param {Array} list
 * @returns {boolean}
 */
export function safeSave(writer, list) {
  try {
    writer(JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * F7 / INV2 — Collision-resistant string id, PURE given (seq, rand). Combines a
 * monotonically-increasing per-session counter with a random suffix so
 * same-millisecond and across-reload collisions are vanishingly unlikely.
 *
 * Purity note (R10): the clock/randomness are NOT read inside the core. The caller
 * (App.jsx) threads in the counter `seq` and a fresh random suffix `rand` (e.g. from
 * crypto.getRandomValues); `makeId` only formats them. This keeps the function
 * deterministic in (seq, rand) — two calls with the same arguments produce the same
 * id — so its format and uniqueness are unit-testable without nondeterminism.
 * @param {number} seq   monotonically-increasing per-session counter
 * @param {string} rand  short random suffix
 * @returns {string}
 */
export function makeId(seq, rand) {
  return `id-${seq.toString(36)}-${rand}`;
}
