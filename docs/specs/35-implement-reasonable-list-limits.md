# Implement reasonable list limits

## Summary

Give the shared todo app explicit, enforced limits on how large a single item can be and how large the whole list can grow, and make hitting a limit a clear, understood outcome for the user rather than a silent failure. Concretely: each item's text is capped at **32 characters** (with a secondary **128-byte** stored-size cap as a belt-and-suspenders backstop), and the list as a whole is capped at **10 items**. Today the app has an implicit 1 MB request cap and a 1000-item count cap, but nothing bounds an individual item's text, and no limit produces any user-visible feedback — an over-limit change looks saved locally while silently failing to persist. This feature replaces that silent-drop behavior with concrete, honest constraints: the UI stops you before you exceed a limit, and the server authoritatively rejects anything over-limit with a clear message.

## Users & motivation

The app serves a single shared todo list per environment (no accounts, no per-user isolation). Two audiences care:
- **Everyday users**, who want the app to stay responsive and to be told plainly when something they typed is too long to save — not to lose work silently.
- **The operator**, who needs the shared list and its backing database protected from one actor (accidental paste of a huge blob, or deliberate abuse) bloating storage or degrading the experience for everyone on that environment.

## Scope

- **A per-item text limit — 32 characters.** A single todo's text may not exceed **32 user-visible characters**. As an independent stored-size backstop, the text must also fit within **128 bytes** when encoded (the worst-case byte size of 32 characters in UTF-8); both checks must hold independently. In the UI the input is **hard-capped** — the field will not accept a 33rd character as you type or paste — and on save the server **also** rejects any over-limit item authoritatively, so the limit cannot be bypassed by a non-UI client.
- **A total-list limit — 10 items.** The list is capped at **10 items**. When the list already holds 10 items, adding another is prevented with a clear message. (This 10-item product cap supersedes the pre-existing implicit 1000-item cap for normal use.)
- **Refuse, never truncate.** When a limit is hit, the offending input is **refused with a message** — the app never silently shortens the user's text or drops items to make room. The user stays in control of what their text says.
- **Honest feedback on rejection.** Whichever limit is hit, the user gets an understandable, actionable message at the moment they hit it, instead of the current silent-drop behavior.
- **Consistent limits everywhere.** The same limits apply identically regardless of client and regardless of runtime (local Bun dev vs. deployed Worker/D1).

## Non-goals

- No per-user or per-tenant quotas — the single shared list is the final, intended scope; there are no multi-user isolation or quota concerns to solve here.
- No rate limiting/throttling.
- No rich text, attachments, or expansion of item content.
- No configurable/user-adjustable limits — 32 characters, 128 bytes, and 10 items are fixed product constants.
- No change to the existing 1 MB transport body cap, which stays as defense-in-depth.
- **No migration or special handling of pre-existing over-limit data.** Any items already stored beyond the new limits are left as-is; the app does not scan, truncate, force-edit, or block on them. See the callout below.

## Success criteria

- A user typing or pasting text beyond **32 characters** is stopped at the input and told why, at the moment it happens — and the server rejects the same over-limit input (over 32 characters or over 128 bytes) via any other path, including a direct `PUT /api/todos` call.
- A user attempting to add an **11th item** to a full 10-item list is told the list is full instead of silently losing the addition.
- No user action that violates a limit ever appears to have saved locally while being silently dropped on persistence.
- The app never truncates or auto-edits a user's text to satisfy a limit — it refuses and messages.
- Identical limits and rejection behavior are demonstrable on both the Bun and Worker/D1 runtimes.
- The shared list/DB cannot be driven to unbounded per-item or total size through the app's normal API.

**Legacy-data callout (accepted decision).** Because pre-existing over-limit data is deliberately left untouched, an environment that already contains long items or more than 10 items may briefly present a state that the new rules would not let a user *create*: an old item can display longer than 32 characters, and a list that already holds more than 10 items won't accept new additions until it's back under 10. Critically, this must **not** lock anyone out — viewing, completing, and deleting existing items always works, so the list naturally drains back within limits through normal use. Editing an existing over-limit item's text, however, is treated as a new write and must be brought within the 32-character / 128-byte limit to save. The operator has explicitly accepted this transitional inconsistency; no cleanup is in scope.

## Architectural direction

Enforcement must be **server-side authoritative** in the shared, runtime-agnostic write handler (`PUT /api/todos`), not client-only — that endpoint is directly reachable without the UI. The client-side hard-cap and messaging are additive UX that make the limits pleasant to hit early; they are never the enforcement boundary. The 32-character and 128-byte per-item checks and the 10-item list check must each be evaluated server-side and hold independently, identically across Bun and Worker/D1.
