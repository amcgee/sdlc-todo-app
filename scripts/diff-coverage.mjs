#!/usr/bin/env node
// Diff coverage: which lines ADDED by this branch have never executed under the test
// suite. The output is a target list — the adversary attacks uncovered new lines first,
// and the reviewer dossier quotes the summary — never a gate: a coverage threshold only
// breeds vanity tests, so this script always exits 0.
//
// Usage:  node scripts/diff-coverage.mjs [base-ref]     (default: origin/main)
// Needs:  coverage/coverage-final.json from `bun run test:coverage` first.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'origin/main';
const root = fileURLToPath(new URL('..', import.meta.url));
const coverageFile = resolve(root, 'coverage/coverage-final.json');

if (!existsSync(coverageFile)) {
  console.log(`diff-coverage: ${relative(root, coverageFile)} not found — run \`bun run test:coverage\` first. (informational; not failing)`);
  process.exit(0);
}

// --- added lines per file, from a zero-context diff of the shipped-code dirs --------
let diff;
try {
  diff = execFileSync(
    'git', ['diff', '-U0', '--no-color', `${base}...HEAD`, '--', 'src', 'server', 'worker'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.log(`diff-coverage: git diff against ${base} failed (${e.message.split('\n')[0]}). (informational; not failing)`);
  process.exit(0);
}

const added = new Map(); // repo-relative path -> Set of added line numbers
let file = null;
for (const line of diff.split('\n')) {
  const f = line.match(/^\+\+\+ b\/(.+)$/);
  if (f) { file = f[1]; continue; }
  const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (h && file) {
    const start = Number(h[1]);
    const count = h[2] === undefined ? 1 : Number(h[2]);
    if (!added.has(file)) added.set(file, new Set());
    for (let i = 0; i < count; i++) added.get(file).add(start + i);
  }
}

// --- coverage lookup: istanbul statement starts, count > 0 = executed ---------------
// Executable lines = statement start lines (the standard istanbul "lines" metric);
// added lines that map to no statement (comments, blanks, braces) are ignored.
const coverage = JSON.parse(readFileSync(coverageFile, 'utf8'));
const byFile = new Map(); // repo-relative path -> Map(line -> hit count)
for (const [abs, data] of Object.entries(coverage)) {
  const rel = relative(root, abs);
  const lines = new Map();
  for (const [id, loc] of Object.entries(data.statementMap || {})) {
    const l = loc.start.line;
    const hits = (data.s || {})[id] ?? 0;
    lines.set(l, Math.max(lines.get(l) ?? 0, hits));
  }
  byFile.set(rel, lines);
}

let executable = 0, covered = 0;
const uncovered = [];
for (const [rel, lineSet] of added) {
  const lines = byFile.get(rel);
  for (const n of [...lineSet].sort((a, b) => a - b)) {
    const hits = lines?.get(n);
    if (hits === undefined) continue; // not executable (or file untracked by coverage)
    executable++;
    if (hits > 0) covered++;
    else uncovered.push(`${rel}:${n}`);
  }
}

if (executable === 0) {
  console.log(`diff-coverage: no executable new lines vs ${base} in src/, server/, worker/.`);
  process.exit(0);
}
const pct = Math.round((100 * covered) / executable);
console.log(`diff-coverage: ${covered}/${executable} executable new lines covered (${pct}%) vs ${base}`);
if (uncovered.length) {
  console.log('uncovered new lines (adversary: attack these first — nothing has ever proven them):');
  for (const u of uncovered) {
    console.log(`  ${u}`);
    if (process.env.GITHUB_ACTIONS) {
      const [f, l] = u.split(':');
      console.log(`::warning file=${f},line=${l},title=untested new line::added by this branch and never executed by the suite`);
    }
  }
}
process.exit(0);
