# Plan: Fix the Session and Log-Sink Cleanup Leaks in `runTests`

**Change**: 260726-gohy-fix-runtests-session-cleanup-leak
**Intake**: `intake.md`

## Requirements

### CLI Test Runner: Session Release on Abort

#### R1: Session released when abort fires between session prepare and execution
`runTests` (`packages/cli/src/testRunner.ts`) MUST release the device session (`goalSession.cleanup()`) on the abort path where `ctx.runAborted` becomes true during/after `prepareRunSession` but before test execution. The post-`prepareRunSession` abort check MUST sit INSIDE the `try` whose `finally` releases the session.

- **GIVEN** a run where SIGINT arrives while `prepareTestSession` is in flight (so `ctx.runAborted` is true immediately after `prepareRunSession` returns a live session)
- **WHEN** `runTests` throws `abortedBeforeExecutionError()`
- **THEN** the session's `cleanup()` has been invoked exactly once before the error propagates to the caller
- **AND** no test execution occurred and no run artifacts were created

#### R2: Log sinks removed on every exit path
`Logger.addSink(ctx.bufferingSink)` runs unconditionally near the top of `runTests`, so its matching removal MUST run on every exit path — success, validation failure, abort before/after session prepare, and `prepareRunSession` failure. Sink removal (`ctx.logSink` when set, then `ctx.bufferingSink`) SHALL be lifted into the OUTER `finally` of `runTests`, beside `removeSigintListener()`.

- **GIVEN** a `runTests` call that exits early (e.g. a validation failure before any session exists)
- **WHEN** the call settles (rejects)
- **THEN** every sink registered on the module-level `Logger` during the call has been removed

#### R3: `cleanupRunResources` narrowed to session release only
The helper at `testRunner.ts:499` MUST be reduced to the session concern only (renamed to `releaseSession`) — sink removal moves out per R2. It MUST keep its swallow-and-warn semantics: a `goalSession.cleanup()` failure still logs `Failed to clean up device resources:` via `Logger.w` and MUST NOT propagate (it runs in a `finally` and would mask the real error).

- **GIVEN** a session whose `cleanup()` rejects
- **WHEN** the inner `finally` runs `releaseSession(goalSession)`
- **THEN** the warning `Failed to clean up device resources:` is logged and the original control flow (return value or in-flight error) is unaffected

