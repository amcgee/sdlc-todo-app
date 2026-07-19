// @vitest-environment node
//
// ISSUE-40 F5 — proves the visual baseline for the 'due-dates' scene actually
// exists and is wired consistently, without depending on a browser/pixelmatch
// run (scripts/screenshots.mjs itself is the heavier end-to-end check; this pins
// the cheap, deterministic contract that F5's regenerated baselines satisfy):
//   1. docs/screenshots/due-dates.png exists on disk and is a real, non-empty PNG.
//   2. docs/screenshots/scenes.json declares a 'due-dates' scene entry.
//   3. docs/guide/managing-todos.md's embedded image points at that same PNG,
//      with alt text consistent with the scene's manifest description (so the
//      doc page and the baseline cannot silently drift apart).
//
// ISSUE-40 F11 — the same contract, pinned again for the 'editing-todo' scene
// added by the F11 fix (the previously-missing edit-mode screenshot).

import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCREENSHOTS_DIR = join(ROOT, 'docs', 'screenshots');
const DUE_DATES_PNG = join(SCREENSHOTS_DIR, 'due-dates.png');
const EDITING_TODO_PNG = join(SCREENSHOTS_DIR, 'editing-todo.png');
const SCENES_MANIFEST = join(SCREENSHOTS_DIR, 'scenes.json');
const GUIDE_PAGE = join(ROOT, 'docs', 'guide', 'managing-todos.md');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('due-dates visual baseline (F5)', () => {
  it('docs/screenshots/due-dates.png exists and is a real, non-trivial PNG', () => {
    const stat = statSync(DUE_DATES_PNG); // throws (test fails) if missing
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);

    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A.
    const bytes = readFileSync(DUE_DATES_PNG);
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });

  it('scenes.json declares a due-dates scene entry', () => {
    const manifest = JSON.parse(readFileSync(SCENES_MANIFEST, 'utf8'));
    const scene = manifest.scenes.find((s) => s.id === 'due-dates');
    expect(scene).toBeDefined();
    expect(scene.kind).not.toBe('recording'); // a still PNG scene, not a GIF
    expect(typeof scene.description).toBe('string');
    expect(scene.description.length).toBeGreaterThan(0);
    // Sanity-checks the seed data actually exercises what the description claims:
    // a dated active item (for the badge) and a dated completed item (no badge).
    expect(scene.todos.some((t) => t.dueDate && !t.completed)).toBe(true);
    expect(scene.todos.some((t) => t.dueDate && t.completed)).toBe(true);
  });

  it('the guide page embeds due-dates.png with alt text matching the scene description', () => {
    const manifest = JSON.parse(readFileSync(SCENES_MANIFEST, 'utf8'));
    const scene = manifest.scenes.find((s) => s.id === 'due-dates');
    const guide = readFileSync(GUIDE_PAGE, 'utf8');

    const match = /!\[([^\]]+)\]\(\.\.\/screenshots\/due-dates\.png\)/.exec(guide);
    expect(match).not.toBeNull(); // the guide must link this exact file
    const altText = match[1];
    // The doc's alt text is consistent with (a case-insensitive substring of) the
    // manifest's description — sentence-leading capitalization differs ("A dated
    // item..." vs "...— a dated item...") but the two cannot silently describe
    // different scenes.
    expect(scene.description.toLowerCase()).toContain(altText.toLowerCase());
  });
});

describe('editing-todo visual baseline (F11)', () => {
  it('docs/screenshots/editing-todo.png exists and is a real, non-trivial PNG', () => {
    const stat = statSync(EDITING_TODO_PNG); // throws (test fails) if missing
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);

    const bytes = readFileSync(EDITING_TODO_PNG);
    expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it('scenes.json declares an editing-todo scene with a still "edit" action matching a seeded, dated todo', () => {
    const manifest = JSON.parse(readFileSync(SCENES_MANIFEST, 'utf8'));
    const scene = manifest.scenes.find((s) => s.id === 'editing-todo');
    expect(scene).toBeDefined();
    expect(scene.kind).not.toBe('recording'); // a still PNG scene, not a GIF
    expect(typeof scene.description).toBe('string');
    expect(scene.description.length).toBeGreaterThan(0);

    // The scene drives one row into edit mode via the "edit" still-scene action
    // (mirroring the existing "delete" action) — its `match` must actually
    // identify one of the scene's seeded todos, or scripts/screenshots.mjs's
    // `page.locator('li', { hasText: match })` silently finds nothing and the
    // capture step no-ops on an ordinary, non-editing row.
    expect(scene.action).toBeDefined();
    expect(scene.action.type).toBe('edit');
    const target = scene.todos.find((t) => t.text === scene.action.match);
    expect(target).toBeDefined();
    // The whole point of this scene is to show the date field populated in edit
    // mode, so the targeted todo must actually carry a dueDate.
    expect(target.dueDate).toBeTruthy();
  });

  it('the guide page embeds editing-todo.png with alt text describing the same edit-mode scene', () => {
    const manifest = JSON.parse(readFileSync(SCENES_MANIFEST, 'utf8'));
    const scene = manifest.scenes.find((s) => s.id === 'editing-todo');
    const guide = readFileSync(GUIDE_PAGE, 'utf8');

    const match = /!\[([^\]]+)\]\(\.\.\/screenshots\/editing-todo\.png\)/.exec(guide);
    expect(match).not.toBeNull(); // the guide must link this exact file
    const altText = match[1].toLowerCase();
    const description = scene.description.toLowerCase();

    // The guide's alt text drops the manifest description's "explicit" qualifier,
    // so it isn't a byte-for-byte substring of it (unlike the due-dates scene
    // above) — assert instead that both name the same identifying elements of
    // the scene, so the doc page and the manifest cannot silently drift apart to
    // describe two different captures.
    for (const phrase of ['editing a todo', 'text field', 'date field', 'save/cancel buttons']) {
      expect(description).toContain(phrase);
      expect(altText).toContain(phrase);
    }
  });
});
