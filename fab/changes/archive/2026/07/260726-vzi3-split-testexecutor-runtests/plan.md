# Plan: Split the Two Largest Well-Tested Functions

**Change**: 260726-vzi3-split-testexecutor-runtests
**Intake**: `intake.md`

## Requirements

### goal-executor: `TestExecutor.executeGoal` decomposition

#### R1: `executeGoal` keeps its iteration loop and delegates phases to private methods
`executeGoal` (405 lines, complexity 42) SHALL be restructured so the `for (let iteration = 1; iteration <= maxIterations; iteration++)` loop remains in `executeGoal` and every phase of a step (capture, planning, terminal-action handling, action execution, post-action capture, step finalization) is extracted into a `_`-prefixed private method on `TestExecutor`, matching the file's existing `_captureDeviceState` / `_capturePostActionScreenshot` convention. The top level of `executeGoal` MUST read as the phase sequence.

- **GIVEN** the refactored `TestExecutor.ts`
- **WHEN** `npm run lint` runs
- **THEN** `executeGoal` no longer appears in the `max-lines-per-function` or `complexity` warnings
- **AND** the loop, all early-exit returns (`aborted`, fatal capture, repeated transient capture, terminal planner failure, planner COMPLETED/FAILED, action terminal failure, max-iterations-exceeded), and all `continue` paths behave exactly as before

#### R2: Accumulating state in `executeGoal` is threaded explicitly, never promoted to instance fields
The per-run accumulating locals — `history` (string, appended per iteration), `remember` (string[], replaced per iteration), `consecutiveTransientCaptureFailures` (counter, reset/incremented on specific paths) — SHALL be threaded through the extracted phase methods via an explicit per-run context object created as a local inside `executeGoal` (plus `startedAt`/`maxIterations` as read-only members). `this._aborted` checks and per-iteration `StepTraceBuilder` construction plus planner+grounder LLM-call aggregation MUST keep their exact current semantics. No new instance field SHALL be introduced for any of this state.

- **GIVEN** two consecutive `executeGoal` invocations on the same executor instance
- **WHEN** the second invocation starts
- **THEN** `history`, `remember`, and `consecutiveTransientCaptureFailures` start fresh (same lifetime as the original locals)
- **AND** within one invocation, a transient capture failure increments the counter, a successful capture resets it to 0, and two consecutive transient failures end the run — exactly as today

### cli: `testRunner.runTests` decomposition

#### R3: `runTests` phases are extracted into module-private helpers
`runTests` (280 lines, complexity 46) SHALL be split into module-private (non-exported) helper functions for its phases: run-context creation + SIGINT abort handling, validation (`runCheck` + effective goals), host preflight + session preparation, lazy report-writer initialization, the per-test execution loop, per-test execution + failure recording, run finalization (summary + report + run index), and resource cleanup. State with meaningful identity — `testResults`, `encounteredFailure`, `reportWriter` (lazily created; `undefined` is meaningful), `runDir`, `startedAt`, `runAborted`, the log sinks, and the `AbortController` — SHALL live on an explicit run-context object created as a local inside `runTests` and passed to helpers.

- **GIVEN** the refactored `testRunner.ts`
- **WHEN** `npm run lint` runs
- **THEN** `runTests` no longer appears in the `max-lines-per-function` or `complexity` warnings
- **AND** the try/finally nesting is preserved: SIGINT-listener removal wraps everything; session cleanup + sink removal wrap only the execution/finalize section (so a setup-phase failure still skips session cleanup, exactly as today)

#### R4: PR #153's `max-depth` flattening in `runTests` is preserved
The restructuring MUST NOT undo PR #153's work: the post-result checks (`goalResult.status === 'aborted' || runAborted` and `goalResult.terminalFailure`) stay hoisted OUTSIDE the per-test `try`, preserving the documented qualification that an `appendLogLine` write failure in those checks propagates out of the loop rather than being caught. `max-depth` MUST remain at zero tree-wide.

- **GIVEN** a `reportWriter.appendLogLine` that throws during the post-result aborted/terminal-failure checks
- **WHEN** the per-test loop processes that result
- **THEN** the error propagates out of the loop (run finalization is skipped, cleanup still runs via `finally`), not swallowed by the per-test catch

### Both files: lint outcome and behavior preservation

