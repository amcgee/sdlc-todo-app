import { defineConfig, configDefaults } from 'vitest/config'

// ISSUE-31 (D-TESTS / F1) — CLOUD lane config: `bun run test:cloud` =
// `vitest run --config vitest.cloud.config.js` (NO positional path arg). Finds and
// runs ONLY tests/cloud/**, driving the Worker/D1 runtime via `wrangler dev`.
//
// The path is expressed via `include`, NOT a positional CLI path, precisely
// because a global `exclude` overrides a positional path filter — the defect the
// verifier caught: `vitest run tests/cloud` under a config that excludes
// tests/cloud/** resolves ZERO files and exits 1 ("No test files found"). This
// config's exclude keeps ONLY the standard defaults and deliberately does NOT
// exclude tests/cloud/**, so the required cloud lane actually executes.
export default defineConfig({
  test: {
    include: ['tests/cloud/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    exclude: [...configDefaults.exclude],
  },
})
