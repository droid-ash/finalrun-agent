# Plan: Clear Dead Code and Excess Nesting Flagged by the Lint Gate

**Change**: 260725-983g-dead-code-nesting-cleanup
**Intake**: `intake.md`

## Requirements

### Lint Cleanup: Dead Code (`@typescript-eslint/no-unused-vars`)

#### R1: Remove seven unreferenced symbols
The seven straight-deletion symbols listed in the intake table MUST be deleted, and each deletion MUST be preceded by confirming zero remaining references in the package (type-only and string positions included): `ExecFileFn` (`packages/cli/src/hostPreflight.ts:10`), `createSuccessfulCommandResult` (`packages/cli/src/reportServerManager.test.ts:69`), `RunTarget` and `LoadedEnvironmentConfig` (`packages/cli/src/testRunner.ts:10`, `:31`), `ChildProcess` (`packages/device-node/src/discovery/DeviceDiscoveryService.test.ts:8`), `LLMPhase` (`packages/goal-executor/src/ai/AIAgent.test.ts:16`), `MAGENTA` (`packages/goal-executor/src/trace.ts:312`).

- **GIVEN** a symbol flagged `no-unused-vars` with zero references outside its declaration
- **WHEN** the declaration (import specifier, type alias, const, or function) is deleted
- **THEN** the package still compiles and its warning disappears with no other diagnostics introduced

#### R2: Delete `formatSection`, keep `formatCheckLines`
`formatSection` in `packages/cli/src/hostPreflight.ts:221` MUST be deleted. `formatCheckLines` MUST be kept — it is still called at `hostPreflight.ts:208` by the live `formatTestReport`.

- **GIVEN** `formatSection` has zero callers repo-wide and `formatCheckLines` has a live caller at line 208
- **WHEN** only `formatSection` is removed
- **THEN** `formatTestReport` output is byte-identical and the `cli` package builds and tests pass

#### R3: Rename `rotate`'s unused parameter to `_action`
The positional, interface-bound parameter of `rotate(action: RotateAction)` in `packages/device-node/src/device/android/AndroidDevice.ts:102` MUST NOT be deleted; it SHALL be renamed `action` → `_action`, matching the sibling methods `home(_action:)` / `hideKeyboard(_action:)` and the config's `argsIgnorePattern: '^_'`.

- **GIVEN** the device interface requires the positional parameter
- **WHEN** the parameter is renamed to `_action`
- **THEN** the signature arity and types are unchanged and the warning is satisfied by the ignore pattern

#### R4: Remove the write-only `startupState` local in `AndroidDeviceSetup.prepare`
After verifying across the whole enclosing `prepare` method (lines 96–221, including catch/finally and any closures) that the local `startupState` is never read, the declaration (line 116) and all three assignments (lines 168, 185, 202) MUST be removed. If any read had been found, the fallback is a `_startupState` rename with a recorded explanation.

- **GIVEN** every nearby read (`lines 171, 204, 207`) is `spawned.startupState` — a property on a different object — and the method contains no closure or catch/finally reading the local
- **WHEN** the declaration and the three assignments are removed
- **THEN** driver-setup behavior is unchanged (all reads target `spawned.startupState`) and the `AndroidDriverStartupState` type import remains (still used by `_trackAndroidDriverProcess` and `_awaitCaptureReadiness`)

### Lint Cleanup: Nesting Depth (`max-depth` ≤ 4)

#### R5: Flatten the two depth-5 blocks in `sessionRunner.ts`
The depth-5 blocks at `packages/cli/src/sessionRunner.ts:482` and `:505` (log-capture stop handling inside `executeTestOnSession`) MUST be brought to depth ≤ 4 while preserving behavior exactly, using the intake's preferred techniques (guard clause / early return first; helper extraction only where guards cannot remove the level).

- **GIVEN** the stop-log-capture branch nests `try → if → if/else → try` five deep inside the function's outer `try`
- **WHEN** the stop/abort handling is flattened (the inner abort `try/catch` requires a small extracted helper since a guard cannot remove that level)
- **THEN** every path — success with file path, success without file path, stop failure with abort, stop throwing (leaves `activeLogCapture` set for the `finally` abort) — produces identical logs, identical `deviceLog` values, and identical `activeLogCapture` mutations

#### R6: Flatten the three depth-5 blocks in `testRunner.ts::runTests` with minimal restructuring
The blocks at `packages/cli/src/testRunner.ts:238`, `:320`, `:325` MUST be brought to depth ≤ 4 with the MINIMUM restructuring: no decomposition of `runTests`, no chasing its `max-lines-per-function`/`complexity` warnings.

- **GIVEN** `:238` nests an abort/no-reportWriter check inside `if (runAborted)`, and `:320`/`:325` sit inside the per-test `try` block
- **WHEN** `:238` is split into two sequential depth-4 guards, and the post-result abort/terminal-failure checks (`:320`/`:325`) are moved out of the per-test `try` to loop-body level (reachable only on the success path since the `catch` always breaks)
- **THEN** loop-exit conditions, `runAborted` mutations, log lines, and report records are identical for every input ordering

