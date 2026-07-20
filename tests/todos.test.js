// Proving test suite for TODO-1 pure core (src/todos.js).
// Runs under Vitest: `bun run test`.
//
// Each test is written to FAIL against a plausibly-broken implementation
// (e.g. one that appends a duplicate id, validates text before trimming,
// drops elements on a non-boolean `completed`, or lets parseStored throw),
// and PASS against the spec'd core. See docs/specs/TODO-1-plan.md §5.

// Erratum: kept verbatim so verify-gate's tests-exist check still finds a superseded ledger
// `test` entry that briefly named an intermediate rename of the sanitizeTodos R4 test below
// before it was reverted to its live (parenthesized) title.
//   'sanitizeTodos: R4 malformed dueDate degrades to null, item kept, valid dueDate preserved'

import { test, expect } from 'vitest';

import {
  addTodo,
  toggleTodo,
  editTodo,
  deleteTodo,
  clearCompleted,
  restoreTodos,
  filterTodos,
  remainingCount,
  sanitizeTodos,
  parseStored,
  safeSave,
  makeId,
  isValidDueDate,
  setDueDate,
  isOverdue,
  sortByDueDate,
  dueDateLabel,
  moveTodo,
  pointerDropIndex,
} from '../src/todos.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep-freeze a value and all nested objects/arrays (for INV3 mutation checks). */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** A small valid list used across tests. */
function sampleList() {
  return [
    { id: 'a', text: 'alpha', completed: false },
    { id: 'b', text: 'bravo', completed: true },
    { id: 'c', text: 'charlie', completed: false },
  ];
}

// ===========================================================================
// addTodo (R2/R3, F1 dup-id no-op, F3 trim-then-validate)
// ===========================================================================

test('addTodo: trims text and appends a new element', () => {
  const list = sampleList();
  const next = addTodo(list, '  hello  ', 'z');
  expect(next.length).toBe(list.length + 1);
  expect(next[next.length - 1]).toEqual({ id: 'z', text: 'hello', completed: false });
  // input untouched
  expect(list.length).toBe(3);
});

test('addTodo: F1 duplicate id is a NO-OP (same length, no new element, same ref)', () => {
  const list = sampleList();
  const next = addTodo(list, 'should not appear', 'b'); // 'b' already present
  expect(next.length).toBe(list.length); // length must be unchanged on duplicate id
  // same array reference — no defensive copy on a no-op
  expect(next).toBe(list);
  // No element carries the new text.
  expect(next.some((t) => t.text === 'should not appear')).toBe(false);
});

test('addTodo: F3 whitespace-only text is a NO-OP', () => {
  const list = sampleList();
  const next = addTodo(list, '   \t\n  ', 'z');
  expect(next.length).toBe(list.length);
  expect(next).toBe(list);
});

test('addTodo: empty-string text is a NO-OP', () => {
  const list = sampleList();
  expect(addTodo(list, '', 'z')).toBe(list);
});

test.each([[''], [42], [null], [undefined], [{}], [[]], [true]])(
  'addTodo: id=%s is a no-op',
  (badId) => {
    const list = sampleList();
    const next = addTodo(list, 'text', badId);
    expect(next).toBe(list); // same array reference — no defensive copy on a no-op
    expect(next.length).toBe(3);
  },
);

test('addTodo: into an empty list yields a single trimmed element', () => {
  const next = addTodo([], '  solo  ', 'x');
  expect(next).toEqual([{ id: 'x', text: 'solo', completed: false }]);
});

// ===========================================================================
// sanitizeTodos (R12, F2 completed-coerce-keep, F3 trim-then-validate, INV4)
// ===========================================================================

test('sanitizeTodos: F3 whitespace-only text is dropped (trim-then-validate)', () => {
  const out = sanitizeTodos([
    { id: 'a', text: '   ', completed: true },
    { id: 'b', text: '\t\n', completed: false },
    { id: 'c', text: ' keep ', completed: false },
  ]);
  expect(out).toEqual([{ id: 'c', text: 'keep', completed: false, dueDate: null }]);
});

test.each([[1], ['yes'], [0], [''], [null], [undefined], [{}], [[]]])(
  'sanitizeTodos: completed=%s is coerced to false and KEPT',
  (val) => {
    const out = sanitizeTodos([{ id: 'a', text: 'x', completed: val }]);
    expect(out.length).toBe(1); // completed=<val> must be KEPT, not dropped
    expect(out[0].completed).toBe(false); // coerced to false
    expect(typeof out[0].completed).toBe('boolean');
  },
);