#### R5: Every extracted helper clears — not relocates — the warnings
Every extracted helper (private method or module function) MUST itself be ≤60 lines (ESLint `max-lines-per-function` config: skipBlankLines, skipComments) and complexity ≤12. The net tree-wide warning count MUST fall from 140 (87 `max-lines-per-function` + 53 `complexity`) with zero new warnings of ANY rule; `max-depth` and `no-unused-vars` stay at zero.

- **GIVEN** the completed refactor
- **WHEN** `npm run lint` runs
- **THEN** exit code is 0 with 0 errors and ≤136 warnings, all of them pre-existing `max-lines-per-function` / `complexity` warnings in other functions

#### R6: Zero behavior change, proven by the untouched test suite
The change SHALL be pure restructuring. All 348 tests (75 common, 91 device-node, 67 goal-executor, 115 cli) MUST pass with no test-file edits. Extracted result-construction helpers MUST preserve the exact key set and key order of every returned `TestExecutionResult` variant (e.g., `terminalFailure` present only on the two terminal-failure paths; `analysis` key present — even when `undefined` — exactly where the original literal had it).

- **GIVEN** the refactored code
- **WHEN** `npm run build --workspaces --if-present` and `npm run test:workspaces` run
- **THEN** both exit 0 with exactly 348 passing tests and `git diff` shows no `*.test.ts` changes

### goal-executor: optional same-file cleanups

#### R7: `_captureDeviceState` / `_capturePostActionScreenshot` fixed only if trivially clean
The two methods share an identical head (stabilized screenshot+hierarchy request, capture-trace parse) and an identical failure-classification tail. IF a shared `_`-prefixed request helper plus failure classifier resolves both methods' warnings (62 lines / complexity 13, and complexity 13) without real restructuring, the change MAY include it; otherwise both are left untouched.

- **GIVEN** the shared-helper extraction is small and obvious
- **WHEN** `npm run lint` runs
- **THEN** neither method appears in the warnings and the observable capture semantics (transient/fatal classification, empty-screenshot/missing-hierarchy handling) are unchanged

### Non-Goals

- `sessionRunner.ts:286`, `cloud-core/src/submit.ts:70`, `reportWriter.ts:156` — untested; need characterization tests first (later change)
- All oversized test functions; any other of the 140 warnings; promoting lint rules to `error`
- Any behavior change whatsoever

### Design Decisions

#### Phase outcome objects instead of exceptions for loop control
**Decision**: `executeGoal` phase methods return a small discriminated union (`proceed` / `continue` / `return` with the final `TestExecutionResult`) so the loop in `executeGoal` decides `continue`/`return` itself.
**Why**: Keeps all loop control flow visible at the top level (the intake requires the top level to read as the phase sequence) and threads state without exceptions-as-control-flow.
**Rejected**: Throwing sentinel exceptions from phase helpers — obscures control flow and risks interacting with the real error paths (planner errors are semantically caught, not control flow).
*Introduced by*: 260726-vzi3-split-testexecutor-runtests

#### Explicit local run-context objects for accumulating state
**Decision**: Both functions create a plain local context object (`GoalRunState` in `TestExecutor`, `TestRunContext` in `testRunner`) holding the accumulating/mutable state, created per invocation and passed to helpers.
**Why**: Intake explicitly allows "an explicit per-iteration context object"; identical lifetime to the original locals; makes mutation sites explicit.
**Rejected**: New instance fields on `TestExecutor` (changes state lifetime across `executeGoal` calls — a real behavior change) and long parameter/return tuples for every helper (unreadable at 5+ pieces of state).
*Introduced by*: 260726-vzi3-split-testexecutor-runtests

#### Single result builder preserving exact object shape
**Decision**: A `_terminalResult(run, status, message, totalIterations, extras)` helper builds every `TestExecutionResult` return, with `extras` spread between `message` and `platform` so key order and key presence match each original literal exactly.
**Why**: The original literals differ only in the optional `analysis`/`terminalFailure` keys at one position; the builder collapses ~8 near-identical 10-line literals while keeping byte-identical object shape.
**Rejected**: Conditional-spread of `analysis`/`terminalFailure` inside the builder (`...(x ? {x} : {})`) — would change key *presence* on paths where the original literal carried the key with an `undefined` value.
*Introduced by*: 260726-vzi3-split-testexecutor-runtests

## Tasks

### Phase 2: Core Implementation

