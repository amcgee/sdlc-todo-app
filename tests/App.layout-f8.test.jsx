// @vitest-environment happy-dom
//
// ISSUE-40-F8 — component-level proving suite for the operator layout feedback fix:
// long todo text truncates (with a full-text `title`) instead of wrapping, and the
// per-row trailing Edit/Delete controls are grouped in their own cluster distinct
// from the checkbox and text.
//
// Updated for ISSUE-40-F9: the date affordance moved into edit mode (it no longer
// sits in the always-visible trailing-controls group with Edit/Delete — see
// docs/specs/40-due-dates-for-todos.md, "Revision — operator feedback ...
// ISSUE-40-F9"). The grouping claim here is now scoped to Edit/Delete only; the
// date-input assertions were rewritten to (a) require entering edit mode to find
// the input at all, and (b) pin the new fact that in edit mode the date input sits
// directly in the row, NOT inside the Edit/Delete wrapper, rather than silently
// dropping coverage of where the date input lives.
//
// Updated again for ISSUE-40-F10: the text and date inputs now share a wrapping
// <div>, so the date input's direct parent is that div, not the row <li> — the
// assertion below now checks the *grandparent*. The test's title is kept verbatim
// (it is a ledger anchor re-executed by spot_check.py).
//
// Updated again for ISSUE-40-F11: while a row is being edited its trailing-controls
// group shows Save/Cancel, not Edit/Delete (the wrapping div's onBlur from the F10
// fix is gone entirely — commit/cancel is explicit-only now). The grouping
// assertion below locates that group via the Save button instead of Edit.
//
// Conventions mirror tests/App.duedate.test.jsx: happy-dom, a stubbed `fetch`
// (GET/PUT), afterEach cleanup, fireEvent only (no user-event dep).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import App from '../src/App.jsx';

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
});

function mkTodo(id, text, completed = false, dueDate = null) {
  return { id, text, completed, dueDate };
}

// Stub `fetch`: a single GET response, no PUTs expected in this suite.
function installFetch(getResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'PUT') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => getResponse };
    })
  );
}

function rowFor(text) {
  return screen.getByText(text).closest('li');
}

const LONG_TEXT =
  'A very long todo item description that would previously wrap across several lines inside the card instead of being truncated with an ellipsis and a hover title';

describe('F8 — long todo text truncates with a full-text title', () => {
  it('the todo-text span carries the full text as its title attribute', async () => {
    installFetch([mkTodo('a1', LONG_TEXT)]);
    render(<App />);
    const textEl = await screen.findByText(LONG_TEXT);

    expect(textEl.tagName).toBe('SPAN');
    expect(textEl).toHaveAttribute('title', LONG_TEXT);
  });

  it('the todo-text span has the truncate class applied so it degrades to one line', async () => {
    installFetch([mkTodo('a1', LONG_TEXT)]);
    render(<App />);
    const textEl = await screen.findByText(LONG_TEXT);

    expect(textEl).toHaveClass('truncate');
    expect(textEl).toHaveClass('min-w-0');
  });
});

describe('F8 — trailing per-row controls are grouped separately from the checkbox and text', () => {
  // Title kept verbatim from the original F8 proving test — it is the named anchor for
  // an already-recorded ledger `test` entry (ISSUE-40-F8) that re-executes this exact
  // string via spot_check.py. Its assertions are updated for ISSUE-40-F9 (the date input
  // is no longer part of this group at all — see the edit-mode test below), but the
  // Edit/Delete grouping claim the title names is still true and still what's checked.
  it('the due-date input and the Edit/Delete buttons share a wrapper distinct from the row itself', async () => {
    installFetch([mkTodo('a1', 'grouped controls item')]);
    render(<App />);
    await screen.findByText('grouped controls item');

    const row = rowFor('grouped controls item');
    const editButton = within(row).getByRole('button', { name: 'Edit' });
    const deleteButton = within(row).getByRole('button', { name: 'Delete' });

    // Edit/Delete must be co-located in a single wrapping element that is NOT the
    // row <li> itself (i.e. an actual sub-group, not just loose siblings directly
    // inside the row alongside the checkbox and text).
    expect(editButton.parentElement).not.toBe(row);
    expect(editButton.parentElement).toBe(deleteButton.parentElement);
  });

  it("the controls group does not also contain the row's checkbox", async () => {
    installFetch([mkTodo('a1', 'grouped controls item 2')]);
    render(<App />);
    await screen.findByText('grouped controls item 2');

    const row = rowFor('grouped controls item 2');
    const checkbox = within(row).getByRole('checkbox', { name: 'Toggle complete' });
    const editButton = within(row).getByRole('button', { name: 'Edit' });

    expect(editButton.parentElement).not.toContainElement(checkbox);
  });

  it('in edit mode, the date input sits directly in the row, not inside the Edit or Delete wrapper', async () => {
    installFetch([mkTodo('a1', 'grouped controls item 3')]);
    render(<App />);
    await screen.findByText('grouped controls item 3');

    fireEvent.click(within(rowFor('grouped controls item 3')).getByRole('button', { name: 'Edit' }));

    const dateInput = screen.getByLabelText('Due date');
    const row = dateInput.closest('li');
    // F11: while editing, the trailing-controls group shows Save/Cancel (not
    // Edit/Delete) — locate that group via the Save button instead.
    const saveButton = within(row).getByRole('button', { name: 'Save' });

    // F10: the date input shares a wrapping <div> with the text input (so a single
    // onBlur on that div can tell focus moving between them apart from focus
    // leaving both) — that div is a direct child of the row, distinct from the
    // Save/Cancel wrapper.
    expect(dateInput.parentElement.parentElement).toBe(row);
    expect(dateInput.parentElement).not.toBe(saveButton.parentElement);
  });
});

describe('F8 — the due-date field uses the shared Input component, not a bare native input', () => {
  it("carries the shared Input component's bordered, rounded-corner styling, not the old borderless native input", async () => {
    installFetch([mkTodo('a1', 'styled date field item')]);
    render(<App />);
    await screen.findByText('styled date field item');

    // ISSUE-40-F9: the date input is edit-mode-only now — enter edit mode first.
    fireEvent.click(within(rowFor('styled date field item')).getByRole('button', { name: 'Edit' }));

    const dateInput = screen.getByLabelText('Due date');
    expect(dateInput).toHaveClass('border-input');
    expect(dateInput).toHaveClass('rounded-md');
  });
});
