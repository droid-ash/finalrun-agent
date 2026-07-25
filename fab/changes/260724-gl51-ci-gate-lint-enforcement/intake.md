# Intake: CI PR Test Gate + Lint Enforcement of Code-Quality Principles

**Change**: 260724-gl51-ci-gate-lint-enforcement
**Created**: 2026-07-24

## Origin

This change was initiated conversationally. The user asked how to "support proper TDD and improve
the code", with the end goal that **tests should run at PR opening** and that code should improve
along four principles:

1. Code readability — fewer lines
2. DRY
3. YAGNI
4. Functions should be ~50–60 lines max, and max nesting depth ≤ 4

A full-repo assessment was performed first. Key findings that shaped this change:

- **No PR-triggered CI exists.** `.github/workflows/` contains only `release.yml` and
  `star-notify.yml`. Tests never run on pull requests today.
- **ESLint is extremely permissive.** `eslint.config.mjs` has no `complexity`,
  `max-lines-per-function`, or `max-depth` rules, and explicitly disables `no-unused-vars`,
  `prefer-const`, and `no-explicit-any`. The four target principles are entirely unenforced.
- **The codebase is healthier than expected**: ~26.7k LOC of source across 7 workspaces, with only
  ~18 functions exceeding 60 lines and ~2 functions with genuinely excessive nesting. The real gap
  is *enforcement and a PR gate*, not a rewrite.

> {USER_INPUT}
> "suppose we want to support proper TDD and improve the code... end goal is test should run at PR
> opening and code should improve: 1. code readability (less lines) 2. DRY 3. YAGNI 4. Function
> should be just 50-60 lines and max depth should be <= 4. ... let's start intake with all possible
> stages"

**Scope decision (asked and confirmed):** When asked whether scope should be the enabling
foundation, foundation + refactor, or the full initiative, the user chose **Foundation only**. This
change therefore delivers *only* the enabling infrastructure — the CI PR test gate plus ESLint rule
enforcement of the four principles as **warnings**. **No source refactoring** and **no test
backfilling** happen in this change; those are explicitly out of scope and left for follow-up
changes once the foundation is in place.

## Why

**Problem.** There is no automated quality gate on pull requests. Tests exist (uneven coverage
across packages) but are never executed on PR open, so regressions and standards drift land on
`main` unchecked. The four code-quality principles the user cares about are aspirational — nothing
machine-checks them, so they are not applied consistently.

**Consequence if not fixed.** TDD has no teeth without a gate: a contributor can open a PR that
breaks tests or introduces a 300-line, deeply-nested function and nothing flags it. Quality depends
entirely on manual review, which does not scale and is inconsistent.

**Why this approach.** The highest-leverage, lowest-risk first step is to (a) make tests actually
run at PR open via a `pull_request`-triggered GitHub Actions workflow, and (b) encode the four
principles as ESLint rules so they are machine-checked and visible in every PR. Introducing the
lint rules as **warnings** (not errors) means the foundation lands without breaking the ~18 existing
oversized functions — the offenders become visible in CI output and are cleaned up in later,
separately-scoped changes, at which point the rules can be promoted to errors. This sequencing (gate
first, enforce-as-warn second, refactor + promote-to-error later) is the standard brownfield path
and is what "start with the foundation" means here.

## What Changes

### 1. New PR-triggered CI workflow: `.github/workflows/ci.yml`

A new GitHub Actions workflow triggered on `pull_request` (targeting `main`) — and on `push` to
`main` as a post-merge safety net. It runs the existing repo scripts as the quality gate:

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20.19'   # matches package.json engines >=20.19.0
          # NOTE: no `cache: npm` — package-lock.json is gitignored (.gitignore line 4),
          # so there is no lockfile for setup-node's cache to key on.
      - run: npm install           # NOT `npm ci` — no committed lockfile (mirrors release.yml)
      - run: npm run build --workspaces --if-present
      - run: npm run test:workspaces
      - run: npm run lint          # non-blocking in phase 1 (rules are warnings; eslint exits 0)