#### R4: Behavioral invariants preserved
The restructuring MUST NOT change:
- Thrown error identity on both abort paths: `PreExecutionFailureError`, `phase: 'setup'`, message `Run aborted before execution.`, `exitCode: 130`.
- Success-path observable behavior. New ordering (`finalizeRun` → inner `finally`: session release → outer `finally`: `removeSigintListener` + sink removal) is unobservable-equivalent to the old ordering because nothing reads the sinks between the inner and outer `finally` — confirmed by inspection: after `finalizeRun` returns, `runTests` executes only the two `finally` blocks; no `Logger` call sits between them on the success path (`releaseSession`'s `Logger.w` fires only on cleanup failure, which the old code also emitted before sink removal).
- The lazy `reportWriter` contract (`undefined` means no run artifacts exist yet); `ctx.logSink` set only by `initializeReportWriter` (`testRunner.ts:309-312`).
- Everything from PR #154 (the `TestRunContext` per-call local, the phase helpers) and PR #153 (the `max-depth` hoist and its documented exception-path qualification); `max-depth` lint findings stay ZERO.

- **GIVEN** the existing 348-test suite (115 in `cli`)
- **WHEN** the restructuring lands
- **THEN** all existing tests pass unchanged, and lint reports 133 warnings / 0 errors or better with zero `max-depth` and zero `no-unused-vars` findings

### CLI Test Runner: Regression Coverage

#### R5: Regression test for abort-after-session-prepare (mandatory)
`packages/cli/src/testRunner.test.ts` MUST gain a test covering abort after session prepare, before execution, asserting the session was released and the error identity of R4. The test MUST be proven to FAIL against the unfixed code and PASS after the fix (verified explicitly by running it before applying the source fix).

- **GIVEN** an injected `addSigintListener` capturing the abort listener and an injected `prepareTestSession` that fires the captured listener mid-preparation and returns a session whose `cleanup()` increments a counter
- **WHEN** `runTests` runs against the unfixed code
- **THEN** the test fails (cleanup counter is 0)
- **AND WHEN** it runs against the fixed code
- **THEN** it passes (counter is 1, error is `PreExecutionFailureError` / `setup` / `Run aborted before execution.` / exit code 130, no artifacts, no test executed)

#### R6: Sink-removal regression test on an early-exit path
A second test SHOULD assert R2 on a validation-failure early exit, tracking sink registration by wrapping the public `Logger.addSink`/`Logger.removeSink` statics (a spy on the public API surface — no coupling to the private `_sinks` field). It likewise MUST fail pre-fix and pass post-fix.

- **GIVEN** wrapped `Logger.addSink`/`removeSink` recording the set of sinks added-but-not-removed during the call
- **WHEN** `runTests` rejects with a validation-phase failure (no selectors)
- **THEN** the tracked set is empty after the call settles

### Non-Goals

- The 133 pre-existing lint warnings (`max-lines-per-function` / `complexity`), including `sessionRunner.ts`, `cloud-core/src/submit.ts`, `reportWriter.ts`.
- Promoting lint rules from `warn` to `error`; test backfill for other packages.
- Any change to `prepareRunSession`'s internal error handling.

### Design Decisions

#### Sink-leak observation via public-API spies, not private state
**Decision**: The sink-removal test wraps the public `Logger.addSink`/`Logger.removeSink` static methods to track the added-minus-removed sink set, instead of reading `Logger._sinks`.
**Why**: The intake permits skipping the sink test if it would couple to `Logger` internals; spying on the public statics observes exactly the contract being fixed (every `addSink` during a run is matched by a `removeSink` by the time the call settles) without naming any private field.
**Rejected**: Reading `(Logger as any)._sinks.size` — brittle coupling to a private field name; skipping the test entirely — the spy approach makes it cheap and non-brittle.
*Introduced by*: 260726-gohy-fix-runtests-session-cleanup-leak

## Tasks

### Phase 1: Regression tests first (prove they fail pre-fix)

- [x] T001 Add the abort-after-session-prepare regression test to `packages/cli/src/testRunner.test.ts`: inject `addSigintListener` + `prepareTestSession` (listener fired mid-prepare, `cleanup()` counts calls), assert rejection identity (`PreExecutionFailureError`, `phase 'setup'`, `Run aborted before execution.`, `exitCode 130`), `cleanupCalls === 1`, zero executions, no run artifacts <!-- R5 -->
- [x] T002 [P] Add the sink-removal regression test to `packages/cli/src/testRunner.test.ts`: wrap `Logger.addSink`/`removeSink` statics, run a no-selectors validation failure, assert the tracked sink set is empty after rejection <!-- R6 -->
- [x] T003 Build and run the cli test suite against the UNFIXED source; confirm both new tests FAIL and record the observed failure messages <!-- R5 -->

### Phase 2: Core fix

- [x] T004 Restructure `runTests` in `packages/cli/src/testRunner.ts`: move the post-`prepareRunSession` abort check inside the `try` whose `finally` releases the session; lift `ctx.logSink`/`ctx.bufferingSink` removal into the outer `finally` beside `removeSigintListener()` <!-- R1 -->
- [x] T005 Narrow `cleanupRunResources` to session release only, renamed `releaseSession(goalSession)` (drop the now-unused `ctx` parameter), keeping swallow-and-warn (`Logger.w('Failed to clean up device resources:', error)`) <!-- R3 -->

### Phase 3: Verification

- [x] T006 Re-run build + cli tests: both new tests pass; then `npm run build --workspaces --if-present`, `npm run test:workspaces` (count must rise above 348 total / 115 cli), `npm run lint` (133 warnings / 0 errors or better; `max-depth` and `no-unused-vars` zero) <!-- R4 -->

## Execution Order

- T001/T002 before T003 (tests must exist to prove pre-fix failure); T003 strictly before T004/T005 (pre-fix failure evidence); T004/T005 before T006.

## Acceptance

### Functional Completeness

- [x] A-001 R1: The abort-after-session-prepare path releases the device session exactly once before the error propagates — guard hoisted inside the releasing `try` (`testRunner.ts:143-153`); `releaseSession` is the sole `goalSession.cleanup()` call site in the `runTests` path (verified by grep), so exactly-once holds
- [x] A-002 R2: Sink removal runs in the outer `finally` of `runTests` (logSink when set, then bufferingSink), covering every exit path including validation failures and setup failures — `testRunner.ts:154-160`; all seven exit paths traced
- [x] A-003 R3: `releaseSession` handles only session release, and a rejecting `cleanup()` logs `Failed to clean up device resources:` without propagating — `testRunner.ts:503-510`, body byte-identical to the old helper minus the sink lines

### Behavioral Correctness

- [x] A-004 R4: Both abort paths still throw `PreExecutionFailureError` with `phase: 'setup'`, message `Run aborted before execution.`, `exitCode: 130` — both sites still call the untouched `abortedBeforeExecutionError()` (`testRunner.ts:199-205`), identical to `origin/main`
- [x] A-005 R4: Success-path behavior is unchanged — 350/350 tests pass (75/91/67/117), all 115 pre-existing cli tests unmodified; `bufferedLogEntries`/`bufferingSink`/`logSink` have zero references outside `testRunner.ts` (verified by repo-wide grep), so nothing reads the sinks between `finalizeRun` and the outer `finally`

### Scenario Coverage

- [x] A-006 R5: The new abort-after-prepare test exists and was **independently re-verified** during review — reverting only `testRunner.ts` and rebuilding gave `tests 117 / pass 115 / fail 2` with `0 !== 1` at `assert.equal(cleanupCalls, 1)`; restored source passes 117/117
- [x] A-007 R6: The sink-removal test exists, failed pre-fix in the same review re-verification with `1 !== 0` at `assert.equal(danglingSinks.size, 0)`, and touches only the public `Logger.addSink`/`Logger.removeSink` statics (no `_sinks` reference), restoring both in a `finally`

### Edge Cases & Error Handling

- [x] A-008 R3: A session `cleanup()` failure during an in-flight error does not mask the original error (swallow-and-warn preserved in a `finally`) — verified by inspection; the `try/catch` around `goalSession.cleanup()` is carried over unchanged

### Code Quality

- [x] A-009 Pattern consistency: New tests follow the file's existing DI-override/save-restore pattern (`testRunnerDependencies` members, `finally` restoration, temp-workspace helpers)
- [x] A-010 No unnecessary duplication: Tests reuse `createTestSession`, `writeWorkspaceConfig`, `assertNoRunArtifacts`; the fix reuses `abortedBeforeExecutionError()` rather than re-declaring error construction. *(Residual, non-blocking: the new `createSingleTestWorkspace` helper duplicates ~10 pre-existing inline setup blocks that were not migrated — see `## Deletion Candidates`.)*
- [x] A-011 Lint budget: `npm run lint` exits 0 with 133 warnings / 0 errors (84 `max-lines-per-function` + 49 `complexity`); `max-depth` and `no-unused-vars` findings are ZERO

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `packages/cli/src/testRunner.test.ts:1446-1457` (`runTests rejects validation failures before creating run artifacts`) — its workspace setup block is byte-identical to the new `createSingleTestWorkspace` helper (differing only in the mkdtemp prefix); the inline block is now redundant
- `packages/cli/src/testRunner.test.ts:1482-1493` (`runTests surfaces device setup diagnostics before execution without creating run artifacts`) — same byte-identical setup block, now redundant
- `packages/cli/src/testRunner.test.ts` — eight further inline blocks with the same shape (`dev.yaml` = `{}` + `login.yaml`) at lines ~815, ~885, ~944, ~1011, ~1121, ~1229, ~1543, ~1605, ~1667, ~1734; those calling `writeWorkspaceConfig(rootDir, 'ios'|'both')` would need a platform parameter on the helper before migrating
- `cleanupRunResources(ctx, goalSession)` / its `ctx` parameter — already deleted by this change (narrowed to `releaseSession(goalSession)`); no residue remains
- No production code was made redundant — the fix is a control-flow move, not an addition

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Rename `cleanupRunResources` → `releaseSession` and drop its unused `ctx` param | Intake names the rename as appropriate; after narrowing, `ctx` is dead weight and keeping it would trip `no-unused-vars` (must stay zero) | S:85 R:90 A:95 D:90 |
| 2 | Certain | Trigger the abort in the test by firing the captured SIGINT listener inside the injected `prepareTestSession` | The only window where `runAborted` flips between the intra-`prepareRunSession` guard and the post-return check — exactly the leak window; intake explicitly sketches this seam | S:90 R:90 A:95 D:90 |
| 3 | Confident | Write the sink test as public-API spies on `Logger.addSink`/`removeSink` rather than skipping it | Intake marks the test desirable-but-optional gated on avoiding `Logger` internals; wrapping public statics avoids the private `_sinks` field entirely | S:70 R:85 A:85 D:75 |
| 4 | Certain | Prove pre-fix failure by adding tests first and running them before touching the source (rather than stash/restore) | Same evidence, fewer moving parts; the task mandates observing the failure explicitly | S:85 R:95 A:95 D:85 |
| 5 | Certain | Success-path ordering equivalence confirmed by inspection, not assumed | After `finalizeRun` returns, only the two `finally` blocks execute; no `Logger` reads/writes occur between them on the success path | S:85 R:80 A:90 D:90 |
| 6 | Confident | Validation failure (missing selectors) is the early-exit path for the sink test | Simplest deterministic early exit that never creates a session or reportWriter; other early-exit paths add setup noise without extra coverage of R2 | S:75 R:90 A:85 D:80 |

6 assumptions (4 certain, 2 confident, 0 tentative).
