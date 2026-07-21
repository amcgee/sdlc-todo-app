# Design brief — Manual reordering of todos (drag-and-drop)

**PRD-rev: 2** · Issue amcgee/sdlc-todo-app#2 · Design set: `docs/specs/2-manual-reordering-design/`

Mockups (self-contained HTML + light/dark PNGs) live beside this file, one per state.

## Visual language

Reuses the existing shadcn/Tailwind token set verbatim (`src/index.css`) — same card
(max-width 560, white on `--background`, `rounded-lg`, `shadow-sm`), same 16px title, same
`py-3` rows with a bottom hairline `--border`, same Radix checkbox, same ghost Edit/Delete
buttons and filled-primary filter pills. No new colors, radii, or type scales are introduced;
the feature adds exactly one new affordance (a drag handle) and two transient overlays (the
drop-target line and a move announcement), all drawn from existing tokens.

- **Drag handle**: a 6-dot grip glyph in `--muted-foreground`, sitting in a reserved
  ~20px left gutter before the checkbox. Reserving the gutter means content never shifts
  when the handle fades in. `cursor: grab` (→ `grabbing` while dragging). This gutter is the
  one intentional change to the resting row layout versus today's app.
- **Drop-target indicator**: a 2px `--primary` line with a leading dot, spanning the row
  width, rendered in the gap where the dragged item will land.
- **Lifted row**: the dragged row detaches onto its own `--card` surface with an elevated
  shadow and a slight tilt; its origin leaves a dashed placeholder slot.
- **Move announcement**: reuses the app's existing `role="status" aria-live="polite"`
  region (the notice/undo line between the add form and the filters) — no new UI chrome.
- Both themes derive entirely from `prefers-color-scheme`; the primary drop line stays
  high-contrast in each (near-black on light, near-white on dark).

## Interaction notes (what the static mockups can't show)

- **Handle reveal**: opacity 0 at rest; fades in (~120ms) on row `:hover` or when any control
  in the row receives focus (`:focus-within`). It is never visible at rest.
- **Focus order**: the handle is the first focusable element in each row (before the
  checkbox), so Tab order reads handle → checkbox → text → Edit → Delete, top to bottom.
- **Keyboard move**: the handle is a real `<button>`. When focused, each `↑`/`↓` press moves
  the item one position *immediately* and keeps focus on the moving handle — there is no
  pick-up/drop mode and no Enter/Space to "grab". At the ends, the key is a no-op with a
  "already at the top/bottom" announcement. A short "Press ↑ / ↓ to move" hint appears on
  focus.
- **Live-region copy**: each successful move announces `"<text> moved to position N of M."`;
  a no-op announces `"<text> is already at the top."` / `"…at the bottom."`. Keep the item
  text first so it's not truncated by a verbose prefix.
- **Settle**: after a drop or a keyboard move the landed row shows a brief `--accent` settle
  highlight that fades; motion should respect `prefers-reduced-motion` (snap, no slide).
- **Touch** *(provisional — pending operator confirmation)*: same handle drives full
  press-hold-drag on touch; the handle's hit target should be at least ~44px tall (the row is
  ~53px, so the handle can grow to fill row height without new layout).
- **Persistence**: reordering rides the existing whole-list save; no per-move network chrome,
  no spinner. Ordering is the stored array order.

## Disabled-context treatment (open PRD question, resolved here)

Per the PRD comment's lean toward discoverability, I chose **shown-but-disabled with a
tooltip** over fully hiding the handle. In any view where reordering doesn't apply — an
Active/Completed filter, or the view-only "Sort by date" toggle — the handle stays in its
gutter but is dimmed, `cursor: not-allowed`, non-draggable, and its arrow keys are inert.
Hovering/focusing it shows `"Reordering is only available in the All view with manual order"`.
This keeps the affordance's existence learnable instead of making it silently vanish.

## States

| File | State | Binding? |
|---|---|---|
| `resting` | All view, manual order, handles hidden at rest | **binding** |
| `hover` | Row hover/focus reveals the handle in the reserved gutter | **binding** |
| `dragging` | Item lifted; drop-target line at target; dashed origin slot | **binding** (structure: lifted item + a distinct drop indicator + a visible source gap must all be present; exact shadow/tilt illustrative) |
| `post-drop` | New order settled, brief settle highlight | *illustrative* (highlight styling is direction; the settled order is the binding behavior) |
| `filtered` | Active filter (stands in for Sort-by-date too); handle disabled + tooltip | **binding** (disabled, non-draggable, inert keys, discoverable reason) |
| `keyboard` | Handle focused with visible focus ring, key hint, live-region announcement | **binding** (focusable handle, visible focus, `↑`/`↓` one-step move, announcement copy) |

*Binding* = engineering must deliver this structure and these affordances; exact spacing,
shadow, tilt, and animation are the builder's.

## Open questions for the pm

1. **Touch model** is drawn as full drag-and-drop via the handle but is flagged provisional in
   the PRD — needs operator confirmation. If touch instead wants the keyboard-style
   move-up/down, the `dragging` touch path changes (the handle affordance and disabled-context
   treatment are unaffected).
2. **Announcement verbosity** — I assumed `"<text> moved to position N of M."`. If the pm/red
   team prefers position-only or a relative "moved up"/"moved down" phrasing, only the copy in
   the `keyboard` state changes, not its structure.
