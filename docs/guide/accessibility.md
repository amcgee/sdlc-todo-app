# Accessibility

The app is built to be fully usable with a keyboard and a screen reader, and this is
covered by automated tests (`tests/App.a11y.test.jsx`).

## Keyboard

Every control is reachable and operable by keyboard:

- **Tab** moves through the add field, each item's checkbox / Edit / Delete, the
  filters, and Clear completed.
- **Enter** in the add field adds; **Enter** in an edit field saves, **Escape** cancels.
- The active filter is indicated by more than color alone (bold + underline as well as
  the filled button), so the selected state survives forced-colors and color-vision
  differences.

## Screen readers

- Named controls: the add field is **“New todo”**, each item's checkbox is **“Toggle
  complete”**, the edit field is **“Edit todo”**; filter buttons expose their
  pressed state (`aria-pressed`).
- App messages — the item-limit and list-full notices, and the save-failure warning —
  are announced politely via a live status region (`role="status"`,
  `aria-live="polite"`) without stealing focus.
- Completed state is conveyed by the checkbox state, not by text styling alone.
