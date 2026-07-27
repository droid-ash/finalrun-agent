# Plan: Characterize and Refactor the Two Untested `cli` Giants

**Change**: 260727-18tg-characterize-refactor-cli-giants
**Intake**: `intake.md`

> **Premise correction found at apply entry (measured against the tree, base 9162205).**
> The intake states `sessionRunner.ts` has "0 tests" and "no injection seam exists". Neither is
> true of the current source: `sessionRunner.ts` carries a deliberate, pre-existing
> `TestSessionDeps` dependency object (`dependencies: TestSessionDeps = testSessionDeps` on both
> `prepareTestSession` and `executeTestOnSession`), and `packages/cli/src/test/goalRunner.test.ts`
> holds 14 tests that already exercise `prepareTestSession` / `executeTestOnSession` / `runGoal`
> through that seam. The constraint "do NOT add a DI seam" is satisfied trivially — no seam needs
> adding, fakes pass through the **existing** `dependencies` parameter and the **existing**
> `session` parameter, exactly as the established `goalRunner.test.ts` pattern does. The §4
> stopping rule therefore does not trigger on its own premise; §3/§5 proceed. `reportWriter.ts`
> likewise has three direct `ReportWriter` tests inside `testRunner.test.ts` (happy-path artifact
> emission + redaction, suite snapshots, artifact-local recording reuse); the new suite pins the
> §1 behaviours those do not cover. Baseline verified: 89 warnings / 0 errors; 368 tests
> (75/18/91/67/117); `max-depth` and `no-unused-vars` zero.

## Requirements

### cli: Characterize `reportWriter.ts` (§1)

#### R1: Characterization suite passes green against the unmodified source
A new `packages/cli/src/test/reportWriter.test.ts` MUST use real `fs.mkdtempSync` workspaces
(no `fs` stubbing) and MUST pass against the unmodified `reportWriter.ts` before any refactor —
the inverse of a regression test. The pre-refactor green run MUST be executed and reported
explicitly.

- **GIVEN** the unmodified `reportWriter.ts` at base 9162205
- **WHEN** the new suite runs (`npm run test --workspace=@finalrun/finalrun-agent`)
- **THEN** every new test passes, before any source line changes

#### R2: The redaction/security contract is pinned
The suite MUST pin that resolved secret values never land in any file the writer emits: runner
log lines (`createLoggerSink`, `appendLogLine`, `appendRawBlock`), step JSON / result JSON /
run.json record fields (message, analysis, thought, actionPayload text/url, trace/timing span
details, failure reasons), and the copied-then-redacted device log. It MUST also pin that
`input/env.snapshot.yaml` and `input/env.json` carry the *config* secret form (env-var
placeholder) and `secretReferences` (key + envVar names) — never resolved values. A whole-runDir
sweep MUST assert the resolved secret value appears in no emitted file.

- **GIVEN** bindings with a resolved secret value and an env config whose `secrets` map holds the `${ENV_VAR}` placeholder form
- **WHEN** a full writer lifecycle runs (init → writeRunInputs → log lines → writeTestRecord with a device log containing the raw secret → finalize)
- **THEN** no file under the run directory contains the resolved secret value, and redacted sites carry `${secrets.<key>}` placeholders

#### R3: `writeRunInputs` file layout and record shapes are pinned
The suite MUST pin: which files land under `input/` (run-context.json, env.snapshot.yaml,
env.json, tests/<id>.yaml + .json, suite.snapshot.yaml + suite.json when a suite with a
sourcePath is given); run-context.json omitting `reasoning`/`features` keys when undefined and
carrying them when set; test snapshot JSON shape (testId, testName, relativePath,
workspaceSourcePath, bindingReferences, authored fields); `collectBindingReferences` extraction
and sorting; the no-`sourcePath` case (no YAML snapshot copied, `snapshotYamlPath` undefined);
and `toDisplayPath` (workspace-relative posix path inside the root, full posix path outside).

- **GIVEN** a test definition with `${variables.X}`/`${secrets.Y}` references and one without a `sourcePath`
- **WHEN** `writeRunInputs` runs
- **THEN** the pinned files exist with the pinned shapes, and JSON key presence/absence matches the unmodified source byte-behaviour

#### R4: `writeTestRecord` / `writeTestFailureRecord` record shapes are pinned on success and failure
The suite MUST pin: `writeTestRecord`'s result.json shape (status via `resolveTestStatus`
incl. the `aborted` passthrough, durationMs clamped at 0, step artifact files, screenshot decode,
videoOffsetMs); artifact copying incl. the missing-source path (recording/deviceLog path set but
file absent → field `undefined`, no throw); device-log copy + redact-in-place incl.
`deviceLogStartedAt`/`deviceLogCompletedAt`; and `writeTestFailureRecord`'s synthetic record
(placeholder JPEG at screenshots/001.jpg, actions/001.json failure step with redacted message,
result.json with `success: false`, `status: 'error'`, absent `analysis` key in emitted JSON,
exactly one step).