- [x] T001 Refactor `packages/goal-executor/src/TestExecutor.ts` `executeGoal`: add `GoalRunState` + `PhaseOutcome` private types, `_terminalResult` builder, and phase methods `_runCapturePhase`, `_handleCaptureFailure`, `_runPlanningPhase`, `_handlePlannerError`, `_runActionPhase`, `_finishGoalFromPlanner`, `_executePlannedAction`, `_reportActionTerminalFailure`, `_runPostCapturePhase`, `_collectStepLLMCalls`, `_recordStepCompletion`; keep the loop in `executeGoal` <!-- R1, R2 -->
- [x] T002 Refactor `packages/cli/src/testRunner.ts` `runTests`: add `TestRunContext` type and module-private helpers `createRunContext`, `requestRunAbort`, `abortedBeforeExecutionError`, `runValidationPhase`, `prepareRunSession` (+ `toSetupFailure`), `initializeReportWriter`, `runTestLoop`, `executeTestAndRecord`, `recordTestExecutionFailure`, `finalizeRun`, `cleanupRunResources`; preserve PR #153's hoisted post-result checks and the try/finally nesting <!-- R3, R4 -->
- [x] T003 In `TestExecutor.ts`, extract shared `_requestCapture` + `_classifyCaptureFailure` helpers and rewrite `_captureDeviceState` / `_capturePostActionScreenshot` on top of them (only because the extraction is trivially clean) <!-- R7 -->

### Phase 3: Integration & Edge Cases

- [x] T004 Verify: `npm run build --workspaces --if-present` exit 0; `npm run test:workspaces` exit 0 with exactly 348 tests; `npm run lint` exit 0, 0 errors, warning count down from 140 with only `max-lines-per-function`/`complexity` remaining and `executeGoal`/`runTests` absent; `git diff` clean of `*.test.ts` <!-- R5, R6 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `executeGoal` retains its iteration loop and delegates each phase to a `_`-prefixed private method; it no longer triggers `max-lines-per-function` or `complexity`
- [x] A-002 R3: `runTests` is a thin orchestrator over module-private phase helpers; it no longer triggers `max-lines-per-function` or `complexity`
- [x] A-003 R7: `_captureDeviceState` and `_capturePostActionScreenshot` no longer warn, via a small shared request helper + failure classifier (or are left untouched if that proved non-trivial)

### Behavioral Correctness

- [x] A-004 R2: `history`, `remember`, and `consecutiveTransientCaptureFailures` live on a per-run local context object (or params/returns) — no new `TestExecutor` instance fields; reset/increment/replace semantics unchanged
- [x] A-005 R3: `reportWriter` remains lazily created with `undefined` meaningful (abort before first test still throws the setup `PreExecutionFailureError` with exit code 130; abort after creation breaks the loop and finalizes as `aborted`)
- [x] A-006 R6: Every `TestExecutionResult` return variant keeps its exact key set/order (`terminalFailure` and `analysis` presence unchanged per path)

### Scenario Coverage

- [x] A-007 R6: All 348 tests pass (75 common, 91 device-node, 67 goal-executor, 115 cli) with zero test-file edits (`git diff` shows no `*.test.ts` changes)
- [x] A-008 R4: Post-result aborted/terminal-failure checks stay outside the per-test `try`; an `appendLogLine` failure there propagates out of the loop (PR #153 qualification preserved)

### Edge Cases & Error Handling

- [x] A-009 R2: Abort (`this._aborted`) still returns the `aborted` result with `totalIterations: iteration - 1` before any capture work in the iteration
- [x] A-010 R3: A setup-phase failure (preflight blocked, device preparation error, abort at the post-setup checkpoint) still skips session cleanup and sink removal exactly as the original nesting did

### Code Quality

- [x] A-011 R5: Every extracted helper is ≤60 lines and complexity ≤12; lint reports 0 errors, warning total < 140, `max-depth` and `no-unused-vars` at zero, no new warnings of any rule
- [x] A-012 Pattern consistency: New `TestExecutor` methods use the `_` prefix convention; new `testRunner` helpers are module-private functions below the exported API, matching `createReportWriter`/`formatPreExecutionFailureMessage`
- [x] A-013 No unnecessary duplication: The COMPLETED/FAILED planner branches and the near-identical result literals are unified only where object shape is provably identical; existing utilities (`flushBufferedLogEntries`, `createReportWriter`, `formatPreExecutionFailureMessage`) are reused, not reimplemented

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)

