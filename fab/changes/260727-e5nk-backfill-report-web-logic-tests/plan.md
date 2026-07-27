# Plan: Close the Last Zero-Coverage Package — `report-web` Logic Tests

**Change**: 260727-e5nk-backfill-report-web-logic-tests
**Intake**: `intake.md`

## Requirements

### report-web: Characterization tests for the DOM-free logic modules

#### R1: `viewModel.ts` decision logic is pinned by characterization tests
`packages/report-web/src/ui/test/viewModel.test.ts` MUST pin, against the unmodified source, the
behaviours with user-facing consequence: `classifyTestStatus` (aborted precedence over `success`,
success, `run_failure` first-step → `error`, default → `failure`), `buildTestListItems` (join of
selected vs executed tests by `testId`, the synthesized-input fallback when no tests were selected,
`not_executed`/`NA` for a selected-but-never-run test), `summarizeTestItems` (per-status counting),
`deriveReportTitle` (suite name > single test name > "+N more" > runId fallback chain),
`buildRunScopedArtifactPath` (run-scoped `/artifacts/<runId>/…` routing with the absolute-URL
passthrough guard), `toReportViewModel` (artifact-path rewriting across paths/suite/tests/steps/
firstFailure, absent fields staying `undefined`), `resolveStepReasoning` (first non-empty candidate
of think/plan/reason that differs from the title), `resolveRunTarget`, `formatRelativeTime` (with
`Date.now` stubbed and restored in a `finally`), `formatVideoTimestamp`, `statusLabelLong`, and
`reportPayloadForController` (reduced payload shape).

- **GIVEN** a `ReportManifestTestRecord` with `status: 'aborted'` and `success: true`
- **WHEN** `classifyTestStatus` runs
- **THEN** the result is `'aborted'` (abort wins over success)

- **GIVEN** a manifest whose `input.tests` selects a test that never executed
- **WHEN** `buildTestListItems` runs
- **THEN** that item has `status: 'not_executed'` and `durationLabel: 'NA'`

- **GIVEN** a test record whose `recordingFile` is an absolute `https://` URL
- **WHEN** `toReportViewModel` runs
- **THEN** the URL is passed through unchanged, not encoded into a local `/artifacts/` path

#### R2: `logs.ts` log parsing is pinned
`packages/report-web/src/ui/test/logs.test.ts` MUST pin `parseLogTimestamp` (Android threadtime
format with reference-date year resolution, iOS compact format, non-matching → `undefined`),
`parseLogLevel` (iOS `E`/`Ef`→error, `W`/`Wf`→warn; Android `F`/`E`→error, `W`→warn, others→info),
and `parseDeviceLogLines` (empty text → `[]`, filtering of timestamped lines before
`recordingStartedAt`, retention of untimestamped lines, per-line text/timestamp/level mapping).

- **GIVEN** a device log containing lines timestamped before and after the recording start
- **WHEN** `parseDeviceLogLines(logText, recordingStartedAt)` runs
- **THEN** the earlier lines are dropped and untimestamped lines are kept

#### R3: `format.ts` formatting is pinned
`packages/report-web/src/ui/test/format.test.ts` MUST pin `formatLongDuration` (0/undefined→'0s',
seconds, minutes+seconds, hours+minutes, sub-second rounding), `formatStepDuration` (one decimal
below 10s, whole seconds at ≥10s), `successRateTone` (80/50 thresholds), `summaryIconStyle`
(per-tone style strings), and `statusPillLabel`.

- **GIVEN** a duration of 3,661,000 ms
- **WHEN** `formatLongDuration` runs
- **THEN** the label is `'1h 1m'` (seconds suppressed at hour scale)

#### R4: `routes.ts` route construction is pinned
`packages/report-web/src/ui/test/routes.test.ts` MUST pin `buildRunRoute` (URI-encoding of the run
id) and `buildArtifactRoute` (backslash normalization, leading-slash strip, per-segment encoding,
empty-segment filtering, and the throw on `.`/`..` traversal segments).

