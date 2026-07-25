# Plan: CI PR Test Gate + Lint Enforcement of Code-Quality Principles

**Change**: 260724-gl51-ci-gate-lint-enforcement
**Intake**: `intake.md`

## Requirements

### CI: PR-Triggered Quality Gate Workflow

#### R1: CI workflow triggers
A new GitHub Actions workflow at `.github/workflows/ci.yml` MUST run on `pull_request` targeting `main` and on `push` to `main` (post-merge safety net), and MUST declare a `concurrency` group keyed on `github.ref` with `cancel-in-progress: true` so superseded runs are cancelled.

- **GIVEN** a pull request is opened (or updated) against `main`
- **WHEN** GitHub receives the event
- **THEN** the CI workflow starts a run for that PR
- **AND** a newer push to the same ref cancels the in-flight run

#### R2: CI job steps and install constraints
The CI job MUST run, in order: `actions/checkout@v4` → `actions/setup-node@v4` with `node-version: '20.19'` and NO npm cache (no committed lockfile — `package-lock.json` is gitignored) → `npm install` (NOT `npm ci`, which requires a lockfile; mirrors `release.yml`) → build all workspaces (`npm run build --workspaces --if-present`) → `npm run test:workspaces` → `npm run lint`. The test step is the gate (a failing test fails the run); the lint step is non-blocking in phase 1 because all new rules are warnings and eslint exits 0 on warnings-only output.

- **GIVEN** the workflow runs on a PR
- **WHEN** any workspace test fails
- **THEN** the `npm run test:workspaces` step exits non-zero and the run fails
- **GIVEN** the workflow runs on a PR whose code only violates the new lint rules
- **WHEN** `npm run lint` reports warnings and no errors
- **THEN** the lint step exits 0 and the run stays green

### Lint: Encode the Four Code-Quality Principles as Warnings

#### R3: New metric rules at warn severity
`eslint.config.mjs` MUST add, to the TS/TSX source config block (`**/*.{ts,tsx,mts,cts}`), at `warn` severity: `max-lines-per-function` with `{ max: 60, skipBlankLines: true, skipComments: true, IIFEs: true }`, `max-depth` with `4`, and `complexity` with `12`.

- **GIVEN** a TS source file containing a 100-logic-line function nested 6 deep
- **WHEN** `npm run lint` runs
- **THEN** `max-lines-per-function` and `max-depth` warnings are reported for it
- **AND** eslint's exit code remains 0 (warnings, not errors)

#### R4: Re-enable disabled readability rules; preserve the rest
`@typescript-eslint/no-unused-vars` MUST be flipped from `off` to `['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]` and `prefer-const` from `off` to `'warn'` — consistently in BOTH rule blocks where they currently appear disabled. `@typescript-eslint/no-explicit-any` MUST stay `off`, and the `ignores` list MUST NOT be modified.

- **GIVEN** the two existing rule blocks that disable `@typescript-eslint/no-unused-vars` and `prefer-const`
- **WHEN** the config is updated
- **THEN** both blocks carry the `warn` severities (no block left at `off` that would win the flat-config merge)
- **AND** an identifier prefixed `_` raises no unused-var warning

### Tests: Zero-Test Packages Must Not Fail the Gate

#### R5: cloud-core tolerant test script
`packages/cloud-core`'s `test` script MUST exit 0 when — and only when — no test files exist, and MUST propagate the runner's real exit code when test files are present. A blanket `|| true` is prohibited. The implementation SHALL be a find-then-run guard modeled on `packages/cli/scripts/runTests.mjs` (recursive discovery of `dist/**/*.test.js`) with the zero-files exit code inverted from 1 to 0.

- **GIVEN** `packages/cloud-core` has been built and contains no `dist/**/*.test.js`
- **WHEN** `npm run test --workspace=@finalrun/cloud-core` runs
- **THEN** it prints a "no tests yet" notice and exits 0
- **GIVEN** a failing compiled test file exists under `dist/`
- **WHEN** the script runs
- **THEN** it exits non-zero with the runner's real exit code

#### R6: report-web tolerant test script
`packages/report-web`'s `test` script MUST behave equivalently for its `tsx --test src/**/*.test.ts` shape: discover `src/**/*.test.ts` files; exit 0 with a notice when zero exist; otherwise run them through the tsx loader and propagate the real exit code.

