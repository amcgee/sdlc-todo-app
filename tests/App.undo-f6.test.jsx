// @vitest-environment happy-dom
//
// Guarding against dropping a valid undo when the deleted id is still present in
// the refetch with unchanged content (the mirror image of the stale-refetch case):
// handleUndo's restore-skip guard must not treat MERE PRESENCE of the deleted id in the
// undo refetch (`fresh`) as authoritative proof of a genuine concurrent edit, even
// when the content is byte-identical to what was captured. That happens whenever
// the delete's own best-effort PUT simply hasn't landed yet within the 5s undo
// window, or failed outright (R13) — in both cases the server still holds the
// item, but it is NOT a concurrent edit, and skipping the restore silently drops
// the user's undo.
//
//   pre-fix  (src/App.jsx @ b3eecef):
//     const stillAbsent = entries.filter(e => !fresh.some(t => t.id === e.item.id));
//     -> fresh still contains GONE (id present) => stillAbsent = [] => GONE is
//        NEVER re-inserted, even though its text/completed are unchanged.
//   post-fix (src/App.jsx @ 1ea24a7):
//     const toRestore = entries.filter((e) => {
//       const upstream = fresh.find((t) => t.id === e.item.id);
//       return !upstream || (upstream.text === e.item.text && upstream.completed === e.item.completed);
//     });
//     -> upstream has identical content -> restored despite being present in `fresh`.
//
// Conventions mirror tests/App.undo-f5.test.jsx: happy-dom, a stubbed `fetch`
// (GET/PUT), afterEach cleanup, fireEvent only.

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

const KEEP = { id: 'keep-1', text: 'keep me around', completed: false };
const GONE = { id: 'gone-1', text: 'delete me then undo still on server', completed: false };

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
      // The Undo click's refetch (loadTodos): simulate the delete's own PUT not
      // having landed yet (or having failed) — the server STILL returns GONE with
      // content byte-identical to what was captured pre-delete. This is NOT a
      // concurrent edit and must not block the restore.
      return { ok: true, json: async () => [KEEP, GONE] };
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleUndo must restore even when the refetch still has the item, unchanged', () => {
  it('deleting one todo then Undo restores it even though the refetch still shows it unchanged', async () => {
    render(<App />);
    expect(await screen.findByText(KEEP.text)).toBeInTheDocument();
    expect(screen.getByText(GONE.text)).toBeInTheDocument();

    // Delete GONE only.
    const goneRow = screen.getByText(GONE.text).closest('li');
    fireEvent.click(within(goneRow).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.queryByText(GONE.text)).not.toBeInTheDocument();
    });
    expect(screen.getByText(KEEP.text)).toBeInTheDocument();

    // Click Undo. loadTodos' refetch resolves [KEEP, GONE] unchanged — simulating
    // the delete's own PUT not having landed server-side yet, or having failed.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    // GONE must be restored: it is still genuinely absent from the LOCAL list, and
    // its presence in `fresh` is content-identical (not a concurrent edit).
    // PRE-FIX this fails: `stillAbsent` treats mere id-presence in `fresh` as a
    // conflict, so the restore is silently skipped and GONE never comes back.
    await waitFor(() => {
      expect(screen.getByText(GONE.text)).toBeInTheDocument();
    });
    // KEEP must still be present too.
    expect(screen.getByText(KEEP.text)).toBeInTheDocument();
  });
});