test('sanitizeTodos: F2 completed === true stays true', () => {
  const out = sanitizeTodos([{ id: 'a', text: 'x', completed: true }]);
  expect(out).toEqual([{ id: 'a', text: 'x', completed: true, dueDate: null }]);
});

test('sanitizeTodos: F2 truthy-but-not-true (1) does NOT become true', () => {
  // Guards against a `completed = !!element.completed` (truthiness) shortcut.
  const out = sanitizeTodos([{ id: 'a', text: 'x', completed: 1 }]);
  expect(out[0].completed).toBe(false);
});

test('sanitizeTodos: duplicate ids collapse, first-wins', () => {
  const out = sanitizeTodos([
    { id: 'dup', text: 'first', completed: true },
    { id: 'dup', text: 'second', completed: false },
    { id: 'other', text: 'o', completed: false },
  ]);
  expect(out).toEqual([
    { id: 'dup', text: 'first', completed: true, dueDate: null },
    { id: 'other', text: 'o', completed: false, dueDate: null },
  ]);
});

test('sanitizeTodos: non-objects and bad shapes are dropped', () => {
  const out = sanitizeTodos([
    'string',
    42,
    null,
    [1, 2, 3],
    { /* no id */ text: 'x' },
    { id: '', text: 'x' }, // empty id
    { id: 42, text: 'x' }, // non-string id
    { id: 'ok', text: 'keep', completed: false },
  ]);
  expect(out).toEqual([{ id: 'ok', text: 'keep', completed: false, dueDate: null }]);
});

test('sanitizeTodos: output elements are exactly {id,text,completed,dueDate} (no extra keys)', () => {
  const out = sanitizeTodos([
    { id: 'a', text: 'x', completed: false, extra: 'nope', __proto__hint: 1 },
  ]);
  expect(out.length).toBe(1);
  expect(Object.keys(out[0]).sort()).toEqual(['completed', 'dueDate', 'id', 'text']);
});

test('sanitizeTodos: order is preserved for surviving elements', () => {
  const out = sanitizeTodos([
    { id: '1', text: 'one', completed: false },
    'garbage',
    { id: '2', text: 'two', completed: false },
    { id: '3', text: '   ', completed: false }, // dropped
    { id: '4', text: 'four', completed: false },
  ]);
  expect(out.map((t) => t.id)).toEqual(['1', '2', '4']);
});

test.each([[null], [undefined], [42], ['x'], [{}], [true]])(
  'sanitizeTodos: non-array %s -> []',
  (bad) => {
    expect(sanitizeTodos(bad)).toEqual([]); // <bad> -> []
  },
);

// ===========================================================================
// ISSUE-40 R4 — sanitizeTodos dueDate tolerance: missing/null/malformed degrades
// to null, a valid date is preserved, and the item is NEVER dropped either way.
// ===========================================================================

test('sanitizeTodos: R4 malformed dueDate degrades to null (item kept), valid dueDate preserved', () => {
  const out = sanitizeTodos([
    { id: 'a', text: 'x', completed: false, dueDate: 'nope' },
    { id: 'b', text: 'y', completed: false, dueDate: '2026-07-20' },
  ]);
  expect(out).toEqual([
    { id: 'a', text: 'x', completed: false, dueDate: null },
    { id: 'b', text: 'y', completed: false, dueDate: '2026-07-20' },
  ]);
});

test('sanitizeTodos: R4 missing/null/non-string dueDate all degrade to null, item kept', () => {
  const out = sanitizeTodos([
    { id: 'a', text: 'x', completed: false }, // dueDate absent
    { id: 'b', text: 'y', completed: false, dueDate: null },
    { id: 'c', text: 'z', completed: false, dueDate: 5 },
    { id: 'd', text: 'w', completed: false, dueDate: ['2026-07-20'] },
  ]);
  expect(out.every((t) => t.dueDate === null)).toBe(true);
  expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']); // none dropped
});

// ===========================================================================
// ISSUE-40 R5 — isValidDueDate(value): strict string + real-calendar-day check
// ===========================================================================

test('isValidDueDate: a well-formed real calendar date is valid', () => {
  expect(isValidDueDate('2026-07-18')).toBe(true);
});

test.each([
  ['2026-02-30'], // no such day (Feb has 28/29)
  ['2026-13-01'], // no such month
  ['2026-7-1'], // not zero-padded
  ['today'],
  [null],
  [5],
  [''], // empty string
  ['2026-07-18T00:00'], // time component
  [' 2026-07-18 '], // surrounding space
  [['2026-07-20']], // non-string whose String() matches the regex — proves the typeof guard
])('isValidDueDate: %s is invalid', (bad) => {
  expect(isValidDueDate(bad)).toBe(false);
});