- **GIVEN** a relative path containing `..`
- **WHEN** `buildArtifactRoute` runs
- **THEN** it throws `Invalid artifact path: …`

#### R5: `fetchers.ts` fetch helpers are pinned
`packages/report-web/src/test/fetchers.test.ts` MUST pin `fetchReportIndex` and `fetchReportRun`
by stubbing `globalThis.fetch` (restored in a `finally`): the exact endpoint URLs (including
`encodeURIComponent` of the run id), the `Accept: application/json` header, JSON passthrough on
ok responses, and the error message shape on non-ok responses.

- **GIVEN** a stubbed `fetch` returning `{ ok: false, status: 404, statusText: 'Not Found' }`
- **WHEN** `fetchReportRun('my run')` runs
- **THEN** it rejects with `Failed to load run my run (404 Not Found)` and requested
  `/api/report/runs/my%20run`

#### R6: `icons.ts` icon constants are pinned
`packages/report-web/src/ui/test/icons.test.ts` MUST pin the `data:image/svg+xml,` URI shape of
the three data-URI icons (round-trip: `decodeURIComponent` of the payload yields the original
`<svg …>` markup) and the inline stroke-SVG constants' load-bearing attributes (`viewBox`,
`aria-hidden`).

- **GIVEN** `TEST_ICON_SRC`
- **WHEN** its `data:image/svg+xml,` prefix is stripped and the rest decoded
- **THEN** the result is an `<svg>` document containing the `#707EAE` fill

#### R7: `artifacts.ts` stays a runtime-empty type barrel
`packages/report-web/src/test/artifacts.test.ts` MUST pin that the module has **zero runtime
exports** — it is a type-only barrel shipped to browsers, and a runtime export (or a Node built-in
import that executes on load) would be a contract break for the `@finalrun/report-web/ui` library
consumers. This is the only runtime-observable behaviour the module has; its interface shapes are
compile-time-only and are exercised structurally by the `viewModel.test.ts` fixtures typed as
`ReportRunManifest`/`ReportManifestTestRecord`.

- **GIVEN** `import * as artifacts from '../artifacts'`
- **WHEN** the module namespace is inspected
- **THEN** it has no own enumerable runtime keys

#### R8: Every meaningful pin is mutation-verified
For each module, at least one deliberate single-behaviour corruption of the source MUST be applied
temporarily, the suite run (confirming exactly the pinning test fails), and the source reverted
byte-identical (verified via `git diff` empty for `packages/report-web/src` outside test files).
Priority mutations target `viewModel.ts`'s status derivation and failure attribution.

- **GIVEN** `classifyTestStatus` mutated so `run_failure` maps to `'failure'` instead of `'error'`
- **WHEN** the suite runs
- **THEN** the `classifyTestStatus` characterization test fails and no other module's tests do

### report-web: Runner graduation

#### R9: Zero test files is a hard error for report-web
`packages/report-web/scripts/runTests.mjs` MUST exit **1** (not 0) when it finds zero test files.
The empirical check decides shared-vs-local: the shared `scripts/run-node-tests.mjs` discovers
compiled `dist/**/*.test.js`, but `report-web` builds with `tsup` (entry-based bundles for
`ui/index`/`routes/index`, `tsconfig.lib.json` excludes `**/*.test.ts`) and `vite` (bundled SPA in
`dist/app`), so test files MUST be verified as absent from `dist/` after a build — if absent (the
expected outcome), the package-local runner is kept and corrected rather than force-switched.

- **GIVEN** a built `report-web` with the new test files present in `src/`
- **WHEN** `find packages/report-web/dist -name '*.test.js'` runs
- **THEN** it finds nothing, so the shared dist-based runner cannot discover the tests
- **GIVEN** the corrected runner and no `src/**/*.test.ts(x)` files
- **WHEN** `npm test -w @finalrun/report-web` runs
- **THEN** it exits 1 with a "no test files" error

