# Plan: Batched Refactor of `device-node` — 23 Warnings

**Change**: 260727-6z9b-batch-refactor-device-node
**Intake**: `intake.md`

## Requirements

### device-node: Batched warning clearance

#### R1: Clear all 23 in-scope lint warnings without behaviour change
The 18 flagged functions across the 8 tested `device-node` source files MUST be restructured so that
`npm run lint` reports zero `max-lines-per-function`/`complexity` warnings in those files, with zero
behaviour change. Every extracted helper MUST itself be ≤60 lines (skipBlankLines/skipComments) and
complexity ≤12. `max-depth` and `no-unused-vars` MUST stay at zero tree-wide. Total warnings MUST
fall 112 → ~89.

- **GIVEN** the baseline of 112 warnings (23 in the in-scope files)
- **WHEN** the refactor lands and `npm run lint` runs
- **THEN** the 8 in-scope files carry 0 warnings, device-node source warnings are exactly the 6 in
  the excluded untested files, and no new warning appears anywhere

#### R2: The `_probe*` sibling family is factored as a family
`_probeAndroidConnected`, `_probeAndroidTargets`, and `_probeIOSSimulators` MUST be read and
restructured together. Genuinely-common structure (the command-failed → single-diagnostic
`ProbeResult` shape, repeated 6×) SHALL be extracted once; platform-specific entry construction
(Android dead/connected entries; the iOS entry builder collapsing four near-identical pushes)
SHALL be extracted per-platform, not forced through a shared abstraction.

- **GIVEN** `detectInventory` driven over identical mocks by the pre- and post-change builds
- **WHEN** any combination of adb/simctl outputs (connected, offline, unauthorized, weird-state,
  emulator, unavailable, booted, shutdown, invalid JSON, command failure) is probed
- **THEN** entries, diagnostics, transcripts, and the external call sequence are byte-identical

#### R3: `_toFailureResult` sharing decided by honest comparison
The two `_toFailureResult` implementations (AdbClient.ts:1058, SimctlClient.ts:713) MUST be compared
honestly. They are textually identical (only the declared result type name differs, and
`AndroidCommandResult`/`IOSCommandResult` are structurally the same shape), so ONE shared helper
SHALL be extracted into a single-purpose module inside `device-node`'s `infra/` layer — no
cross-package dependency, no grab-bag utility module. If the comparison had shown material
difference, they would have been fixed independently and the split reported.

- **GIVEN** an exec error carrying any of: string stdout/stderr, Buffer stdout/stderr, absent
  fields, a non-Error throw
- **WHEN** either client's command runner catches it (pre- vs post-change builds)
- **THEN** the returned `{success, message, stdout, stderr}` is byte-identical for both clients

#### R4: Remaining functions restructured as ordinary extractions
`Device.executeAction`, `RecordingManager.startRecording`/`stopRecording`,
`ScreenshotCapture._captureWithRetry`/`_waitForStableScreen`,
`AndroidRecordingProvider.startRecordingProcess`, `GrpcDriverSetup._connectWithPolling`, and the
AdbClient/SimctlClient long functions MUST each be split into phase helpers per the recorded DDs:
per-call local context objects (never new instance fields), phase-outcome unions only where the
caller has an exit to take, `finally` scope following each acquisition independently.

- **GIVEN** the pre- and post-change builds driven over identical mocks
- **WHEN** each restructured function runs its success, failure, rollback, retry, and timeout paths
- **THEN** returned values, accumulated arrays/state, the captured Logger stream, and the ordered
  external call sequence (spawn/adb/simctl invocations with arguments) are identical

#### R5: The committed suite is untouched and green
No test file may change. `npm run test:workspaces` MUST stay at 368 tests / 0 fail
(75 common, 18 cloud-core, 91 device-node, 67 goal-executor, 117 cli), and
`npm run test --workspace=@finalrun/device-node` MUST pass after every incremental step.

- **GIVEN** the full refactor applied
- **WHEN** `git diff --numstat` and the workspace test suites run
- **THEN** zero test files appear in the diff and all 368 tests pass

#### R6: Equivalence proved by throwaway differential harnesses
Because coverage is thin relative to surface, differential harnesses are REQUIRED: the pre-change
compiled package (`.dist-before` snapshot of the baseline build) is driven alongside the refactored
build over identical mocks, diffing full returned values, accumulated arrays, the captured Logger
stream, and the external call sequence. Each harness carries negative controls proving it detects
the regression classes at risk. Harnesses live in the scratchpad, are NOT committed, and the
`.dist-before` snapshot is deleted before finishing. Minimum coverage: the three `_probe*` methods,
both `_toFailureResult` paths, `Device.executeAction`, `RecordingManager.startRecording`.