- **GIVEN** `packages/report-web/src` contains no `*.test.ts` files
- **WHEN** `npm run test --workspace=@finalrun/report-web` runs
- **THEN** it prints a "no tests yet" notice and exits 0
- **GIVEN** a failing `src/**/*.test.ts` exists
- **WHEN** the script runs
- **THEN** it exits non-zero

#### R8: With-tests packages must run under CI's pinned Node 20.19
The `test` scripts of `packages/common`, `packages/device-node`, and `packages/goal-executor` MUST execute their existing tests successfully under Node 20.19 (the CI-pinned version) AND under Node ≥21 (developer machines). Their current form — `node --test "dist/**/*.test.js"` — fails on Node 20.19 with `Could not find 'dist/**/*.test.js'` **even when test files exist**, because native glob expansion in `node --test` arrived in Node 21 (verified empirically against a real 20.19.0 binary). Without this fix the new CI gate is red on every PR for a reason unrelated to any real test failure, defeating R2/R7. The fix SHALL be a shared find-then-run runner (`scripts/run-node-tests.mjs`, invoked as `node ../../scripts/run-node-tests.mjs` from each workspace) with STRICT semantics (zero discovered test files → exit 1, since these packages have real tests), because both one-liner alternatives fail on one side of the version range: the glob form breaks on 20.19, and a directory positional (`node --test dist/`) was verified on Node 24 to resolve to a single bogus passing entry — a silently-green suite that runs nothing.

- **GIVEN** the three packages built under Node 20.19 or Node ≥21
- **WHEN** `npm run test --workspaces --if-present` runs
- **THEN** all existing tests (75 common + 91 device-node + 67 goal-executor) run and pass on both versions
- **AND** the discovered test-file set is identical to the old glob's under Node ≥21 (explicit `.test.js`-suffix discovery, verified identical counts)

#### R9: Baseline lint errors cleared so the lint step can exit 0
The two pre-existing `npm run lint` ERRORS on main (verified present with the unmodified baseline config: exit 1, "2 problems (2 errors, 0 warnings)") MUST be cleared with behavior-neutral mechanical edits, because the intake's design requires the phase-1 lint step to exit 0 (warnings-only): (a) `packages/cli/src/finalrun.test.ts` `no-useless-escape` — remove the redundant backslash in `` `...}\"` `` (inside a template literal `\"` already produces `"`, so the resulting string is byte-identical); (b) `packages/report-web/src/routes/StandaloneReportApp.tsx` — remove the stale `// eslint-disable-next-line react-hooks/exhaustive-deps` comment (the react-hooks plugin is not installed, so eslint hard-errors "Definition for rule ... was not found"; the comment suppresses nothing).

- **GIVEN** the two mechanical fixes applied
- **WHEN** `npm run lint` runs
- **THEN** it reports 0 errors and exits 0
- **AND** neither fix changes any runtime or test behavior (identical string value; removed no-op comment)

### Verification: The Gate Must Be Green and Honest