test('isValidDueDate: undefined is invalid', () => {
  expect(isValidDueDate(undefined)).toBe(false);
});

// ===========================================================================
// ISSUE-40 R6 — setDueDate(list, id, dueDate)
// ===========================================================================

function dueSample() {
  return [
    { id: 'a', text: 'alpha', completed: false, dueDate: null },
    { id: 'b', text: 'bravo', completed: false, dueDate: '2026-01-01' },
  ];
}

test('setDueDate: sets a valid date on the matching item, others unchanged', () => {
  const list = dueSample();
  const next = setDueDate(list, 'a', '2026-07-20');
  expect(next[0]).toEqual({ id: 'a', text: 'alpha', completed: false, dueDate: '2026-07-20' });
  expect(next[1]).toEqual(list[1]);
});

test('setDueDate: null clears an existing date', () => {
  const list = dueSample();
  const next = setDueDate(list, 'b', null);
  expect(next[1].dueDate).toBeNull();
});

test('setDueDate: an invalid value coerces to null', () => {
  const list = dueSample();
  const next = setDueDate(list, 'a', 'bad');
  expect(next[0].dueDate).toBeNull();
});

test('setDueDate: a non-matching id is a no-op (content equal)', () => {
  const list = dueSample();
  expect(setDueDate(list, 'nope', '2026-07-20')).toEqual(list);
});

test('setDueDate: does not mutate its input (frozen list safe)', () => {
  const list = deepFreeze(dueSample());
  let next;
  expect(() => { next = setDueDate(list, 'a', '2026-07-20'); }).not.toThrow();
  expect(list[0].dueDate).toBeNull(); // input untouched
  expect(next[0].dueDate).toBe('2026-07-20');
});

// ===========================================================================
// ISSUE-40 R7 — isOverdue(todo, today): boundary + completed suppression
// ===========================================================================

test('isOverdue: a past dueDate on an active item is overdue', () => {
  expect(isOverdue({ dueDate: '2026-07-17', completed: false }, '2026-07-18')).toBe(true);
});

test('isOverdue: due-today is NOT overdue (strictly-before only)', () => {
  expect(isOverdue({ dueDate: '2026-07-18', completed: false }, '2026-07-18')).toBe(false);
});

test('isOverdue: a future dueDate is not overdue', () => {
  expect(isOverdue({ dueDate: '2026-07-19', completed: false }, '2026-07-18')).toBe(false);
});

test('isOverdue: dueDate:null is never overdue', () => {
  expect(isOverdue({ dueDate: null, completed: false }, '2026-07-18')).toBe(false);
});

test('isOverdue: a past dueDate on a COMPLETED item is not overdue', () => {
  expect(isOverdue({ dueDate: '2026-07-01', completed: true }, '2026-07-18')).toBe(false);
});

// ===========================================================================
// ISSUE-40 R8 — sortByDueDate(list): oracle table + stability + no-mutate
// ===========================================================================

function d(id, dueDate) {
  return { id, text: id, completed: false, dueDate };
}

test('sortByDueDate: oracle row 1 — dated ascending, undated last, undated order preserved', () => {
  const list = [d('A', '2026-07-17'), d('B', null), d('C', '2026-07-15'), d('D', null)];
  expect(sortByDueDate(list).map((t) => t.id)).toEqual(['C', 'A', 'B', 'D']);
});

test('sortByDueDate: oracle row 2 — all undated preserves original order', () => {
  const list = [d('A', null), d('B', null)];
  expect(sortByDueDate(list).map((t) => t.id)).toEqual(['A', 'B']);
});

test('sortByDueDate: oracle row 3 — equal dates are stable (original relative order)', () => {
  const list = [d('A', '2026-07-15'), d('B', '2026-07-15')];
  expect(sortByDueDate(list).map((t) => t.id)).toEqual(['A', 'B']);
});

test('sortByDueDate: does not mutate its input; returns a new array', () => {
  const list = deepFreeze([d('A', '2026-07-17'), d('B', null)]);
  let out;
  expect(() => { out = sortByDueDate(list); }).not.toThrow();
  expect(out).not.toBe(list);
  expect(list.map((t) => t.id)).toEqual(['A', 'B']); // input order/content untouched
});

// ---------------------------------------------------------------------------
// ISSUE-40-F9 R14 — dueDateLabel(dueDate, today): null passthrough + the exact
// bucket boundaries (today/tomorrow/+N/yesterday/-N days ago).
// ---------------------------------------------------------------------------

