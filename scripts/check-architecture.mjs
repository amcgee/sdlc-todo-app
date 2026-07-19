#!/usr/bin/env node
// Enforce the dependency rules declared in docs/architecture.md ("Dependency rules",
// numbered the same). This is the mechanically-checkable slice of the architecture —
// the map stays honest because CI fails when code and map disagree. Changing a rule
// means changing the doc, this script, and adding an ADR in one PR.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function* walk(dir) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = posix.join(dir, name);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) yield* walk(rel);
    else if (/\.(js|jsx|mjs)$/.test(name)) yield rel;
  }
}

function importsOf(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const specs = [];
  const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|export\s[^'"]*?from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (let m; (m = re.exec(src)); ) specs.push(m[1]);
  return specs;
}

function resolveSpec(fromRel, spec) {
  // repo-relative path for relative imports; the raw specifier otherwise
  if (spec.startsWith('.')) {
    return posix.normalize(posix.join(posix.dirname(fromRel), spec));
  }
  if (spec.startsWith('@/')) return posix.join('src', spec.slice(2)); // vite alias
  return spec;
}

const violations = [];
for (const dir of ['src', 'server', 'worker']) {
  for (const file of walk(dir)) {
    for (const spec of importsOf(file)) {
      const target = resolveSpec(file, spec);

      // Rule 1: the client's only backend interface is HTTP
      if (file.startsWith('src/') && /^(server|worker)\//.test(target)) {
        violations.push(`rule 1: ${file} imports ${target} — src/ never imports server/ or worker/`);
      }
      // Rule 2: the worker's single seam is the shared handler
      if (file.startsWith('worker/') && !target.startsWith('worker/')
          && /^(src|server|migrations)\//.test(target)
          && !/^server\/handler(\.js)?$/.test(target)) {
        violations.push(`rule 2: ${file} imports ${target} — worker/ may only reach server/handler.js`);
      }
      // Rule 3: the shared handler stays runtime-portable
      if (/^server\/handler\.js$/.test(file)) {
        if (spec === 'bun:sqlite' || spec.startsWith('node:') || spec.startsWith('bun')) {
          violations.push(`rule 3: server/handler.js imports ${spec} — the shared handler is runtime-portable`);
        }
        if (target.startsWith('src/') && !/^src\/(limits|todos)(\.js)?$/.test(target)) {
          violations.push(`rule 3: server/handler.js imports ${target} — only the pure src/limits.js and src/todos.js are shared`);
        }
      }
      // Rule 4: exactly one module owns bun:sqlite
      if (spec === 'bun:sqlite' && file !== 'server/index.js') {
        violations.push(`rule 4: ${file} imports bun:sqlite — only server/index.js owns the sqlite adapter`);
      }
    }
  }
}

if (violations.length) {
  console.error(`⛔ ${violations.length} architecture violation(s) (rules: docs/architecture.md):`);
  for (const v of violations) {
    console.error(`  - ${v}`);
    if (process.env.GITHUB_ACTIONS) console.error(`::error title=architecture::${v}`);
  }
  process.exit(1);
}
console.log('architecture: dependency rules hold (docs/architecture.md)');