- **GIVEN** a deliberate mutation of a pinned behaviour (field value, message string, call order,
  log line, rollback deletion)
- **WHEN** the harness runs against the mutated build
- **THEN** the harness fails; restored, it passes with 0 diffs

### Non-Goals
- The four untested files (`IOSSimulatorSetup.ts`, `LogCaptureManager.ts`, `AndroidDeviceSetup.ts`,
  `AndroidLogcatProvider.ts`) — 6 warnings remain by design (characterization route first).
- Test-file warnings; warnings outside `device-node`; promoting rules to `error`.
- Any behaviour change; any new DI seam.

### Design Decisions

#### Shared `_toFailureResult` lives in `infra/commandFailure.ts`
**Decision**: Extract the identical failure-result conversion into
`packages/device-node/src/infra/commandFailure.ts` (one exported function + one private stream-text
extractor), imported by both `AdbClient` and `SimctlClient`.
**Why**: The two bodies are byte-identical; the result types are structurally identical. `infra/` is
the common parent of both clients, and a single-purpose module is neither a cross-package dependency
nor a grab-bag.
**Rejected**: (a) fixing each independently — leaves the repo's one real structural DRY case
unserved; (b) sharing the whole `_runCommand`/`_runAdb` wrapper too — not flagged, and it would
entangle logging/options policy across platforms beyond what the warnings require.
*Introduced by*: 260727-6z9b-batch-refactor-device-node

#### Per-orchestrator outcome shapes, no invented `continue`
**Decision**: `_waitForStartableEntry`'s per-platform pollers return `{ok, transcript}`;
`ScreenshotCapture._waitForStableScreen`'s poll helper returns a two-variant
stable/not-yet union; `Device.executeAction`'s category dispatchers return
`DeviceNodeResponse | null` (null = not this category) chained with `??`.
**Why**: Each caller consumes exactly the exits it has; a nullable result keeps the exit visible
with no wrapper where a phase either yields or defers (per the recorded phase-outcome DD).
**Rejected**: one shared union across orchestrators — dead variants for callers with nothing to
continue.
*Introduced by*: 260727-6z9b-batch-refactor-device-node

## Tasks

### Phase 1: Setup

- [x] T001 Snapshot the baseline build as `packages/device-node/.dist-before/` (untracked; deleted at the end) for the differential harnesses <!-- R6 -->

### Phase 2: Core Implementation

- [x] T002 Extract shared `toCommandFailureResult` into `packages/device-node/src/infra/commandFailure.ts`; replace both `_toFailureResult` methods in `infra/android/AdbClient.ts` and `infra/ios/SimctlClient.ts`; build + device-node tests <!-- R3 -->
- [x] T003 Split `AdbClient.toggleAirplaneMode` (legacy <29 path into a helper); build + tests <!-- R4 -->
- [x] T004 Split `AdbClient.togglePermissions` (per-permission application helper with per-call error/skip context); build + tests <!-- R4 -->
- [x] T005 Split `SimctlClient._listInstalledAppMetadata` (trimmed-field reader + per-record parser); build + tests <!-- R4 -->
- [x] T006 Split `SimctlClient._applyApplesimutilsPermissions` (per-permission translation helper); build + tests <!-- R4 -->
- [x] T007 Reduce `DeviceDiscoveryService.constructor` complexity (normalize `params` once); build + tests <!-- R1 -->
- [x] T008 Extract shared probe-failure `ProbeResult` helper; split `_probeAndroidConnected` (dead-entry + connected-entry builders); build + tests <!-- R2 -->
- [x] T009 Split `_probeAndroidTargets` (AVD entry builder, shared failure helper); build + tests <!-- R2 -->
- [x] T010 Split `_probeIOSSimulators` (trimmed-field reader, entry builder, per-device classifier); build + tests <!-- R2 -->
- [x] T011 Split `_startAndroidEmulator` (startup-diagnostic helper shared with `_startIOSSimulator`, spawn-capture context, transcript builder); build + tests <!-- R4 -->
- [x] T012 Split `_waitForStartableEntry` into per-platform pollers; build + tests <!-- R4 -->
- [x] T013 Split `Device.executeAction` into category dispatchers chained with `??`; build + tests <!-- R4 -->
- [x] T014 Split `RecordingManager.startRecording` (path-resolution helper + provider-launch phase with rollback kept in the phase that registered state); build + tests <!-- R4 -->
- [x] T015 Split `RecordingManager.stopRecording` (lookup phase-outcome + discard-output helper); build + tests <!-- R4 -->
- [x] T016 Split `ScreenshotCapture._captureWithRetry` (attempt-finalization + log-context helpers); build + tests <!-- R4 -->
- [x] T017 Split `ScreenshotCapture._waitForStableScreen` (single-poll helper + poll-state logger); build + tests <!-- R4 -->
- [x] T018 Split `AndroidRecordingProvider.startRecordingProcess` (args builder + spawn-capture helper); build + tests <!-- R4 -->
- [x] T019 Split `GrpcDriverSetup._connectWithPolling` (startup-failure check + wait-progress logger helpers); build + tests <!-- R4 -->