#### R7: Local verification of the full gate sequence
After the changes, the CI-equivalent command sequence MUST be verified locally: `npm install` succeeds; `npm run build --workspaces --if-present` builds every workspace this change touches; `npm run test:workspaces` runs green for every suite except failures that pre-date this change; and `npm run lint` exits 0 with the new rules surfacing as warnings. This change MUST NOT introduce any new build, test, or lint failure. (Discovered during verification, recorded in Notes: `main` itself is red under a fresh install — goal-executor's `tsc` fails on drifted `ai`/`@ai-sdk/*` types, and 6 cli tests fail from test-vs-implementation drift, reproduced identically on Node 20.19 and 24 and on the unmodified baseline. Repairing those is source-scope work excluded from this change; until those follow-ups land, the new gate is honestly red on them — which is the gate doing its job, not a defect of this change.)

- **GIVEN** a clean checkout with the change applied
- **WHEN** `npm install && npm run build --workspaces --if-present && npm run test:workspaces && npm run lint` runs
- **THEN** common (75), device-node (91), goal-executor (67) suites pass, cloud-core and report-web exit 0 via the tolerant runners, and lint exits 0 with warnings only
- **AND** the only failing steps are the two pre-existing main breakages (goal-executor build; 6 cli tests), byte-identical with and without this change's diff

### Non-Goals

- No source refactoring of oversized/deeply-nested functions — foundation only.
- No test backfilling for cloud-core / report-web.
- No Prettier `format:check` in CI; no jscpd/DRY tooling; no promotion of lint rules to `error` (all explicitly deferred by the intake).
- No consolidation of `packages/cli/scripts/runTests.mjs` or the two tolerant per-package runners onto the new shared `scripts/run-node-tests.mjs` — the shared script exists only because verification proved `common`/`device-node`/`goal-executor` fail under CI's pinned Node 20.19 (see R8); full runner standardization stays deferred per the intake.
- No fixing of pre-existing `main` breakage surfaced by verification (see Notes): the 6 failing cli tests (test-vs-implementation drift) and the goal-executor `tsc` failure under a fresh dependency install (lockfile-less semver drift of the `ai`/`@ai-sdk/*` packages). Both require source-level judgment explicitly outside this config/tooling-only change; both are exactly the class of regression the new gate exists to surface, and each needs its own follow-up change.

### Design Decisions

#### Per-package runner scripts instead of inline shell guards
**Decision**: Add a small `scripts/runTests.mjs` to each of `packages/cloud-core` and `packages/report-web`, pointed at by their `test` scripts.
**Why**: Mirrors the existing, proven `packages/cli/scripts/runTests.mjs` pattern (portable across Node 20.x where `node --test` glob expansion is unavailable, portable across shells/OSes); an inline `sh -c 'find … && …'` guard is not Windows-safe and harder to read.
**Rejected**: Inline `||`/`find`-based one-liners in `package.json` — shell-dependent, unreadable, and easy to get subtly wrong (the exact `|| true` failure mode the intake prohibits).
*Introduced by*: 260724-gl51-ci-gate-lint-enforcement

#### Shared strict runner for the with-tests packages' Node-20.19 glob breakage
**Decision**: Fix the Node-20.19 glob breakage in `common`/`device-node`/`goal-executor` with one shared find-then-run script at `scripts/run-node-tests.mjs` (cwd-based discovery of `dist/**/*.test.js`, strict zero-files → exit 1), invoked as `node ../../scripts/run-node-tests.mjs` (npm sets cwd to the workspace dir).
**Why**: Explicit file discovery + spawn is the only form verified to run the full suites deterministically on BOTH Node 20.19 (CI) and Node ≥21 (dev machines); one shared copy avoids duplicating the script into three packages.
**Rejected**: (a) `node --test dist/` — works on 20.19 but verified on Node 24 to resolve the directory positional to a single bogus passing entry (tests 1/pass 1 instead of 75), i.e. a silently-green suite; (b) bumping CI's node-version to ≥21 — would stop validating the `engines.node >= 20.19.0` floor the repo declares; (c) copying `packages/cli/scripts/runTests.mjs` into each package — 3× duplication of a ~70-line script in a change that exists to enforce DRY.
*Introduced by*: 260724-gl51-ci-gate-lint-enforcement

## Tasks

### Phase 1: Setup

- [x] T001 Create `.github/workflows/ci.yml`: `pull_request` (branches: main) + `push` (branches: main) triggers, `concurrency` group `ci-${{ github.ref }}` with cancel-in-progress, single job running checkout@v4 → setup-node@v4 (node-version '20.19', no npm cache, with the release.yml-style lockfile comment) → `npm install` → `npm run build --workspaces --if-present` → `npm run test:workspaces` → `npm run lint` <!-- R1, R2 -->

### Phase 2: Core Implementation

- [x] T002 [P] Edit `eslint.config.mjs`: add `max-lines-per-function` (`warn`, `{max:60, skipBlankLines:true, skipComments:true, IIFEs:true}`), `max-depth` (`warn`, 4), `complexity` (`warn`, 12) to the `**/*.{ts,tsx,mts,cts}` block; flip `@typescript-eslint/no-unused-vars` → `['warn', {argsIgnorePattern:'^_', varsIgnorePattern:'^_'}]` and `prefer-const` → `'warn'` in BOTH existing rule blocks; leave `no-explicit-any` off and `ignores` untouched <!-- R3, R4 -->
- [x] T003 [P] Add `packages/cloud-core/scripts/runTests.mjs` (find `dist/**/*.test.js`; zero files → notice + exit 0, with a guard that errors if `src/**/*.test.ts` sources exist but dist has no compiled tests; else spawn `node --test` and propagate exit/signal) and point `packages/cloud-core/package.json` `test` at `node ./scripts/runTests.mjs` <!-- R5 -->
- [x] T004 [P] Add `packages/report-web/scripts/runTests.mjs` (find `src/**/*.test.ts`; zero files → notice + exit 0; else run them via the tsx loader — `node --import tsx --test` — and propagate exit/signal) and point `packages/report-web/package.json` `test` at `node ./scripts/runTests.mjs` <!-- R6 -->

### Phase 3: Integration & Edge Cases

- [x] T005 Run `npm install` at the repo root, then `npm run build --workspaces --if-present`; confirm all workspaces build <!-- R7 -->
- [x] T006 Run `npm run test:workspaces`; confirm exit 0 — existing tests (cli, common, device-node, goal-executor) pass and cloud-core/report-web print the tolerant "no tests yet" notice <!-- R5, R6, R7 -->
- [x] T007 Run `npm run lint`; confirm exit 0 with warnings (not errors) from the new rules present in the output <!-- R3, R4, R7 -->
- [x] T008 Verify CI-parity semantics under Node 20.19 specifically (the pinned CI version): confirm the two new runner scripts behave identically (they use explicit file discovery, no glob reliance), and confirm the with-tests packages' test invocation works under 20.19; validate `ci.yml` YAML syntax <!-- R2, R5, R6 -->
- [x] T009 Fix the Node-20.19 glob breakage surfaced by T008: add shared strict runner `scripts/run-node-tests.mjs` and point `test` at `node ../../scripts/run-node-tests.mjs` in `packages/common/package.json`, `packages/device-node/package.json`, and `packages/goal-executor/package.json`; verify under BOTH a real 20.19.0 binary and Node 24 that all three suites run at full counts (75/91/67) with exit 0 <!-- R8 -->
- [x] T010 Clear the two pre-existing baseline lint errors so `npm run lint` can exit 0: remove the useless `\"` escape in `packages/cli/src/finalrun.test.ts` (byte-identical string) and the stale `react-hooks/exhaustive-deps` disable comment in `packages/report-web/src/routes/StandaloneReportApp.tsx` (plugin not installed); re-run lint and confirm 0 errors <!-- R9 -->
- [x] T011 Document the pre-existing main breakage surfaced by verification (goal-executor fresh-install build failure; 6 cli test failures) in this plan's Notes with reproduction evidence, and confirm none of it is attributable to this change's diff <!-- R7 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `.github/workflows/ci.yml` exists with `pull_request`→main and `push`→main triggers and a `concurrency` block with `cancel-in-progress: true`
- [x] A-002 R2: The CI job's step order is checkout → setup-node (20.19, no cache) → `npm install` → workspace build → `npm run test:workspaces` → `npm run lint`, with no `npm ci` and no `cache: npm` anywhere
- [x] A-003 R3: `eslint.config.mjs` carries `max-lines-per-function` `{max:60, skipBlankLines:true, skipComments:true, IIFEs:true}`, `max-depth` 4, and `complexity` 12, all at `warn`, scoped to the TS/TSX source block
- [x] A-004 R4: `@typescript-eslint/no-unused-vars` and `prefer-const` are `warn` in both formerly-disabling rule blocks; `@typescript-eslint/no-explicit-any` remains `off`; the `ignores` list is byte-identical to before
- [x] A-005 R5: `packages/cloud-core` `test` exits 0 when no test files exist (verified) and its runner propagates real exit codes when files are present (no `|| true` anywhere)
- [x] A-006 R6: `packages/report-web` `test` exits 0 when no `src/**/*.test.ts` exists (verified) and propagates real failures when tests are present

### Behavioral Correctness

- [x] A-007 R2: A warnings-only lint run exits 0 (verified locally), so the lint step cannot fail a phase-1 PR
- [x] A-008 R5: The zero-files exit code is inverted relative to `packages/cli/scripts/runTests.mjs` (cli exits 1; cloud-core/report-web exit 0) and ONLY the zero-files case is tolerated — injected failing test propagates non-zero (verified by temporary-file experiment)

### Scenario Coverage

- [x] A-009 R7: `npm run test:workspaces` runs the full suites green for common (75), device-node (91), goal-executor (67), and exits 0 for cloud-core/report-web via the tolerant runners; the only failures are the 6 cli tests verified to pre-date this change (identical on the baseline, on Node 20.19 and 24)
- [x] A-010 R7: `npm run lint` exits 0 and its output contains warnings from `max-lines-per-function` / `max-depth` / `complexity` (rules proven active)
- [x] A-011 R7: `npm run build --workspaces --if-present` builds every workspace except goal-executor, whose `tsc` failure is verified to pre-date this change (fresh-install `ai`/`@ai-sdk/*` semver drift on a lockfile-less repo; no file in this change's diff is an input to that build)

### Edge Cases & Error Handling

- [x] A-012 R5: If test sources appear under `packages/cloud-core/src` but `dist/` has no compiled tests (unbuilt tree), the runner exits 1 with a build hint rather than silently exiting 0
- [x] A-017 R8: `common`, `device-node`, and `goal-executor` `test` scripts use the shared `scripts/run-node-tests.mjs` and their full suites pass at identical counts (75/91/67) under BOTH a real Node 20.19.0 binary and Node 24 — the old glob form's `Could not find` failure on 20.19 is gone, and the `node --test dist/` silently-green trap on Node ≥21 is avoided
- [x] A-018 R8: The shared runner is strict — zero discovered `dist/**/*.test.js` or a missing `dist/` exits 1 with a diagnostic (never a silent pass), and signal deaths propagate as 128+signo
- [x] A-019 R9: `npm run lint` reports 0 errors after the two behavior-neutral fixes (verified: baseline config had the same 2 errors, so both pre-date this change's rules)
- [x] A-020 R7: No new build, test, or lint failure is introduced by this change — every failure observed during verification reproduces byte-identically without this change's diff applied
- [x] A-013 R2: `ci.yml` parses as valid YAML (syntax-checked), and the workflow performs no operation requiring elevated permissions (read-only build/test/lint)

### Code Quality

- [x] A-014 Pattern consistency: `ci.yml` mirrors `release.yml` conventions (setup-node 20.19, no-cache comment, `npm install` rationale); the new runner scripts mirror `packages/cli/scripts/runTests.mjs` structure and error-surfacing style
- [x] A-015 No unnecessary duplication: the runner scripts reuse the established cli runner pattern rather than inventing a new mechanism; no new dependencies introduced
- [x] A-016 No magic values: the CI node version and lint thresholds are the intake-specified values with comments explaining the non-obvious constraints (no lockfile → no cache/`npm ci`)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

### Pre-existing main breakage discovered during apply verification (follow-up changes needed)

Both issues reproduce with this change's diff removed, on the unmodified baseline — they are what the new gate will honestly flag red until fixed:

1. **goal-executor does not build under a fresh `npm install`.** `packages/goal-executor/src/ai/AIAgent.ts(575,9)` `error TS2322`: the local `AIAgentProviderOptions` (its `fallbacks[].thinking`/`output_config` typed `Record<string, unknown>`) is no longer assignable to the AI SDK's `SharedV3ProviderOptions`/`JSONObject`. Cause: `package-lock.json` is gitignored, so every fresh install resolves the newest semver-matching `ai`/`@ai-sdk/*` (observed: `ai@6.0.235`, `@ai-sdk/provider@3.0.14`, `@ai-sdk/anthropic@3.0.101`), whose types drifted. Note `tsc` still EMITS `dist/` despite the error (no `noEmitOnError`), which is why the 67 goal-executor tests pass — only the build STEP fails. Fix requires goal-executor source/type work (and/or a lockfile decision) — its own change.
2. **6 of 115 cli tests fail** (`packages/cli` suite; identical under Node 20.19.0 and 24): 3 `runDoctorCommand` output-format expectations (`/Setup Required/`, `/Ready/` headers absent from captured output), 2 `start-server`/`stop-server` help/behavior expectations (e.g. expected `/stop the local finalrun report server/i` vs actual "Stop all running FinalRun report servers and clear stale state"), and "warning-only results do not block a local run". Classic test-vs-implementation drift accumulated while no CI ran tests. Per the constitution's Test Integrity clause, deciding test-vs-spec-vs-implementation direction is source-scope work — its own change.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The three metric rules (`max-lines-per-function`, `max-depth`, `complexity`) go in the `**/*.{ts,tsx,mts,cts}` block (the TS/TSX source config), not the broader TS+JS block — so `.mjs` helper scripts and `eslint.config.mjs` itself are not metric-checked | Intake says "applied to the TS/TSX source globs"; the four principles target TypeScript source; helper scripts stay out of scope | S:75 R:90 A:85 D:75 |
| 2 | Confident | Both `off` blocks are updated in place (flip to `warn`) rather than consolidated into one shared block | Intake offers either; in-place flip is the minimal diff, keeps the existing block structure (pre-recommended base block + post-recommended override block) intact, and avoids accidental severity resolution changes from reordering flat-config entries | S:70 R:90 A:85 D:70 |
| 3 | Confident | New per-package `scripts/runTests.mjs` runners (cloud-core, report-web) rather than inline shell guards in `package.json` | Intake explicitly sanctions this shape ("You may add a small runner script per package"); mirrors the proven cli pattern; portable (no shell globbing/`find` dependence, works on Node 20.x without `node --test` glob support) | S:85 R:90 A:90 D:80 |
| 4 | Confident | report-web's runner invokes discovered test files via `node --import tsx --test <files>` (spawning `process.execPath`) instead of spawning the `tsx` binary | Equivalent semantics (tsx's `--test` is a wrapper over node's runner with the tsx loader); spawning `process.execPath` mirrors the cli runner and avoids cross-platform binary-resolution issues (`tsx.cmd` on Windows); `--import tsx` is tsx's documented Node ≥20.6 usage | S:65 R:85 A:80 D:70 |
| 5 | Confident | cloud-core's runner adds a src-tests-without-dist-tests guard (exit 1 with a build hint) so the zero-files exit 0 can never mask an unbuilt tree once tests are added | The intake's "exit 0 only when no test files exist" demands distinguishing "no tests authored" from "tests authored but not compiled"; the cli runner's missing-dist error shows the same concern | S:70 R:90 A:85 D:75 |
| 6 | Certain | CI job uses `runs-on: ubuntu-latest` and the step list verbatim from the intake's YAML sketch | The intake reproduces the intended workflow body in full; deviating would contradict the design input | S:90 R:90 A:95 D:90 |
| 7 | Confident | `npm run build --workspaces --if-present` is used as the CI build step (invoking workspace builds directly) rather than root `npm run build` | Matches the intake sketch verbatim; equivalent output (root `build` is the same command) while skipping the root `prebuild` hook, which is redundant right after `npm install` | S:75 R:90 A:85 D:80 |
| 8 | Confident | report-web's runner discovers `*.test.ts` only (not `.test.tsx`), matching the existing `tsx --test src/**/*.test.ts` glob exactly | Behavior-preserving fidelity to the current script; widening the match is out of scope (YAGNI) and `config.yaml` `test_paths` also lists only `*.test.ts`/`*.spec.ts` | S:70 R:90 A:85 D:75 |
| 9 | Confident | Fixing the with-tests packages' Node-20.19 glob breakage (R8, shared `scripts/run-node-tests.mjs` for common/device-node/goal-executor) is in scope, despite the intake's "minimal edit targets cloud-core and report-web only" | The intake's primary requirement is a green, honest gate on CI's pinned Node 20.19; empirical verification against a real 20.19.0 binary proved the old glob form fails there even WITH test files present, so the gate would be red on every PR without this — the intake's scoping statement assumed (incorrectly) that these packages worked on 20.19. Behavior-identical fix (verified identical suite counts on 20.19 and 24) | S:75 R:90 A:85 D:80 |
| 10 | Confident | Clearing the two pre-existing baseline lint ERRORS (R9) via behavior-neutral mechanical edits is in scope, even though both sit in source files | The intake's design requires the phase-1 lint step to exit 0 ("eslint exits 0 on warnings only") — impossible while baseline errors exist; both fixes are provably behavior-neutral (template-literal `\"` ≡ `"`; the removed disable comment references an uninstalled plugin rule and suppresses nothing) and require zero domain judgment, unlike the excluded test/build repairs | S:70 R:90 A:90 D:80 |
| 11 | Confident | The pre-existing main breakage (goal-executor fresh-install build failure; 6 cli test failures) is NOT fixed in this change — documented in Notes and left red for follow-up changes | Both require source-level and spec-direction judgment (constitution Test Integrity: tests conform to spec) explicitly outside this config/tooling-only foundation; both verified to reproduce without this change's diff, on Node 20.19 and 24; an honest red gate on real breakage is the change's intended behavior, and silently patching around it (e.g. `continue-on-error`) would defeat the gate | S:80 R:75 A:80 D:80 |

11 assumptions (1 certain, 10 confident, 0 tentative).
