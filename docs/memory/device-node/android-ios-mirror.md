---
type: memory
description: "The Android/iOS mirror in device-node — platform clients, gRPC setups, recording/log providers, discovery probes: sharing is settled per pair by a measured diff, not parallel shape (`infra/commandFailure.ts`, `device/logWriteStream.ts`, `MAX_DIAGNOSTIC_OUTPUT_CHUNKS`), diagnostic buffers are bounded rings with a consumer, `simctl` plist fields degrade per field, driver recovery replays only an explicit allow-list, and `closeDriverChannel` closes a channel rather than killing a process."
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

`src/device/logWriteStream.ts` is the second instance and conforms the same way: one exported class (`LogWriteStreamRegistry`) for the log-file write-stream bookkeeping the two log providers share, at `device/` — the common parent of `AndroidLogcatProvider` and `IOSLogProvider` — imported by exactly those two, absent from the barrel, and importing nothing from either branch. The measured diff is what admits it: the two providers' versions of that bookkeeping differ only by a log-prefix string ([/device-node/log-capture.md](/device-node/log-capture.md)).

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

### Requirement: A compressed recording replaces the original by rename alone

`IOSRecordingProvider._compressVideo` MUST rename the compressed file straight over the original and
MUST NOT delete the original first. Both paths are in the same directory, where POSIX `rename()`
replaces the destination atomically, so a preceding `rm` buys nothing — and a rename that fails
after it leaves no copy of the recording anywhere. The `-crf` value is the named constant
`COMPRESSION_CRF` (`'40'`, far above the visually-lossless ~18–23 range: a run's video is a
diagnostic artifact uploaded per test, so size dominates fidelity), never a bare literal in the
ffmpeg argument list.

#### Scenario: the rename fails

- **GIVEN** a compressed file and a `rename` that throws
- **WHEN** `_compressVideo` returns
- **THEN** the original recording still exists at its path

#### Scenario: the compression succeeds

- **GIVEN** a compression that completes
- **WHEN** `_compressVideo` returns
- **THEN** the original path holds the compressed video and no `-small` sibling remains

### Requirement: Driver recovery replays only an explicit allow-list of operations

`IOSSimulator._withDriverRecovery` restarts a dead driver on any operation, but MUST re-execute the
failed operation only when its `opName` is a member of `REPLAYABLE_AFTER_DRIVER_RESTART` — six entries: the five
read-only captures (`captureState`, `checkAppInForeground`, `getHierarchy`, `getScreenshot`,
`getScreenshotAndHierarchy`) plus the idempotent driver-state sync `updateAppIds`, which a freshly
restarted driver needs anyway because it has lost its app-id list, and which touches driver state
only, never the device. Every device-touching operation is excluded — `tap`, `tapPercent`,
`longPress`, `enterText`, `eraseText`, `scrollAbs`, `rotate`, `hideKeyboard`, `pressKey`,
`launchApp` — and an operation not named in the set defaults to *not* replayed, so a device action
added later is safe until someone deliberately opts it in. On the non-replayed path the driver is
still restarted (so the *next* call can succeed), a warning names the operation, and the original
error propagates.

This **resolves** rather than contradicts `GrpcDriverClient._unaryCall`'s rationale for defaulting
`maxRetries` to 0 "to prevent duplicating mutating actions": a driver can die *after* the request
reached the device, so the two layers now state one rule, and `GrpcDriverClient`'s doc comment names
the allow-list explicitly ("the read-only captures plus the idempotent `updateAppIds`") so neither
layer can turn one requested mutation into two.

#### Scenario: a tap fails and the driver has exited

- **GIVEN** a `tap` whose call throws and a driver process that has exited
- **WHEN** `_withDriverRecovery` handles it
- **THEN** the driver is restarted, `fn` is called exactly once in total, and the original error propagates

#### Scenario: a capture fails and the driver has exited

- **GIVEN** a `getScreenshot` whose call throws and a driver process that has exited
- **WHEN** `_withDriverRecovery` handles it
- **THEN** the driver is restarted and the capture is retried once

#### Scenario: an unclassified operation fails

- **GIVEN** an `opName` absent from `REPLAYABLE_AFTER_DRIVER_RESTART`
- **WHEN** the driver is found dead
- **THEN** it is not replayed — the default falls the safe way

