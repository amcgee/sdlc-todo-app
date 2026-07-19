# Due dates for todos

## Summary

Today a todo is just text plus a done/not-done flag, so the list can't answer the most common question a task list gets asked: *when does this need to happen?* This feature lets a user attach an optional **due date** to any todo, clear it again, see at a glance which items are **overdue**, and order the list so time-bound items surface first. Items with no date keep behaving exactly as they do now — the date is purely additive.

## Users & motivation

The single-list user of this app (no accounts; one shared list per environment). They're tracking a mix of "someday" items and time-bound ones, and right now the two are indistinguishable. They want to: mark that a specific item is due on a given day, spot at a glance what has slipped past its date, and bring the time-bound items to the top of a longer list. Most items will *not* have a date, so the feature must stay quiet and out of the way until a date is set.

## Scope

- **Set, change, or clear a due date from edit mode.** A row's date field is hidden while ordinary — it appears alongside the text field only while that row is being edited, so an undated row wastes no space on an empty control.
- **Date-only, no time-of-day.** A due date is a calendar day; no time-of-day or timezone scheduling.
- **Explicit Save/Cancel.** Editing a row replaces its **Edit**/**Delete** buttons with **Save** and **Cancel** (Enter and Escape work as shortcuts for each). Both the text and the date are staged drafts: **Save** commits them together as one update; **Cancel** discards both, reverting to the row's original text and date. Losing focus — clicking elsewhere, tabbing between fields — commits or cancels nothing by itself.
- **See the date as a relative "time left" label.** Outside edit mode, a dated todo shows a short, human-readable relative label instead of the raw date — "in 3 days," "due today," "due tomorrow," "yesterday," "5 days ago" — and no label at all when undated.
- **Overdue indicator: row highlight + past-tense label, not a text badge.** An item is overdue when its due date is strictly before the user's current local day (an item due *today* is not overdue). The whole row gets a background highlight, and its relative label reads in the past tense ("yesterday," "5 days ago") — the label's past-tense phrasing is itself the non-color-alone signal (consistent with the app's existing non-color-alone treatment); there is no literal "Overdue" word. A **completed** item never shows as overdue, regardless of its date.
- **Sort by due date.** A user-toggled sort control orders the list soonest-due-first (overdue items surface first as the most urgent), with undated items sorted last, preserving their existing relative order among themselves.
- **Legacy items untouched.** Existing todos (and any list already stored) have no date and render and behave exactly as before. Adding due-date support must never drop, alter, or invalidate an item that has no date.
- **Parity across both runtimes.** The capability behaves identically whether the app is running on the local Bun backend or the deployed Worker/D1 backend — this is required, not optional, per the app's shared-contract invariant (see Architectural direction).

## Non-goals

- **No reminders or notifications.** No alerts, emails, push, or background nagging.
- **No recurring/repeating due dates.**
- **No time-of-day or timezone scheduling.** Date-only; no "due at 3pm," no cross-timezone normalization beyond "the user's local calendar day."
- **No filter-by-due/overdue.** The overdue indicator plus sort-by-date already deliver "see what's due/overdue and order by time"; a dedicated filter control (extending All/Active/Completed) is a candidate for a future, separate change.
- **No change to existing limits** — the 10-item list cap and 32-character item-text cap are unaffected.
- **No calendar view or timeline visualization** — the date lives inline on the existing list, not in a new view.

## Success criteria

- A user can add a due date to an item from edit mode, see its relative label once out of edit mode, and clear it again — on both backends.
- Save commits a row's staged text and date together as one update; Cancel discards both, and neither was ever persisted mid-edit.
- An item whose date is in the past (and not completed) is unmistakably marked overdue via row highlight + past-tense relative label; an item due today, in the future, with no date, or completed is not marked overdue.
- Toggling sort-by-due-date orders the list soonest-first (overdue first), undated items last, and is reversible to the default view.
- A list stored *before* this feature loads and works with zero errors or visual regressions; its items simply have no date.
- The whole-list save/restore round-trips the due date through both the Bun and Worker/D1 backends with no drift, and a malformed or missing date never causes an item to be dropped.

## Architectural direction

Two constraints here are genuine *product* decisions, not incidental implementation — the feature is wrong without them, so they're named here and the *how* is left to the architect:

1. **The due date is a new optional field on the shared whole-list contract, and it must cross both runtimes identically.** The app's defining invariant is that one runtime-agnostic handler and one schema shape back *both* the Bun (`bun:sqlite`) and Worker (D1) backends so they cannot drift. The due date must ride that same whole-list read/replace contract and be persisted by both storage schemas the same way. Shipping it on one backend only, or in a way that lets the two representations diverge, would violate the core promise of the app.

2. **Legacy toleration is mandatory: the date is optional/nullable and its absence or malformation must never invalidate an item.** The load path (`sanitizeTodos`) and shape-validation (`isConformingList`) drop items that don't conform. The due-date field must be introduced so that "no date" is fully valid and a bad/unparseable date value degrades to "no date" rather than discarding the item's text.

Not specified here (architect's to choose): the field name, its wire encoding, the date-picker component, and where "today" is read from — the pure core is deliberately free of `Date.now`/randomness, so "today" for the overdue test and "soonest-first" sort should be threaded in from the UI layer the way `makeId` already receives its randomness.
