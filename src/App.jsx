// Thin React shell over the pure core (plan §3). Holds the list in state, routes
// events to src/todos.js functions, generates ids, persists on change, and renders.
// It contains NO list-mutation logic of its own.
//
// XSS posture (R18 / INV5): todo text reaches the DOM only via React's default
// {todo.text} text interpolation, which React escapes. There is no
// dangerouslySetInnerHTML anywhere, and no user-controlled value (text or id) is
// placed in an href/src/style attribute, an inline event handler, or any other
// non-text-node sink.

import { useEffect, useRef, useState } from 'react';
import {
  addTodo,
  toggleTodo,
  editTodo,
  deleteTodo,
  clearCompleted,
  restoreTodos,
  filterTodos,
  remainingCount,
  makeId,
  setDueDate,
  isOverdue,
  sortByDueDate,
  dueDateLabel,
} from './todos.js';
import { loadTodos, saveTodos } from './storage.js';
import { MAX_ITEM_CHARS, MAX_LIST_ITEMS, itemCharCount } from './limits.js';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';

// A short random suffix for makeId. Prefers crypto.getRandomValues; the randomness
// is generated here (the UI layer) and passed into the pure makeId so the core
// stays nondeterminism-free (R10). Returns a base-36 string.
function randomSuffix() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    return `${buf[0].toString(36)}${buf[1].toString(36)}`;
  }
  // Last-resort fallback when no crypto is available. randomness lives only in the
  // UI layer, never in the pure core.
  return Math.random().toString(36).slice(2);
}

// The user's local calendar day as "YYYY-MM-DD", built from LOCAL Date components
// (never toISOString(), which is UTC and would report tomorrow's date for the last
// hours of each local day in behind-UTC zones, mislabeling a due-today item as
// overdue). This is the feature's one clock read, kept in the UI so the pure core
// stays clock-free; it is threaded into the overdue test the way makeId receives
// its randomness.
function todayLocal() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Generate a fresh id. Prefers a real UUID; otherwise the collision-resistant
// makeId(seq, rand). The per-session counter is threaded via the `seqRef` passed in.
function nextId(seqRef) {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const seq = seqRef.current++;
  return makeId(seq, randomSuffix());
}

