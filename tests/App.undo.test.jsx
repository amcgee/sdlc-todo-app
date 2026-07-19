// @vitest-environment happy-dom
//
// Component-level proving suite for Undo (for delete and clear-completed).
// Scoped to the spec's "Test strategy" component list — see
// docs/specs/39-undo-for-delete-and-clear-completed-spec.md.
// Pure-core restoreTodos coverage lives in tests/todos.test.js.
//
// Conventions mirror tests/App.a11y.test.jsx / tests/App.hydration-f33.test.jsx:
// happy-dom, a stubbed `fetch` (GET/PUT), afterEach cleanup, fireEvent only (no
// user-event dep — the plan's dependency list is closed).

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
import { restoreTodos } from '../src/todos.js';

afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mkTodo(id, text, completed = false) {
  return { id, text, completed };
}

// Stub `fetch`: GET responses are consumed in order (the last one repeats for any
// further GET beyond the array length); PUT bodies are recorded. Returns handles to
// inspect call counts/bodies from the test body.
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

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function rowFor(text) {
  return screen.getByText(text).closest('li');
}

async function deleteRow(text) {
  fireEvent.click(within(rowFor(text)).getByRole('button', { name: 'Delete' }));
  await waitFor(() => {
    expect(screen.queryByText(text)).not.toBeInTheDocument();
  });
}

// ---------------------------------------------------------------------------
// R1 — delete then Undo restores the exact item
// ---------------------------------------------------------------------------

describe('R1 — delete then Undo restores the exact item', () => {
  it('restores text and completed unchanged', async () => {
    // Second GET response simulates the real refetch AFTER the delete's own PUT
    // already committed on the server: the item is genuinely absent there.
    installFetch([[mkTodo('a1', 'buy milk', true)], []]);
    render(<App />);
    expect(await screen.findByText('buy milk')).toBeInTheDocument();
    // completed=true -> strikethrough class present pre-delete
    expect(screen.getByText('buy milk').className).toMatch(/line-through/);

    await deleteRow('buy milk');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(screen.getByText('buy milk')).toBeInTheDocument();
    });
    // Restored with completed still true (verbatim).
    expect(screen.getByText('buy milk').className).toMatch(/line-through/);
  });
});

// ---------------------------------------------------------------------------
// R2 — clear-completed then one Undo restores the whole batch, in order
// ---------------------------------------------------------------------------