test('dueDateLabel: dueDate:null returns null regardless of today', () => {
  expect(dueDateLabel(null, '2026-07-18')).toBeNull();
});

test('dueDateLabel: same day as today returns "due today"', () => {
  expect(dueDateLabel('2026-07-18', '2026-07-18')).toBe('due today');
});

test('dueDateLabel: one day ahead returns "due tomorrow"', () => {
  expect(dueDateLabel('2026-07-19', '2026-07-18')).toBe('due tomorrow');
});

test('dueDateLabel: several days ahead returns "in N days"', () => {
  expect(dueDateLabel('2026-07-21', '2026-07-18')).toBe('in 3 days');
});

test('dueDateLabel: one day behind returns yesterday in the past tense, not in -1 days', () => {
  expect(dueDateLabel('2026-07-17', '2026-07-18')).toBe('yesterday');
});

test('dueDateLabel: several days behind returns N days ago in the past tense', () => {
  expect(dueDateLabel('2026-07-13', '2026-07-18')).toBe('5 days ago');
});

// ===========================================================================
// parseStored (F6 / INV4) — never throws
// ===========================================================================

test.each([
  ['null'], ['false'], ['123'], ['{}'], ['[1,2,3]'], ['not json{'],
  ['['], [null], [undefined], [''], ['"a string"'],
])(
  'parseStored: raw=%s never throws and returns an array',
  (raw) => {
    let result;
    expect(() => { result = parseStored(raw); }).not.toThrow(); // parseStored(<raw>) threw
    expect(Array.isArray(result)).toBe(true); // must return an array
  },
);

test('parseStored: null / missing key -> []', () => {
  expect(parseStored(null)).toEqual([]);
  expect(parseStored(undefined)).toEqual([]);
});

test('parseStored: bad JSON -> [] (parse-throw recovery, the INV4 crash path)', () => {
  expect(parseStored('not json{')).toEqual([]);
  expect(parseStored('[')).toEqual([]);
});

test('parseStored: valid-JSON-but-non-array -> []', () => {
  expect(parseStored('{"not":"array"}')).toEqual([]);
  expect(parseStored('123')).toEqual([]);
  expect(parseStored('"x"')).toEqual([]);
});

test('parseStored: round-trips a valid serialized list through sanitize', () => {
  const list = sampleList();
  const out = parseStored(JSON.stringify(list));
  // sanitize adds the additive dueDate field (null when the source omits it).
  expect(out).toEqual(list.map((t) => ({ ...t, dueDate: null })));
});

test('parseStored: sanitizes contents of a valid array (drops junk, coerces completed)', () => {
  const raw = JSON.stringify([
    { id: 'a', text: ' keep ', completed: 'yes' },
    'junk',
    { id: 'b', text: '   ' },
  ]);
  expect(parseStored(raw)).toEqual([{ id: 'a', text: 'keep', completed: false, dueDate: null }]);
});

// ===========================================================================
// safeSave (F9 / INV6) — swallows a throwing writer
// ===========================================================================

test('safeSave: F9 swallows a throwing writer and returns false (does not throw)', () => {
  let result;
  expect(() => {
    result = safeSave(() => { throw new Error('quota exceeded'); }, sampleList());
  }).not.toThrow();
  expect(result).toBe(false);
});

test('safeSave: calls a working writer with the serialized list and returns true', () => {
  const list = sampleList();
  let received;
  const result = safeSave((s) => { received = s; }, list);
  expect(result).toBe(true);
  expect(received).toBe(JSON.stringify(list));
  expect(JSON.parse(received)).toEqual(list);
});

test('safeSave: works on an empty list', () => {
  let received;
  expect(safeSave((s) => { received = s; }, [])).toBe(true);
  expect(received).toBe('[]');
});

// ===========================================================================
// makeId (F7) — pure, distinct, deterministic
// ===========================================================================

test('makeId: returns a non-empty string', () => {
  const id = makeId(0, 'abc');
  expect(typeof id).toBe('string');
  expect(id.length).toBeGreaterThan(0);
});

test('makeId: deterministic given fixed (seq, rand)', () => {
  expect(makeId(5, 'qq')).toBe(makeId(5, 'qq'));
});

test('makeId: many calls with increasing seq yield distinct ids', () => {
  const ids = new Set();
  for (let seq = 0; seq < 1000; seq++) {
    ids.add(makeId(seq, 'r'));
  }
  expect(ids.size).toBe(1000); // all 1000 ids must be distinct
});

test('makeId: differing rand suffix yields distinct ids at the same seq', () => {
  expect(makeId(7, 'aaa')).not.toBe(makeId(7, 'bbb'));
});