#### R7: Flatten the depth-5 block in `AdbClient.ts:884`
The block at `packages/device-node/src/infra/android/AdbClient.ts:884` (undeclared-permission classification inside the permission loop) MUST be brought to depth ≤ 4 using early `continue` guards, preserving behavior exactly.

- **GIVEN** the inner permission loop branches `if/else → if → if/else` around the SYSTEM_ALERT_WINDOW special case and grant/revoke failure classification
- **WHEN** the SYSTEM_ALERT_WINDOW branch and the success/undeclared-failure paths become early-`continue` guards
- **THEN** `errors`, `skippedUndeclaredRuntime`, and logged messages are identical for every permission/action/result combination

### Non-Goals

- The 87 `max-lines-per-function` and 53 `complexity` warnings — deferred to the follow-up change that writes characterization tests first.
- Promoting any lint rule from `warn` to `error`.
- Test backfill, dependency changes, `docs/memory/**` edits (intake: no memory update needed).

### Design Decisions

#### Helper extraction only where guards cannot remove a level
**Decision**: Use guard clauses / early `continue` for `AdbClient.ts` and `testRunner.ts:238`; move the post-result checks out of the per-test `try` for `testRunner.ts:320/:325`; extract one small helper (`stopActiveLogCapture`) only for `sessionRunner.ts`, where the failure branch's abort `try/catch` occupies a nesting level no guard can remove.
**Why**: Matches the intake's technique preference order and the scope guard on `runTests` — minimal, locally-verifiable control-flow edits.
**Rejected**: A general decomposition of `runTests` or of `executeTestOnSession` — explicitly the next change's job, needs characterization tests first.
*Introduced by*: 260725-983g-dead-code-nesting-cleanup

## Tasks

### Phase 1: Setup

- [x] T001 Capture lint baseline (156 warnings, 0 errors) and the exact 16 target warnings via `npm run lint` <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 [P] Delete the seven unreferenced symbols after per-symbol reference checks: `ExecFileFn` (packages/cli/src/hostPreflight.ts), `createSuccessfulCommandResult` (packages/cli/src/reportServerManager.test.ts), `RunTarget` + `LoadedEnvironmentConfig` (packages/cli/src/testRunner.ts), `ChildProcess` (packages/device-node/src/discovery/DeviceDiscoveryService.test.ts), `LLMPhase` (packages/goal-executor/src/ai/AIAgent.test.ts), `MAGENTA` (packages/goal-executor/src/trace.ts) <!-- R1 -->
- [x] T003 [P] Delete `formatSection` (packages/cli/src/hostPreflight.ts:221–232), keeping `formatCheckLines` <!-- R2 -->
- [x] T004 [P] Rename `action` → `_action` in `rotate()` (packages/device-node/src/device/android/AndroidDevice.ts:102) <!-- R3 -->
- [x] T005 [P] Verify `startupState` is write-only across `prepare` (packages/device-node/src/grpc/setup/AndroidDeviceSetup.ts:96–221), then remove the declaration (116) and assignments (168, 185, 202) <!-- R4 -->
- [x] T006 [P] Flatten sessionRunner.ts:482/:505 — extract `stopActiveLogCapture` helper for the log-capture stop path in `executeTestOnSession` (packages/cli/src/sessionRunner.ts) <!-- R5 -->
- [x] T007 [P] Flatten testRunner.ts:238 (two sequential guards) and :320/:325 (hoist post-result checks out of the per-test try) inside `runTests` (packages/cli/src/testRunner.ts) — minimum restructuring only <!-- R6 -->
- [x] T008 [P] Flatten AdbClient.ts:884 via early-`continue` guards in the permission loop (packages/device-node/src/infra/android/AdbClient.ts) <!-- R7 -->

### Phase 3: Integration & Edge Cases

- [x] T009 Run `npm run build --workspaces --if-present` (exit 0) and `npm run test:workspaces` (348 tests: 75 common, 91 device-node, 67 goal-executor, 115 cli; 0 fail — a count drop means a live test was deleted) <!-- R1 -->
- [x] T010 Run `npm run lint` — exit 0, ~140 warnings (156 − 16), 0 errors, zero remaining `no-unused-vars` and zero `max-depth` warnings; investigate any deviation rather than forcing the number <!-- R1 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: All seven straight-deletion symbols are gone and no reference to any of them remains in source
- [x] A-002 R2: `formatSection` is deleted; `formatCheckLines` remains and is still called by `formatTestReport`
- [x] A-003 R3: `rotate(_action: RotateAction)` matches the sibling `home`/`hideKeyboard` convention; signature unchanged
- [x] A-004 R4: `startupState` local declaration and all three assignments are removed from `prepare`; all `spawned.startupState` reads untouched
- [x] A-005 R5: sessionRunner.ts has no `max-depth` warning; log-capture stop behavior identical on all four paths
- [x] A-006 R6: testRunner.ts has no `max-depth` warning; `runTests` was not decomposed beyond the minimal flattening
- [x] A-007 R7: AdbClient.ts has no `max-depth` warning; permission loop outcomes identical