### Requirement: A method that closes a channel is named for closing a channel

`CommonDriverActions` exposes `close()` and `closeDriverChannel()`, byte-identical bodies that close
this client's gRPC channel and nothing else: the on-device driver — the Android instrumentation host
or the XCUITest runner — keeps running, and ending that process is the platform runtime's job
(`IOSSimulator.close` terminates the runner bundle via simctl). Both MUST document that, so the next
reader neither collapses two identical bodies nor trusts a name that promises a process kill.

The public interface name `killDriver()` is **retained** on `DeviceAgent`, `DeviceRuntime` and the
`Device` facade — renaming it would ripple through `@finalrun/common`, goal-executor and four test
stubs — and is instead documented at every one of those declarations, plus both platform
implementations (`AndroidDevice`, `IOSSimulator`), as closing the driver channel rather than killing
a process. Every one of those implementations delegates to `CommonDriverActions.closeDriverChannel()`.

#### Scenario: a reader looks for the method that terminates the driver process

- **GIVEN** `CommonDriverActions` and the interfaces declaring `killDriver()`
- **WHEN** a reader looks for a method that terminates the driver process
- **THEN** none claims to, and every channel-closing declaration says what it closes

### Requirement: A registered disconnection handler is actually invoked, and cannot break the action's response

`Device._disconnectionCallback`, registered by `listenForDeviceDisconnection`, MUST be invoked when
`Device` observes a lost connection: an action that threw while `runtime.isConnected()` reports
`false`. That is the only disconnection signal `Device` receives — nothing in the stack emits a
disconnection event to subscribe to. The handler receives the device UUID and a reason, and is
notified **at most once per registration** (a single dead connection otherwise produces one callback
per subsequent failing action); registering again re-arms it, and `clearListener()` clears both the
handler and the armed flag.

The notify path runs inside `executeAction`'s `catch`, so it MUST NOT throw. Both remaining steps
run foreign code — the runtime's `isConnected()` and the caller-supplied handler — and both are
inside the guard, because an exception escaping would make `executeAction` **reject** instead of
returning the `Action failed: …` response its contract promises, replacing the original action error
with an unrelated one. The one-shot flag is set *before* the handler call, so a throwing handler is
still not called again by the next failing action. **The notification is best-effort; the action's
own reported outcome is not.**

#### Scenario: an action fails while the runtime reports not-connected

- **GIVEN** a registered `onDeviceDisconnected` handler and a runtime whose action throws while reporting not-connected
- **WHEN** `executeAction` handles the failure
- **THEN** the handler is invoked once with the device UUID and a reason naming the failure, and the action still returns its failure response

#### Scenario: a second action fails on the same dead connection

- **GIVEN** the same handler and a second failing action
- **WHEN** `executeAction` handles it
- **THEN** the handler is not invoked again

#### Scenario: the registered handler throws

- **GIVEN** a handler that throws
- **WHEN** it is notified
- **THEN** the throw is logged, `executeAction` still returns `{ success: false, message: 'Action failed: …' }` carrying the original error, and the handler is not retried

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

### Replay after a driver restart is opt-in per operation, keyed on the name the call sites already pass

**Decision**: `_withDriverRecovery` consults `REPLAYABLE_AFTER_DRIVER_RESTART`, a module-level set of
operation names safe to replay (the read-only captures plus `updateAppIds`); everything else restarts
the driver and rethrows. An unlisted name defaults to *not* replayed.

**Why**: Every call site already passes `opName`, so the classification costs no new parameter and no
call-site churn, and the default falls the safe way — a newly added mutating action is not replayed
until someone deliberately lists it. `updateAppIds` is listed because a restarted driver has *lost*
its app-id list, so replay is required for correctness, and it mutates driver state only, never the
device. Stating the same rule in both layers' doc comments is what keeps them from drifting back into
contradiction: the value of the retry policy is entirely in the two layers agreeing.

**Rejected**: (a) disabling re-execution wholesale — smaller, but it also gives up recovery for the
read-only captures, which is the case the mechanism was built for and where replay is observably
harmless; (b) a `retryAfterRestart` boolean at each of the 16 call sites — the same information
spread over 16 places to be kept consistent by hand; (c) parsing the gRPC error to decide — process
state, not error text, is the source of truth for whether the driver died.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### An atomic rename needs no `rm`, and the `rm` is the part that can lose data