describe('R2 — clear-completed then one Undo restores the whole batch in order', () => {
  it('all completed items return, in original relative order', async () => {
    const seed = [
      mkTodo('a1', 'alpha', true),
      mkTodo('b1', 'bravo', false),
      mkTodo('c1', 'charlie', true),
      mkTodo('d1', 'delta', true),
    ];
    // Second GET response reflects the server AFTER clear-completed's own PUT:
    // only the untouched active item remains.
    installFetch([seed, [mkTodo('b1', 'bravo', false)]]);
    render(<App />);
    expect(await screen.findByText('alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear completed' }));
    await waitFor(() => {
      expect(screen.queryByText('alpha')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('charlie')).not.toBeInTheDocument();
    expect(screen.queryByText('delta')).not.toBeInTheDocument();
    expect(screen.getByText('bravo')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(screen.getByText('alpha')).toBeInTheDocument();
    });
    expect(screen.getByText('charlie')).toBeInTheDocument();
    expect(screen.getByText('delta')).toBeInTheDocument();

    // Order preserved: original relative order was alpha, bravo, charlie, delta.
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    const order = ['alpha', 'bravo', 'charlie', 'delta'].map((text) =>
      items.findIndex((t) => t.includes(text))
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// R3 — no Undo taken within 5s -> pending undo discarded, removal stays final
// ---------------------------------------------------------------------------

describe('R3 — timer expiry finalizes the delete', () => {
  it('advancing fake timers past 5s clears the Undo control and the item stays deleted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installFetch([[mkTodo('a1', 'ephemeral')]]);
    render(<App />);
    expect(await screen.findByText('ephemeral')).toBeInTheDocument();

    await deleteRow('ephemeral');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(5001);

    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByText('ephemeral')).not.toBeInTheDocument();

    // And clicking a (now-absent) Undo is moot: nothing to click, item stays gone
    // even after further time passes.
    await vi.advanceTimersByTimeAsync(5000);
    expect(screen.queryByText('ephemeral')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// R4 — any subsequent list-mutating action finalizes the pending undo early;
// no-op actions (blank add, whitespace-only edit commit) do NOT.
// ---------------------------------------------------------------------------

describe('R4 — a subsequent mutation dismisses the pending undo; no-ops do not', () => {
  it('toggling another row finalizes a pending delete-undo', async () => {
    installFetch([[mkTodo('a1', 'alpha'), mkTodo('b1', 'bravo')]]);
    render(<App />);
    await screen.findByText('alpha');

    await deleteRow('alpha');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle complete' }));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('a real add finalizes the pending undo; a blank/whitespace add does not', async () => {
    installFetch([[mkTodo('a1', 'alpha'), mkTodo('b1', 'bravo')]]);
    render(<App />);
    await screen.findByText('alpha');

    await deleteRow('alpha');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    const input = screen.getByLabelText('New todo');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form'));
    // Blank/whitespace add is an addTodo no-op -> undo must survive.
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'charlie' } });
    fireEvent.submit(input.closest('form'));
    await screen.findByText('charlie');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('committing a real edit finalizes the pending undo; a whitespace-only commit does not', async () => {
    installFetch([[mkTodo('a1', 'alpha'), mkTodo('b1', 'bravo')]]);
    render(<App />);
    await screen.findByText('alpha');

    await deleteRow('alpha');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' })); // only 'bravo' remains
    const edit = screen.getByLabelText('Edit todo');
    fireEvent.change(edit, { target: { value: '   ' } });
    fireEvent.keyDown(edit, { key: 'Enter' });
    // editTodo no-ops on empty-after-trim: commitEdit still exits edit mode (per
    // App.jsx), but must NOT finalize the pending undo and must NOT change the text.
    expect(screen.queryByLabelText('Edit todo')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.getByText('bravo')).toBeInTheDocument();

    // A real edit commit (re-enter edit mode) mutates -> finalizes the pending undo.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const edit2 = screen.getByLabelText('Edit todo');
    fireEvent.change(edit2, { target: { value: 'bravo-changed' } });
    fireEvent.keyDown(edit2, { key: 'Enter' });
    await screen.findByText('bravo-changed');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('a second delete discards the first pending undo and arms only its own', async () => {
    // Second GET response reflects the server AFTER both deletes' own PUTs already
    // committed (alpha and bravo both genuinely gone server-side by the time Undo
    // refetches).
    installFetch([
      [mkTodo('a1', 'alpha'), mkTodo('b1', 'bravo'), mkTodo('c1', 'charlie')],
      [mkTodo('c1', 'charlie')],
    ]);
    render(<App />);
    await screen.findByText('alpha');

    await deleteRow('alpha');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    await deleteRow('bravo');
    // Still exactly one Undo control (the second delete's).
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(screen.getByText('bravo')).toBeInTheDocument();
    });
    // alpha (the discarded pending undo) is NOT restorable.
    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// R7 — Undo issues one loadTodos then exactly one saveTodos PUT carrying the merge
// ---------------------------------------------------------------------------

describe('R7 — Undo performs exactly one refetch and one merge-PUT', () => {
  it('one loadTodos (GET) then one saveTodos (PUT) carrying restoreTodos(server list, entries)', async () => {
    const seed = [mkTodo('a1', 'alpha'), mkTodo('b1', 'bravo')];
    const afterDelete = [mkTodo('b1', 'bravo')]; // what the server holds when Undo refetches
    const { putBodies, getCalls } = installFetch([seed, afterDelete]);
    render(<App />);
    await screen.findByText('alpha');

    await deleteRow('alpha');

    const getCountBefore = getCalls.count;
    const putCountBefore = putBodies.length;

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(screen.getByText('alpha')).toBeInTheDocument();
    });

    expect(getCalls.count - getCountBefore).toBe(1); // exactly one refetch
    expect(putBodies.length - putCountBefore).toBe(1); // exactly one PUT

    const expected = restoreTodos(afterDelete, [
      { item: mkTodo('a1', 'alpha'), prevId: null },
    ]).map((t) => ({ ...t, dueDate: null }));
    expect(putBodies[putBodies.length - 1]).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// R8 — Undo state is client-only: never persisted, absent on a fresh mount
// ---------------------------------------------------------------------------

describe('R8 — undo state is client-only and non-durable', () => {
  it('a fresh mount shows no Undo control', async () => {
    installFetch([[mkTodo('a1', 'solo')]]);
    render(<App />);
    await screen.findByText('solo');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('PUT bodies never carry undo-related data (plain {id,text,completed,dueDate} only)', async () => {
    const { putBodies } = installFetch([[mkTodo('a1', 'solo')]]);
    render(<App />);
    await screen.findByText('solo');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Toggle complete' }));
    await waitFor(() => expect(putBodies.length).toBeGreaterThan(0));

    for (const body of putBodies) {
      expect(Array.isArray(body)).toBe(true);
      for (const item of body) {
        expect(Object.keys(item).sort()).toEqual(['completed', 'dueDate', 'id', 'text']);
      }
    }
  });

  it('undo state does not survive a remount (no Undo control after reload)', async () => {
    const seed = [mkTodo('a1', 'alpha'), mkTodo('b1', 'bravo')];
    installFetch([seed, [mkTodo('b1', 'bravo')]]);
    const { unmount } = render(<App />);
    await screen.findByText('alpha');

    await deleteRow('alpha');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    unmount();

    // A fresh App instance ("reload"); the GET now resolves the persisted
    // post-delete list. No Undo control should reappear.
    render(<App />);
    await screen.findByText('bravo');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// R9 — the Undo button is outside role=status, Tab-reachable, named "Undo"
// ---------------------------------------------------------------------------

describe('R9 — Undo control structure/focus/name', () => {
  it('is not a descendant of role=status, is a real <button>, focusable, named "Undo"', async () => {
    installFetch([[mkTodo('a1', 'solo')]]);
    render(<App />);
    await screen.findByText('solo');

    await deleteRow('solo');

    const status = screen.getByRole('status');
    const undoBtn = screen.getByRole('button', { name: 'Undo' });

    expect(status.contains(undoBtn)).toBe(false); // sibling, not descendant
    // A native, non-disabled <button> with no explicit tabindex is Tab-reachable in
    // every real browser (an implicit tabindex of 0); asserting the ABSENCE of an
    // exclusion (tabindex="-1" / disabled) plus the native tag is the accurate,
    // environment-independent proof here (happy-dom's `tabIndex` getter does not
    // itself return the browser-implicit 0 default for a bare <button>).
    expect(undoBtn.tagName).toBe('BUTTON');
    expect(undoBtn).not.toHaveAttribute('tabindex', '-1');
    expect(undoBtn).not.toBeDisabled();

    undoBtn.focus();
    expect(undoBtn).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// Concurrent-collision: a genuinely-absent entry in the same batch still
// restores even when a sibling entry's id has been recreated/edited concurrently.
// ---------------------------------------------------------------------------

describe('concurrent same-id recreation is preserved, not overwritten/duplicated', () => {
  it('clear-completed batch: the concurrently-recreated id is left alone; the genuinely-absent sibling still restores', async () => {
    const seed = [
      mkTodo('x1', 'x-original', true), // will collide
      mkTodo('y1', 'y untouched', false),
      mkTodo('z1', 'z-original', true), // genuinely absent at undo time
    ];
    // The Undo refetch: x1 already recreated/edited concurrently (present under
    // the same id, different text); z1 genuinely absent; y1 (never removed) present.
    const concurrentServerList = [
      mkTodo('x1', 'x-edited-elsewhere', false),
      mkTodo('y1', 'y untouched', false),
    ];
    installFetch([seed, concurrentServerList]);
    render(<App />);
    await screen.findByText('x-original');

    fireEvent.click(screen.getByRole('button', { name: 'Clear completed' }));
    await waitFor(() => {
      expect(screen.queryByText('x-original')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('z-original')).not.toBeInTheDocument();
    expect(screen.getByText('y untouched')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    // z (genuinely absent) is restored.
    await waitFor(() => {
      expect(screen.getByText('z-original')).toBeInTheDocument();
    });
    // y (never touched) survives throughout.
    expect(screen.getByText('y untouched')).toBeInTheDocument();
    // x's captured snapshot is NOT resurrected over the concurrent recreation, and
    // is not duplicated: neither the original nor the "elsewhere" text is injected
    // into this client's list by the restore (no second x1 row is created).
    expect(screen.queryByText('x-original')).not.toBeInTheDocument();
    const xRows = screen.getAllByRole('listitem').filter((li) =>
      li.textContent.includes('x-')
    );
    expect(xRows.length).toBeLessThanOrEqual(1); // no duplicate x entry
  });
});

// ---------------------------------------------------------------------------
// Mount/hydration finalizes any pre-hydration-armed undo
// ---------------------------------------------------------------------------

describe('hydration finalizes a pre-hydration-armed undo', () => {
  it('an undo armed during the pre-hydration flash is dismissed once the mount load resolves', async () => {
    const gate = deferred();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'PUT') {
          return { ok: true, json: async () => ({ ok: true }) };
        }
        await gate.promise; // block the mount GET until the test releases it
        return { ok: true, json: async () => [] };
      })
    );

    render(<App />);
    const input = await screen.findByLabelText('New todo'); // pre-hydration flash
    fireEvent.change(input, { target: { value: 'flash-add' } });
    fireEvent.submit(input.closest('form'));
    await screen.findByText('flash-add');

    // Delete it — arms a pending undo even though hydration hasn't resolved yet.
    await deleteRow('flash-add');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();

    // Now let the mount load resolve.
    gate.resolve();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    });
  });
});
