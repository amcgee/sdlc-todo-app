// @vitest-environment happy-dom
//
// Undo must never replace the WHOLE list with only
// the undo-merged, freshly-REFETCHED snapshot: when that refetch is stale or fails
// (loadTodos never rejects; it resolves `[]` on failure per storage.js), a naive
//   setTodos(restoreTodos(fresh, entries))
// silently drops every OTHER todo that was never part of the undo — a collateral
// data-loss bug, since `fresh` is authoritative only for detecting a concurrent
// same-id recreation, not for the rest of the list.
//
// The fix merges into the LIVE in-memory list via the functional setTodos updater,
// filtering only entries genuinely absent from the refetch:
//   const stillAbsent = entries.filter(e => !fresh.some(t => t.id === e.item.id));
//   setTodos((current) => restoreTodos(current, stillAbsent));
// so an unrelated todo already in `current` (never removed) always survives,
// independent of what the refetch happens to contain.
//
//   pre-fix  (src/App.jsx @ 4e47a3d): setTodos(restoreTodos(fresh, entries))
//     -> fresh=[] (refetch "failure") => result = [restored item] ONLY;
//        the untouched sibling todo is WIPED from the list and from the next PUT.
//   post-fix (src/App.jsx @ 67697a9): setTodos(current => restoreTodos(current, stillAbsent))
//     -> current ([sibling]) is merged INTO -> sibling preserved, item restored.
//
// Conventions mirror tests/App.hydration-f33.test.jsx / tests/App.a11y.test.jsx:
// happy-dom, a stubbed `fetch` (GET/PUT), afterEach cleanup, fireEvent only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import App from '../src/App.jsx';

afterEach(cleanup);

const KEEP = { id: 'keep-1', text: 'keep me untouched', completed: false };
const GONE = { id: 'gone-1', text: 'delete me then undo', completed: false };

let getCount;

beforeEach(() => {
  getCount = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'PUT') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      getCount += 1;
      if (getCount === 1) {
        // Mount hydration GET: two todos.
        return { ok: true, json: async () => [KEEP, GONE] };
      }
      // The Undo click's refetch (loadTodos): simulate a stale/failed refetch that
      // comes back empty — the exact scenario storage.js's `loadTodos` degrades to
      // on any network error/timeout/non-2xx (it never rejects).
      return { ok: true, json: async () => [] };
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleUndo must not drop unrelated todos on a stale/failed refetch', () => {
  it('deleting one todo then Undo with an empty refetch restores it without losing the other todo', async () => {
    render(<App />);
    expect(await screen.findByText(KEEP.text)).toBeInTheDocument();
    expect(screen.getByText(GONE.text)).toBeInTheDocument();

    // Delete GONE only.
    const goneRow = screen.getByText(GONE.text).closest('li');
    fireEvent.click(within(goneRow).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.queryByText(GONE.text)).not.toBeInTheDocument();
    });
    // KEEP was never touched — must still be present right after the delete.
    expect(screen.getByText(KEEP.text)).toBeInTheDocument();

    // Click Undo. loadTodos' refetch resolves [] (stale/failed).
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    // GONE is restored...
    await waitFor(() => {
      expect(screen.getByText(GONE.text)).toBeInTheDocument();
    });
    // ...and KEEP — an unrelated todo never part of this undo — MUST still be
    // present. PRE-FIX this fails: setTodos(restoreTodos([], entries)) replaces the
    // whole list with just the restored GONE item, silently dropping KEEP.
    expect(screen.getByText(KEEP.text)).toBeInTheDocument();
  });
});
