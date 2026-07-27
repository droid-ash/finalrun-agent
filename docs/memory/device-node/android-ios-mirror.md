---
type: memory
description: "The Android/iOS mirror in device-node — AdbClient/SimctlClient, the gRPC setups, the recording and log providers, the discovery probe family: `infra/commandFailure.ts` is the one shared point on the seam, sharing is settled per helper by a measured diff rather than by parallel shape, and per-platform policy (probe `blocking` scope, the Android `sys.boot_completed` gate) keeps its own path."
---
# Android/iOS Mirror (device-node)

**Domain**: device-node

## Overview

`device-node` is built as two per-platform branches behind common interfaces: `infra/android/AdbClient.ts` against `infra/ios/SimctlClient.ts`, `grpc/setup/AndroidDeviceSetup.ts` against `grpc/setup/IOSSimulatorSetup.ts`, `device/AndroidRecordingProvider.ts` against `device/IOSRecordingProvider.ts`, `device/AndroidLogcatProvider.ts` against `device/IOSLogProvider.ts`, `device/android/AndroidDevice.ts` against `device/ios/IOSSimulator.ts`, plus the per-platform probes and pollers inside `discovery/DeviceDiscoveryService.ts`. The pairs look alike everywhere and are the same code almost nowhere. One module crosses the seam: `src/infra/commandFailure.ts`.

## Requirements

### Requirement: A mirrored helper is shared only on a measured diff

A helper appearing in both platform branches MUST NOT be lifted into shared code on the strength of parallel shape, comparable length, or a matching call sequence. The two bodies SHALL be diffed against each other, and any declared types they differ by SHALL be compared field-by-field; sharing proceeds only when both diffs are empty modulo the type name. A pair that fails the diff is restructured independently on each side and the split reported.

#### Scenario: a duplicated helper is evaluated for sharing

- **GIVEN** a private helper present in both `infra/android/AdbClient.ts` and `infra/ios/SimctlClient.ts`
- **WHEN** the two bodies and their declared result types are diffed
- **THEN** the pair is shared only if both diffs are empty modulo the type name; otherwise each side is fixed in place

### Requirement: A shared cross-platform module is a single-purpose, zero-import leaf at the common parent

A module shared across the seam MUST sit at the nearest common parent directory of its call sites, export only the shared operation, import nothing, and stay out of the package barrel (`src/index.ts`). `src/infra/commandFailure.ts` is the shape: it exports `toCommandFailureResult` over a module-private stream-text extractor, sits at `infra/` — the common parent of `infra/android/` and `infra/ios/` — is imported by exactly the two clients, and is not part of the package's public API. It declares its own `CommandFailureResult` rather than either client's result type, so it depends on neither branch.

#### Scenario: a proven-identical operation is placed

- **GIVEN** an operation that survives the measured diff
- **WHEN** it is extracted
- **THEN** it lands in a single-purpose module at the nearest common parent of its call sites, imports nothing from either branch, and is not re-exported from the barrel

### Requirement: Per-platform policy stays a parameter or a per-platform helper

Structure common to both platforms MAY be extracted, but a value or step that differs by platform MUST remain a call-site parameter or its own per-platform helper rather than being normalized into the shared code. In `discovery/DeviceDiscoveryService.ts` the no-entries-plus-one-diagnostic `ProbeResult` shape is extracted once as `_probeFailure`, with `scope` and `blocking` as parameters: an absent `adb` or a failed `adb devices -l` is blocking, an absent emulator binary or a failed AVD listing is not. Readiness polling splits the same way — `_waitForStartableEntry` owns the deadline loop while `_pollAndroidStarted` and `_pollIOSStarted` own the per-platform test, and only the Android poll follows a `runnable` match with `adb -s <id> shell getprop sys.boot_completed`.

#### Scenario: a platform probe reports a failure

- **GIVEN** a probe whose underlying command fails
- **WHEN** the shared failure helper builds the `ProbeResult`
- **THEN** the diagnostic's `scope` and `blocking` come from the call site, never from the helper

## Design Decisions

### Measured identity, not parallel shape, decides what the mirror shares

**Decision**: Each mirrored helper is settled on its own by diffing the two bodies, never by reading the pair as parallel. `toCommandFailureResult` in `src/infra/commandFailure.ts` is the worked instance and the only shared point on the seam: the failed-exec → `{ success: false, message, stdout, stderr }` conversion, called by `AdbClient._runAdb` and `SimctlClient._runCommand`. Those two wrappers, whose bodies are themselves near-identical, stay per-platform.

**Why**: The mirror is at once this package's largest apparent DRY opportunity and its largest YAGNI trap — the platforms are genuinely different, and an abstraction imposed on incidentally-similar code is worse than the duplication, because every later divergence then has to be threaded through a hook or a flag. A diff is the one cheap test that separates the two readings, so the question is answered per helper with evidence rather than once for the whole seam by intuition. It answers affirmatively here: the two clients' failure-conversion implementations diff empty apart from the declared return type, and `AndroidCommandResult`/`IOSCommandResult` are field-for-field identical, so the shared version is provably the same function rather than a generalization over two similar ones. `infra/` is the nearest common parent of the two clients, and a module holding one exported function is neither a cross-package dependency nor a grab-bag. Batching a package's flagged functions into one change is what puts a whole sibling family in scope at once, which is the condition under which the diff can be run at all.

**Rejected**: (a) clearing the two duplicated methods independently — leaves the package's one proven-identical pair duplicated; (b) sharing the `_runAdb`/`_runCommand` wrappers too — each closes over its own client's injected `_execFileFn` and owns that client's error-logging policy (`suppressErrorLog`) and result type, so sharing them moves per-platform policy into common code, which identity of the happy path does not justify; (c) a platform-agnostic base class or template method for a mirrored pair — commits every future divergence to a hook; (d) a general `deviceCommand`/`utils` module for the pair to grow into — a grab-bag attracts unrelated helpers and re-couples the branches through it; (e) exporting the shared helper from the package barrel — it is an internal detail of two clients, not API; (f) deferring the whole mirror indefinitely as a YAGNI risk — the risk lies in unmeasured sharing, and refusing to measure leaves a proven duplicate standing.

*Introduced by*: 260727-6z9b-batch-refactor-device-node

### The probe family shares its failure shape, not its platform paths

**Decision**: The three discovery probes share two extracted helpers — `_probeFailure` for the failure `ProbeResult`, and `_startupFailure` for the always-blocking `scope: 'startup'` diagnostic used by both start paths. Entry construction stays per-platform (`_deadAndroidEntry`, `_connectedAndroidEntry`, `_avdEntry` against `_iosEntryFromDevice`, `_makeIOSEntry`), and so does readiness polling.

**Why**: The failure shape is the same object literal at every site, so extracting it removes real repetition. The entry builders differ in inputs, fields and per-platform state vocabulary, so a shared builder would be a parameter list restating those differences. Keeping `blocking` a call-site parameter preserves the distinction discovery actually makes: a platform that cannot be enumerated at all blocks the run, while an unavailable optional emulator inventory does not.

**Rejected**: (a) one `probe(platform)` entry point branching internally — recreates the switch the split exists to remove and makes each platform's path harder to follow; (b) hoisting `blocking: true` into the shared helper and overriding it at the non-blocking sites — the default is then wrong for a whole diagnostic scope; (c) a shared poller taking a platform predicate — the Android poll runs an extra command against the device and carries its transcript, so the predicate would have to be the poller.

*Introduced by*: 260727-6z9b-batch-refactor-device-node