**Decision**: `_compressVideo` renames the compressed file over the original with no preceding
deletion.

**Why**: A same-directory POSIX `rename()` replaces the destination atomically, so deleting first
changes nothing about the outcome on the success path — while on the failure path it is the whole
difference between "compression failed, the recording is still there" and "the recording is gone".
The deletion reads as tidy-up, which is why it survives review: its cost is only visible on a path
nobody exercises.

**Rejected**: (a) keeping the `rm` and wrapping the rename in a retry — retries a step that cannot
recover the deleted file; (b) copying the original aside before deleting it — reintroduces a
temp-file lifetime to manage in order to restore a guarantee `rename` already gives for free.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### A misleading name is corrected inside the package and documented at every public declaration

**Decision**: The channel-closing method inside `device-node` is named `closeDriverChannel`. The
`killDriver()` name on `DeviceAgent`, `DeviceRuntime`, `Device` and the two platform runtimes is kept,
and each of those five declarations carries a doc comment saying the call closes a channel and leaves
the driver process running.

**Why**: The accurate name earns its keep where the implementation is read, and inside `device-node`
that costs two call sites. Carrying it to the public interface would ripple through
`@finalrun/common`, goal-executor and four test stubs in a change whose contract is "no runtime
behaviour changes" — a bigger diff for the same reader benefit a doc comment delivers at the
declaration. Documenting *every* retained declaration rather than only the two platform
implementations matters because a reader arriving at the interface sees only `killDriver()`.

**Rejected**: (a) renaming the public interface method too — a cross-package rename inside a
no-behaviour-change fix; (b) collapsing `close()` and `closeDriverChannel()` into one method — the
public `killDriver()` chain still needs a target, and collapsing them is the exact move the two
doc comments exist to stop happening by accident; (c) leaving the internal name as `killDriver` and
documenting only — the implementation is where a name promising a process kill does its damage, and
there it is free to correct.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### A callback invoked from a `catch` is guarded end to end, and armed before it is called

**Decision**: `Device._notifyIfDisconnected` wraps both the runtime's `isConnected()` probe and the
caller-supplied handler in its own try/catch, logs anything they throw, and sets its one-shot flag
before calling the handler.

**Why**: It runs inside `executeAction`'s `catch`, which owes its caller a
`{ success: false, message: 'Action failed: …' }` response carrying the *original* error. An escaping
exception converts that into a rejection and substitutes an unrelated error — a strictly worse
outcome than a missed notification, so the notification is the part that gets to be best-effort.
Arming before the call keeps a throwing handler from being retried on every subsequent failing
action, which is the same storm the one-shot exists to prevent.

**Rejected**: (a) guarding only the handler — `isConnected()` is a runtime implementation the
`Device` does not own and can throw for its own reasons; (b) letting a handler's exception propagate
so the caller "sees" it — the caller asked about an action, and the error it would receive is not
about that action; (c) arming after a successful handler call — a handler that throws every time is
then called on every failure.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### A malformed plist field degrades to its fallback rather than raising a better error

**Decision**: `_trimmed` answers a non-string value with `undefined`. It does not throw a more descriptive error, does not coerce, and does not report the offending field.

**Why**: All eight call sites already carry a fallback for an absent value, so `undefined` costs one field on one app while any throw costs the entire listing — `_listInstalledAppMetadata` catches it and `uninstallUserApps`/`isAppInstalled` propagate the text verbatim, so a user asking for their installed apps receives an internal expression name instead. The parameter is declared `unknown` because that is what `JSON.parse` output is; a runtime type check is what makes behaviour match the declaration, where a cast asserts a fact about the parser's output that nothing establishes.

**Rejected**: (a) throwing a descriptive error naming the bad field — still aborts a whole listing to report one field, and the callers flatten it to a `message` string with no structure; (b) coercing with `String(value)` — invents a version like `"[object Object]"` and defeats each call site's fallback, which is designed to fire on absence; (c) keeping the cast and documenting why it is safe — the documentation cannot make it safe, because the values are parsed from a file the tool does not control.

*Introduced by*: 260728-o3me-fix-deferred-error-path-defects