#### R10: Discovery includes `.test.tsx`
The runner's discovery MUST match both `.test.ts` and `.test.tsx` (the `.test.ts`-only match at
`scripts/runTests.mjs:37` was flagged in #151's review — left unfixed, a future component-test
change silently finds nothing).

- **GIVEN** a file `src/ui/test/Component.test.tsx`
- **WHEN** the runner discovers test files
- **THEN** the file is included in the `node --import tsx --test` invocation

### memory: Post-change truth

#### R11: `docs/memory/ci/pr-quality-gate.md` reflects post-change truth
The "Tests run through explicit-discovery runner scripts" requirement MUST stop naming `report-web`
as the zero-test/tolerant package; the zero-test scenario keyed on it MUST be replaced with the
strict post-change behaviour; and if no tolerant runner survives anywhere, the tolerant shape MUST
be described as retired (in the "Separate strict and tolerant runners" Design Decision), not left
as a live option. The `report-web` runner stays package-local (tsx over `src/`, both extensions,
strict) because its `tsup`+`vite` build emits no test files to `dist/` — record that reason.

- **GIVEN** the updated memory file
- **WHEN** a reader checks which packages tolerate zero test files
- **THEN** the answer is none — every runner exits 1 on zero files

#### R12: `docs/memory/report-web/renderers.md` drift is corrected
The file MUST be rewritten to present truth: `renderers.ts` no longer exists (the package is a
Vite React SPA + importable UI library); the device-log viewer is `DeviceLogPanel.tsx` rendering
`<div class="device-log-inline">` (not `<details class="device-log">`); the tail read lives in
`packages/cli/src/reportViewModel.ts` (500-line cap with a `[… N lines truncated]` header, not
`slice(-200)` in `artifacts.ts`); `loadRunManifestRecord()` (schema 2|3) lives in
`packages/cli/src/reportViewModel.ts`; `reportTemplate.ts` no longer exists; `artifacts.ts` is a
type-only barrel. `fab memory-index` MUST be run afterwards and `--check` MUST exit 0.

- **GIVEN** the rewritten memory file
- **WHEN** each concrete claim is checked against the source
- **THEN** every file path, function location, and rendering shape matches the code

### Non-Goals
- The 14 DOM-dependent warnings and any DOM test environment (`jsdom`/`happy-dom`/testing-library) — follow-up change.
- Any refactor of `report-web` source; the only non-test source edit is the `package.json` test script (kept as-is if the runner path does not change).
- The other 30 source warnings; promoting rules to `error`.

### Design Decisions

#### Keep a package-local strict runner for report-web
**Decision**: `report-web` keeps `scripts/runTests.mjs` (corrected: zero files → exit 1, discovery widened to `.test.tsx`) instead of switching to the shared `scripts/run-node-tests.mjs`.
**Why**: The shared runner discovers compiled `dist/**/*.test.js`; `report-web` builds with `tsup` (entry-based library bundles, tests excluded by `tsconfig.lib.json`) and `vite` (SPA bundle), so test files never reach `dist/` — verified empirically. Running `src/**/*.test.ts(x)` through `node --import tsx --test` is the only path that executes these tests without a build-system change.
**Rejected**: Forcing the shared runner — it would exit 1 on "no `*.test.js` under dist/" forever, or require adding a `tsc` test build to a package whose build is deliberately bundler-based (a source/build refactor this change prohibits).
*Introduced by*: 260727-e5nk-backfill-report-web-logic-tests

#### Pin `artifacts.ts` at its only runtime-observable contract
**Decision**: The `artifacts.ts` test asserts the module namespace has zero runtime exports, rather than attempting runtime tests of interfaces.
**Why**: The module is a type-only barrel (its loaders moved to `packages/cli/src/reportViewModel.ts`); "no runtime exports / no load-time Node dependency" is the browser-library contract and the only thing a runtime test can genuinely pin. The interface shapes are exercised at type level by the typed fixtures in `viewModel.test.ts`.
**Rejected**: Skipping the module entirely — leaves the contract unpinned; fabricating runtime assertions on types — asserts nothing.
*Introduced by*: 260727-e5nk-backfill-report-web-logic-tests

