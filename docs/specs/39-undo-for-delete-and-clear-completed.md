# Undo for delete and clear-completed

## Summary

Deleting a todo and "clear completed" are today instant and irreversible: one stray click permanently loses a task, and one "clear completed" can wipe out a batch of finished items with no recovery. This feature adds a short, forgiving **Undo** window after each destructive action. Immediately after a delete or a clear-completed, the user sees an Undo affordance; taking it restores exactly what was removed. The goal is to turn an unforgiving, one-way action into a recoverable one, without adding a heavyweight trash/history system.

## Users & motivation

- **End users of the shared TODO app** want to recover from an accidental delete or an accidental "clear completed" — the two irreversible actions in the app — without having to remember and re-type the lost item(s). Their job-to-be-done is "I didn't mean to do that; put it back."
- The motivating problem: both destructive actions commit instantly with no confirmation and no recovery, so a mistake is permanent. Adding a confirmation dialog would slow the common (intentional) case; a brief post-action Undo keeps the fast path fast while making mistakes cheap.

## Scope

- After a user **deletes a single todo**, an **Undo** affordance appears; taking it restores that todo.
- After a user runs **clear-completed**, an **Undo** affordance appears; taking it restores **all** the items that clear-completed just removed, as a single group (one Undo brings the whole batch back, not one at a time).
- **Undo window: 5 seconds.** The affordance is offered for 5 seconds after the destructive action; after it expires, the removal is final.
- **Any new action dismisses the pending Undo early.** If the user performs any other action (add, edit, toggle, or another delete / clear-completed) before the 5s elapses, the pending Undo is dismissed immediately and its removal becomes final. At most one Undo is ever pending at a time; a second destructive action dismisses the first's Undo and offers its own.
- **Affordance: the existing status/notice line, with an inline Undo control.** We reuse the app's current status/notice line to show what was removed and an inline **Undo** button — no new toast/snackbar component is introduced.
- On Undo, restored items rejoin the list in a **best-effort** position near where they originally were. Exact original index is **not** guaranteed, because the list may have changed during the window (see Non-goals and Architectural direction).
- **Concurrent-collision rule:** restoring never overwrites or duplicates an item that is currently present in the list; Undo only brings back items that are genuinely absent. If, during the window, an item slated for restore was independently re-created or otherwise already exists, it is simply left as-is rather than clobbered.

## Non-goals

- **No persistent trash, history, or multi-level undo.** This is a single, short-lived "undo the last destructive action," not an undo stack and not a recycle bin.
- **No cross-session or post-reload undo.** Undo is scoped to the **acting session only**: it is not available after a reload, and one session cannot undo a delete performed by another session. Once the window closes (or the page reloads), the removal is final.
- **No undo for non-destructive edits** (add, toggle, rename) — only delete and clear-completed.
- **No confirmation dialogs.** The fast path stays fast; Undo is the recovery mechanism, not a pre-action prompt.
- **No guaranteed exact re-ordering** of restored items on a list that changed during the window.

## Success criteria

- After deleting a single todo, the user can restore that exact todo within 5 seconds via the Undo affordance in the status/notice line; after 5 seconds (or after any intervening action), Undo is gone and the deletion is permanent.
- After clear-completed, one Undo restores **all** the just-removed completed items together; a partial/failed restore does not silently drop items.
- Restored items reappear in a sensible (best-effort near-original) position and are functionally identical to before removal (text and completed-state preserved).
- Undo is never available after a reload, and never lets one session reverse another session's delete.
- Restoring never overwrites, duplicates, or corrupts an item that is currently present — a concurrent change during the window is preserved, and only genuinely-absent items are brought back.
- The common, intentional delete/clear path is not slowed by any new prompt.

## Architectural direction

Two constraints are part of the product decision here and bound what "correct" means; the architect chooses how to satisfy them.

- **Session-scoped, non-durable Undo.** The recoverable state lives only in the acting client session for the duration of the 5s window; it is intentionally **not** persisted server-side and **not** shared across sessions. This is essential because the product promise is "undo my accidental click right now," not a durable trash feature — persisting or sharing it would change what the feature is (see Non-goals) and add data-lifecycle surface we've deliberately excluded.
- **Restore must be a safe, non-destructive merge, not a snapshot rollback.** Because the app is a single shared no-auth list that other sessions may be editing concurrently, Undo must **re-insert only genuinely-absent items** and must **never overwrite or duplicate** an item that is currently present. It must not restore by replacing the whole list with a pre-delete snapshot, since that would clobber concurrent edits. Position on restore is **best-effort** near the original location — exact index is explicitly not required, precisely because the list may have moved on. This safety property is feature-critical: without it, Undo could silently destroy a concurrent user's work, which is unacceptable for a shared list.

Beyond these two constraints, the mechanism (how removed items are held, how the timer and dismissal are implemented, how "genuinely absent" is determined against the current server state) is the architect's to design.
