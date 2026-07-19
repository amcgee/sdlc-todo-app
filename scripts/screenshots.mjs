#!/usr/bin/env node
// Screenshot capture + visual regression, one tool. The images under docs/screenshots/
// are dual-purpose: embedded in the product docs (README) AND the baselines CI diffs
// against — docs staleness and visual regressions are the same failure, caught the
// same way. Scenes are defined in docs/screenshots/scenes.json; only manifest scenes
// may produce images there.
//
//   node scripts/screenshots.mjs            capture → visual-diff/current/, compare
//                                           against baselines, write diff images to
//                                           visual-diff/, exit 1 on drift
//   node scripts/screenshots.mjs --update   re-capture the BASELINES in docs/screenshots/
//                                           (an SDLC PR that changes them needs a pm
//                                           "visual:" approval note on the ledger — CI
//                                           checks; baselines are never self-approved)
//   --only <id>                             restrict either mode to one scene (e.g. add a
//                                           new scene without regenerating the others)
//
// Scene kinds: a still scene (default) captures one PNG and is pixel-compared; it may
// drive ONE transient, non-seedable state first via a single `action` (e.g. {type:
// "delete", match:"..."} for the post-delete Undo affordance) — still one pixel-compared
// PNG. A "kind": "recording" scene instead scripts a sequence (actions:
// fill/click/dblclick/press, resolved by aria-label → button name → text, optional nth)
// and renders an animated GIF from step-frames — one frame per action, ~1.2s apart,
// longer hold at the end. Recordings are DOCUMENTATION ONLY: never pixel-compared
// (animation diffs flake, and a flaky check teaches agents to regenerate goldens
// blindly). Compare mode just verifies the baseline GIF exists; regeneration happens only
// via --update, and a changed GIF needs the same pm approval as any baseline.
//
// Determinism measures: fixed viewport & deviceScaleFactor, animations/transitions/
// caret disabled via injected CSS, fonts awaited, network idle, server seeded through
// the real API with a throwaway SQLite file, and the page's `Date`/`Date.now()` pinned
// to FROZEN_NOW via Playwright's clock API (setTimeout/setInterval are untouched, so
// timer-driven scenes like the Undo window still work) — a scene showing relative,
// day-counting text ("5 days ago") would otherwise render different text every day the
// repo exists, which a plain "pick a date far enough in the past" trick (sufficient for
// a stable true/false like "overdue") cannot fix. Threshold is deliberately loose (2% of
// pixels) — a flaky visual check trains agents to regenerate baselines blindly, which
// silently turns regression DETECTION into regression RATIFICATION.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright';
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = join(ROOT, 'docs/screenshots/scenes.json');
const BASELINE_DIR = join(ROOT, 'docs/screenshots');
const OUT_DIR = join(ROOT, 'visual-diff');
const PORT = Number(process.env.SCREENSHOT_PORT) || 8123;
const THRESHOLD_RATIO = 0.02;       // >2% differing pixels = drift
// Pinned "now" for every scene capture (see the determinism note above) — an arbitrary,
// fixed, mid-year UTC noon so scene seed dates can be chosen relative to it and never
// drift as real time passes.
const FROZEN_NOW = '2026-06-15T12:00:00.000Z';
const UPDATE = process.argv.includes('--update');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  if (i === -1) return null;
  const id = process.argv[i + 1];
  if (!id || id.startsWith('--')) {
    console.error('screenshots: --only requires a scene id (e.g. --only add-and-complete)');
    process.exit(2);
  }
  return id;
})();
const FRAME_DELAY_MS = 1200;        // per step-frame; the final state holds longer
const LAST_FRAME_DELAY_MS = 2600;

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

