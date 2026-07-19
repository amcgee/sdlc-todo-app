import { defineConfig, configDefaults, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config.js'

// ISSUE-31 (D-TESTS) — DEFAULT lane config: `bun run test` = `vitest run` (no path
// arg). Runs exactly the pre-existing suites — the pure core, the two mocked
// component suites, and the ISSUE-19 integration suite — and NEVER picks up
// tests/cloud/** (which needs wrangler/workerd, absent from the default job).
//
// The mandated scoping (F1) is `exclude: [...configDefaults.exclude, 'tests/cloud/**']`
// on top of the standard defaults; include stays the Vitest default glob and
// `bun run test` is invoked with no path argument.
//
// It is merged over vite.config.js (via mergeConfig) so the React plugin and the
// `@` → src/ alias that the .jsx component suites depend on are preserved. A
// standalone vitest.config.js would otherwise stop Vitest from auto-loading
// vite.config.js, breaking `@/lib/utils` resolution and JSX transform in those
// suites (regressing R-SUITE). No global `environment` override — the per-file
// `// @vitest-environment` pragmas keep environments scoped.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // vendor/** holds the framework submodule — never part of the app's test lanes.
      exclude: [...configDefaults.exclude, 'tests/cloud/**', 'vendor/**'],
      // Coverage is informational only — scripts/diff-coverage.mjs turns it into a
      // map of untested new lines for the adversary and the reviewer dossier. It is
      // never a gate or a target (see SDLC docs: a coverage threshold just breeds
      // vanity tests).
      coverage: {
        provider: 'v8',
        include: ['src/**', 'server/**', 'worker/**'],
        reporter: ['text-summary', 'json', 'json-summary'],
        reportsDirectory: 'coverage',
      },
    },
  })
)
