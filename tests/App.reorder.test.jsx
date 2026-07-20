// @vitest-environment happy-dom
//
// Component-level proving suite for manual reordering (drag-and-drop) — R2..R7 of
// docs/specs/2-manual-reordering-spec.md. The pure primitives moveTodo (R1) and
// pointerDropIndex (R4 geometry) are proven in tests/todos.test.js; this suite proves
// the App wiring: context gating, keyboard moves + focus, pointer-drag structure and
// the committed PUT, the live-region announcement lifecycle, and handle a11y.
//
// Conventions mirror tests/App.undo.test.jsx / tests/App.a11y.test.jsx: happy-dom, a
// stubbed `fetch` (GET seeds, PUT bodies recorded), afterEach cleanup, fireEvent only
// (no user-event dep — the plan's dependency list is closed).

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
});

function mkTodo(id, text, completed = false) {
  return { id, text, completed };
}

// Stub `fetch`: the first GET seeds the list; later GETs repeat the last response. PUT
// bodies are recorded (the whole new-order array a move persists — R6). Returns a
// handle to inspect the recorded PUTs.
function installFetch(seed) {
  const putBodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'PUT') {
        putBodies.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => seed };
    })
  );
  return { putBodies };
}

// Render + settle hydration (the initial GET must resolve inside act before we touch
// anything). Returns testing-library's render result plus the fetch handle.
async function renderSeeded(seed) {
  const fetchHandle = installFetch(seed);
  const utils = render(<App />);
  await screen.findByText(seed[0].text); // hydration landed
  return { ...utils, ...fetchHandle };
}

function handleFor(text) {
  return screen.getByRole('button', { name: `Reorder ${text}` });
}

function renderedOrder() {
  return screen
    .getAllByRole('listitem')
    .map((li) => li.querySelector('button[aria-label^="Reorder "]').getAttribute('aria-label'));
}

// Stub each rendered row's geometry to a synthetic contiguous vertical band (row k ->
// [k*50, k*50+50)), and the list's own top to 0, so pointer-drag math is deterministic
// under happy-dom (which reports zero-sized rects). Call after render, before dragging.
function stubRowBands() {
  const rows = screen.getAllByRole('listitem');
  rows.forEach((li, k) => {
    li.getBoundingClientRect = () => ({
      top: k * 50,
      bottom: k * 50 + 50,
      left: 0,
      right: 100,
      width: 100,
      height: 50,
      x: 0,
      y: k * 50,
    });
  });
  const ul = rows[0].closest('ul');
  ul.getBoundingClientRect = () => ({
    top: 0,
    bottom: rows.length * 50,
    left: 0,
    right: 100,
    width: 100,
    height: rows.length * 50,
    x: 0,
    y: 0,
  });
}

const THREE = [mkTodo('a', 'Alpha'), mkTodo('b', 'Bravo'), mkTodo('c', 'Charlie')];
const FOUR = [
  mkTodo('a', 'Alpha'),
  mkTodo('b', 'Bravo'),
  mkTodo('c', 'Charlie'),
  mkTodo('d', 'Delta'),
];

// ---------------------------------------------------------------------------
// R7 — handle is a real <button>, first in the row, with an accessible name
// ---------------------------------------------------------------------------
describe('R7 — reorder handle placement and a11y', () => {
  it("the row's first focusable control is the reorder handle with an accessible name", async () => {
    await renderSeeded(THREE);
    const row = screen.getByText('Alpha').closest('li');
    const focusables = within(row).getAllByRole('button');
    expect(focusables[0]).toBe(handleFor('Alpha'));
    expect(handleFor('Alpha')).toHaveAccessibleName('Reorder Alpha');
  });

  it('is hidden-at-rest (revealed on hover/focus) when reorderable, and present-but-dimmed when disabled', async () => {
    await renderSeeded(THREE);
    // Reorderable (All + manual): opacity-0 at rest, revealed via group-hover/focus.
    expect(handleFor('Alpha').className).toMatch(/opacity-0/);
    expect(handleFor('Alpha').className).toMatch(/group-hover:opacity-100/);
    // Disabled context: the handle stays visible (dimmed) at rest, no hover needed.
    // (Active keeps the three not-completed rows on screen, unlike Completed.)
    fireEvent.click(screen.getByRole('button', { name: 'Active' }));
    expect(handleFor('Alpha').className).toMatch(/opacity-40/);
    expect(handleFor('Alpha').className).not.toMatch(/opacity-0/);
  });
});

