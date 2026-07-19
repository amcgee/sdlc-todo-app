# Getting started

TODO is a small shared to-do list. One list per deployment — no accounts, no sign-in;
everyone who opens the app sees and edits the same list, and it persists across reloads.

![An empty list, ready for a first todo](../screenshots/empty-list.png)

## Open the app

- **Deployed:** open the app's URL (for the reference deployment, a
  `https://todo-app.<subdomain>.workers.dev` address).
- **Locally:** from a checkout, `bun install && bun run dev`, then open
  `http://localhost:5173`. (Details for developers: [repository README](../../README.md).)

## Your first todo

1. Type into the **“What needs to be done?”** field.
2. Press **Enter** (or click **Add**).

The item appears in the list, and the **“N items left”** counter at the bottom updates.
Adding an empty or whitespace-only item does nothing — the field just clears.

Next: [Managing todos](managing-todos.md).
