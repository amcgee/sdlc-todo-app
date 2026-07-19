# DESIGN — ISSUE-31: Migrate to cloud

Status: ratified (PRODUCT phase closed; engineering — SPEC — begins from this document)
Owner: pm (with the operator)
Work item: ISSUE-31
GitHub issue: #31 — "Migrate to cloud"
PR: #32

---

## Summary

Today the TODO app runs only on a developer's own machine: a single Bun process bound to
loopback that owns a local SQLite file and serves the built UI. There is no way to share it,
reach it from another device, or hand someone a URL. This work migrates the app to run on
Cloudflare's serverless platform so it is reachable on the public internet, provisioned
reproducibly from code (no hand-clicking a console), with two standing environments — a
stable production deployment and an ephemeral per-PR preview deployment for validating changes
before they ship. Deploys are automated from GitHub. The app's behavior and its persistence
promise stay the same; what changes is where and how it runs.

## Users & motivation

- The operator / maintainer wants to deploy the app to a real URL, promote changes safely
  (preview before production), have every push deploy itself without manual steps, and
  re-create the whole setup from source rather than remembered console clicks.
- End users of the TODO app want to open a URL in a browser — from any device, not just the
  host machine — and have the app work and remember their list across reloads, exactly as it
  does locally today.

The motivating problem: local-only deployment makes the app un-shareable and non-durable
beyond one machine, and there is currently no defined path from "it works on my laptop" to
"it's running in the cloud."

## Scope

- The app is reachable at a public URL on Cloudflare and delivers the same user-facing
  behavior it has today: add, toggle, edit, delete, clear-completed, filter (All/Active/
  Completed), remaining count.
- The list remains a **single shared, no-auth list** — anyone with the URL sees and edits the
  same list, exactly as today; this migration does not add access control.
- The todo list persists across reloads, cold starts, and redeploys in the cloud.
- Two environments exist and are both provisioned from code: **Production** (stable, shipped
  state) and **Preview** (non-production). Preview is created **per pull request**, each with
  its own isolated data that never touches production's list. Both environments **start
  empty** — no data is carried over from local machines or between previews.
- **Deploys are automated from GitHub** — no manual CLI step is required to ship. The intended
  mapping is merge/push to the main line → Production and PR opened/updated → its Preview; the
  precise CI trigger wiring is the architect's to design.
- The entire cloud footprint is defined as infrastructure as code, reviewable/versioned/
  re-creatable reproducibly.
- Existing write-path safety guarantees (default-deny origin guard, body-size cap, atomic
  whole-list replace) are carried into the cloud deployment and re-derived for a public origin.

## Non-goals

- No accounts/login/multi-user separation — the shared no-auth model is intentional and
  unchanged.
- No new app features.
- No data migration from local machines, and no data carried between environments — the cloud
  starts empty.
- No commitment to a specific storage primitive or IaC tool in this design doc.
- No multi-region/HA guarantees beyond Cloudflare defaults.
- This design does not provision or own the Cloudflare account itself — account credentials
  are supplied externally at deploy time (see Architectural direction).

## Success criteria

- Production URL loads and every capability works.
- A todo survives reload and redeploy.
- Preview (per-PR) and production data are isolated from each other, and each preview starts
  empty.
- A change pushed to GitHub deploys itself to the right environment with no manual deploy
  step.
- Existing automated test suite still passes.
- Both environments can be torn down/recreated from committed IaC alone (given valid
  credentials).

## Architectural direction

- Cloudflare serverless is mandated.
- **Cloudflare account credentials are a provided external input**: they are supplied at
  deploy time via a GitHub Actions secret — not provisioned by this design, not hardcoded in
  the repo, and not chosen by the architect. The design assumes their availability at deploy
  time.
- **Public URL / domain**: defaults to Cloudflare's `*.workers.dev` address unless a custom
  domain is specified later; a custom domain is out of scope here.
- **Deploy automation is required** and is driven from GitHub using the provided secret; the
  granular CI configuration (exact triggers, job wiring) is the architect's to design.
- Persistence must survive the serverless model (no durable local filesystem) — store choice
  left to architect.
- Everything as infrastructure as code — tool choice left open (Q4 below).
- Two isolated environments with isolated data (production + per-PR preview) — mechanism left
  open.
- Write-path safety must be preserved, re-derived for a public origin.

## Open questions carried into SPEC

1. **IaC tool preference** — Wrangler-native config, Terraform, Pulumi, or the architect's
   call? No default assumed by the operator; the architect may choose.
2. **Cost / limits / region** — any free-tier ceiling or latency/region constraints? Default
   assumption (unconfirmed): Cloudflare free-tier defaults, no region pinning.

---

## Ratification history

- Drafted by `pm` from issue #31.
- Revised after operator feedback (PR #32): confirmed the single-shared/no-auth list, per-PR
  preview with isolated data, and empty-start defaults; answered that the Cloudflare account
  is supplied via a GitHub Actions secret at deploy time, and that deploys must be automated
  from GitHub.
- Ratified by operator comment `@claude continue` on PR #32.
