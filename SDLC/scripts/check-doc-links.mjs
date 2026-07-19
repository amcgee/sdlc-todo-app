#!/usr/bin/env node
// Relative links in the docs must resolve — link rot is the unambiguous, mechanical
// slice of "docs are stale". Scans README.md, docs/ (excluding docs/specs/, which are
// frozen historical artifacts of shipped cycles), and SDLC/*.md (excluding SDLC/templates/,
// which carry placeholder links like `[▶ Live session](<session>)` by design).
// Framework tool (lives in SDLC/scripts/): generic Markdown link checking, no app
// assumptions — a port copies it as-is (or reimplements the same contract sans JS).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function* mdFiles(dir) {
  if (!existsSync(join(ROOT, dir))) return;        // a consumer may not have this root at all
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = posix.join(dir, name);
    if (rel.startsWith('docs/specs')) continue;      // frozen per-cycle artifacts
    if (rel.startsWith('SDLC/templates')) continue;  // driver templates: placeholder links by design
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) yield* mdFiles(rel);
    else if (name.endsWith('.md')) yield rel;
  }
}

const targets = ['README.md', ...mdFiles('docs'), ...mdFiles('SDLC')];
const broken = [];
for (const file of targets) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const link = m[1];
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    const path = link.split('#')[0];
    if (!path) continue;
    if (!existsSync(join(ROOT, dirname(file), path))) {
      broken.push(`${file}: (${link}) does not resolve`);
    }
  }
}

if (broken.length) {
  console.error(`⛔ ${broken.length} broken relative link(s) in docs:`);
  for (const b of broken) {
    console.error(`  - ${b}`);
    if (process.env.GITHUB_ACTIONS) console.error(`::error title=doc links::${b}`);
  }
  process.exit(1);
}
console.log(`doc links: all relative links resolve (${targets.length} files scanned)`);