## Tasks

### Phase 1: Setup

- [x] T001 Verify baseline: build exit 0, 401 tests green (75/18/91/67/150), lint 78 warnings 0 errors, report-web prints the "no tests yet" notice; confirm empirically that a built `packages/report-web/dist` contains no `*.test.js` <!-- R9 -->

### Phase 2: Core Implementation

- [x] T002 Write `packages/report-web/src/ui/test/viewModel.test.ts` — status derivation, list building, summary, title, artifact-path rewriting + URL passthrough, reasoning selection, time/video formatting, controller payload <!-- R1 -->
- [x] T003 [P] Write `packages/report-web/src/ui/test/logs.test.ts` — timestamp parsing, level parsing, line filtering/mapping <!-- R2 -->
- [x] T004 [P] Write `packages/report-web/src/ui/test/format.test.ts` — durations, tones, styles, labels <!-- R3 -->
- [x] T005 [P] Write `packages/report-web/src/ui/test/routes.test.ts` — run route, artifact route, traversal throw <!-- R4 -->
- [x] T006 [P] Write `packages/report-web/src/test/fetchers.test.ts` — stubbed `globalThis.fetch`, URLs, headers, error shapes <!-- R5 -->
- [x] T007 [P] Write `packages/report-web/src/ui/test/icons.test.ts` — data-URI round-trip, inline SVG attributes <!-- R6 -->
- [x] T008 [P] Write `packages/report-web/src/test/artifacts.test.ts` — zero runtime exports <!-- R7 -->
- [x] T009 Correct `packages/report-web/scripts/runTests.mjs`: zero test files → exit 1; discovery matches `.test.ts` AND `.test.tsx`; update header comments to the strict semantics <!-- R9, R10 -->

### Phase 3: Integration & Edge Cases

- [x] T010 Mutation-verify every meaningful pin: one corruption at a time in `viewModel.ts` (status derivation, failure attribution, URL passthrough), `logs.ts`, `format.ts`, `routes.ts`, `fetchers.ts`, `icons.ts`, `artifacts.ts`, confirming exactly the pinning test fails; revert byte-identical each time <!-- R8 -->
- [x] T011 Verify zero-test-files exits 1 (temporarily move the test dirs aside, run the runner, restore) and that `.test.tsx` discovery works (temporary probe `.test.tsx`, then delete) <!-- R9, R10 -->

### Phase 4: Polish

- [x] T012 Update `docs/memory/ci/pr-quality-gate.md`: strict-everywhere runner truth, retire the tolerant shape, replace the zero-test scenario, record why report-web's runner stays package-local <!-- R11 -->
- [x] T013 Rewrite `docs/memory/report-web/renderers.md` to present truth (component rendering, tail-read location and 500-line shape, schema handling location, type-only artifacts.ts); run `fab memory-index` and verify `--check` exits 0 <!-- R12 -->
- [x] T014 Final verification: `npm run build --workspaces --if-present` exit 0; `npm run test:workspaces` exit 0 with count > 401 and a real report-web count (no notice); `npm run lint` exit 0 / 78 warnings / 0 errors / `max-depth`+`no-unused-vars` zero; `git diff` shows no `packages/report-web/src` non-test change <!-- R1, R9, R11 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `viewModel.test.ts` exists and pins status derivation, first-failure attribution (`run_failure` → error), list joining, summary counting, title derivation, artifact-path rewriting with URL passthrough, reasoning selection, and formatting — all passing against unmodified source
- [x] A-002 R2: `logs.test.ts` pins both timestamp formats, all level mappings, and recording-start filtering
- [x] A-003 R3: `format.test.ts` pins all four formatting/tone helpers and the label map
- [x] A-004 R4: `routes.test.ts` pins encoding, normalization, and the traversal throw
- [x] A-005 R5: `fetchers.test.ts` pins endpoint URLs, headers, ok/non-ok handling via stubbed global fetch restored in `finally`
- [x] A-006 R6: `icons.test.ts` pins the data-URI encoding round-trip and inline SVG constants
- [x] A-007 R7: `artifacts.test.ts` pins the zero-runtime-export contract
- [x] A-008 R9: report-web runner exits 1 on zero test files (verified empirically)
- [x] A-009 R10: runner discovers `.test.tsx` as well as `.test.ts` (verified with a temporary probe)
- [x] A-010 R11: `pr-quality-gate.md` no longer names report-web as zero-test; tolerant shape described as retired; package-local-runner reason recorded
- [x] A-011 R12: `renderers.md` rewritten to present truth; `fab memory-index --check` exits 0