// ---------------------------------------------------------------------------
// R2 — reordering offered ONLY in a reorderable context
// ---------------------------------------------------------------------------
describe('R2 — context gating', () => {
  it('in All + manual the handle is enabled and a keyboard move mutates + PUTs the list', async () => {
    const { putBodies } = await renderSeeded(THREE);
    const handle = handleFor('Alpha');
    expect(handle).not.toHaveAttribute('aria-disabled');
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it.each([
    ['a filter is active', () => fireEvent.click(screen.getByRole('button', { name: 'Active' }))],
    ['Sort by date is on', () => fireEvent.click(screen.getByRole('button', { name: 'Sort by date' }))],
  ])('with %s the handle is aria-disabled and arrow keys + drag do nothing (no PUT)', async (_label, disable) => {
    const { putBodies } = await renderSeeded([
      mkTodo('a', 'Alpha'),
      mkTodo('b', 'Bravo'),
      mkTodo('c', 'Charlie'),
    ]);
    disable();
    const handle = handleFor('Alpha');
    expect(handle).toHaveAttribute('aria-disabled', 'true');
    expect(handle).toHaveAttribute(
      'title',
      'Reordering is only available in the All view with manual order'
    );

    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    // A simulated drag is inert too: no lifted row appears.
    fireEvent.pointerDown(handle, { pointerType: 'mouse', button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(handle, { clientY: 120 });
    fireEvent.pointerUp(handle, { clientY: 120, pointerId: 1 });
    expect(document.querySelector('[data-dragging]')).toBeNull();

    // Give any (erroneous) save effect a chance to fire, then assert none did.
    await Promise.resolve();
    expect(putBodies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R3 — keyboard move (immediate, focus stays) + focus hint
// ---------------------------------------------------------------------------
describe('R3 — keyboard reorder', () => {
  it('ArrowDown on the 2nd of 3 items reorders the DOM and keeps focus on that handle', async () => {
    await renderSeeded(THREE);
    const handle = handleFor('Bravo');
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(renderedOrder()).toEqual(['Reorder Alpha', 'Reorder Charlie', 'Reorder Bravo']);
    // Focus rides along: the same handle node is still the active element.
    expect(document.activeElement).toBe(handle);
    expect(document.activeElement).toHaveAccessibleName('Reorder Bravo');
  });

  it('ArrowUp on the first item is a no-op: order unchanged and no PUT', async () => {
    const { putBodies } = await renderSeeded(THREE);
    const handle = handleFor('Alpha');
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(renderedOrder()).toEqual(['Reorder Alpha', 'Reorder Bravo', 'Reorder Charlie']);
    await Promise.resolve();
    expect(putBodies).toHaveLength(0);
  });

  it('focusing an enabled handle exposes the move hint; blurring removes it', async () => {
    await renderSeeded(THREE);
    const handle = handleFor('Alpha');
    expect(screen.queryByText('Press ↑ / ↓ to move')).not.toBeInTheDocument();
    fireEvent.focus(handle);
    const hint = screen.getByText('Press ↑ / ↓ to move');
    expect(hint).toBeInTheDocument();
    // Programmatically associated with the handle.
    expect(handle).toHaveAttribute('aria-describedby', hint.id);
    fireEvent.blur(handle);
    expect(screen.queryByText('Press ↑ / ↓ to move')).not.toBeInTheDocument();
  });

  it('in a disabled context the focused handle shows no hint (its tooltip stands in)', async () => {
    await renderSeeded(THREE);
    fireEvent.click(screen.getByRole('button', { name: 'Active' }));
    fireEvent.focus(handleFor('Alpha'));
    expect(screen.queryByText('Press ↑ / ↓ to move')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// R4 — pointer drag: three-part mid-drag structure + one committed PUT
// ---------------------------------------------------------------------------
describe('R4 — pointer drag', () => {
  it('mid-drag shows exactly one lifted row, one drop indicator and one source placeholder, all gone on drop', async () => {
    const { container } = await renderSeeded(FOUR);
    stubRowBands();
    const handle = handleFor('Alpha');
    fireEvent.pointerDown(handle, { pointerType: 'mouse', button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(handle, { clientY: 140 }); // over row Charlie, lower half

    expect(container.querySelectorAll('[data-dragging]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-drop-indicator]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-source-gap]')).toHaveLength(1);

    fireEvent.pointerUp(handle, { clientY: 140, pointerId: 1 });
    expect(container.querySelectorAll('[data-dragging]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-drop-indicator]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-source-gap]')).toHaveLength(0);
  });

  it.each([
    ['Alpha down over row Charlie lower half', 'Alpha', 140, ['b', 'c', 'a', 'd']],
    ['Delta up over row Alpha upper half', 'Delta', 10, ['d', 'a', 'b', 'c']],
  ])('%s commits exactly one new-order PUT', async (_label, text, dropY, expected) => {
    const { putBodies } = await renderSeeded(FOUR);
    stubRowBands();
    const handle = handleFor(text);
    fireEvent.pointerDown(handle, { pointerType: 'mouse', button: 0, pointerId: 1, clientY: 25 });
    fireEvent.pointerMove(handle, { clientY: dropY });
    fireEvent.pointerUp(handle, { clientY: dropY, pointerId: 1 });
    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].map((t) => t.id)).toEqual(expected);
  });

  it('a release back on the origin row (either half) commits nothing', async () => {
    const { putBodies } = await renderSeeded(FOUR);
    stubRowBands();
    const handle = handleFor('Alpha');
    // Upper half of the origin row (row 0): gap 0, toIndex 0 == origin.
    fireEvent.pointerDown(handle, { pointerType: 'mouse', button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(handle, { clientY: 10 });
    fireEvent.pointerUp(handle, { clientY: 10, pointerId: 1 });
    // Lower half of the origin row: gap 1, toIndex 0 == origin.
    fireEvent.pointerDown(handle, { pointerType: 'mouse', button: 0, pointerId: 2, clientY: 40 });
    fireEvent.pointerMove(handle, { clientY: 40 });
    fireEvent.pointerUp(handle, { clientY: 40, pointerId: 2 });
    await Promise.resolve();
    expect(putBodies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R5 — live-region announcement copy, mutual exclusivity, and the seq nonce
// ---------------------------------------------------------------------------
describe('R5 — move announcement', () => {
  it('a completed keyboard move announces the position copy in the status region', async () => {
    await renderSeeded(THREE);
    const handle = handleFor('Alpha');
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(screen.getByRole('status')).toHaveTextContent('Alpha moved to position 2 of 3.');
  });

  it('an end-of-list no-op announces the top / bottom copy', async () => {
    await renderSeeded(THREE);
    handleFor('Alpha').focus();
    fireEvent.keyDown(handleFor('Alpha'), { key: 'ArrowUp' });
    expect(screen.getByRole('status')).toHaveTextContent('Alpha is already at the top.');

    handleFor('Charlie').focus();
    fireEvent.keyDown(handleFor('Charlie'), { key: 'ArrowDown' });
    expect(screen.getByRole('status')).toHaveTextContent('Charlie is already at the bottom.');
  });

  it('a later unrelated action (toggle) evicts the move message from the region', async () => {
    await renderSeeded(THREE);
    const handle = handleFor('Bravo');
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(screen.getByRole('status')).toHaveTextContent('Bravo moved to position 3 of 3.');
    // Toggling writes the region (finalizes undo) -> the move text must be gone.
    fireEvent.click(within(screen.getByText('Alpha').closest('li')).getByRole('checkbox'));
    expect(screen.getByRole('status')).not.toHaveTextContent('moved to position');
  });

  it('two successive ArrowUp presses at the top re-announce identical copy with an incremented seq', async () => {
    await renderSeeded(THREE);
    const handle = handleFor('Alpha');
    handle.focus();
    const status = screen.getByRole('status');

    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    const firstSeq = Number(status.getAttribute('data-announce-seq'));
    expect(status).toHaveTextContent('Alpha is already at the top.');

    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    const secondSeq = Number(status.getAttribute('data-announce-seq'));
    expect(status).toHaveTextContent('Alpha is already at the top.'); // identical copy
    expect(secondSeq).toBe(firstSeq + 1); // …but re-announced via the incremented nonce
  });
});
