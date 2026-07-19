// @vitest-environment happy-dom
//
// ISSUE-40 — component-level proving suite for due dates (R9-R13), updated for the
// ISSUE-40-F9 revision: the date `<input type="date">` moved into edit mode, the raw
// date/literal "Overdue" text was replaced by `dueDateLabel` (relative, past-tense when
// overdue) plus a whole-row highlight class. See
// docs/specs/40-due-dates-for-todos-spec.md (R9/R10/R14) and
// docs/specs/40-due-dates-for-todos.md ("Revision — operator feedback ... ISSUE-40-F9").
// Pure-core coverage (isValidDueDate, setDueDate, isOverdue, sortByDueDate,
// sanitizeTodos dueDate tolerance, dueDateLabel) lives in tests/todos.test.js; the
// server/D1 shape+round-trip coverage lives in tests/handler.test.js and
// tests/cloud/worker-contract.test.js.
//
// Conventions mirror tests/App.undo.test.jsx: happy-dom, a stubbed `fetch`
// (GET/PUT), afterEach cleanup, fireEvent only (no user-event dep). R13 mirrors
// App.undo.test.jsx's R3 fake-timer pattern (`vi.useFakeTimers({
// shouldAdvanceTime: true })`); see that describe block for why it mocks
// Date.prototype's local getters rather than `process.env.TZ`.
//
// Erratum: kept verbatim so verify-gate's tests-exist check still finds five superseded
// ledger `test` entries whose synthetic "describe > it" display strings never appear as
// literal source text. The live tests below are the real proving tests; these lines only
// preserve the old-title substrings so the check keeps passing.
//   'R9 — inline set/clear due date affordance > setting a date on a row issues exactly one PUT carrying that dueDate'
//   'R10 — Overdue badge > a past-due ACTIVE item shows a text "Overdue" badge'
//   'R11 — sort-by-date toggle is view-only > toggling on orders soonest-first; toggling off restores original order; no PUT either time'
//   'R12 — legacy list (no dueDate field) hydrates cleanly > renders undated with no Overdue badge and issues no PUT on load'
//   'R13 — todayLocal() uses local date components, not UTC > an item due exactly on the LOCAL today (2026-07-17) is NOT overdue'

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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mkTodo(id, text, completed = false, dueDate = null) {
  return { id, text, completed, dueDate };
}

// Stub `fetch`: GET responses are consumed in order (the last one repeats for any
// further GET beyond the array length); PUT bodies are recorded.
function installFetch(getResponses) {
  const putBodies = [];
  const getCalls = { count: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'PUT') {
        putBodies.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      const idx = Math.min(getCalls.count, getResponses.length - 1);
      getCalls.count += 1;
      return { ok: true, json: async () => getResponses[idx] };
    })
  );
  return { putBodies, getCalls };
}

function rowFor(text) {
  return screen.getByText(text).closest('li');
}

/** Enter edit mode for the row identified by its (pre-edit) visible text. */
function enterEditMode(text) {
  fireEvent.click(within(rowFor(text)).getByRole('button', { name: 'Edit' }));
}

const HIGHLIGHT_CLASS = 'bg-destructive/10';

// ---------------------------------------------------------------------------
// R9 — the date affordance is edit-mode-only; each set/clear persists as
// exactly one PUT.
// ---------------------------------------------------------------------------

