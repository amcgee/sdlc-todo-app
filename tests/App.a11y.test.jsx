// @vitest-environment happy-dom
//
// A11y render-test harness (plan §8 / R11). Scoped to A1–A7
// structure/role/name/focus/edit-semantics assertions plus a static
// token-contrast check reading the SHIPPED :root custom properties. It does NOT
// re-test pure-core logic (that stays in tests/todos.test.js, node env, 87
// cases). Kept in tests/ (not src/) so the build-gate src/ guard is not tripped.
//
// Uses only @testing-library/react's fireEvent (no user-event dep — the plan's
// dependency list is closed: react/dom/jest-dom + happy-dom only).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
// Use the /vitest entrypoint (not the bare import): it extends Vitest's own
// `expect` rather than a global, which is required under the repo's default
// globals:false (no vitest.config). Bare '@testing-library/jest-dom' would call
// expect.extend on an undefined global and throw at import time.
import '@testing-library/jest-dom/vitest';

import App from '../src/App.jsx';

// Test isolation (F32): the repo runs `vitest run` with no config and Vitest's
// default globals:false, so testing-library's auto-cleanup does not register.
// Without this explicit afterEach(cleanup) each render accumulates in the shared
// happy-dom document and single-element queries throw "found multiple elements".
afterEach(cleanup);

// ISSUE-15: storage.js now talks to /api/todos over async `fetch` instead of the
// synchronous `localStorage`. There is no server in the test env, so stub `fetch`
// (F62/§4.3): GET resolves an empty list (each render starts clean, as
// localStorage.clear() formerly guaranteed) and PUT resolves ok (best-effort save,
// ignored). Restore in afterEach. This is a setup-only harness change; no assertion
// below is weakened.
beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'PUT') {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => [] };
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The load seam is async now, so let hydration settle after each render before
// interacting: the initial empty-list GET must resolve inside `act` (via waitFor)
// so setTodos/hydration flags land before the synchronous assertions run.
async function addTodo(text) {
  const input = await screen.findByLabelText('New todo');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form'));
  await waitFor(() => {
    expect(screen.getByText(text)).toBeInTheDocument();
  });
}

describe('A4 — semantic structure', () => {
  it('renders a single h1 "TODO" and a submitting form', async () => {
    render(<App />);
    const input = await screen.findByLabelText('New todo'); // settle hydration
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('TODO');
    expect(input.closest('form')).not.toBeNull();
  });

  it('list items are <li> inside a <ul>', async () => {
    render(<App />);
    await addTodo('buy milk');
    const item = screen.getByText('buy milk').closest('li');
    expect(item).not.toBeNull();
    expect(item.closest('ul')).not.toBeNull();
  });
});

describe('A3/A4/A5/A6/R10 — checkbox toggle', () => {
  it('toggle is role=checkbox with aria-checked and Toggle complete name', async () => {
    render(<App />);
    await addTodo('task');
    const box = screen.getByRole('checkbox', { name: 'Toggle complete' });
    expect(box).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(box);
    const boxAfter = screen.getByRole('checkbox', { name: 'Toggle complete' });
    expect(boxAfter).toHaveAttribute('aria-checked', 'true');
    // completed cue is non-color-only: strikethrough class present
    expect(screen.getByText('task').className).toMatch(/line-through/);
  });
});

describe('A5 — accessible names', () => {
  it('New todo input and control buttons have accessible names', async () => {
    render(<App />);
    expect(await screen.findByLabelText('New todo')).toBeInTheDocument();
    await addTodo('task');
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    // Clear completed mounts only when the filtered view holds a completed todo,
    // so complete the seeded item before asserting its accessible name.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle complete' }));
    expect(
      screen.getByRole('button', { name: 'Clear completed' })
    ).toBeInTheDocument();
  });

  it('edit input exposes aria-label="Edit todo"', async () => {
    render(<App />);
    await addTodo('task');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Edit todo')).toBeInTheDocument();
  });
});