### Behavioral Correctness

- [x] A-012 R9: `npm run test:workspaces` shows a real report-web test count and NO "no tests yet" notice; total count rises above 401 with 0 failures

### Scenario Coverage

- [x] A-013 R8: every mutation listed in the mutation log was caught by exactly the test that pins the corrupted behaviour, and each was reverted byte-identical

### Edge Cases & Error Handling

- [x] A-014 R1: absolute-URL artifact references pass through `buildRunScopedArtifactPath`/`toReportViewModel` unchanged; absent optional paths stay `undefined`
- [x] A-015 R4: `.`/`..` traversal segments make `buildArtifactRoute` throw

### Code Quality

- [x] A-016 Pattern consistency: tests follow the repo conventions (`node:test` + `node:assert/strict`, `test/` directory beside subjects, globals stubbed and restored in `finally`)
- [x] A-017 No unnecessary duplication: shared fixture factories inside each test file; no copied production logic in assertions
- [x] A-018: Test files stay within lint ceilings — `npm run lint` still reports exactly 78 warnings, 0 errors, `max-depth`/`no-unused-vars` zero
- [x] A-019: No `packages/report-web/src` non-test file changed; no new dependency; no existing test file edited

## Notes

### Recorded from CodeRabbit/review of PR — not addressed here

**1. Nothing typechecks these test files.** Review injected a pure excess-property type error into a
`viewModel.test.ts` fixture: `npm test`, `npm run build` and `npm run lint` **all passed**. Only
`tsc -p packages/report-web/tsconfig.json` caught it, and no npm script or CI step invokes it. The
type annotations on the fixtures are real but unenforced, which weakens R7's justification that
"shapes are exercised structurally by the typed fixtures".

This is **pre-existing and repo-wide**, not introduced here — `report-web` builds via `tsup`/`vite`,
neither of which typechecks, and the CI gate runs build → test → lint with no `tsc --noEmit`. It is
the most consequential item on this list: a whole class of error is currently invisible to the gate.
Worth its own change adding a typecheck step.

**2. Four boundary values are unpinned** (each a one-value fixture fix): `formatLongDuration`'s
round-up (`Math.round`→`Math.floor` survives because 1400 and 499 behave alike — needs 1600→'2s');
`formatVideoTimestamp` truncation (1499 rounds the same either way); `formatRelativeTime`'s 24h→day
boundary (24→12 survives); `resolveStepReasoning`'s `think`-before-`plan` precedence. Low
consequence — formatting, not correctness of what a run *is* — so recorded rather than fixed.

**3. Two survived mutations are dead defensive code in the source**, not test gaps: `Math.max(0, …)`
in `formatRelativeTime` and the `!logText` guard in `parseDeviceLogLines` are both provably
unreachable. Deletion candidates; out of scope for a tests-only change.

**4. `artifacts.ts` browser-safety is half-pinned.** The test pins zero runtime *exports*; adding
`import 'node:fs'` still passes. The memory wording is careful to claim only the export contract, so
this is a coverage gap rather than a doc error.