- **GIVEN** an execution result whose recording/deviceLog `filePath` points at a missing file
- **WHEN** `writeTestRecord` runs
- **THEN** the record's `recordingFile`/`deviceLogFile` are undefined and no artifact file is created
- **GIVEN** a pre-execution failure
- **WHEN** `writeTestFailureRecord` runs
- **THEN** the pinned synthetic record and placeholder artifacts are emitted

#### R5: `finalize` and manifest shapes are pinned, incl. the aborted run and key omission
The suite MUST pin: summary.json shape (counts, success derivation from failedCount,
`successOverride`/`statusOverride`/`failurePhase` incl. the aborted-run case, per-test
`resultFile` paths, `variables` passthrough); run.json manifest shape (`schemaVersion: 3`,
run counts for tests and steps, firstFailure precedence — failed test's own firstFailure, then
synthesized from the failed test, then `diagnosticsSummary`, then absent); `_toRunManifestTest`
(step counts, first failed step's message precedence errorMessage → trace.failureReason →
test.message, previewScreenshotPath preferring a failed step's screenshot, authored fallback when
no snapshot exists, resultJsonPath); and JSON key omission — `runContextJson` absent from
`paths` when `writeRunInputs` never ran, `failurePhase`/`diagnosticsSummary`/`firstFailure`
absent when undefined (an added present-and-undefined key changes emitted JSON).

- **GIVEN** an aborted run finalized with `successOverride: false`, `statusOverride: 'aborted'`, a `failurePhase`, and no `writeRunInputs` call
- **WHEN** `finalize` runs
- **THEN** summary.json and run.json carry the pinned aborted shapes and the `runContextJson` key is absent from run.json's `paths`

### cli: Refactor `reportWriter.ts` (§2)

#### R6: The six flagged functions land under the ceilings with behaviour pinned by R1–R5
Only after R1–R5 are green pre-refactor, `writeRunInputs` (156L/cx15), `writeTestRecord` (73L),
`finalize` (63L), `writeTestFailureRecord` (86L), `_buildRunManifest` (68L), and
`_toRunManifestTest` (cx17) MUST be restructured so every function — including every extracted
helper — is ≤60 lines and ≤12 complexity. The four `write*`/`finalize` functions MUST be read
together first and genuinely-common structure factored once (candidates measured from the
source: the `Math.max(0, completedAt - startedAt)` duration clamp ×6, the
`fsp.writeFile(path, JSON.stringify(v, null, 2), 'utf-8')` JSON-emit ×10, the
test-dir scaffolding shared by `writeTestRecord`/`writeTestFailureRecord`). The characterization
suite MUST pass byte-for-byte unmodified after the refactor, and the cli suite runs after each
function's restructure.

- **GIVEN** the green characterization suite
- **WHEN** each function is restructured and `npm run test --workspace=@finalrun/finalrun-agent` runs
- **THEN** all tests pass unmodified and the 7 reportWriter warnings are gone with no new warning introduced

### cli: Characterize `sessionRunner.ts` (§3)

#### R7: New suite pins `prepareTestSession`/`executeTestOnSession` through existing parameters only
A new `packages/cli/src/test/sessionRunner.test.ts` MUST pin behaviours not already covered by
`goalRunner.test.ts`, building fakes in that file's established style and passing them ONLY
through the existing `dependencies: TestSessionDeps` parameter and the existing `session:
TestSession` parameter. No source reshaping for testability. Behaviours to pin: device-log
capture lifecycle (start success/failure/throw; stop success with timestamp fallbacks; stop
returning failure → abort with `keepPartialOnFailure`; stop throwing → the `finally` aborts the
still-active capture); the pre-aborted signal early return (no executeGoal call, renderer still
destroyed); abort-listener add/remove; optional (non-required) recording start failure
continuing execution; required-recording stop-without-file marking the result failed with the
concatenated message; recording abort in `finally` when executeGoal throws; result composition
(recording/deviceLog merged onto the result only when present); `prepareTestSession` cleanup
idempotence, cleanup-on-error, startTarget diagnostic → `DevicePreparationError` with
diagnostics, started-entry-not-runnable failure, and the platform-scoped no-usable-target
message. These MUST pass green against the unmodified source, reported explicitly.