describe('A3 — edit commit/cancel paths', () => {
  it('Enter commits the edit', async () => {
    render(<App />);
    await addTodo('orig');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = screen.getByLabelText('Edit todo');
    fireEvent.change(edit, { target: { value: 'changed' } });
    fireEvent.keyDown(edit, { key: 'Enter' });
    expect(screen.getByText('changed')).toBeInTheDocument();
  });

  it('Escape cancels the edit', async () => {
    render(<App />);
    await addTodo('orig');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = screen.getByLabelText('Edit todo');
    fireEvent.change(edit, { target: { value: 'discard' } });
    fireEvent.keyDown(edit, { key: 'Escape' });
    expect(screen.getByText('orig')).toBeInTheDocument();
  });

  // ISSUE-40-F11: the onBlur-commit path introduced by the F10 fix was removed
  // entirely — edit mode now ends only via explicit Save, Cancel, Enter, or
  // Escape. Blurring the text input must leave edit mode open with the draft
  // text un-committed.
  it('blur does not commit or cancel the edit', async () => {
    render(<App />);
    await addTodo('orig');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = screen.getByLabelText('Edit todo');
    fireEvent.change(edit, { target: { value: 'blurred' } });
    fireEvent.blur(edit);

    // Still in edit mode: the input (with the draft value) is still present.
    expect(screen.getByLabelText('Edit todo')).toBeInTheDocument();
    expect(screen.getByLabelText('Edit todo')).toHaveValue('blurred');
    // Neither the draft nor the original text is committed text content yet —
    // the original todo text was never re-rendered as a <span>.
    expect(screen.queryByText('blurred')).not.toBeInTheDocument();
    expect(screen.queryByText('orig')).not.toBeInTheDocument();
  });

  it('clicking Save commits the edit', async () => {
    render(<App />);
    await addTodo('orig');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = screen.getByLabelText('Edit todo');
    fireEvent.change(edit, { target: { value: 'saved via button' } });
    fireEvent.blur(edit); // must not have committed anything on its own
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('saved via button')).toBeInTheDocument();
    expect(screen.queryByLabelText('Edit todo')).not.toBeInTheDocument();
  });

  it('clicking Cancel discards the edit', async () => {
    render(<App />);
    await addTodo('orig');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edit = screen.getByLabelText('Edit todo');
    fireEvent.change(edit, { target: { value: 'discarded via button' } });
    fireEvent.blur(edit); // must not have committed anything on its own
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('orig')).toBeInTheDocument();
    expect(screen.queryByText('discarded via button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Edit todo')).not.toBeInTheDocument();
  });
});

describe('A5 — filter selected state', () => {
  it('active filter exposes aria-pressed and a non-color variant cue', async () => {
    render(<App />);
    await screen.findByLabelText('New todo'); // settle hydration
    const all = screen.getByRole('button', { name: 'All' });
    const active = screen.getByRole('button', { name: 'Active' });
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(active).toHaveAttribute('aria-pressed', 'false');
    // The pressed button carries the filled default-variant class (bg-primary);
    // inactive filters use ghost (no bg-primary).
    expect(all.className).toMatch(/bg-primary/);
    expect(active.className).not.toMatch(/bg-primary/);
    // A6/F24: the selected-state cue must NOT be color-alone. Assert a non-color
    // distinguishing feature — bold weight + underline — is present on the active
    // button and absent on inactive ones. This guards against a regression that
    // makes the cue color-only again (which asserting bg-primary alone would miss).
    expect(all.className).toMatch(/font-semibold/);
    expect(all.className).toMatch(/underline/);
    expect(active.className).not.toMatch(/font-semibold/);
    expect(active.className).not.toMatch(/underline/);
    fireEvent.click(active);
    const activeAfter = screen.getByRole('button', { name: 'Active' });
    expect(activeAfter).toHaveAttribute('aria-pressed', 'true');
    expect(activeAfter.className).toMatch(/bg-primary/);
    // …and the non-color cue moves with the selection.
    expect(activeAfter.className).toMatch(/font-semibold/);
    expect(activeAfter.className).toMatch(/underline/);
  });
});