### Deferred: pre-existing session-cleanup leak in `runTests` (follow-up bug fix)

CodeRabbit flagged (PR #154) that in `runTests`, `prepareRunSession` can return a live
`goalSession` and the immediately-following `if (ctx.runAborted) throw abortedBeforeExecutionError()`
throws **before** the inner `try` whose `finally` calls `cleanupRunResources`. On that path the
session is created and never cleaned up. The same applies to
`Logger.removeSink(ctx.bufferingSink)`, which lives in the inner `finally`.

**This is a real latent bug, but it is NOT introduced by this change** — it is structurally
identical to `origin/main`: there, `goalSession` is assigned at `testRunner.ts:203`, the abort check
throws at `:225`, and the try whose `finally` (`:379`) performs `goalSession.cleanup()` (`:382`) and
`Logger.removeSink(bufferingSink)` (`:390`) only opens at `:233`. The refactor preserved the window
exactly, as the review stage independently confirmed ("a preserved pre-existing quirk").

**Deferred deliberately.** This change's contract is zero behavior change; closing the leak alters
cleanup semantics on an error path and would break the equivalence property that makes this diff
reviewable. It belongs in its own `fix:` change, which should:

1. Open the `try` **before** the post-`prepareRunSession` abort check so any returned session is
   always released.
2. Move `Logger.removeSink(ctx.bufferingSink)` to the outer `finally` beside `removeSigintListener`.
3. Reduce `cleanupRunResources` to releasing session resources only.
4. Add a regression test for abort-after-session-prepare — the path has no coverage today, which is
   why the leak survived.

## Deletion Candidates

- `packages/goal-executor/src/TestExecutor.ts:1013` `_isTransientCaptureFailure` — now has exactly one caller (`_classifyCaptureFailure`, its only remaining consumer after T003); the two could be merged into one predicate-plus-builder if a future change wants the extra symbol gone.
- `packages/cli/src/testRunner.ts:233` `toSetupFailure` — single call site (`prepareRunSession`'s catch); kept separate only to hold `prepareRunSession` under the 60-line ceiling, so it is a candidate for inlining if that function ever shrinks.
- Otherwise: none — this change removed the redundancy it created (8 result literals → `_terminalResult`, 2 capture heads → `_requestCapture`, 4 abort literals → `abortedBeforeExecutionError`) rather than leaving it behind.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Phase helpers communicate loop control via a discriminated `PhaseOutcome` union rather than boolean flags or exceptions | Keeps `continue`/`return` decisions visible in `executeGoal`; TypeScript narrows the union safely; no behavior surface | S:70 R:85 A:85 D:70 |
| 2 | Confident | A mutable local `GoalRunState`/`TestRunContext` object passed to helpers satisfies the intake's state-threading constraint | Intake explicitly permits "an explicit per-iteration context object"; lifetime identical to the original locals | S:85 R:80 A:85 D:80 |
| 3 | Certain | The `_terminalResult` builder must preserve exact key presence/order per return path, so `extras` is spread verbatim (never conditionally re-keyed) | `analysis: undefined` as a present key vs an absent key is observably different under deep-equality and `Object.keys`; zero-behavior-change is non-negotiable | S:80 R:85 A:90 D:85 |
| 4 | Confident | The optional R7 items qualify as "trivially clean": both methods share an identical request head and failure tail, so one shared helper resolves all 3 warnings | The duplication is verbatim (~20 lines twice); no control flow changes; if verification shows otherwise, T003 is dropped | S:75 R:90 A:85 D:75 |
| 5 | Certain | `goalSession` is always defined when the cleanup `finally` runs (setup either returns a session or throws before the inner try), so the cleanup helper takes a non-optional session | Matches original reachability: the inner try was only entered after assignment; the original `if (goalSession)` guard was vacuous there | S:80 R:85 A:90 D:85 |
| 6 | Certain | ESLint 10's `complexity` rule counts optional chaining, logical operators, and ternaries — helper complexity budgets are computed against that model and verified by running lint | Measured: `_captureDeviceState` reports 13, which only reconciles if `?.` counts; final verification is empirical via `npm run lint` | S:75 R:95 A:90 D:85 |

6 assumptions (3 certain, 3 confident, 0 tentative).