// ===========================================================================
// toggleTodo (R4)
// ===========================================================================

test('toggleTodo: flips exactly the matching element', () => {
  const list = sampleList();
  const next = toggleTodo(list, 'a');
  expect(next[0].completed).toBe(true); // was false
  expect(next[1].completed).toBe(true); // unchanged
  expect(next[2].completed).toBe(false); // unchanged
});

test('toggleTodo: non-matching id is a no-op (content equal)', () => {
  const list = sampleList();
  expect(toggleTodo(list, 'nope')).toEqual(list);
});

test('toggleTodo: empty list -> empty', () => {
  expect(toggleTodo([], 'a')).toEqual([]);
});

// ===========================================================================
// editTodo (R5, F3 empty-edit no-op)
// ===========================================================================

test('editTodo: updates and trims text, preserving id and completed', () => {
  const list = sampleList();
  const next = editTodo(list, 'b', '  renamed  ');
  expect(next[1]).toEqual({ id: 'b', text: 'renamed', completed: true });
});

test('editTodo: F3/Q3 empty-after-trim text is a no-op (target unchanged)', () => {
  const list = sampleList();
  const next = editTodo(list, 'a', '   ');
  // same reference — no-op edit returns the input list unchanged
  expect(next).toBe(list);
  expect(next[0]).toEqual({ id: 'a', text: 'alpha', completed: false });
});

test('editTodo: non-matching id is a no-op', () => {
  const list = sampleList();
  expect(editTodo(list, 'nope', 'new text')).toEqual(list);
});

// ===========================================================================
// deleteTodo (R6)
// ===========================================================================

test('deleteTodo: removes the matching element, preserves order', () => {
  const list = sampleList();
  const next = deleteTodo(list, 'b');
  expect(next.map((t) => t.id)).toEqual(['a', 'c']);
  expect(next.length).toBe(2);
});

test('deleteTodo: non-matching id is a no-op (content equal)', () => {
  const list = sampleList();
  expect(deleteTodo(list, 'nope')).toEqual(list);
  expect(deleteTodo(list, 'nope').length).toBe(3);
});

test('deleteTodo: empty list -> empty', () => {
  expect(deleteTodo([], 'a')).toEqual([]);
});

// ===========================================================================
// clearCompleted (R7)
// ===========================================================================

test('clearCompleted: removes all completed, keeps active in order', () => {
  const list = sampleList(); // b is completed
  expect(clearCompleted(list).map((t) => t.id)).toEqual(['a', 'c']);
});

test('clearCompleted: all-active -> unchanged content', () => {
  const list = [
    { id: 'a', text: 'a', completed: false },
    { id: 'b', text: 'b', completed: false },
  ];
  expect(clearCompleted(list)).toEqual(list);
});

test('clearCompleted: all-completed -> []', () => {
  const list = [
    { id: 'a', text: 'a', completed: true },
    { id: 'b', text: 'b', completed: true },
  ];
  expect(clearCompleted(list)).toEqual([]);
});

test('clearCompleted: empty -> []', () => {
  expect(clearCompleted([])).toEqual([]);
});

// ===========================================================================
// restoreTodos — non-destructive Undo merge
// ===========================================================================

test('restoreTodos: single restore, prevId null -> inserted at the front', () => {
  const list = [{ id: 'c', text: 'charlie', completed: false }];
  const entries = [
    { item: { id: 'a', text: 'alpha', completed: false }, prevId: null },
  ];
  expect(restoreTodos(list, entries)).toEqual([
    { id: 'a', text: 'alpha', completed: false },
    { id: 'c', text: 'charlie', completed: false },
  ]);
});

test('restoreTodos: plan table row 1 — [A,C] + B:A, D:C -> [A,B,C,D]', () => {
  const list = [
    { id: 'A', text: 'a', completed: false },
    { id: 'C', text: 'c', completed: false },
  ];
  const entries = [
    { item: { id: 'B', text: 'b', completed: false }, prevId: 'A' },
    { item: { id: 'D', text: 'd', completed: false }, prevId: 'C' },
  ];
  expect(restoreTodos(list, entries).map((t) => t.id)).toEqual([
    'A', 'B', 'C', 'D',
  ]);
});

test('restoreTodos: plan table row 2 — [C] + A:null, B:A -> [A,B,C]', () => {
  const list = [{ id: 'C', text: 'c', completed: false }];
  const entries = [
    { item: { id: 'A', text: 'a', completed: false }, prevId: null },
    { item: { id: 'B', text: 'b', completed: false }, prevId: 'A' },
  ];
  expect(restoreTodos(list, entries).map((t) => t.id)).toEqual([
    'A', 'B', 'C',
  ]);
});

