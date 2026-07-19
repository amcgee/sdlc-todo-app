// @vitest-environment happy-dom
//
// ISSUE-35-F5 proving test. commitEdit must measure the TRIMMED edit text against
// MAX_ITEM_CHARS (matching what editTodo actually stores via normalizeText), not
// the raw padded text. Otherwise an edit that is over the 32-char cap ONLY because
// of leading/trailing whitespace (e.g. 31 chars + 2 trailing spaces = 33 raw code
// points, 31 trimmed) is falsely refused.
//
//   pre-fix (src/App.jsx:195  itemCharCount(editText)        > 32): 33 > 32 -> REFUSED
//   post-fix (src/App.jsx:197 itemCharCount(editText.trim()) > 32): 31 <= 32 -> COMMITS
//
// Reproduction seam: capText blocks GROWTH past 32 on the edit input, so a padded
// over-32 value can only reach editText by SHRINKING a legacy over-limit item
// (the shrink clause `itemCharCount(next) <= itemCharCount(prev)`). We seed such a
// legacy item via the load GET (sanitizeTodos trims whitespace but does NOT enforce
// length, so a 40-char non-whitespace item is grandfathered in), start editing it
// (startEdit prefills verbatim, bypassing capText), then shrink to the padded
// value and commit. This exercises the real commitEdit boundary the adversary
// attacked — no stub of commitEdit itself.
//
// Conventions mirror tests/App.a11y.test.jsx: happy-dom, fetch stub, afterEach
// cleanup, jest-dom/vitest matchers, fireEvent only (no user-event dep).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import App from '../src/App.jsx';

afterEach(cleanup);

const LEGACY_ID = 'legacy-over-limit';
// A 40-char legacy item with NO surrounding whitespace: survives sanitizeTodos
// (which trims but does not truncate) as a grandfathered over-limit item. Its
// 40-char length is what lets capText's shrink clause admit a padded 33-char value.
const LEGACY_TEXT = 'a'.repeat(40);

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'PUT') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      // GET: hydrate with a single legacy over-limit item.
      return {
        ok: true,
        json: async () => [
          { id: LEGACY_ID, text: LEGACY_TEXT, completed: false },
        ],
      };
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ISSUE-35-F5 — commitEdit measures trimmed text, not raw', () => {
  it('commits an edit whose raw text is >32 only due to trailing whitespace (trimmed <=32)', async () => {
    render(<App />);
    // Settle hydration: the legacy 40-char item loads and renders.
    expect(await screen.findByText(LEGACY_TEXT)).toBeInTheDocument();

    // Enter edit mode — startEdit prefills editText verbatim with the 40-char value.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = screen.getByLabelText('Edit todo');

    // Shrink to 31 real chars + 2 trailing spaces = 33 raw code points, 31 trimmed.
    // capText admits it because 33 <= 40 (the current value), so editText holds the
    // padded value at commit time.
    const trimmed = 'b'.repeat(31);
    const padded = `${trimmed}  `;
    fireEvent.change(edit, { target: { value: padded } });
    expect(edit).toHaveValue(padded);

    // Commit via Enter.
    fireEvent.keyDown(edit, { key: 'Enter' });

    // POST-FIX: trimmed length 31 <= 32 -> commit; editTodo trims -> stored text is
    // the 31-char 'b' string, edit mode exits, no over-limit notice.
    // PRE-FIX: raw length 33 > 32 -> refused; the trimmed text never commits and
    // this findByText would time out -> the test fails, catching the defect.
    await waitFor(() => {
      expect(screen.getByText(trimmed)).toBeInTheDocument();
    });
    // Edit mode exited (the input is gone) and the legacy value is replaced.
    expect(screen.queryByLabelText('Edit todo')).not.toBeInTheDocument();
    expect(screen.queryByText(LEGACY_TEXT)).not.toBeInTheDocument();
    // No over-limit notice was surfaced.
    expect(
      screen.queryByText(/limited to 32 characters/i)
    ).not.toBeInTheDocument();
  });

  it('still refuses an edit whose TRIMMED text is genuinely >32 (fix did not over-loosen)', async () => {
    render(<App />);
    expect(await screen.findByText(LEGACY_TEXT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = screen.getByLabelText('Edit todo');

    // 33 non-whitespace chars: trimmed is still 33 > 32. capText admits it (33 <= 40),
    // but commitEdit must refuse.
    const overLimit = 'c'.repeat(33);
    fireEvent.change(edit, { target: { value: overLimit } });
    expect(edit).toHaveValue(overLimit);

    fireEvent.keyDown(edit, { key: 'Enter' });

    // Refused: the over-limit notice shows and the row stays in edit mode (INV-4:
    // no truncation, no commit).
    expect(
      await screen.findByText(/limited to 32 characters/i)
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Edit todo')).toBeInTheDocument();
  });

  it('commits an exactly-32 trimmed edit that is 34 raw with padding (boundary)', async () => {
    render(<App />);
    expect(await screen.findByText(LEGACY_TEXT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = screen.getByLabelText('Edit todo');

    // 32 real chars + 2 trailing spaces = 34 raw, 32 trimmed (exactly the cap).
    const trimmed = 'd'.repeat(32);
    const padded = `${trimmed}  `;
    fireEvent.change(edit, { target: { value: padded } });

    fireEvent.keyDown(edit, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(trimmed)).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/limited to 32 characters/i)
    ).not.toBeInTheDocument();
  });
});
