# Sync & storage

## One shared list

There are no accounts and no per-user lists: **everyone who opens the same deployment
sees and edits the same list.** Treat it as a shared surface — like a whiteboard, not a
private notebook.

## When your changes are saved

Every change — add, edit, toggle, delete, clear completed — is saved to the server
immediately and automatically; there is no Save button. On page load the app fetches the
current list, so reloading (or opening the app on another device pointed at the same
deployment) shows the latest saved state.

## If saving fails

Saving is not silently best-effort: if your latest change may not have reached the
server (network trouble, or a conflicting concurrent update), the app tells you in the
notice line:

> Your last change may not have been saved. Refresh to see the current list.

When you see it, reload the page to get back in sync with what the server actually has,
then re-apply your change if it's missing.

## Concurrent edits

Two people editing at once save whole-list snapshots in turn; the server accepts them in
arrival order. The app is designed to never lose your keystrokes silently — if your
snapshot loses a race, you get the save-failure notice above rather than a quiet
overwrite of your screen.

Next: [Accessibility](accessibility.md).