test('restoreTodos: plan table row 3 — [X] + X:null (present) -> [X], skipped (no dup/overwrite)', () => {
  const list = [{ id: 'X', text: 'original', completed: true }];
  const entries = [
    { item: { id: 'X', text: 'resurrected', completed: false }, prevId: null },
  ];
  const out = restoreTodos(list, entries);
  expect(out).toEqual([{ id: 'X', text: 'original', completed: true }]); // untouched
  expect(out.length).toBe(1); // no duplicate id
});

test('restoreTodos: plan table row 4 — [C] + B:Z (prevId gone) -> [C,B] appended', () => {
  const list = [{ id: 'C', text: 'c', completed: false }];
  const entries = [
    { item: { id: 'B', text: 'b', completed: false }, prevId: 'Z' },
  ];
  expect(restoreTodos(list, entries).map((t) => t.id)).toEqual(['C', 'B']);
});

test('restoreTodos: id-present entry is skipped without touching the rest of the batch', () => {
  const list = [
    { id: 'X', text: 'present', completed: false },
    { id: 'W', text: 'other', completed: false },
  ];
  const entries = [
    { item: { id: 'X', text: 'dup attempt', completed: true }, prevId: null },
    { item: { id: 'Y', text: 'genuinely absent', completed: false }, prevId: 'W' },
  ];
  const out = restoreTodos(list, entries);
  expect(out.map((t) => t.id)).toEqual(['X', 'W', 'Y']); // X untouched, Y inserted after W
  expect(out.find((t) => t.id === 'X')).toEqual({ id: 'X', text: 'present', completed: false });
});

test('restoreTodos: completed/text are preserved verbatim (not re-normalized/trimmed)', () => {
  const entries = [
    { item: { id: 'a', text: '  padded  ', completed: true }, prevId: null },
  ];
  expect(restoreTodos([], entries)).toEqual([
    { id: 'a', text: '  padded  ', completed: true },
  ]);
});

test('restoreTodos: batch clustering — a later entry\'s prevId points at an earlier REMOVED sibling, not present in `list`', () => {
  // Mirrors the clear-completed batch scenario (R2/R6): three entries removed
  // together, each threading off the previous one's re-inserted id, none of which
  // is present in the base `list` — in-order processing must still recover the
  // original clustering/order.
  const list = [{ id: 'active', text: 'active item', completed: false }];
  const entries = [
    { item: { id: 'a', text: 'a', completed: true }, prevId: null },
    { item: { id: 'b', text: 'b', completed: true }, prevId: 'a' },
    { item: { id: 'c', text: 'c', completed: true }, prevId: 'b' },
  ];
  expect(restoreTodos(list, entries).map((t) => t.id)).toEqual([
    'a', 'b', 'c', 'active',
  ]);
});

test('restoreTodos: empty entries returns content-equal list (still a new array)', () => {
  const list = [{ id: 'a', text: 'alpha', completed: false }];
  expect(restoreTodos(list, [])).toEqual(list);
});

test('restoreTodos: does not mutate the input list (returns a new array; frozen input safe)', () => {
  const list = deepFreeze([{ id: 'a', text: 'alpha', completed: false }]);
  const entries = [
    { item: { id: 'b', text: 'bravo', completed: false }, prevId: 'a' },
  ];
  let out;
  expect(() => { out = restoreTodos(list, entries); }).not.toThrow();
  expect(out.map((t) => t.id)).toEqual(['a', 'b']);
  expect(list.length).toBe(1); // input untouched
});

// ===========================================================================
// filterTodos (R8)
// ===========================================================================

test('filterTodos: active returns only not-completed', () => {
  expect(filterTodos(sampleList(), 'active').map((t) => t.id)).toEqual(['a', 'c']);
});

test('filterTodos: completed returns only completed', () => {
  expect(filterTodos(sampleList(), 'completed').map((t) => t.id)).toEqual(['b']);
});

test('filterTodos: "all" and unknown filters return everything', () => {
  expect(filterTodos(sampleList(), 'all').map((t) => t.id)).toEqual(['a', 'b', 'c']);
  expect(filterTodos(sampleList(), 'bogus').map((t) => t.id)).toEqual(['a', 'b', 'c']);
});

test('filterTodos: empty list -> empty for every filter', () => {
  for (const f of ['all', 'active', 'completed', 'bogus']) {
    expect(filterTodos([], f)).toEqual([]);
  }
});