### Behavioral Correctness

- [x] A-008 R5: On stop-log-capture failure the abort is still attempted and `activeLogCapture` cleared; on stop throwing, `activeLogCapture` stays set for the `finally` abort
- [x] A-009 R6: Abort before first test with no reportWriter still throws `PreExecutionFailureError` (exit 130); abort/terminal-failure after a test still breaks the loop with the same log lines
- [x] A-010 R7: Undeclared runtime-permission grant failures still increment `skippedUndeclaredRuntime` without an error entry; other failures still log and append to `errors`

### Removal Verification

- [x] A-011 R1: `npm run lint` reports zero `@typescript-eslint/no-unused-vars` warnings
- [x] A-012 R5: `npm run lint` reports zero `max-depth` warnings

### Scenario Coverage

- [x] A-013 R6: Full suite passes with exactly 348 tests (75 common, 91 device-node, 67 goal-executor, 115 cli) — proves no live test was deleted and the flattened control flow is covered by the existing suite

### Edge Cases & Error Handling

- [x] A-014 R4: `AndroidDriverStartupState` import remains (still used by other methods); build passes — it is a file-local `interface` (AndroidDeviceSetup.ts:24) still referenced at :222, :223, :282, :295, :391, :440

### Code Quality

- [x] A-015 Pattern consistency: The `_action` rename and guard-clause style match existing conventions in the same files
- [x] A-016 No unnecessary duplication: The extracted `stopActiveLogCapture` helper reuses existing types (`GoalRunnerDevice` via `TestSession`, `DeviceLogCaptureResult`); no utility reimplemented
- [x] A-017 Readability over cleverness: Flattening uses plain guards/early-continue, no clever conditional merging that changes evaluation order
- [x] A-018 No new god functions: No function grows past its current size class; total warning count drops 156 → 140 with no new warnings of any rule (post-change breakdown is exactly 87 `max-lines-per-function` + 53 `complexity`, both at their pre-change baselines)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `packages/cli/src/sessionRunner.ts:292-308` and `:530-535` — the log-capture/recording handle shape (`runId`/`testId`/`startedAt`/`keepPartialOnFailure`) is now written out inline in three places; a single named type would remove two copies.
- `type ExecFileFn` in `packages/device-node/src/filePathUtil.ts:12`, `src/device/IOSLogProvider.ts:10`, `src/device/IOSRecordingProvider.ts:11` — three byte-identical private copies of the alias this change deleted from `hostPreflight.ts`; pre-existing duplication, collapsible into one shared alias.
- `packages/cli/src/sessionRunner.ts:417-471` (recording stop block) — structurally the same stop/abort/`filePath`-extraction shape now factored out as `stopActiveLogCapture`; a sibling extraction would remove the near-duplicate. Deliberately out of scope here (it carries no `max-depth` warning).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `startupState` is write-only in `prepare` — remove declaration + 3 assignments (no `_startupState` fallback needed) | Whole-method verification done this run: lines 96–221 read in full; the only `startupState` tokens are the 4 write sites; all reads are `spawned.startupState`; no closures capture the local; lines 395+ are a separate method's own `const` | S:90 R:85 A:95 D:95 |
| 2 | Confident | `sessionRunner` depth fix uses one extracted helper (`stopActiveLogCapture`) rather than pure guards | The failure branch's abort `try/catch` occupies a nesting level that no guard/inversion can remove inside the enclosing `if`/`try`; intake permits helper extraction as the third-preference technique | S:75 R:80 A:85 D:75 |
| 3 | Confident | `testRunner` :320/:325 fix hoists the post-result checks out of the per-test `try` (declaring `goalResult` as a `let` above it) | The `catch` always `break`s, so post-`try` code runs only on the success path — identical reachability to the original in-`try` placement; TS control-flow narrows `goalResult` as assigned after the try | S:70 R:80 A:85 D:70 |
| 4 | Certain | `AdbClient` fix uses early-`continue` guards (SYSTEM_ALERT_WINDOW branch continues; success continues; undeclared-failure continues) | First-preference technique in the intake; the loop body has no post-branch code, so `continue` is behavior-identical | S:85 R:85 A:90 D:90 |
| 5 | Certain | Expected post-change lint count is exactly 140 (156 − 16) with no new warnings | Edits remove flagged constructs without adding functions above 60 lines or complexity above 12; verified against the captured baseline listing | S:85 R:90 A:90 D:85 |

5 assumptions (3 certain, 2 confident, 0 tentative).