async function waitForServer(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${url} never became ready`);
}

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (err) {
    // The environment may pin a chromium build playwright's pinned revision doesn't
    // match (PLAYWRIGHT_BROWSERS_PATH) — fall back to any executable found there.
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (base) {
      for (const guess of ['chromium/chrome-linux/chrome', 'chromium']) {
        const p = join(base, guess);
        if (existsSync(p)) return chromium.launch({ executablePath: p });
      }
      const found = execFileSync('find', [base, '-maxdepth', '3', '-name', 'chrome', '-type', 'f'],
        { encoding: 'utf8' }).trim().split('\n').filter(Boolean)[0];
      if (found) return chromium.launch({ executablePath: found });
    }
    throw err;
  }
}

// --- recording helpers ---------------------------------------------------------------
// Resolve a recording action's target the way a user would name it: accessible label
// first, then button name, then visible text. `nth` disambiguates repeated controls
// (e.g. each row's "Toggle complete").
async function act(page, a) {
  let loc = page.getByLabel(a.target, { exact: true });
  if ((await loc.count()) === 0) loc = page.getByRole('button', { name: a.target, exact: true });
  if ((await loc.count()) === 0) loc = page.getByText(a.target, { exact: true });
  if ((await loc.count()) === 0) throw new Error(`recording action target not found: ${JSON.stringify(a)}`);
  loc = loc.nth(a.nth ?? 0);
  if (a.do === 'fill') await loc.fill(a.value ?? '');
  else if (a.do === 'click') await loc.click();
  else if (a.do === 'dblclick') await loc.dblclick();
  else if (a.do === 'press') await loc.press(a.value ?? 'Enter');
  else throw new Error(`unknown recording action: ${a.do}`);
  await page.waitForTimeout(120); // let the UI commit before the frame
}

function encodeGif(frames) {
  const gif = GIFEncoder();
  const { width, height } = frames[0];
  frames.forEach((f, i) => {
    const rgba = new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength);
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, width, height, {
      palette, delay: i === frames.length - 1 ? LAST_FRAME_DELAY_MS : FRAME_DELAY_MS,
    });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

// --- build (if needed) + seeded server ----------------------------------------------
if (!existsSync(join(ROOT, 'dist/index.html'))) {
  console.log('screenshots: no dist/ build found — running `bun run build`');
  execFileSync('bun', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
}
const dbPath = join(tmpdir(), `screenshots-${process.pid}.sqlite`);
const server = spawn('bun', ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, TODOS_PORT: String(PORT), TODOS_DB_PATH: dbPath },
  stdio: 'ignore',
});

let failures = [];
try {
  const api = `http://127.0.0.1:${PORT}/api/todos`;
  await waitForServer(api);
  const browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: manifest.viewport, deviceScaleFactor: 1,
    reducedMotion: 'reduce', timezoneId: 'UTC', locale: 'en-US',
  });
  // Fix Date/Date.now() only — setTimeout/setInterval keep ticking normally, so the
  // Undo window and any other timer-driven scene are unaffected (see determinism note).
  await page.clock.setFixedTime(new Date(FROZEN_NOW));

  mkdirSync(join(OUT_DIR, 'current'), { recursive: true });
  for (const scene of manifest.scenes) {
    if (ONLY && scene.id !== ONLY) continue;
    const seed = await fetch(api, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scene.todos),
    });
    if (!seed.ok) throw new Error(`seeding ${scene.id} failed: HTTP ${seed.status}`);
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content:
      '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
    await page.evaluate(() => document.fonts.ready);

    if (scene.kind === 'recording') {
      // Documentation-only: a GIF is never pixel-compared (see header). But compare mode
      // still RE-DRIVES the scripted actions, failing if any target no longer resolves —
      // so a recording that demonstrates a control the UI has since removed fails loudly,
      // the one rot a never-compared GIF would otherwise hide. No pixels compared; act()
      // throws when a target can't be found.
      const gifPath = join(BASELINE_DIR, `${scene.id}.gif`);
      if (!UPDATE) {
        if (!existsSync(gifPath)) {
          failures.push(`${scene.id}: no recording baseline — run \`node scripts/screenshots.mjs --update --only ${scene.id}\``);
          continue;
        }
        try {
          for (const a of scene.actions ?? []) await act(page, a);
          console.log(`  ⏭ ${scene.id}: recording — not pixel-compared; ${(scene.actions ?? []).length} action target(s) still resolve`);
        } catch (e) {
          failures.push(`${scene.id}: a recorded action no longer resolves against the current UI — ${e.message}. The GIF may show a removed control; re-record with \`--update --only ${scene.id}\``);
        }
        continue;
      }
      const frames = [PNG.sync.read(await page.screenshot())];
      for (const a of scene.actions ?? []) {
        await act(page, a);
        frames.push(PNG.sync.read(await page.screenshot()));
      }
      writeFileSync(gifPath, encodeGif(frames));
      console.log(`  baseline updated: docs/screenshots/${scene.id}.gif — ${scene.description} (${frames.length} frames)`);
      continue;
    }

    // A still scene may drive ONE transient, non-seedable state before capture (e.g. the
    // post-delete Undo affordance) via a single `action`. Distinct from a recording's
    // scripted `actions`: this yields one still PNG, pixel-compared like any baseline.
    if (scene.action?.type === 'delete') {
      await page.locator('li', { hasText: scene.action.match })
        .getByRole('button', { name: 'Delete' }).click();
      await page.waitForTimeout(100);
    } else if (scene.action?.type === 'edit') {
      await page.locator('li', { hasText: scene.action.match })
        .getByRole('button', { name: 'Edit' }).click();
      await page.waitForTimeout(100);
    }
    const target = UPDATE ? join(BASELINE_DIR, `${scene.id}.png`)
                          : join(OUT_DIR, 'current', `${scene.id}.png`);
    await page.screenshot({ path: target });

    if (UPDATE) {
      console.log(`  baseline updated: docs/screenshots/${scene.id}.png — ${scene.description}`);
      continue;
    }
    const baselinePath = join(BASELINE_DIR, `${scene.id}.png`);
    if (!existsSync(baselinePath)) {
      failures.push(`${scene.id}: no baseline — run \`node scripts/screenshots.mjs --update\``);
      continue;
    }
    const a = PNG.sync.read(readFileSync(baselinePath));
    const b = PNG.sync.read(readFileSync(target));
    if (a.width !== b.width || a.height !== b.height) {
      failures.push(`${scene.id}: size changed ${a.width}x${a.height} → ${b.width}x${b.height}`);
      continue;
    }
    const diff = new PNG({ width: a.width, height: a.height });
    const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.15 });
    const ratio = differing / (a.width * a.height);
    if (ratio > THRESHOLD_RATIO) {
      const diffPath = join(OUT_DIR, `${scene.id}.diff.png`);
      writeFileSync(diffPath, PNG.sync.write(diff));
      failures.push(`${scene.id}: ${(ratio * 100).toFixed(1)}% of pixels differ (diff: ${diffPath})`);
    } else {
      console.log(`  ✅ ${scene.id}: matches baseline (${(ratio * 100).toFixed(2)}% ≤ ${THRESHOLD_RATIO * 100}%)`);
    }
  }
  await browser.close();
} finally {
  server.kill();
  rmSync(dbPath, { force: true });
}

if (UPDATE) {
  console.log('\nBaselines updated. An SDLC PR shipping these needs the pm\'s approval note:');
  console.log('  python SDLC/sdlc.py note --item <ID> --by pm --msg "visual: <scenes> changed intentionally — <why>"');
  process.exit(0);
}
if (failures.length) {
  console.error(`\n⛔ visual drift in ${failures.length} scene(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('\nIf the change is INTENTIONAL: regenerate with --update and get the pm approval note.');
  console.error('If not: the diff images above show what broke.');
  process.exit(1);
}
console.log('visual: all scenes match their baselines');