// ===========================================================================
// remainingCount (R9)
// ===========================================================================

test('remainingCount: counts only active', () => {
  expect(remainingCount(sampleList())).toBe(2); // a, c active
});

test('remainingCount: all-active, all-completed, empty', () => {
  expect(remainingCount([
    { id: 'a', text: 'a', completed: false },
    { id: 'b', text: 'b', completed: false },
  ])).toBe(2);
  expect(remainingCount([
    { id: 'a', text: 'a', completed: true },
  ])).toBe(0);
  expect(remainingCount([])).toBe(0);
});

// ===========================================================================
// INV1 schema integrity (after a mix of operations)
// ===========================================================================

test('INV1: after add/edit/sanitize, every element matches {id:str≠"", text:str≠"", completed:bool}', () => {
  let list = [];
  list = addTodo(list, '  one  ', 'i1');
  list = addTodo(list, 'two', 'i2');
  list = editTodo(list, 'i1', '  one-edited  ');
  list = toggleTodo(list, 'i2');
  list = sanitizeTodos([...list, { id: 'i3', text: ' three ', completed: 'truthy' }]);
  for (const t of list) {
    expect(typeof t.id).toBe('string');
    expect(t.id.length).toBeGreaterThan(0);
    expect(typeof t.text).toBe('string');
    expect(t.text.length).toBeGreaterThan(0);
    expect(typeof t.completed).toBe('boolean');
    expect(Object.keys(t).sort()).toEqual(['completed', 'dueDate', 'id', 'text']);
  }
});

// ===========================================================================
// INV2 unique ids
// ===========================================================================

test('INV2: no two elements share an id after addTodo dup attempt or sanitize dedup', () => {
  let list = sampleList();
  list = addTodo(list, 'dup attempt', 'a'); // no-op
  const sanitized = sanitizeTodos([
    { id: 'x', text: 'x1', completed: false },
    { id: 'x', text: 'x2', completed: false },
    { id: 'y', text: 'y', completed: false },
  ]);
  const idsA = list.map((t) => t.id);
  const idsB = sanitized.map((t) => t.id);
  expect(new Set(idsA).size).toBe(idsA.length);
  expect(new Set(idsB).size).toBe(idsB.length);
});

// ===========================================================================
// INV3 / R11 immutability — frozen inputs, no throw, inputs unchanged
// ===========================================================================

const mutators = [
  ['addTodo', (l) => addTodo(l, 'new', 'newid')],
  ['addTodo-dup', (l) => addTodo(l, 'new', 'a')],
  ['toggleTodo', (l) => toggleTodo(l, 'a')],
  ['editTodo', (l) => editTodo(l, 'a', 'changed')],
  ['deleteTodo', (l) => deleteTodo(l, 'a')],
  ['clearCompleted', (l) => clearCompleted(l)],
  ['filterTodos', (l) => filterTodos(l, 'active')],
  ['remainingCount', (l) => remainingCount(l)],
  ['sanitizeTodos', (l) => sanitizeTodos(l)],
];

test.each(mutators)(
  'INV3/R11: %s leaves a deep-frozen input unchanged and does not throw',
  (name, fn) => {
    const list = deepFreeze(sampleList());
    const snapshot = sampleList(); // structurally-identical fresh copy
    expect(() => fn(list)).not.toThrow(); // <name> threw on a frozen input
    expect(list).toEqual(snapshot); // <name> mutated its input
  },
);

// ===========================================================================
// R1/R10 purity — behavioral determinism (F8): same args -> deep-equal output
// ===========================================================================

test('R1/R10/F8: exported functions are deterministic (twice-called -> deep-equal)', () => {
  const list = sampleList();
  const calls = [
    () => addTodo(list, 'd', 'newid'),
    () => toggleTodo(list, 'a'),
    () => editTodo(list, 'a', 'x'),
    () => deleteTodo(list, 'a'),
    () => clearCompleted(list),
    () => filterTodos(list, 'active'),
    () => remainingCount(list),
    () => sanitizeTodos(list),
    () => parseStored(JSON.stringify(list)),
    () => makeId(3, 'rr'),
  ];
  for (const call of calls) {
    expect(call()).toEqual(call());
  }
});

// ===========================================================================
// moveTodo (R1 / INV-PERMUTATION) — remove-then-insert, clamp, same-ref no-op
// ===========================================================================

/** The R1 oracle list, [A,B,C,D] keyed by id. */
function abcd() {
  return [
    { id: 'A', text: 'alpha', completed: false },
    { id: 'B', text: 'bravo', completed: true },
    { id: 'C', text: 'charlie', completed: false },
    { id: 'D', text: 'delta', completed: true },
  ];
}

