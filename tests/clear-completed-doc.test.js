// @vitest-environment node
//
// "Clear completed" is hidden when the *currently filtered* list has no
// completed item — e.g. on the Active filter, which never shows completed
// items. This pins that docs/guide/managing-todos.md documents that rule,
// so a future regression that drops the prose fails a deterministic,
// no-browser check.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUIDE_PAGE = join(ROOT, 'docs', 'guide', 'managing-todos.md');

describe('managing-todos.md documents the Clear-completed filtered-view hiding rule', () => {
  it('describes that the button is hidden on the Active filter and tied to the current filtered view', () => {
    const guide = readFileSync(GUIDE_PAGE, 'utf8');

    // Isolate the "Clear completed" section so a match elsewhere in the doc
    // can't accidentally satisfy this.
    const section = /## Clear completed\n([\s\S]*?)\n##/.exec(guide);
    expect(section).not.toBeNull();
    const body = section[1];

    // The rule is scoped to the currently filtered view...
    expect(body).toMatch(/currently filtered view/i);
    // ...and is explicitly hidden on the Active filter, since Active never
    // shows completed items.
    expect(body).toMatch(/\*\*Active\*\* filter[^.]*no completed items[^.]*hidden/i);
  });
});