### Phase 3: Integration & Edge Cases

- [x] T020 Build differential harnesses in the scratchpad (discovery, clients, device, recording, screenshot, grpc-polling) driving `.dist-before` and `dist` over identical mocks; diff returns, state sequences, Logger stream, call sequences <!-- R6 -->
- [x] T021 Run negative controls: one deliberate mutation per regression class (field value, message string, call order, log line, rollback deletion) must fail its harness; revert each <!-- R6 -->

### Phase 4: Polish

- [x] T022 Full verification: workspace build, `test:workspaces` (368/0 fail, device-node 91), `npm run lint` (~89 warnings, 0 errors, per-rule breakdown, device-node source = 6 excluded-file warnings, max-depth/no-unused-vars zero), `git diff --numstat` (no test file, no harness/`.dist-before` committed); delete `.dist-before` <!-- R1 R5 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: All 23 in-scope warnings cleared; total 112 → ~89; 0 errors
- [x] A-002 R2: The three `_probe*` methods restructured with the shared failure shape extracted once and platform paths kept separate
- [x] A-003 R3: One shared failure-result helper in `device-node/src/infra/`, both clients using it; the sharing verdict reported explicitly

### Behavioral Correctness

- [x] A-004 R4: Every extracted helper ≤60 lines and complexity ≤12; per-call context objects only; no new instance fields or module-level mutable state
- [x] A-005 R5: `max-depth` and `no-unused-vars` still zero tree-wide

### Scenario Coverage

- [x] A-006 R6: Differential harnesses cover at minimum the three `_probe*` methods, both `_toFailureResult` paths, `Device.executeAction`, `RecordingManager.startRecording`; all diffs empty
- [x] A-007 R6: Negative controls demonstrate the harness detects each at-risk regression class

### Edge Cases & Error Handling

- [x] A-008 R4: Error/rollback/timeout paths (probe failures, invalid JSON, spawn failure, provider-start rollback, stop-preserve logic, transient-capture retry exhaustion, polling timeout) proven identical pre/post — one narrow exception noted in review (`SimctlClient._trimmed` TypeError message text on non-string plist fields; should-fix, not blocking)

### Code Quality

- [x] A-009 Pattern consistency: New helpers follow the file’s existing naming (`_`-prefixed privates) and structural patterns
- [x] A-010 No unnecessary duplication: The 6× probe-failure shape and the 2× failure-result conversion are each extracted once; no forced abstraction over platform differences

## Notes

### Accepted deviation from the zero-behaviour-change claim

Review found one real delta, narrow but user-reachable, and it is recorded here rather than buried.

`SimctlClient._trimmed` replaced eight inline `(value as string | undefined)?.trim()` casts. The
cast semantics are identical, but the **thrown message is not**. V8 builds a TypeError's text from
the source expression, so when a record carries a non-string, non-null value — a malformed
`Info.plist` with, say, `CFBundleVersion: 17` — the message now reads `value?.trim is not a
function` where it previously read `valueRecord.CFBundleVersion?.trim is not a function`. That
string is caught by `_listInstalledAppMetadata` and propagated verbatim as `message` by
`uninstallUserApps` and `isAppInstalled`, so a caller can observe it.

**Why accepted rather than fixed.** The old text cannot be preserved while the `?.trim()` lives in a
helper — the message embeds the source expression, so restoring it means re-inlining all eight call
sites, which is exactly what put `_listInstalledAppMetadata` over the complexity ceiling. Throw
class, throw point, success/failure classification and returned data are all unchanged, and neither
string is a designed diagnostic; both leak an internal JS expression name. The helper's doc comment
previously claimed it "mirrors the original inline casts", which was false in this respect — that
comment now states the delta explicitly.

**Follow-up worth considering:** a malformed `Info.plist` arguably should not surface a raw JS
TypeError to a caller at all. Replacing both texts with a designed diagnostic would be a genuine
improvement, but it is a behaviour change and belongs in its own change.

### Deferred from CodeRabbit review of PR #160 (both are behaviour changes)