test('moveTodo: A -> 2 lands the item at its final index (B,C,A,D)', () => {
  const next = moveTodo(abcd(), 'A', 2);
  expect(next.map((t) => t.id)).toEqual(['B', 'C', 'A', 'D']);
});

test('moveTodo: D -> 0 moves to the front (D,A,B,C)', () => {
  const next = moveTodo(abcd(), 'D', 0);
  expect(next.map((t) => t.id)).toEqual(['D', 'A', 'B', 'C']);
});

test('moveTodo: B -> 1 is a no-op and returns the SAME list reference', () => {
  const list = abcd();
  const next = moveTodo(list, 'B', 1);
  expect(next).toBe(list); // same ref -> no redundant PUT
});

test('moveTodo: C -> 99 clamps to the last index (A,B,D,C)', () => {
  const next = moveTodo(abcd(), 'C', 99);
  expect(next.map((t) => t.id)).toEqual(['A', 'B', 'D', 'C']);
});

test('moveTodo: negative toIndex clamps to the front', () => {
  const next = moveTodo(abcd(), 'C', -5);
  expect(next.map((t) => t.id)).toEqual(['C', 'A', 'B', 'D']);
});

test('moveTodo: an absent id returns the SAME list reference', () => {
  const list = abcd();
  const next = moveTodo(list, 'X', 1);
  expect(next).toBe(list);
});

test('moveTodo: a clamped destination equal to the current index is a same-ref no-op', () => {
  const list = abcd();
  // C is at index 2; clamping 99 down would move it, but clamping to its own index does not.
  const next = moveTodo(list, 'A', 0);
  expect(next).toBe(list);
});

test('moveTodo: never mutates its input (frozen list)', () => {
  const list = deepFreeze(abcd());
  expect(() => moveTodo(list, 'A', 3)).not.toThrow();
  expect(list.map((t) => t.id)).toEqual(['A', 'B', 'C', 'D']); // untouched
});

test('moveTodo: INV-PERMUTATION — preserves length, id multiset, and every field', () => {
  const before = abcd();
  const after = moveTodo(before, 'B', 3);
  expect(after).toHaveLength(before.length);
  expect([...after.map((t) => t.id)].sort()).toEqual(
    [...before.map((t) => t.id)].sort()
  );
  // Each moved item is the same object shape, no field edited.
  for (const item of before) {
    expect(after.find((t) => t.id === item.id)).toEqual(item);
  }
});

// ===========================================================================
// pointerDropIndex (R4 geometry) — rects + pointer Y -> { gap, toIndex }
// ===========================================================================

/** Four contiguous 50px-tall row bands: row k spans [k*50, k*50+50). */
function bands(n = 4) {
  return Array.from({ length: n }, (_, k) => ({ top: k * 50, bottom: k * 50 + 50 }));
}

test('pointerDropIndex: A down, pointer over row C lower half -> gap 3, toIndex 2', () => {
  // origin i=0; row C is r=2 ([100,150)), lower half is y>=125.
  expect(pointerDropIndex(bands(), 140, 0)).toEqual({ gap: 3, toIndex: 2 });
});

test('pointerDropIndex: D up, pointer over row A upper half -> gap 0, toIndex 0', () => {
  // origin i=3; row A is r=0 ([0,50)), upper half is y<25.
  expect(pointerDropIndex(bands(), 10, 3)).toEqual({ gap: 0, toIndex: 0 });
});

test('pointerDropIndex: over the origin row, either half maps to toIndex === origin (no-op)', () => {
  // origin i=0 over row A: upper half -> gap 0, lower half -> gap 1, both toIndex 0.
  expect(pointerDropIndex(bands(), 10, 0)).toEqual({ gap: 0, toIndex: 0 });
  expect(pointerDropIndex(bands(), 40, 0)).toEqual({ gap: 1, toIndex: 0 });
});

test('pointerDropIndex: pointer above the list clamps to gap 0', () => {
  expect(pointerDropIndex(bands(), -20, 2)).toEqual({ gap: 0, toIndex: 0 });
});

test('pointerDropIndex: pointer below the list clamps to gap N (append)', () => {
  // origin i=0, gap 4 > i so toIndex = 3 (the last resting index after removal).
  expect(pointerDropIndex(bands(), 999, 0)).toEqual({ gap: 4, toIndex: 3 });
});

test('pointerDropIndex: an empty band list returns the origin unchanged', () => {
  expect(pointerDropIndex([], 100, 2)).toEqual({ gap: 0, toIndex: 2 });
});