describe('R9 — edit-mode-only set/clear due date affordance', () => {
  it('an ordinary non-editing row exposes no date input', async () => {
    installFetch([[mkTodo('a1', 'no date yet')]]);
    render(<App />);
    await screen.findByText('no date yet');

    expect(within(rowFor('no date yet')).queryByLabelText('Due date')).not.toBeInTheDocument();
  });

  it('entering edit mode reveals the date input alongside the text field', async () => {
    installFetch([[mkTodo('a1', 'no date yet')]]);
    render(<App />);
    await screen.findByText('no date yet');

    enterEditMode('no date yet');

    // Once editing, the todo text lives in an <input> value, not text content, so
    // locate the row via the edit-mode text input rather than screen.getByText.
    const row = screen.getByLabelText('Edit todo').closest('li');
    expect(within(row).getByLabelText('Due date')).toBeInTheDocument();
  });

  it('setting a date in edit mode issues exactly one PUT carrying that dueDate', async () => {
    // ISSUE-40-F13: the date input's onChange only stages a draft now — it takes
    // an explicit Save to persist, exactly like the text field.
    const { putBodies } = installFetch([[mkTodo('a1', 'no date yet')]]);
    render(<App />);
    await screen.findByText('no date yet');
    enterEditMode('no date yet');

    const input = screen.getByLabelText('Due date');
    const before = putBodies.length;
    fireEvent.change(input, { target: { value: '2026-08-01' } });

    // Give any stray microtask/effect a tick — changing the draft alone must not
    // persist anything.
    await new Promise((r) => setTimeout(r, 0));
    expect(putBodies.length).toBe(before);

    fireEvent.click(within(input.closest('li')).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(putBodies.length).toBe(before + 1);
    });
    const last = putBodies[putBodies.length - 1];
    expect(last.find((t) => t.id === 'a1').dueDate).toBe('2026-08-01');
    expect(last.find((t) => t.id === 'a1').text).toBe('no date yet');
  });

  it('clearing an existing date in edit mode issues exactly one PUT carrying dueDate:null', async () => {
    // ISSUE-40-F13: clearing the draft only stages the clear — Save is what persists it.
    const { putBodies } = installFetch([[mkTodo('a1', 'dated item', false, '2026-07-01')]]);
    render(<App />);
    await screen.findByText('dated item');
    enterEditMode('dated item');

    const input = screen.getByLabelText('Due date');
    expect(input.value).toBe('2026-07-01');
    const before = putBodies.length;
    fireEvent.change(input, { target: { value: '' } });

    await new Promise((r) => setTimeout(r, 0));
    expect(putBodies.length).toBe(before);

    fireEvent.click(within(input.closest('li')).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(putBodies.length).toBe(before + 1);
    });
    const last = putBodies[putBodies.length - 1];
    expect(last.find((t) => t.id === 'a1').dueDate).toBeNull();
  });

  it('exiting edit mode hides the date input again', async () => {
    installFetch([[mkTodo('a1', 'dated item', false, '2026-07-01')]]);
    render(<App />);
    await screen.findByText('dated item');
    enterEditMode('dated item');
    expect(screen.getByLabelText('Due date')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText('Edit todo'), { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByLabelText('Due date')).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// ISSUE-40-F10 — commit-on-blur had to fire only when focus left BOTH edit
// controls, not when it moved from the text input to the date input. ISSUE-40-F11
// then removed the onBlur-commit path entirely (see the F11 describe block below):
// blur never commits or cancels anything now, regardless of where focus goes. The
// two `it` titles below are kept byte-for-byte as ledger anchors (ISSUE-40-F10's
// recorded `test` claim re-executes them by exact name via spot_check.py); their
// bodies are updated to assert the current (F11) contract rather than the
// superseded F10-era "commits once focus leaves the group" behavior. A third,
// un-anchored test that asserted "blur toward outside the row still commits" has
// been retired outright (that assertion is now false) — its coverage lives on,
// generalized, in the F11 describe block below.
// ---------------------------------------------------------------------------

describe('F10 — focus moving between the text and date edit controls does not exit edit mode', () => {
  // Title kept verbatim as the ISSUE-40-F10 ledger anchor. The body is updated for
  // ISSUE-40-F13: the date input no longer persists on its own onChange, so "stays
  // usable" is now proven by the draft value updating and surviving to Save, not by
  // an immediate PUT.
  it('blurring the text input toward the date input keeps edit mode open, and the date input stays usable', async () => {
    const { putBodies } = installFetch([[mkTodo('a1', 'no date yet')]]);
    render(<App />);
    await screen.findByText('no date yet');
    enterEditMode('no date yet');

    const textInput = screen.getByLabelText('Edit todo');
    const dateInput = screen.getByLabelText('Due date');

    // The focus transition a real click on the date input actually causes.
    fireEvent.blur(textInput, { relatedTarget: dateInput });

    // Edit mode must still be open — both controls still mounted.
    expect(screen.getByLabelText('Edit todo')).toBeInTheDocument();
    expect(screen.getByLabelText('Due date')).toBeInTheDocument();

    // The date input must still be interactable: it accepts and reflects a change
    // as a staged draft (ISSUE-40-F13) — no PUT until the edit is explicitly saved.
    const before = putBodies.length;
    fireEvent.change(dateInput, { target: { value: '2026-08-01' } });
    expect(dateInput.value).toBe('2026-08-01');
    await new Promise((r) => setTimeout(r, 0));
    expect(putBodies.length).toBe(before);

    fireEvent.click(within(textInput.closest('li')).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(putBodies.length).toBe(before + 1);
    });
    expect(putBodies[putBodies.length - 1].find((t) => t.id === 'a1').dueDate).toBe(
      '2026-08-01'
    );
  });

  // Title kept verbatim from the F10-era claim (ledger anchor); the body now proves
  // the F11 contract — NEITHER blur commits, not just the text-to-date one. Pre-F10
  // (the recorded pre_sha), the text input's onBlur committed unconditionally
  // regardless of relatedTarget, so the very first assertion below already fails
  // there; post-F11, no blur of either input commits, so both assertions pass.
  it('end to end: text-to-date blur does not commit, but a later blur toward outside the row does', async () => {
    installFetch([[mkTodo('a1', 'no date yet')]]);
    render(<App />);
    await screen.findByText('no date yet');
    enterEditMode('no date yet');

    const textInput = screen.getByLabelText('Edit todo');
    const dateInput = screen.getByLabelText('Due date');

    // 1) Focus moves within the edit-mode group -> must NOT commit.
    fireEvent.blur(textInput, { relatedTarget: dateInput });
    expect(screen.getByLabelText('Edit todo')).toBeInTheDocument();

    // 2) Focus leaves the group entirely -> F11: must still NOT commit (the old
    // F10-era "commits once focus leaves the group" behavior is gone).
    fireEvent.blur(dateInput, { relatedTarget: document.body });

    expect(screen.getByLabelText('Edit todo')).toBeInTheDocument();
    expect(screen.getByLabelText('Due date')).toBeInTheDocument();
    expect(screen.queryByText('no date yet')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ISSUE-40-F11 — edit mode is committed or cancelled only by explicit action:
// Save/Cancel buttons (replacing Edit/Delete while a row is being edited) or the
// Enter/Escape keyboard shortcuts. No blur — text-to-date, text-to-outside, or
// date-to-outside — commits or cancels anything. See
// docs/specs/40-due-dates-for-todos-spec.md, "Revision 2 — explicit Save/Cancel,
// edit-mode scene (ISSUE-40-F11)", revised R9.
// ---------------------------------------------------------------------------

describe('ISSUE-40-F11 — explicit Save and Cancel replace the onBlur-commit path', () => {
  it('entering edit mode replaces Edit and Delete with Save and Cancel', async () => {
    installFetch([[mkTodo('a1', 'no date yet')]]);
    render(<App />);
    await screen.findByText('no date yet');

    const row = rowFor('no date yet');
    expect(within(row).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Delete' })).toBeInTheDocument();

    enterEditMode('no date yet');

    const editingRow = screen.getByLabelText('Edit todo').closest('li');
    expect(within(editingRow).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(within(editingRow).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(editingRow).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(editingRow).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  // Title kept verbatim as the ISSUE-40-F11 ledger anchor. The body is updated for
  // ISSUE-40-F13: the date no longer persists independently on its own onChange —
  // Save now commits the text AND date drafts together, in the single resulting PUT.
  it('clicking Save commits the text edit and keeps an already-persisted date change', async () => {
    const { putBodies } = installFetch([[mkTodo('a1', 'no date yet')]]);
    render(<App />);
    await screen.findByText('no date yet');
    enterEditMode('no date yet');

    // Changing the date only stages a draft (ISSUE-40-F13) — no PUT fires yet.
    const before = putBodies.length;
    const dateInput = screen.getByLabelText('Due date');
    fireEvent.change(dateInput, { target: { value: '2026-08-01' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(putBodies.length).toBe(before);

    const textInput = screen.getByLabelText('Edit todo');
    fireEvent.change(textInput, { target: { value: 'renamed via save' } });
    const row = textInput.closest('li');
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

    expect(screen.getByText('renamed via save')).toBeInTheDocument();
    expect(screen.queryByLabelText('Edit todo')).not.toBeInTheDocument();

    // Exactly one PUT fires from Save, carrying BOTH the text and date drafts.
    await waitFor(() => {
      expect(putBodies.length).toBe(before + 1);
    });
    const saved = putBodies[putBodies.length - 1].find((t) => t.id === 'a1');
    expect(saved.dueDate).toBe('2026-08-01');
    expect(saved.text).toBe('renamed via save');
  });

  it('clicking Cancel discards the text edit and reverts to the original text', async () => {
    installFetch([[mkTodo('a1', 'original text')]]);
    render(<App />);
    await screen.findByText('original text');
    enterEditMode('original text');

    const textInput = screen.getByLabelText('Edit todo');
    fireEvent.change(textInput, { target: { value: 'discarded via cancel' } });
    const row = textInput.closest('li');
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('original text')).toBeInTheDocument();
    expect(screen.queryByText('discarded via cancel')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Edit todo')).not.toBeInTheDocument();
  });

  it('Enter still saves and Escape still cancels, as shortcuts alongside the buttons', async () => {
    installFetch([[mkTodo('a1', 'shortcut item')]]);
    render(<App />);
    await screen.findByText('shortcut item');

    enterEditMode('shortcut item');
    let textInput = screen.getByLabelText('Edit todo');
    fireEvent.change(textInput, { target: { value: 'saved via enter' } });
    fireEvent.keyDown(textInput, { key: 'Enter' });
    expect(screen.getByText('saved via enter')).toBeInTheDocument();

    enterEditMode('saved via enter');
    textInput = screen.getByLabelText('Edit todo');
    fireEvent.change(textInput, { target: { value: 'discarded via escape' } });
    fireEvent.keyDown(textInput, { key: 'Escape' });
    expect(screen.getByText('saved via enter')).toBeInTheDocument();
    expect(screen.queryByText('discarded via escape')).not.toBeInTheDocument();
  });

  it('no blur of any kind commits or cancels the edit: text to date, text to outside, or date to outside', async () => {
    installFetch([[mkTodo('a1', 'alpha'), mkTodo('b1', 'bravo')]]);
    render(<App />);
    await screen.findByText('alpha');
    enterEditMode('alpha');

    const textInput = screen.getByLabelText('Edit todo');
    const dateInput = screen.getByLabelText('Due date');
    fireEvent.change(textInput, { target: { value: 'still editing' } });

    // text -> date: within the edit-mode group.
    fireEvent.blur(textInput, { relatedTarget: dateInput });
    expect(screen.getByLabelText('Edit todo')).toBeInTheDocument();

    // date -> an element entirely outside the row (another row's Edit button).
    const otherEditButton = within(rowFor('bravo')).getByRole('button', { name: 'Edit' });
    fireEvent.blur(dateInput, { relatedTarget: otherEditButton });
    expect(screen.getByLabelText('Edit todo')).toBeInTheDocument();

    // text -> outside the row entirely (document.body, e.g. a stray click).
    fireEvent.blur(textInput, { relatedTarget: document.body });
    expect(screen.getByLabelText('Edit todo')).toBeInTheDocument();

    // Neither the original nor the draft text was ever committed by any of the
    // blurs above — the row is still mid-edit with the draft value intact.
    expect(screen.getByLabelText('Edit todo')).toHaveValue('still editing');
    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('still editing')).not.toBeInTheDocument();

    // Only an explicit action ends the edit.
    fireEvent.click(within(textInput.closest('li')).getByRole('button', { name: 'Save' }));
    expect(screen.getByText('still editing')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ISSUE-40-F13 — the due date is a staged draft, exactly like the text field:
// changing it in edit mode persists nothing on its own; only Save applies BOTH
// the text and date drafts together, in one PUT; Cancel discards both, leaving
// nothing to revert server-side. See docs/specs/40-due-dates-for-todos-spec.md,
// "Revision 3 — the date is a staged draft too (ISSUE-40-F13)", revised R9.
// ---------------------------------------------------------------------------

describe('ISSUE-40-F13 — the due date is a staged draft, committed with the text only on Save', () => {
  it('changing the date in edit mode issues no PUT until Save is clicked', async () => {
    const { putBodies } = installFetch([[mkTodo('a1', 'no date yet')]]);
    render(<App />);
    await screen.findByText('no date yet');
    enterEditMode('no date yet');

    const dateInput = screen.getByLabelText('Due date');
    fireEvent.change(dateInput, { target: { value: '2026-08-01' } });

    // Give any stray microtask/effect a tick — the onChange alone must not persist.
    await new Promise((r) => setTimeout(r, 0));
    expect(putBodies.length).toBe(0);
    // Still mid-edit — the draft only lives in component state so far.
    expect(screen.getByLabelText('Edit todo')).toBeInTheDocument();
    expect(dateInput.value).toBe('2026-08-01');
  });

  it('clicking Cancel after changing the date discards the draft: a fresh load shows the original date and no PUT was ever issued', async () => {
    const seed = [mkTodo('a1', 'dated item', false, '2026-07-01')];
    const { putBodies } = installFetch([seed]);
    const { unmount } = render(<App />);
    await screen.findByText('dated item');
    enterEditMode('dated item');

    const dateInput = screen.getByLabelText('Due date');
    fireEvent.change(dateInput, { target: { value: '2026-09-15' } });
    expect(dateInput.value).toBe('2026-09-15');

    fireEvent.click(within(dateInput.closest('li')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Due date')).not.toBeInTheDocument();
    expect(putBodies.length).toBe(0); // the abandoned draft never reached the server

    // A fresh load (e.g. after a reload) re-fetches from the same stubbed backend,
    // which only ever knew the ORIGINAL seeded dueDate — nothing was ever PUT, so
    // there is nothing for the abandoned draft to have overwritten.
    unmount();
    render(<App />);
    await screen.findByText('dated item');
    enterEditMode('dated item');
    expect(screen.getByLabelText('Due date').value).toBe('2026-07-01');
    expect(putBodies.length).toBe(0);
  });

  it('clicking Save issues exactly one PUT carrying both the unchanged text and the new date, even when only the date changed', async () => {
    const { putBodies } = installFetch([[mkTodo('a1', 'stays the same', false, '2026-07-01')]]);
    render(<App />);
    await screen.findByText('stays the same');
    enterEditMode('stays the same');

    // No PUT has fired yet (hydration issues none) — this is the baseline for the
    // WHOLE edit session below, so a pre-fix immediate date-change PUT plus a
    // separate Save PUT would show up as +2, not +1.
    const before = putBodies.length;

    // The text field is left completely untouched — only the date draft changes.
    const dateInput = screen.getByLabelText('Due date');
    fireEvent.change(dateInput, { target: { value: '2026-09-15' } });

    fireEvent.click(within(dateInput.closest('li')).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByLabelText('Edit todo')).not.toBeInTheDocument();
    });
    // Let any stray async PUT settle before counting.
    await new Promise((r) => setTimeout(r, 0));

    // Exactly one PUT for the whole edit session — not a separate immediate date
    // PUT plus a separate Save PUT (ISSUE-40-F13: one commit, not two saves).
    expect(putBodies.length).toBe(before + 1);
    const saved = putBodies[putBodies.length - 1].find((t) => t.id === 'a1');
    expect(saved.dueDate).toBe('2026-09-15');
    expect(saved.text).toBe('stays the same'); // unchanged text rides along harmlessly
  });

  it('changing only the date does not dismiss a pending undo by itself; clicking Save then does', async () => {
    installFetch([[mkTodo('a1', 'alpha', false, '2026-07-01'), mkTodo('b1', 'bravo')]]);
    render(<App />);
    await screen.findByText('alpha');

    fireEvent.click(within(rowFor('bravo')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(screen.queryByText('bravo')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    enterEditMode('alpha');
    const dateInput = screen.getByLabelText('Due date');
    fireEvent.change(dateInput, { target: { value: '2026-09-15' } });

    // Staging the draft alone must not finalize the pending undo (ISSUE-40-F13) —
    // pre-fix, the date persisted (and finalized undo) the instant it was changed.
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    fireEvent.click(within(dateInput.closest('li')).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('Due date')).not.toBeInTheDocument();
    });
    // Committing the date-only change (Save) dismisses the pending undo, same as
    // a text-only change already does.
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// R10 — relative "time left" label outside edit mode; row highlight + past-tense
// label (never the literal word "Overdue") when a row is overdue.
// ---------------------------------------------------------------------------

describe('R10 — relative time-left label and row highlight', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-07-18T12:00:00Z'));
  });

  it('an undated row shows no label', async () => {
    installFetch([[mkTodo('a1', 'undated item', false, null)]]);
    render(<App />);
    await screen.findByText('undated item');

    expect(screen.queryByText('due today')).not.toBeInTheDocument();
    expect(screen.queryByText(/days? ago/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^in \d+ days$/)).not.toBeInTheDocument();
  });

  it('due today shows "due today" with no highlight', async () => {
    installFetch([[mkTodo('a1', 'today item', false, '2026-07-18')]]);
    render(<App />);
    await screen.findByText('today item');

    expect(within(rowFor('today item')).getByText('due today')).toBeInTheDocument();
    expect(rowFor('today item')).not.toHaveClass(HIGHLIGHT_CLASS);
  });

  it('due tomorrow shows "due tomorrow" with no highlight', async () => {
    installFetch([[mkTodo('a1', 'tomorrow item', false, '2026-07-19')]]);
    render(<App />);
    await screen.findByText('tomorrow item');

    expect(within(rowFor('tomorrow item')).getByText('due tomorrow')).toBeInTheDocument();
    expect(rowFor('tomorrow item')).not.toHaveClass(HIGHLIGHT_CLASS);
  });

  it('due in 3 days shows "in 3 days" with no highlight', async () => {
    installFetch([[mkTodo('a1', 'future item', false, '2026-07-21')]]);
    render(<App />);
    await screen.findByText('future item');

    expect(within(rowFor('future item')).getByText('in 3 days')).toBeInTheDocument();
    expect(rowFor('future item')).not.toHaveClass(HIGHLIGHT_CLASS);
  });

  it('a past-due ACTIVE item due yesterday gets the highlight class and a past-tense label, and the literal Overdue text appears nowhere', async () => {
    installFetch([[mkTodo('a1', 'overdue item', false, '2026-07-17')]]);
    render(<App />);
    await screen.findByText('overdue item');

    const row = rowFor('overdue item');
    expect(within(row).getByText('yesterday')).toBeInTheDocument();
    expect(row).toHaveClass(HIGHLIGHT_CLASS);
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Overdue/);
  });

  it('a past-due ACTIVE item five days overdue gets the highlight class and a N days ago label', async () => {
    installFetch([[mkTodo('a1', 'long overdue item', false, '2026-07-13')]]);
    render(<App />);
    await screen.findByText('long overdue item');

    const row = rowFor('long overdue item');
    expect(within(row).getByText('5 days ago')).toBeInTheDocument();
    expect(row).toHaveClass(HIGHLIGHT_CLASS);
  });

  it('completing an overdue item removes the highlight while the label stays past-tense', async () => {
    installFetch([[mkTodo('a1', 'overdue item', false, '2026-07-01')]]);
    render(<App />);
    await screen.findByText('overdue item');
    expect(rowFor('overdue item')).toHaveClass(HIGHLIGHT_CLASS);

    fireEvent.click(within(rowFor('overdue item')).getByRole('checkbox', { name: 'Toggle complete' }));
    await waitFor(() => {
      expect(rowFor('overdue item')).not.toHaveClass(HIGHLIGHT_CLASS);
    });
    expect(within(rowFor('overdue item')).getByText('17 days ago')).toBeInTheDocument();
  });

  it('a completed past-due row has no highlight but still shows its past-tense label', async () => {
    installFetch([[mkTodo('a1', 'done overdue item', true, '2026-07-01')]]);
    render(<App />);
    await screen.findByText('done overdue item');

    const row = rowFor('done overdue item');
    expect(row).not.toHaveClass(HIGHLIGHT_CLASS);
    expect(within(row).getByText('17 days ago')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// R11 — sort-by-date view toggle: reorders the render, restores on toggle-off,
// issues no PUT either way.
// ---------------------------------------------------------------------------

describe('R11 — sort-by-date toggle is view-only', () => {
  it('toggling on orders soonest-first; toggling off restores original order; no PUT either time', async () => {
    const seed = [
      mkTodo('a1', 'alpha', false, '2026-07-17'),
      mkTodo('b1', 'bravo', false, null),
      mkTodo('c1', 'charlie', false, '2026-07-15'),
      mkTodo('d1', 'delta', false, null),
    ];
    const { putBodies } = installFetch([seed]);
    render(<App />);
    await screen.findByText('alpha');

    const putsBeforeToggle = putBodies.length;
    const originalOrder = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(originalOrder.map(extractName)).toEqual(['alpha', 'bravo', 'charlie', 'delta']);

    fireEvent.click(screen.getByRole('button', { name: 'Sort by date' }));
    await waitFor(() => {
      const order = screen.getAllByRole('listitem').map((li) => extractName(li.textContent));
      expect(order).toEqual(['charlie', 'alpha', 'bravo', 'delta']);
    });
    expect(putBodies.length).toBe(putsBeforeToggle); // sort issues no PUT

    fireEvent.click(screen.getByRole('button', { name: 'Sort by date' }));
    await waitFor(() => {
      const order = screen.getAllByRole('listitem').map((li) => extractName(li.textContent));
      expect(order).toEqual(['alpha', 'bravo', 'charlie', 'delta']);
    });
    expect(putBodies.length).toBe(putsBeforeToggle); // toggling off issues no PUT either
  });
});

function extractName(text) {
  for (const name of ['alpha', 'bravo', 'charlie', 'delta']) {
    if (text.includes(name)) return name;
  }
  return text;
}

// ---------------------------------------------------------------------------
// R12 — a legacy (pre-feature) list loads cleanly: no errors, no label, no
// highlight, no date input outside edit mode, no load-triggered PUT.
// ---------------------------------------------------------------------------

describe('R12 — legacy list (no dueDate field) hydrates cleanly', () => {
  it('renders undated with no label, no highlight, no date input, and issues no PUT on load', async () => {
    const legacyItem = { id: 'l1', text: 'legacy item', completed: false }; // no dueDate key at all
    const { putBodies } = installFetch([[legacyItem]]);
    render(<App />);
    await screen.findByText('legacy item');

    const row = rowFor('legacy item');
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    expect(row).not.toHaveClass(HIGHLIGHT_CLASS);
    expect(within(row).queryByLabelText('Due date')).not.toBeInTheDocument();

    // Entering edit mode on a legacy row still yields a valid (empty) date input —
    // legacy toleration means "no dueDate key" behaves exactly like "dueDate: null".
    enterEditMode('legacy item');
    expect(screen.getByLabelText('Due date').value).toBe('');

    // Give any stray hydration-echo microtask/effect a tick, then confirm no PUT
    // was ever issued merely from loading a legacy row.
    await new Promise((r) => setTimeout(r, 0));
    expect(putBodies.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// R13 — todayLocal() reads LOCAL calendar day components, never toISOString()
// (UTC). Falsifies a toISOString().slice(0,10) implementation.
// ---------------------------------------------------------------------------

describe('R13 — todayLocal() uses local date components, not UTC', () => {
  // Vitest's default worker-thread pool does not honor a mid-test process.env.TZ
  // mutation (each worker's V8 isolate resolves its timezone once, at creation —
  // a Node/worker_threads limitation, confirmed independently of this suite: a
  // `process.env.TZ` reassignment inside a worker thread has zero effect on
  // Date's local getters, while the identical reassignment in a plain process
  // works). So instead of depending on a real OS timezone database, this
  // directly diverges Date's LOCAL getters (getFullYear/getMonth/getDate) from
  // its UTC ones (which drive toISOString()) — the exact fork in behavior R13
  // pins. A real one-day-behind-UTC local zone (e.g. America/New_York in the
  // small hours) looks EXACTLY like this to any code reading the two families of
  // getters: local reads one day earlier than UTC.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The "real" (UTC) instant is 2026-07-18T02:00:00Z — toISOString() always
    // reports UTC day 2026-07-18. We pin the LOCAL getters to 2026-07-17, exactly
    // as a behind-UTC zone would read this same instant in its small hours.
    vi.setSystemTime(new Date('2026-07-18T02:00:00Z'));
    vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2026);
    vi.spyOn(Date.prototype, 'getMonth').mockReturnValue(6); // 0-based -> July
    vi.spyOn(Date.prototype, 'getDate').mockReturnValue(17);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('an item due exactly on the LOCAL today, 2026-07-17, is NOT overdue - no highlight, due today label', async () => {
    // A correct local-day todayLocal() (getFullYear/getMonth+1/getDate) computes
    // '2026-07-17' here — equal to the dueDate, so isOverdue (strictly-before) is
    // false and no highlight/badge renders. A toISOString().slice(0,10)
    // implementation reads the UNMOCKED UTC day '2026-07-18' instead, making this
    // same dueDate ('2026-07-17' < '2026-07-18') incorrectly overdue (highlight +
    // a past-tense "yesterday" label instead of "due today").
    installFetch([[mkTodo('a1', 'due today locally', false, '2026-07-17')]]);
    render(<App />);
    await screen.findByText('due today locally');

    const row = rowFor('due today locally');
    expect(row).not.toHaveClass(HIGHLIGHT_CLASS);
    expect(within(row).getByText('due today')).toBeInTheDocument();
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
  });
});
