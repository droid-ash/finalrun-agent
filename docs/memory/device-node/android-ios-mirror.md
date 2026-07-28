---
type: memory
description: "The Android/iOS mirror in device-node — AdbClient/SimctlClient, the gRPC setups, the recording and log providers, the discovery probe family: sharing is settled per pair by a measured diff rather than parallel shape (`infra/commandFailure.ts`, the `MAX_DIAGNOSTIC_OUTPUT_CHUNKS` bound), child-process diagnostic buffers are bounded rings that exist only where a consumer reads them, `simctl` plist fields degrade per field, and per-platform policy keeps its own path."
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

### Requirement: A child-process diagnostic buffer is a bounded ring, at every push site

An array accumulating `stdout`/`stderr` chunks from a child process's `data` events MUST be a bounded ring: push, then `shift()` once the length exceeds `MAX_DIAGNOSTIC_OUTPUT_CHUNKS` (`src/diagnosticBuffer.ts`, 20), so the most recent chunks are retained and the oldest dropped. **Every** push site on a buffer honours the cap, including a handler that can only fire once. `DeviceDiscoveryService._spawnEmulatorWithCapture` has three writers on its capture context — the `stdout` handler, the `stderr` handler, and the `once('error')` handler that appends `error.message` to `capture.stderrChunks` — and all three cap. `AndroidRecordingProvider._spawnScrcpy` bounds both of its closure-local arrays the same way. Retaining the tail rather than the head is the diagnostic choice: a startup crash exits fast enough that first and last coincide, while for a long-running child the most recent output is what explains the failure.

#### Scenario: the once-only error writer meets a full buffer

- **GIVEN** a capture already holding `MAX_DIAGNOSTIC_OUTPUT_CHUNKS` stderr chunks
- **WHEN** the child emits `error` and the `once('error')` handler pushes the message
- **THEN** the message is retained, the oldest chunk is evicted, and the buffer stays at the cap

### Requirement: A branch accumulates child-process output only where a consumer reads it

Accumulation is justified by a reader, and an accumulator without one is not added. `AndroidRecordingProvider`'s scrcpy chunks are read by `_formatStartupExit` inside the startup window; `DeviceDiscoveryService`'s emulator chunks are read by `_emulatorTranscript` for the startup `CommandTranscript`. `IOSRecordingProvider`'s `data` handlers log without accumulating because iOS has no scrcpy-equivalent startup-diagnostic consumer — the asymmetry with Android is correct and MUST NOT be made symmetric. `AndroidDeviceSetup.appendLog` and `IOSSimulatorSetup.appendLog` carry their own `recentLogs` rings capped at 20 with `shift()`; they are the source of the idiom and are already bounded.

#### Scenario: one branch accumulates and its mirror does not

- **GIVEN** a `data` handler in one platform branch that pushes onto a buffer and its counterpart that only logs
- **WHEN** the asymmetry is evaluated
- **THEN** it is resolved by locating the consumer, and a branch with no consumer keeps no buffer

### Requirement: A malformed `simctl` plist field degrades to its fallback

`SimctlClient._trimmed` — the single extractor behind the eight `simctl listapps` field reads — MUST type-check its `unknown` argument and return `undefined` for anything that is not a string. The records come from `JSON.parse` of `simctl listapps` output, where a malformed or unusual `Info.plist` can carry a field as a number or nested object (`CFBundleVersion: 17`), and every call site already has a fallback (`|| fallbackName`, `?? null`, the `com.apple.` prefix default). One bad field therefore degrades on its own instead of raising a `TypeError` that aborts enumeration of the whole app list and reaches the user verbatim as the `message` propagated by `uninstallUserApps` and `isAppInstalled`.

#### Scenario: one app record carries a numeric version

- **GIVEN** `simctl listapps` output in which one record's `CFBundleVersion` is a number
- **WHEN** `listInstalledApps` parses the records
- **THEN** that app is enumerated with `version: null` and every other app in the listing is returned normally

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

### The measured-diff test settles any duplicated pair, not only a platform mirror

**Decision**: The diff-before-sharing test that governs the platform seam applies unchanged to two duplicated siblings that are not a platform pair, and `MAX_DIAGNOSTIC_OUTPUT_CHUNKS` (`src/diagnosticBuffer.ts`) is the worked instance. `AndroidRecordingProvider._spawnScrcpy` and `DeviceDiscoveryService._spawnEmulatorWithCapture` are same-package siblings; their accumulator bodies were diffed and come back different — one closes over two local arrays and logs each chunk, the other pushes silently onto a `capture` context field — so the **bound is shared and the push-and-cap statements are not**. Placement follows the same rule as `infra/commandFailure.ts`: a single-purpose zero-import leaf at `src/`, the nearest common parent of `device/` and `discovery/`, absent from the package barrel. The module states the measurement alongside the value, so the constant-only outcome reads as a result rather than an omission.

**Why**: The rule's content is "share what a diff proves identical", and nothing in it depends on the two sides being Android and iOS — reading it as mirror-only leaves every other duplicated pair to be settled by intuition, which is the failure mode it exists to prevent. Running the diff is what keeps a `pushBounded` helper out here: the two bodies are parallel-shaped, exactly the reading the diff overrules, and a helper spanning them would take a target array, a context field and a per-chunk log callback — a parameter list restating the difference. A named constant carries the whole genuinely-shared decision (the retention policy and the number) with no coupling to either call site's structure, which is why it survives the diff the helper fails, and why the bound cannot instead be a literal at each site.

**Rejected**: (a) a shared `pushBounded(buffer, chunk)` push helper — the diff is measured at accumulator-body granularity and is non-empty, so extracting it would be sharing on parallel shape; (b) duplicating the literal `20` at both sites — a magic number twice over, with the retention policy written nowhere; (c) putting the constant in an existing `device/` or `discovery/` module or exporting it from the barrel — both directories sit below the call sites' common parent, so one branch would import from the other's tree, and the bound is an internal detail of two callers rather than package API; (d) reading the two sites as unrelated because they are not a platform pair — the duplication and the test that settles it are the same either way.

*Introduced by*: 260728-o3me-fix-deferred-error-path-defects

### A malformed plist field degrades to its fallback rather than raising a better error

**Decision**: `_trimmed` answers a non-string value with `undefined`. It does not throw a more descriptive error, does not coerce, and does not report the offending field.

**Why**: All eight call sites already carry a fallback for an absent value, so `undefined` costs one field on one app while any throw costs the entire listing — `_listInstalledAppMetadata` catches it and `uninstallUserApps`/`isAppInstalled` propagate the text verbatim, so a user asking for their installed apps receives an internal expression name instead. The parameter is declared `unknown` because that is what `JSON.parse` output is; a runtime type check is what makes behaviour match the declaration, where a cast asserts a fact about the parser's output that nothing establishes.

**Rejected**: (a) throwing a descriptive error naming the bad field — still aborts a whole listing to report one field, and the callers flatten it to a `message` string with no structure; (b) coercing with `String(value)` — invents a version like `"[object Object]"` and defeats each call site's fallback, which is designed to fire on absence; (c) keeping the cast and documenting why it is safe — the documentation cannot make it safe, because the values are parsed from a file the tool does not control.

*Introduced by*: 260728-o3me-fix-deferred-error-path-defects
