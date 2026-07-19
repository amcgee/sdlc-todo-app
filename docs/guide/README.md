# TODO — user guide

The user documentation for the TODO app: what it does and how to use it, one page per
task area. (For developer docs — architecture, running tests, deploying — see the
[repository README](../../README.md).)

| Page | What it covers |
|------|----------------|
| [Getting started](getting-started.md) | What the app is, opening it, your first todo |
| [Managing todos](managing-todos.md) | Add, edit, complete, delete, clear completed, filters, and the list limits |
| [Sync & storage](sync-and-storage.md) | Where your list lives, how saving works, what the save-failure notice means |
| [Accessibility](accessibility.md) | Keyboard use and screen-reader behavior |

## How this guide stays current

This guide is part of the same delivery pipeline as the code. Every change that alters
user-facing behavior must update the affected page(s) here — or record an explicit
"docs: none" disposition — before it can merge, and the screenshots embedded in these
pages are simultaneously the app's **visual-regression baselines**: if the app drifts
from these pictures, CI notices. Stale user docs and visual drift are the same,
CI-visible failure. (Mechanics: [SDLC/docs/methodology.md](../../SDLC/docs/methodology.md).)