```

**Design constraints (verified against the repo, must be honored):**

- **No committed lockfile.** `package-lock.json` is gitignored. The install step MUST be
  `npm install`, never `npm ci` (which requires a lockfile). `release.yml` already documents and
  follows this exact constraint.
- **Tests require a build.** Package test scripts run against compiled output
  (`node --test "dist/**/*.test.js"`; `cli` uses `packages/cli/scripts/runTests.mjs` over
  `dist/`). So the workflow MUST build before testing. Running `npm run test:workspaces` after an
  explicit build step is the intended shape; `npm test` (which itself does `build && test:workspaces`)
  is an acceptable equivalent.
- **Node 20.19**, matching `engines.node` and `release.yml`.

The **test step is the gate** (a failing test fails the PR). The lint step runs but is
non-blocking in phase 1 because the new rules are warnings.

### 2. ESLint rules encoding the four principles: `eslint.config.mjs`

Add a rules block (applied to the TS/TSX source globs) that encodes principles 1 & 4 directly and
supports 2 & 3 indirectly, all at **`warn`** severity initially:

```js
rules: {
  'max-lines-per-function': ['warn', { max: 60, skipBlankLines: true, skipComments: true, IIFEs: true }],
  'max-depth': ['warn', 4],
  'complexity': ['warn', 12],
  // Re-enable the free readability/YAGNI wins currently disabled:
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'prefer-const': 'warn',
}
```

- **`max-lines-per-function: 60`** enforces principle 4's upper bound (user said 50–60; the rule
  takes a single max, so 60 is used). `skipBlankLines`/`skipComments` so the count reflects logic.
- **`max-depth: 4`** enforces principle 4's nesting ceiling directly.
- **`complexity: 12`** is a proxy for DRY/YAGNI sprawl — flags functions doing too much.
- Re-enabling **`no-unused-vars`** and **`prefer-const`** (currently `off` in two places in the
  config) surfaces dead code and needless mutability across the whole tree — the low-risk "fewer
  lines" (readability + YAGNI) lever. `no-explicit-any` stays off (out of scope; noisy).

**Severity is `warn`, not `error`, in this change.** These do not block CI (eslint exits 0 on
warnings only), so the ~18 pre-existing oversized functions do not break the build. The rules make
violations visible in `npm run lint` output. Promotion to `error` is an explicit follow-up change
after the offenders are refactored.

### 3. Make zero-test package scripts tolerant of the no-tests case

<!-- clarified: added after /fab-clarify exploration surfaced a day-one CI-red risk -->

**Problem this fixes.** Two workspaces have a `test` script but zero test files:

- `packages/cloud-core` → `node --test "dist/**/*.test.js"`
- `packages/report-web` → `tsx --test src/**/*.test.ts`

On Node 20.19 (`engines.node`) there is no native glob expansion in `node --test`, and neither
`node --test` nor `tsx --test` finds any matching file. In that state the runner exits **non-zero**
("no test files found"), so `npm run test:workspaces` — and therefore the new CI gate — would fail
on **every PR** for reasons unrelated to any real test failure. This directly defeats the change's
goal ("tests run at PR opening") and MUST be fixed as part of the foundation.

**Fix (chosen: make the scripts tolerant).** Change the two zero-test packages' `test` scripts so
they **exit 0 when — and only when — no test files exist**, while still propagating real failures
once tests are added. The fix MUST NOT be a blanket `|| true` (that would also swallow genuine test
failures). The correct shape is a find-then-run guard:

- Enumerate test files (the same recursive-discovery approach `packages/cli/scripts/runTests.mjs`
  already uses for the dist tree — the difference is the **zero-files exit code**: cli exits 1, these
  packages must exit 0).
- If zero files found → print a "no tests yet" notice and exit 0.
- If files found → run the runner and propagate its real exit code (a genuine failure still fails CI).

This keeps the gate **green and honest**: it goes red only on an actual test failure, never on a
package that simply has no tests yet. Backfilling real tests for these packages remains a separate
follow-up change (see Out of Scope). The minimal edit targets `cloud-core` and `report-web` only;
standardizing all `node --test` packages onto one shared tolerant runner is an optional cleanup and
is **not** required here.

### Out of scope (explicitly deferred to follow-up changes)

- Refactoring any oversized/deeply-nested functions (e.g. `cli/src/testRunner.ts:runTests` ~293L,
  `cloud-core/src/submit.ts:submitRun` ~228L, `goal-executor/src/ai/AIAgent.ts:plan`/`ground`).
- Backfilling *real* tests for untested packages (`report-web` 25 src/0 test, `cloud-core` 4/0).
  (Note: this change only makes their scripts *tolerant* of having no tests — see What Changes §3 —
  it does not add test coverage.)
- Any DRY consolidation (e.g. the android/ios mirror in `device-node`).
- Promoting the lint rules from `warn` to `error`.
- **Prettier `format:check` in CI** — considered during clarify (Gap B) and **deliberately skipped**.
  Formatting stays ungated in this change; `eslint-config-prettier` means `npm run lint` does not
  check it either. Can be added in a follow-up.
- **DRY copy-paste detection tooling** (e.g. `jscpd`) — considered during clarify (Gap C) and
  **deferred** (YAGNI / avoids a new dependency). `complexity: 12` remains the only DRY-adjacent
  signal for now.

## Affected Memory

This change is CI/tooling infrastructure. It does not alter the runtime spec-level behavior of the
existing memory domains (`cli`, `device-node`, `report-web`), so no existing memory file changes.

- `ci/pr-quality-gate`: (new) *(optional — hydrate's call)* A short note that PR CI runs
  build → test → lint via `.github/workflows/ci.yml`, and that the four code-quality principles are
  encoded as ESLint warnings pending promotion to errors. There is no `ci` memory domain today; this
  would create one. If hydrate judges this below the spec-behavior threshold, no memory write is
  needed — the change is self-documenting in `ci.yml` and `eslint.config.mjs`.

## Impact

- **New file**: `.github/workflows/ci.yml` (~20 lines).
- **Modified file**: `eslint.config.mjs` — add a rules block; flip `no-unused-vars` and
  `prefer-const` from `off` to `warn` (they appear in two rule blocks in the current config — both
  should be updated consistently, or the shared rules consolidated).
- **Modified**: `packages/cloud-core/package.json` and `packages/report-web/package.json` — make
  their `test` scripts tolerant of zero test files (What Changes §3). May add a small tolerant
  runner script (e.g. a `scripts/*.mjs` alongside the pattern of `packages/cli/scripts/runTests.mjs`)
  if a one-line inline guard is not clean enough.
- **No source code (`packages/**/src`) changes** — the test-script fix touches `package.json`
  (and possibly a small runner script), not TypeScript source.
- **Dependencies**: no new dependencies — `eslint`, `typescript-eslint`, and all needed rules are
  already installed. `max-lines-per-function`, `max-depth`, `complexity`, `prefer-const` are core
  ESLint rules; `@typescript-eslint/no-unused-vars` is already available.
- **CI cost / behavior**: first-ever PR gate. Because tests build all workspaces first, the job runs
  a full monorepo build — expect a multi-minute job. `concurrency` cancels superseded runs.
- **Risk surface**: low. The only way this breaks a PR is a genuinely failing test (the intended
  behavior). Lint warnings do not fail the job in phase 1.

## Open Questions

- Should the `push: [main]` trigger be included, or `pull_request` only? (Included by default as a
  post-merge safety net; harmless to drop.)
- Long-term: at what point are the lint rules promoted to `error`? (Out of scope here; tracked as
  the follow-up that also does the refactoring.)

## Clarifications

### Session 2026-07-24

Exploration prompted by: "is there something missing when it comes to code quality which I am
missing, can you explore?" A full-repo re-scan surfaced three gaps not covered by the original
intake:

| Gap | Question | Resolution |
|-----|----------|------------|
| A (CI-red risk) | `cloud-core` & `report-web` have `test` scripts but zero test files — the gate would fail every PR. How to handle? | **Make test scripts tolerant** — exit 0 only when no test files exist; still fail on real failures. Added to What Changes §3. |
| B (formatting) | Prettier is configured + has `format:check`, but `eslint-config-prettier` means `lint` doesn't check it. Add `format:check` to CI? | **Skip** — formatting stays ungated in this change; recorded in Out of Scope. |
| C (DRY) | DRY has no direct enforcement (only the `complexity` proxy). Add jscpd copy-paste detection? | **Defer** — avoids a new dependency (YAGNI); recorded in Out of Scope. |

Not a gap (verified): type-checking is already covered by the CI `build` step (`tsc` across
workspaces).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is foundation-only: CI gate + lint warnings, no refactoring or test backfill | User was asked and explicitly chose "Foundation only" | S:95 R:70 A:80 D:90 |
| 2 | Confident | CI triggers on `pull_request` (target `main`) plus `push` to `main` | User's stated goal is "tests run at PR opening"; push-to-main is a standard low-cost safety net, trivially removable | S:80 R:85 A:80 D:75 |
| 3 | Certain | Install step is `npm install`, not `npm ci`; no setup-node npm cache | Verified: `package-lock.json` is gitignored (.gitignore line 4); `release.yml` documents and follows the same constraint | S:90 R:80 A:95 D:95 |
| 4 | Certain | CI must build before running tests | Verified: package test scripts run `node --test` over compiled `dist/`; `cli` uses a dist-based runner | S:90 R:85 A:95 D:95 |
| 5 | Confident | Lint rules land at `warn` severity, not `error`, in this change | ~18 pre-existing oversized functions would break a hard gate; warn keeps the foundation non-breaking and makes violations visible; promotion to error is a deliberate follow-up | S:75 R:80 A:80 D:80 |
| 6 | Confident | `max-lines-per-function` max = 60 (with skipBlankLines/skipComments) | User specified "50–60 lines"; the rule takes a single max, so the upper bound (60) is used, counting logic lines only | S:80 R:85 A:75 D:80 |
| 7 | Confident | `complexity: 12` used as the DRY/YAGNI proxy rule | User's principles 2 & 3 aren't directly lintable; complexity is the standard proxy for functions doing too much. 12 is a conventional threshold | S:55 R:85 A:70 D:65 |
| 8 | Confident | `no-explicit-any` stays disabled | Re-enabling it is out of the stated principles, high-noise across an `any`-heavy codebase, and would balloon scope | S:70 R:80 A:80 D:75 |
| 9 | Tentative | Node 20.19 pinned in CI (single version, no matrix) | Matches `engines.node` and `release.yml`; a version matrix is more than the foundation needs and adds CI cost | S:70 R:85 A:70 D:60 |
| 10 | Tentative | Possibly create a new `ci` memory domain at hydrate | Change is tooling/infra and may fall below the spec-behavior threshold; hydrate decides whether a memory note is warranted | S:50 R:85 A:55 D:55 |
| 11 | Certain | Fix the day-one CI-red risk by making cloud-core & report-web test scripts tolerant of zero tests (exit 0 only when no test files exist; still propagate real failures) | Clarified — user chose "make test scripts tolerant"; verified both packages have 0 test files and their runners exit non-zero on no-match under Node 20.19 | S:95 R:80 A:90 D:85 |
| 12 | Certain | Do NOT add Prettier `format:check` to CI in this change | Clarified — user chose "skip it"; formatting stays ungated for the foundation, addable in a follow-up | S:95 R:85 A:85 D:90 |
| 13 | Certain | Do NOT add DRY copy-paste detection (jscpd) in this change | Clarified — user chose "defer"; avoids a new dependency (YAGNI); `complexity: 12` remains the DRY-adjacent signal | S:95 R:85 A:80 D:90 |

13 assumptions (8 certain, 5 confident, 0 tentative, 0 unresolved).