**1. Make `SimctlClient._trimmed` type-safe instead of documenting the TypeError delta.**
CodeRabbit proposes `typeof value === 'string' ? value.trim() : undefined`, which would make a
malformed `Info.plist` field degrade to `undefined` rather than aborting the whole `listapps` parse,
and would delete the explanatory comment entirely. **This is the better end state and should be
done** — it also aligns `SimctlClient` with its own package's convention, since
`DeviceDiscoveryService._trimmedField` already uses exactly that guard, making the throwing form the
outlier.

Not done here because it is a **larger** behaviour change than the one it replaces: today a
non-string throws and the parse aborts; with the guard the parse continues with an undefined field.
Trading a documented diagnostic-string delta for an undocumented control-flow delta inside a PR
whose claim is zero behaviour change would be the wrong direction. This initiative has spun three
such fixes into their own changes (#155, #157, #158) and each was better for it. The follow-up
should carry a test for the malformed-record path, which has no coverage today.

**2. Cap the retained output in `_spawnEmulatorWithCapture`.**
`stdoutChunks`/`stderrChunks` grow unbounded across the 120s emulator startup wait, so a chatty
emulator accumulates an arbitrarily large in-memory buffer that is then joined into a diagnostic
transcript. CodeRabbit suggests retaining only a trailing window.

Valid, and **pre-existing**: `origin/main` pushes the same chunks with no bound (`:574-591`); the
refactor moved the code into a helper without changing accumulation. Capping changes what the
transcript contains on a long or noisy boot, which is observable output — a behaviour change, so it
belongs in its own change alongside a decision about the window size.

### Pre-existing, not addressed here

`DeviceDiscoveryService._startAndroidEmulator` releases the spawned child (`destroy`/`unref`) only on
the success path, not in a `finally`. Pre-existing and correctly left alone — changing it would be a
behaviour change — but given this initiative has already shipped two fixes for exactly this class
(`finally` scope not following the acquisition), it is a real follow-up candidate.


- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)

## Deletion Candidates

- `packages/device-node/src/infra/commandFailure.ts:7` — `export interface CommandFailureResult` has zero import sites; only `toCommandFailureResult` is imported. The `export` keyword can drop (the interface is still needed as the return type).
- `packages/device-node/src/infra/ios/SimctlClient.ts:17` `IOSCommandResult` / `packages/device-node/src/infra/android/AdbClient.ts:35` `AndroidCommandResult` — now *proven* structurally identical (verified field-by-field against `origin/main` during review). A future change could collapse them into one shared result type; out of scope here because both are part of each client's public surface.
- `packages/device-node/src/infra/ios/SimctlClient.ts` `_appRecordDetails` — exists only to keep `_parseAppRecord` under the complexity ceiling; it has a single call site and no independent meaning. Harmless, but a candidate to re-inline if the ceiling ever moves.
- None of the refactored code left any function, branch, or constant unreachable: the byte-identity audit found 134 of 152 method bodies unchanged and every removed symbol (`_toFailureResult` ×2) replaced by the shared helper.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Share `_toFailureResult` via `infra/commandFailure.ts` | The two bodies are byte-identical and the result types structurally identical; `infra/` is the common parent; single-purpose module, not a grab-bag | S:85 R:85 A:95 D:90 |
| 2 | Confident | `Device.executeAction` splits into category dispatchers returning `DeviceNodeResponse \| null` chained with `??` | Preserves one-handler-per-type semantics; the only observable difference would require a runtime method resolving `undefined`, which no real runtime or test mock does — verified by harness over all action types | S:70 R:80 A:80 D:70 |
| 3 | Confident | Harness normalizes wall-clock timestamps (`startedAt`/`completedAt` ISO strings) and patches `Date.now`/log timestamps deterministically where loops depend on real time | `new Date()` inside RecordingInfo/deadline loops differs across runs by construction; format+presence is the pinned behaviour, values are wall-clock | S:75 R:90 A:85 D:80 |
| 4 | Certain | `.dist-before` snapshot of the baseline build is the differential oracle | The baseline build was verified green (368/0) before any edit; compiled-output comparison avoids a second tsconfig; snapshot is untracked and deleted at the end | S:85 R:90 A:90 D:90 |
| 5 | Confident | Object-literal key order inside built entries/metadata records is not an observable behaviour | Consumers access fields by name; deep-equality (order-insensitive) is the diff criterion | S:70 R:85 A:85 D:80 |
| 6 | Certain | Rollback/cleanup placement: RecordingManager's registered-state rollback stays in the same phase that registers it, mirroring the original try/catch reachability | The `finally`-scope DD binds release scope to acquisition; moving registration and rollback together preserves reachability exactly | S:85 R:80 A:90 D:90 |

6 assumptions (3 certain, 3 confident, 0 tentative).