- **GIVEN** the unmodified `sessionRunner.ts` and fakes passed through existing parameters
- **WHEN** the new suite runs
- **THEN** every test passes before any source change; if a behaviour were reachable only by reshaping the source, it is left unpinned and recorded as a gap (none is expected — the seam exists)

### cli: Refactor `sessionRunner.ts` (§5)

#### R8: `prepareTestSession` and `executeTestOnSession` land under the ceilings
Only after R7 is green, `prepareTestSession` (134L/cx22) and `executeTestOnSession` (219L/cx46)
MUST be restructured with every extracted helper ≤60 lines and ≤12 complexity, following the
recorded DDs: module-private phase helpers (the file's existing `stopActiveLogCapture` sets the
convention); per-call local context for the accumulating recording/log-capture/abort-listener
state so the orchestrator's `finally` still sees exactly what each phase acquired; phase-outcome
variants per-orchestrator (nullable-failure `TestExecutionResult | undefined` where a phase
either fails the run or hands nothing back — no dead `continue` variants); the cleanup-on-error
`catch` in `prepareTestSession` and the single all-acquisitions `finally` in
`executeTestOnSession` keep their existing reachability (each release already individually
guarded and try/caught — restructuring must not narrow any release's reachable set). Both new
suites plus `goalRunner.test.ts`/`testRunner.test.ts` MUST pass byte-for-byte unmodified.

- **GIVEN** the green R7 suite and the pre-existing goalRunner tests
- **WHEN** the two functions are restructured and the cli suite runs after each
- **THEN** all tests pass unmodified and the 4 sessionRunner warnings are gone with no new warning introduced

### verification: Mutation and gate checks

#### R9: Each suite is mutation-verified as load-bearing against the unmodified source
Before each refactor begins, pinned behaviours MUST be corrupted one at a time in the source
(e.g., skip the device-log redaction write; drop the `statusOverride` passthrough; invert the
firstFailure message precedence; drop the `finally` log-capture abort; drop the pre-aborted
early return) and each corruption MUST fail exactly the test(s) that pin it, then be reverted
(`git checkout` the file) and green re-confirmed.

- **GIVEN** a green characterization suite and one deliberate corruption
- **WHEN** the cli suite runs
- **THEN** the pinning test fails, no unrelated test fails spuriously, and the revert restores green

#### R10: Final gates hold
`npm run build --workspaces --if-present` → exit 0. `npm run test:workspaces` → exit 0 with the
total count risen above 368 and per-package counts reported. `npm run lint` → exit 0, **78**
warnings (89 − 11), 0 errors, `max-depth`/`no-unused-vars` still zero, per-rule breakdown
reported. `git diff --numstat` shows no existing test file modified — new test files only.

- **GIVEN** the completed change
- **WHEN** the four verification commands run
- **THEN** every exit code is 0, warnings fall 89 → 78, and no existing test file appears in the diff

### Non-Goals

- The other 43 source warnings (`runDetailController.ts`, `Hierarchy.ts`, etc.)
- The seven queued follow-ups; promoting rules from `warn` to `error`
- Adding any new DI seam to either file (none is needed — the existing seam is used as-is)
- Editing any existing test file

### Design Decisions

#### Use the existing `TestSessionDeps` seam instead of triggering the §4 stopping rule
**Decision**: Characterize `sessionRunner.ts` through the pre-existing `dependencies:
TestSessionDeps` parameter and a directly-constructed `TestSession` object, in the fake style
`goalRunner.test.ts` already establishes; do not stop after §2.
**Why**: The stopping rule keys on needing (a) a new DI seam or (b) fakes so elaborate they
encode assumptions. Neither holds: the seam exists in the unmodified source (the memory DD
explicitly notes "the rule is not 'no seams': `testRunner.ts` carries a deliberate
`testRunnerDependencies` object" — `TestSessionDeps` is the same sanctioned pattern), and the
fakes are the same small per-method stubs 14 existing tests already use.
**Rejected**: Stopping after §2 on the intake's stale premise — it would leave 4 clearable
warnings and an achievable suite on the table for no principled reason.
*Introduced by*: 260727-18tg-characterize-refactor-cli-giants

## Tasks

### Phase 1: Setup

- [x] T001 Verify baseline on branch `260727-18tg-characterize-refactor-cli-giants`: build exit 0, 368 tests (75/18/91/67/117), 89 warnings / 0 errors, `max-depth`/`no-unused-vars` zero <!-- R10 -->

### Phase 2: Core Implementation

- [x] T002 Write `packages/cli/src/test/reportWriter.test.ts` pinning R2–R5 behaviours with real `fs.mkdtempSync` workspaces; run green against unmodified source and record the run <!-- R1 --> <!-- rework cycle 1 FIXED: review should-fix — the R5 firstFailure message-precedence pin was incomplete (only the trace.failureReason rung load-bearing); the fixture's first failed step now carries BOTH errorMessage and trace.failureReason, and two new failed tests pin the trace-only and neither-field rungs; all three rungs mutation-verified load-bearing -->

- [x] T003 Mutation-verify the reportWriter suite: ≥3 one-at-a-time source corruptions each failing exactly its pinning test; revert and re-confirm green <!-- R9 -->
- [x] T004 Refactor `reportWriter.ts` incrementally (read the four `write*`/`finalize` functions together first; factor the measured shared shapes; then per-function extraction), running the cli suite after each function <!-- R6 -->
- [x] T005 Write `packages/cli/src/test/sessionRunner.test.ts` pinning R7 behaviours through existing parameters only; run green against unmodified source and record the run <!-- R7 -->
- [x] T006 Mutation-verify the sessionRunner suite: ≥3 one-at-a-time source corruptions each failing exactly its pinning test; revert and re-confirm green <!-- R9 -->
- [x] T007 Refactor `sessionRunner.ts` (`prepareTestSession`, then `executeTestOnSession`) into module-private phase helpers per R8, running the cli suite after each function <!-- R8 --> <!-- rework cycle 1 FIXED: review must-fix — R8 violation (startRecordingPhase/startLogCapturePhase logged the "started" line before the orchestrator recorded the acquisition in state, so a throwing Logger.i orphaned the capture origin/main released). Both helpers now take `state` and record the acquisition BEFORE the Logger.i call; probe-verified against origin/main and pinned by two regression tests in sessionRunner.test.ts -->


### Phase 3: Integration & Edge Cases

- [x] T008 Confirm both characterization suites pass byte-for-byte unmodified post-refactor; confirm `goalRunner.test.ts`/`testRunner.test.ts` untouched and green <!-- R6, R8 -->

### Phase 4: Polish

- [x] T009 Full verification: build, test:workspaces (counts above 368, per-package), lint (78/0, per-rule, max-depth+no-unused-vars zero), `git diff --numstat` no-existing-test-edits <!-- R10 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `reportWriter.test.ts` exists and passed green against the unmodified source (run recorded before any refactor)
- [x] A-002 R7: `sessionRunner.test.ts` exists, passed green against the unmodified source, and uses only existing parameters (no source reshaping)
- [x] A-003 R6: all 7 `reportWriter.ts` warnings cleared; every helper ≤60 lines and ≤12 complexity
- [x] A-004 R8: all 4 `sessionRunner.ts` warnings cleared; every helper ≤60 lines and ≤12 complexity — review must-fix #1 (R8 "must not narrow any release's reachable set") FIXED in rework cycle 1: `startRecordingPhase`/`startLogCapturePhase` now take `state` and record the acquisition BEFORE the "started" `Logger.i` line. Probe-proven: with a sink throwing on the "started" message, the tree now matches origin/main exactly — log-capture case `startLogCapture`+`stopLogCapture` (was `startLogCapture` only), recording case `startRecording`+`abortRecording`+throw (was `startRecording`+throw). Two regression tests in `sessionRunner.test.ts` pin both paths (each failed pre-fix).

### Behavioral Correctness

- [x] A-005 R6: the reportWriter characterization suite passes byte-for-byte unmodified after the refactor
- [x] A-006 R8: the sessionRunner characterization suite and pre-existing `goalRunner.test.ts` pass byte-for-byte unmodified after the refactor

### Scenario Coverage

- [x] A-007 R5: the aborted-run finalize case and the `runContextJson`-key-absent case are pinned by passing tests
- [x] A-008 R4: the missing-source artifact paths (recording and device log) are pinned by passing tests
- [x] A-009 R7: the device-log stop-throw → `finally`-abort path and the pre-aborted early return are pinned by passing tests

### Edge Cases & Error Handling

- [x] A-010 R9: each mutation failed exactly the test that pins the corrupted behaviour, and every mutation was reverted (final diff contains no corruption)

### Code Quality

- [x] A-011 Pattern consistency: new tests follow the workspace test conventions (`src/test/` placement, `node:test` + `assert/strict`, mkdtemp workspaces, goalRunner-style fakes); refactor helpers follow each file's existing module-private/private-method conventions
- [x] A-012 No unnecessary duplication: the measured shared shapes (duration clamp, JSON emit, test-dir scaffolding) are factored once, not per-function

### Security

- [x] A-013 R2: a whole-runDir sweep test proves resolved secret values appear in no emitted file, and the env snapshot carries only placeholder/reference forms

## Deletion Candidates

- `docs/memory/ci/pr-quality-gate.md:119` — the sentence naming `cli/src/sessionRunner.ts` and `cli/src/reportWriter.ts` as "the route for the remaining untested oversized functions" is now stale for both; only `uploadApp` and `GrounderResponseConverter.extractPoint`/`extractScrollAction` remain (hydrate edit, not a file deletion).
- None in source — the refactor is behaviour-preserving extraction; every new helper has a call site and nothing in either file became unreachable. The three direct `ReportWriter` cases inside `testRunner.test.ts` are NOT redundant with the new suite: they exercise the writer through `runTests`, not directly.

## Notes

### Deferred from CodeRabbit review of PR #161 — both pre-existing

Two source findings, both **verified pre-existing** against `origin/main` and both behaviour changes,
so both are deferred rather than folded into a characterization-and-refactor change.

**1. `sessionRunner.ts` — derive platform from `deviceInfo.getPlatform()` instead of the inline
literal.** `origin/main:223` already reads `deviceInfo.isAndroid ? PLATFORM_ANDROID : 'ios'`; the
refactor carried it verbatim into the extracted helper. `getPlatform()` is the single source of
truth backed by `PLATFORM_ANDROID`/`PLATFORM_IOS`, so the literal is a duplicate — a real DRY point.
Swapping them is only safe if `getPlatform()` is provably equivalent for every device state,
including any that is neither Android nor iOS, which the ternary silently maps to `'ios'`. That
equivalence needs checking, and if it does not hold the swap is a behaviour change on device
detection. The same finding notes the `?.` in `params.selectedEntry?.deviceInfo` is dead
(`origin/main:218` has it too) — safe to drop, but not worth a source edit on its own.

**2. `sessionRunner.ts` — replace the `adbPath!` assertion with an explicit guard.**
`origin/main:237` already uses `adbPath!`. `AdbPath` is `string | null`, so when `getADBPath()`
resolves to `null` the assertion forwards `null` into `installAndroidApp` rather than failing with a
diagnosable message — unlike the adjacent `deviceInfo.id` check, which does guard. CodeRabbit is
right that a guard is better. It is nonetheless a behaviour change on an error path: today a null
adb path produces whatever `installAndroidApp` does with `null`; with a guard it throws a clear
error earlier. That belongs in its own `fix:` change with a test for the null-adb path, which has no
coverage today.

Both are good suggestions on code this change only relocated. Folding either into a PR whose claim
is behaviour preservation would undercut the equivalence the characterization suite exists to prove.


- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Proceed with §3/§5 instead of stopping at §4 — the seam the stopping rule keys on already exists (`TestSessionDeps`), and 14 tests already use it | The stopping rule's own conditions ((a) new seam needed, (b) contrived fakes) are both false against the measured tree; stopping would enforce a stale premise over the spec's intent | S:85 R:90 A:95 D:90 |
| 2 | Certain | Pin JSON key *absence* by parsing/scanning emitted files, not by comparing in-memory objects | The intake names present-and-undefined vs omitted as a contract; only the emitted bytes distinguish them | S:90 R:90 A:95 D:95 |
| 3 | Confident | Leave `_copyLogArtifact`'s redaction-failure branch (read/redact throw after copy → unlink + undefined) unpinned as a recorded gap | Reaching it requires making a copied file unreadable mid-flow — an `fs` stub or chmod race, both against the no-stubbing rule and flaky cross-platform; the branch is small and its shape is unchanged by the refactor | S:70 R:80 A:75 D:70 |
| 4 | Confident | Keep pre-existing instance-field accumulation in `ReportWriter` (`_inputEnvironment`, `_testSnapshots`, …) rather than converting to a per-call context | The per-call-context DD governs state *introduced by a split*; these fields are the class's existing cross-method contract (writeRunInputs → finalize reads them) — converting them is a design change beyond a behaviour-preserving refactor | S:75 R:80 A:85 D:80 |
| 5 | Confident | Mutation-verify pre-refactor (against the unmodified source), with the refactor itself then certified by the unchanged suite | The memory DD sequences it exactly this way ("the suite is then mutation-checked") — the pin claim is made against the original source | S:75 R:85 A:85 D:80 |
| 6 | Certain | Expect 78 warnings (both halves land), not 82 | Both intake outcomes are conditional; with §5 executed the 82 branch is moot | S:85 R:90 A:90 D:90 |

6 assumptions (3 certain, 3 confident, 0 tentative).