describe('control placement and Clear-completed visibility', () => {
  it('renders the filter + sort row before the first list item in DOM order', async () => {
    render(<App />);
    await addTodo('task');
    const firstLi = screen.getAllByRole('listitem')[0];
    const all = screen.getByRole('button', { name: 'All' });
    const sort = screen.getByRole('button', { name: 'Sort by date' });
    // Both controls precede the first <li>: the item follows them in document order.
    expect(
      all.compareDocumentPosition(firstLi) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      sort.compareDocumentPosition(firstLi) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('hides Clear completed under filter "active" even with a completed todo elsewhere', async () => {
    render(<App />);
    await addTodo('task');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle complete' }));
    // The completed todo exists in the list, but the Active view excludes it, so
    // the currently-filtered view has nothing completed to clear.
    fireEvent.click(screen.getByRole('button', { name: 'Active' }));
    expect(
      screen.queryByRole('button', { name: 'Clear completed' })
    ).not.toBeInTheDocument();
  });

  it('shows Clear completed under "all"/"completed" with a completed todo, and clicking clears it', async () => {
    render(<App />);
    await addTodo('task');
    // No completed todo yet -> button absent under the new gate.
    expect(
      screen.queryByRole('button', { name: 'Clear completed' })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle complete' }));
    // Default filter is "all": the completed todo is in view, so the button mounts.
    expect(
      screen.getByRole('button', { name: 'Clear completed' })
    ).toBeInTheDocument();
    // It also shows under "completed".
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    expect(
      screen.getByRole('button', { name: 'Clear completed' })
    ).toBeInTheDocument();
    // Clicking it still clears the completed todo as before.
    fireEvent.click(screen.getByRole('button', { name: 'Clear completed' }));
    await waitFor(() => {
      expect(screen.queryByText('task')).not.toBeInTheDocument();
    });
  });

  it('keeps the item count and sort toggle functional after the reflow', async () => {
    render(<App />);
    await addTodo('task');
    expect(screen.getByText('1 items left')).toBeInTheDocument();
    const sort = screen.getByRole('button', { name: 'Sort by date' });
    expect(sort).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(sort);
    expect(
      screen.getByRole('button', { name: 'Sort by date' })
    ).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('A2 — focus (class presence only; visible contrast is manual)', () => {
  it('interactive elements are focusable and carry a focus-visible ring class', async () => {
    render(<App />);
    const input = await screen.findByLabelText('New todo'); // settle hydration
    input.focus();
    expect(input).toHaveFocus();
    expect(input.className).toMatch(/focus-visible:ring/);

    await addTodo('task');
    const add = screen.getByRole('button', { name: 'Add' });
    add.focus();
    expect(add).toHaveFocus();
    expect(add.className).toMatch(/focus-visible:ring/);

    const box = screen.getByRole('checkbox', { name: 'Toggle complete' });
    box.focus();
    expect(box).toHaveFocus();
    expect(box.className).toMatch(/focus-visible:ring/);
  });
});

// --- Static token-contrast check (A1 / INV-3), reading SHIPPED :root (F34) ---

function hslTripletToRgb(triplet) {
  const [h, sPct, lPct] = triplet
    .trim()
    .split(/\s+/)
    .map((p) => parseFloat(p));
  const s = sPct / 100;
  const l = lPct / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function relLuminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastRatio(tripletA, tripletB) {
  const la = relLuminance(hslTripletToRgb(tripletA));
  const lb = relLuminance(hslTripletToRgb(tripletB));
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe('A1 / INV-3 — token contrast (shipped :root, not hardcoded hex)', () => {
  // Read the SHIPPED tokens straight from src/index.css (F34): drift between the
  // plan's §4 values and what ships fails these tests. happy-dom does not resolve
  // @layer :root custom properties into getComputedStyle (no PostCSS/cascade in
  // the DOM shim), so the values are parsed from the source stylesheet instead of
  // hardcoded hex — this still asserts against exactly what the app ships.
  function readRootTokens() {
    // process.cwd() is the repo root under `vitest run`; happy-dom rewrites
    // import.meta.url to an http:// URL, so resolve from cwd instead.
    const cssPath = resolve(process.cwd(), 'src/index.css');
    const css = readFileSync(cssPath, 'utf8');
    const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/);
    if (!rootBlock) throw new Error('no :root block found in src/index.css');
    const body = rootBlock[1];
    const get = (name) => {
      const m = body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
      if (!m) throw new Error(`token ${name} not found in :root`);
      return m[1].trim();
    };
    return {
      background: get('--background'),
      foreground: get('--foreground'),
      primary: get('--primary'),
      primaryForeground: get('--primary-foreground'),
      mutedForeground: get('--muted-foreground'),
      destructive: get('--destructive'),
      destructiveForeground: get('--destructive-foreground'),
    };
  }

  function tokens() {
    return readRootTokens();
  }

  it('foreground/background >= 4.5:1', () => {
    const t = tokens();
    expect(contrastRatio(t.foreground, t.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('primary-foreground/primary >= 4.5:1', () => {
    const t = tokens();
    expect(
      contrastRatio(t.primaryForeground, t.primary)
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('muted-foreground/background >= 4.5:1 (weakest pair, was #999 FAIL)', () => {
    const t = tokens();
    expect(
      contrastRatio(t.mutedForeground, t.background)
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('destructive-foreground/destructive >= 4.5:1 (F33; stock pair fails)', () => {
    const t = tokens();
    expect(
      contrastRatio(t.destructiveForeground, t.destructive)
    ).toBeGreaterThanOrEqual(4.5);
  });
});