**5. `test:workspaces` uses `--if-present`**, so deleting a package's `test` script silently skips
it — the one remaining way the gate can find nothing, now that all six runners are strict.
Pre-existing.


- Baseline (verified this run): build exit 0; tests 401 (75 common, 18 cloud-core, 91 device-node, 67 goal-executor, 150 cli), exit 0; lint exit 0, 78 warnings, 0 errors.
- The `package.json` `test` script stays `node ./scripts/runTests.mjs` because the package-local runner survives (see Design Decisions) — so the permitted `package.json` edit turns out to be unnecessary.

## Deletion Candidates

Discovered during review's independent mutation battery (61 mutations); all are `report-web` **source**
changes, therefore out of scope for this tests-only change — recorded for a future change.

- `packages/report-web/src/ui/viewModel.ts:240` — the `Math.max(0, …)` clamp in `formatRelativeTime` has no observable effect: a negative delta already yields `totalMinutes < 1` → `'just now'`. Removing the clamp survives the whole suite because no input can distinguish it.
- `packages/report-web/src/ui/logs.ts:56` — the `if (!logText) return [];` guard in `parseDeviceLogLines` is redundant: `''.split('\n')` → `['']` is already dropped by the `line.length === 0` filter, so the function returns `[]` either way.
- `packages/report-web/src/ui/format.ts:45` (`statusPillLabel`) vs `packages/report-web/src/ui/viewModel.ts:260` (`statusLabelLong`) — two near-duplicate status→label maps over the same five-member union, differing only in `'Not Executed'` vs `'Not executed'`. One could take a casing parameter, or the pair could be collapsed if the casing difference is unintentional.
- `packages/report-web/scripts/runTests.mjs` — **not** a deletion candidate: verified empirically that `tsup` + `vite` emit no `*.test.*` to `dist/` (even with a `.test.tsx` present), so the shared dist-based runner cannot replace it.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Keep the package-local runner; do not switch to the shared dist-based runner | Verified empirically: `tsup` bundles only the two entries with tests excluded, `vite` bundles the SPA — no `*.test.js` reaches `dist/`, so the shared runner would find nothing | S:90 R:85 A:95 D:95 |
| 2 | Certain | `package.json` `test` script stays unchanged | The runner path does not change; only the runner script's semantics do. Intake permitted the edit but predicted this outcome as the check-first branch | S:85 R:90 A:95 D:90 |
| 3 | Confident | Pin `artifacts.ts` via its zero-runtime-export contract, and exercise its shapes through typed fixtures in `viewModel.test.ts` | The module is type-only at runtime; asserting emptiness is the only runtime-observable, mutation-verifiable pin. The intake's "artifact path resolution" description reflects the pre-split file — that logic now lives in `viewModel.buildRunScopedArtifactPath`, which R1 covers | S:70 R:85 A:85 D:80 |
| 4 | Confident | Pin `icons.ts` as encoding/shape constants (no selection function exists) | The intake's "icon selection by status/action" reflects the legacy renderer; the current module exports constants only. Pinning the data-URI round-trip is what a mutation can catch | S:70 R:85 A:85 D:80 |
| 5 | Confident | `formatRelativeTime`/`fetchers` tests stub `Date.now`/`globalThis.fetch` restored in `finally`, per the repo's characterize-around-the-absent-seam pattern | Matches the documented cloud-core characterization decision; no seam added | S:80 R:85 A:90 D:85 |
| 6 | Certain | Test files must individually stay under lint ceilings so the warning count stays exactly 78 | Binding constraint in the intake; eslint's TS block covers `src/**` test files via `**/*.{ts,tsx,mts,cts}` | S:90 R:85 A:95 D:90 |
| 7 | Confident | The zero-test-files exit-1 check is done by temporarily moving test directories aside (not deleting), then restoring | Equivalent observable behaviour, zero risk to the new files; tree verified clean afterwards | S:75 R:90 A:90 D:85 |

7 assumptions (3 certain, 4 confident, 0 tentative).