export default function App() {
  const [todos, setTodos] = useState([]); // start empty; async load populates (D2)
  const [filter, setFilter] = useState('all');
  const [sortByDate, setSortByDate] = useState(false); // view-only soonest-first sort
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [editDueDate, setEditDueDate] = useState(''); // staged date draft (ISSUE-40-F13)
  const [notice, setNotice] = useState(null); // non-silent limit / save-failure message (R4/R5/R10/R13)
  const [pendingUndo, setPendingUndo] = useState(null); // { entries, label } | null — the single live undo
  const undoTimerRef = useRef(null); // setTimeout id for the 5s undo window
  const seqRef = useRef(0);
  const hydratedRef = useRef(false); // authoritative gate (read sync in save effect)
  const skipNextSaveRef = useRef(false); // suppress the load-applied echo (D2 step 3)
  const preHydrationNonEmptyRef = useRef(false); // current pre-hydration list is non-empty (F64/F33)

  // Discard the pending undo and stop its timer. Fires only from an actual list
  // mutation (or timer expiry / unmount), never from a validation-rejected no-op, so
  // the captured entries are dropped exactly when the list they referenced changes.
  // At most one pending undo exists, so clearing the single timer + state is enough.
  function finalizeUndo() {
    if (undoTimerRef.current !== null) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setPendingUndo(null);
  }

  // Arm a fresh 5s pending undo, first clearing any prior one (at most one at a time).
  function armUndo(entries, label) {
    if (undoTimerRef.current !== null) {
      clearTimeout(undoTimerRef.current);
    }
    setPendingUndo({ entries, label });
    setNotice(null);
    undoTimerRef.current = setTimeout(finalizeUndo, 5000);
  }

  // Mount load (D2): runs once; abort/ignore-safe under StrictMode double-invoke.
  // loadTodos never rejects and returns already-sanitized data (INV-F/§4.1).
  useEffect(() => {
    let ignore = false;
    loadTodos().then((result) => {
      if (ignore) return; // stale (unmounted) instance -> no setState, no flip

      // A whole-list replacement from storage is an external mutation that
      // invalidates any captured undo entries — dismiss before applying either branch.
      finalizeUndo();

      if (preHydrationNonEmptyRef.current) {
        // F64: the user added/edited during the pre-hydration flash and the list is
        // STILL non-empty at resolution time. Keep their in-memory state
        // authoritative (don't clobber it with the server list), hydrate, and flush
        // it as the first PUT via an identity re-commit.
        //
        // F33: this branch is taken ONLY when the current in-memory list is
        // genuinely non-empty. A pre-hydration add-then-delete that nets back to
        // empty resets the ref to false (see the save effect below), so it falls
        // through to apply the loaded server data instead of PUTting [] and wiping
        // a real server-persisted list.
        hydratedRef.current = true;
        setTodos((current) => current.slice()); // new ref -> hydrated save effect runs
        return;
      }

      skipNextSaveRef.current = true; // the setTodos below must NOT emit a PUT (load echo)
      setTodos(result); // apply loaded (or []-fallback) data — already sanitized
      hydratedRef.current = true; // hydrate AFTER settle, on success OR fallback
    });
    return () => {
      ignore = true;
    }; // cleanup marks this instance stale
  }, []);

  // Persist the whole list on every change (R17). Best-effort: saveTodos swallows
  // write failures (INV6). No-op until hydrated; skip the load-applied echo (INV-H).
  useEffect(() => {
    if (!hydratedRef.current) {
      // Pre-hydration: track whether the CURRENT list is non-empty (F33). A
      // non-empty list means a live user edit worth preserving; a list that nets
      // back to empty (add-then-delete) is indistinguishable from mount [] and has
      // nothing to preserve, so the flag is RESET — the load resolver must then use
      // the server data rather than clobbering it with []. No PUT yet either way.
      preHydrationNonEmptyRef.current = todos.length > 0;
      return; // no PUT for mount [] nor for a pre-hydration edit
    }
    if (skipNextSaveRef.current) {
      // no PUT merely re-sending the loaded list
      skipNextSaveRef.current = false;
      return;
    }
    // Genuine user mutation -> PUT (best-effort, INV-J). R13: no save is silently
    // dropped — if the newest state fails to persist (any non-2xx, network error,
    // timeout, or the accepted concurrency-race rejection R12 cannot pre-empt), the
    // resolved boolean is `false` and we surface a non-silent notice. saveTodos was
    // tightened so a coalesced call resolves to the drain's EVENTUAL real result, so
    // a rapid double-edit whose newest send succeeds does not show a false positive.
    saveTodos(todos).then((ok) => {
      if (!ok) {
        setNotice(
          'Your last change may not have been saved. Refresh to see the current list.'
        );
      }
    });
  }, [todos]);

  // Clear the pending-undo timer on unmount so no expired callback fires after
  // teardown (no leaked timer).
  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    };
  }, []);

  const today = todayLocal();
  const filtered = filterTodos(todos, filter);
  // Sort is a view-only toggle (like the filters): it reorders what is rendered and
  // never mutates state or issues a PUT, so the stored position order is untouched.
  const visible = sortByDate ? sortByDueDate(filtered) : filtered;
  const remaining = remainingCount(todos);

  // Capped setter for a text field (R4). Accepts the new value IFF it is within the
  // per-item code-point cap OR it does not GROW the current value — the second clause
  // is essential so a user can SHRINK an over-limit legacy value in the edit field
  // (40->39->...), which a plain `<= 32` guard would freeze. A refused change leaves
  // the value unchanged and surfaces a notice. NB: no HTML maxLength — it counts
  // UTF-16 code units and would diverge from the server's code-point measure for
  // astral characters.
  function capText(next, prev, apply) {
    if (
      itemCharCount(next) <= MAX_ITEM_CHARS ||
      itemCharCount(next) <= itemCharCount(prev)
    ) {
      apply(next);
    } else {
      setNotice(`Item text is limited to ${MAX_ITEM_CHARS} characters.`);
    }
  }

  function handleAdd(e) {
    e.preventDefault();
    // R10: block the ADD when the list is already at/over the cap (covers exactly-
    // full and legacy over-full). No optimistic mutation, no PUT; the draft text is
    // left intact so the user's work is not lost.
    if (todos.length >= MAX_LIST_ITEMS) {
      setNotice(
        `The list is full (${MAX_LIST_ITEMS} items max). Delete an item to add a new one.`
      );
      return;
    }
    // addTodo is a no-op on empty/whitespace text (R3) — the input is cleared either
    // way for a consistent UX, but nothing is appended when blank.
    setNotice(null);
    // A blank/whitespace add is a no-op, so it does not dismiss a pending undo; a
    // real add (fresh id, so never a duplicate) mutates and finalizes it.
    if (draft.trim() !== '') finalizeUndo();
    const id = nextId(seqRef);
    setTodos((current) => addTodo(current, draft, id));
    setDraft('');
  }

  function handleToggle(id) {
    setNotice(null);
    // Toggling an existing row always mutates -> finalize any pending undo.
    finalizeUndo();
    setTodos((current) => toggleTodo(current, id));
  }

  function handleDelete(id) {
    setNotice(null);
    // Capture the removed entry (item + preceding id) from the current list BEFORE
    // deleting, so Undo can re-insert it verbatim at a best-effort position.
    const idx = todos.findIndex((t) => t.id === id);
    if (idx === -1) return; // nothing to remove -> no-op, pending undo untouched
    const item = todos[idx];
    const entries = [{ item, prevId: idx > 0 ? todos[idx - 1].id : null }];
    finalizeUndo(); // discard any prior pending undo before arming this one
    setTodos((current) => deleteTodo(current, id));
    armUndo(entries, `"${item.text}" deleted.`);
  }

  function handleClearCompleted() {
    setNotice(null);
    // Build one entry per completed item, in original order, capturing the id of the
    // item immediately preceding it in the full pre-removal list (or null if first).
    const entries = [];
    for (let i = 0; i < todos.length; i++) {
      if (todos[i].completed) {
        entries.push({ item: todos[i], prevId: i > 0 ? todos[i - 1].id : null });
      }
    }
    if (entries.length === 0) return; // nothing completed -> no removal, no undo armed
    finalizeUndo();
    setTodos((current) => clearCompleted(current));
    armUndo(entries, `${entries.length} completed items cleared.`);
  }

  async function handleUndo() {
    if (pendingUndo === null) return;
    const { entries } = pendingUndo;
    // Single-fire: clear the timer + state first so a mid-fetch re-click or a timer
    // expiry that lands during the await cannot double-apply the restore.
    finalizeUndo();
    const fresh = await loadTodos();
    // Only skip restoring an entry if `fresh` holds the SAME id with DIFFERENT
    // content (text or completed) than what we captured -- that's a genuine
    // concurrent edit we must not clobber. Mere presence with identical
    // content just means our own delete hasn't landed (or failed) server-side
    // and is NOT a conflict: the item is still genuinely absent from `current`
    // and must be restored there.
    const toRestore = entries.filter((e) => {
      const upstream = fresh.find((t) => t.id === e.item.id);
      return (
        !upstream ||
        (upstream.text === e.item.text && upstream.completed === e.item.completed)
      );
    });
    setTodos((current) => restoreTodos(current, toRestore));
  }

  function startEdit(todo) {
    // Prefill verbatim — even if the item is over-limit legacy text (never truncated,
    // INV-4); the shrink-allowed cap + commit guard handle bringing it within limits.
    setEditingId(todo.id);
    setEditText(todo.text);
    setEditDueDate(todo.dueDate ?? ''); // staged date draft (ISSUE-40-F13)
  }

  function commitEdit(id) {
    // R5: refuse to save an edit whose committed text is over the per-item cap (the
    // over-limit legacy-edit case). Stay in edit mode so the user can shrink the text
    // — do NOT apply editTodo and do NOT truncate (INV-4). Measure the TRIMMED text,
    // matching what editTodo actually stores (normalizeText trims), so an edit that is
    // only over-limit due to leading/trailing whitespace isn't falsely refused.
    if (itemCharCount(editText.trim()) > MAX_ITEM_CHARS) {
      setNotice(`Item text is limited to ${MAX_ITEM_CHARS} characters.`);
      return;
    }
    // editTodo no-ops on empty-after-trim (R5); the row exits edit mode regardless.
    setNotice(null);
    // ISSUE-40-F13: the date is a staged draft, exactly like the text — Save applies
    // both together as one update (one PUT), whether or not the date was touched.
    const original = todos.find((t) => t.id === id);
    const dueDateChanged = original != null && (original.dueDate ?? '') !== editDueDate;
    // An empty-after-trim commit is a no-op for text; the row still exits edit mode.
    // Finalize undo if either draft is a real change (a no-op edit dismisses nothing).
    if (editText.trim() !== '' || dueDateChanged) finalizeUndo();
    // Only apply setDueDate when the date actually changed: it always returns a new
    // array (unlike editTodo's no-op case), so calling it unconditionally would defeat
    // the same-reference bail-out and fire a redundant PUT on a no-op edit (ISSUE-40-F14).
    setTodos((current) => {
      const next = editTodo(current, id, editText);
      return dueDateChanged ? setDueDate(next, id, editDueDate || null) : next;
    });
    setEditingId(null);
    setEditText('');
    setEditDueDate('');
  }

  function cancelEdit() {
    // Neither draft was ever persisted (ISSUE-40-F13), so discarding them here is a
    // pure client-side revert — there is nothing to undo server-side.
    setEditingId(null);
    setEditText('');
    setEditDueDate('');
  }

  return (
    <div className="max-w-[560px] mx-auto my-8 p-4 bg-card rounded-lg shadow-sm">
      <h1 className="text-2xl font-semibold text-center mb-4">TODO</h1>

      <form className="flex gap-2 mb-4" onSubmit={handleAdd}>
        <Input
          type="text"
          value={draft}
          onChange={(e) => capText(e.target.value, draft, setDraft)}
          placeholder="What needs to be done?"
          aria-label="New todo"
          className="flex-1"
        />
        <Button type="submit">Add</Button>
      </form>

      {/* Notice + Undo area. The role="status" aria-live node (always rendered so
          screen readers announce updates) carries the non-silent notice
          (R4/R5/R10/R13) and, after a delete/clear-completed, the removal label as
          text only. The Undo control is a focusable SIBLING outside the live region
          — never its descendant — so assistive-tech focus/announce behavior stays
          defined; a save-failure notice and the Undo affordance can show together. */}
      <div className="min-h-5 mb-2 flex items-center gap-2 text-sm">
        <div role="status" aria-live="polite" className="flex-1">
          {notice && <span className="text-destructive mr-2">{notice}</span>}
          {pendingUndo && (
            <span className="text-muted-foreground">{pendingUndo.label}</span>
          )}
        </div>
        {pendingUndo && (
          <Button type="button" variant="ghost" size="sm" onClick={handleUndo}>
            Undo
          </Button>
        )}
      </div>

      {/* Filter + sort controls sit above the list they shape. Behavior and the
          non-color-alone selected-state cues are unchanged — only position moved. */}
      <div className="flex items-center justify-between mb-4 text-sm">
        <div className="flex gap-1">
          {/* Active-filter selected-state cue (A6/F24): non-color-alone. The
              filled default variant is paired with an explicit bold+underline
              text treatment so the distinction survives even if the fill color
              is ever changed — recreating the original visual cue, not color
              alone. */}
          <Button
            type="button"
            variant={filter === 'all' ? 'default' : 'ghost'}
            size="sm"
            aria-pressed={filter === 'all'}
            className={cn(filter === 'all' && 'font-semibold underline underline-offset-4')}
            onClick={() => setFilter('all')}
          >
            All
          </Button>
          <Button
            type="button"
            variant={filter === 'active' ? 'default' : 'ghost'}
            size="sm"
            aria-pressed={filter === 'active'}
            className={cn(filter === 'active' && 'font-semibold underline underline-offset-4')}
            onClick={() => setFilter('active')}
          >
            Active
          </Button>
          <Button
            type="button"
            variant={filter === 'completed' ? 'default' : 'ghost'}
            size="sm"
            aria-pressed={filter === 'completed'}
            className={cn(filter === 'completed' && 'font-semibold underline underline-offset-4')}
            onClick={() => setFilter('completed')}
          >
            Completed
          </Button>
        </div>
        {/* View-only sort toggle. Selected-state cue is non-color-alone (bold +
            underline), matching the filter cue; it reorders the view soonest-first
            and issues no PUT. */}
        <Button
          type="button"
          variant={sortByDate ? 'default' : 'ghost'}
          size="sm"
          aria-pressed={sortByDate}
          className={cn(sortByDate && 'font-semibold underline underline-offset-4')}
          onClick={() => setSortByDate((v) => !v)}
        >
          Sort by date
        </Button>
      </div>

      <ul className="list-none p-0 m-0">
        {visible.map((todo) => (
          <li
            key={todo.id}
            className={cn(
              'flex items-center gap-3 py-3 border-b border-border',
              isOverdue(todo, today) && 'bg-destructive/10'
            )}
          >
            <Checkbox
              checked={todo.completed}
              onCheckedChange={() => handleToggle(todo.id)}
              aria-label="Toggle complete"
            />
            {editingId === todo.id ? (
              // F11: edit mode commits/cancels only via explicit Save/Cancel (or the
              // Enter/Escape shortcuts below) — never implicitly on blur. This removes
              // the onBlur-commit path entirely, and with it the whole class of bug
              // F10 was an instance of (focus moving between the two edit fields no
              // longer risks unmounting them mid-interaction).
              <div className="flex flex-1 items-center gap-2">
                <Input
                  type="text"
                  value={editText}
                  onChange={(e) => capText(e.target.value, editText, setEditText)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit(todo.id);
                    else if (e.key === 'Escape') cancelEdit();
                  }}
                  aria-label="Edit todo"
                  autoFocus
                  className="flex-1"
                />
                {/* Date affordance lives only in edit mode (ISSUE-40-F9) — an
                    ordinary row wastes no space on it when no date is set. Staged
                    draft (ISSUE-40-F13): only commitEdit persists it, same as text. */}
                <Input
                  type="date"
                  value={editDueDate}
                  onChange={(e) => setEditDueDate(e.target.value)}
                  aria-label="Due date"
                  className="h-9 w-36 shrink-0 text-sm text-muted-foreground"
                />
              </div>
            ) : (
              <>
                <span
                  className={cn(
                    'flex-1 min-w-0 truncate',
                    todo.completed && 'line-through text-muted-foreground'
                  )}
                  onDoubleClick={() => startEdit(todo)}
                  title={todo.text}
                >
                  {todo.text}
                </span>
                {/* Relative "time left" label (ISSUE-40-F9) — replaces the raw date
                    and the old "Overdue" word; nothing renders when undated. Past-tense
                    phrasing is the non-color-alone signal for an overdue row. */}
                {dueDateLabel(todo.dueDate, today) != null && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {dueDateLabel(todo.dueDate, today)}
                  </span>
                )}
              </>
            )}
            <div className="flex items-center gap-2 shrink-0">
              {editingId === todo.id ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => commitEdit(todo.id)}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => cancelEdit()}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => startEdit(todo)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(todo.id)}
                  >
                    Delete
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between mt-4 text-sm">
        <span className="text-muted-foreground">{remaining} items left</span>
        {/* Clear completed is shown only when the currently-filtered view holds
            at least one completed todo — hidden on "Active", which never shows
            completed items, even if completed todos exist elsewhere in the list. */}
        {filtered.some((t) => t.completed) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleClearCompleted}
          >
            Clear completed
          </Button>
        )}
      </div>
    </div>
  );
}
