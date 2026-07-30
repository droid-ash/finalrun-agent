---
type: memory
description: "Per-test device log capture (manager, providers, Device integration) and the write-stream finalization contract: every exit from start/stop ends and flushes the log file's write stream through one shared `LogWriteStreamRegistry`, held per provider instance and keyed on the capture's output file path, so the file the CLI copies next is complete."
---
# Log Capture (device-node)

**Domain**: device-node

## Overview

Per-test device log capture for Android (logcat) and iOS (simctl log stream), mirroring the recording pipeline architecture. The non-obvious part is stopping: the file must be complete when the stop resolves, because the CLI copies it immediately afterwards.

## Architecture

The log capture system mirrors RecordingManager/RecordingProvider exactly:

- **`LogCaptureProvider`** (`src/device/LogCaptureProvider.ts`) -- interface with `startLogCapture`, `stopLogCapture`, `checkAvailability`, `cleanupPlatformResources`, plus `fileExtension` and `platformName` readonly properties.
- **`AndroidLogcatProvider`** (`src/device/AndroidLogcatProvider.ts`) -- clears ring buffer with `adb -s <serial> logcat -c` before capture, then spawns `adb -s <serial> logcat -v threadtime` piping stdout to a write stream. Uses injected `execFileFn` and `spawnFn` for testability.
- **`IOSLogProvider`** (`src/device/IOSLogProvider.ts`) -- spawns `xcrun simctl spawn <udid> log stream --style compact` piping stdout to a write stream. Same injected function pattern.
- **`LogCaptureManager`** (`src/device/LogCaptureManager.ts`) -- state-tracking controller. Implements `DeviceLogCaptureController` interface. Exposes `startLogCapture`, `stopLogCapture`, `abortLogCapture`, `cleanupDevice`.
- **`LogInfo`** (`src/device/LogInfo.ts`) -- state object tracking deviceId, filePath, runId, testId, platform, startTime, endTime.

## Key Patterns

- **Map key**: `{runId}###{testId}` (same delimiter as RecordingManager).
- **Three maps**: `_logProcessMap` (ChildProcess), `_logInfoMap` (LogInfo), `_deviceToLogKeysMap` (deviceId to keys).
- **Stopped set**: `_stoppedTestCases` Set prevents double-stop.
- **Output path**: `<os.tmpdir()>/finalrun-logs/{sanitizedRunId}_{sanitizedTestId}.log`. Never writes directly to the report directory — the CLI copies the finished file in and redacts it there ([/cli/report-writer.md](/cli/report-writer.md)).
- **Process stop**: SIGINT + `_waitForExit` (listens for `exit` event via `once`), then `LogWriteStreamRegistry.finalize(outputFilePath, stdout)` — drain `stdout` to EOF, end the write stream, await its flush. Both providers use this pattern, and both finalize on every other exit too (see the finalization requirement below).
- **Write-stream registry**: `LogWriteStreamRegistry` (`src/device/logWriteStream.ts`) is a **per-provider-instance** field (`private readonly _logStreams`), not a module-level singleton, and is keyed on `outputFilePath` — which `LogCaptureManager` derives from the same `(runId, testId)` pair as its own `mapKey`, so the key is that capture's identity. It is not re-exported from the package barrel.
- **Provider selection**: Constructor accepts optional providers map; defaults to `PLATFORM_ANDROID -> AndroidLogcatProvider`, `PLATFORM_IOS -> IOSLogProvider`.
- **Default instance**: `defaultLogCaptureManager` exported as a singleton.

## Device Integration

`Device` class (`src/device/Device.ts`) exposes four parallel methods to recording:
- `startLogCapture(request)` -- delegates to `DeviceLogCaptureController`
- `stopLogCapture(runId, testId)` -- delegates with platform from `this._platform`
- `abortLogCapture(runId, keepOutput)` -- delegates with deviceId and platform
- `logCaptureCleanUp()` -- called from `closeConnection()` after `recordingCleanUp()`

`GrpcDriverSetup.setUp()` (`src/grpc/GrpcDriverSetup.ts`) instantiates and injects `LogCaptureManager` into Device alongside RecordingManager. The per-test caller that drives start/stop/abort across one goal execution is [/cli/session-runner.md](/cli/session-runner.md).

## Error Handling

- Start failures return `DeviceNodeResponse { success: false }` and clean up map entries.
- Stop failures still finalize state (delete from maps, add to stopped set) to prevent leaks.
- File deletion on `keepOutput: false` uses `force: true` and logs warnings on failure.

## Requirements

### Requirement: Every exit from a capture's lifecycle finalizes its write stream

A provider MUST end and flush the log file's write stream on **every** path out of
`startLogCapture` and `stopLogCapture`, not only the success path. `Readable.unpipe()` detaches a
pipe **without** ending the destination: anything still buffered is dropped, `finish` never fires,
and the file is silently truncated — so detaching alone is never a stop. Finalization happens
through `LogWriteStreamRegistry`, which drains the child's `stdout` to EOF (the pipe writes
everything the child produced), ends the write stream, and awaits its flush.

Two entry points express the difference in how a failure is reported:

- **`finalize(outputFilePath, source?)`** throws. It is the success path's call
  (`AndroidLogcatProvider.stopLogCapture`, `IOSLogProvider.stopLogCapture`): a log that could not be
  flushed is a failed stop, because the file is not known to be complete.
- **`finalizeQuietly(outputFilePath, source?)`** logs and swallows. It is the call on every path
  that is already returning a failure — a start that threw, a stop whose SIGINT was never delivered
  (an early return), and each provider's outer `catch` when `_waitForExit` throws. Those paths still
  MUST end the stream and drop its registry entry, but a finalization error there must not mask the
  failure being reported.

`finalize` is idempotent and cheap on repeat: an untracked path (a capture that never opened a
stream, or one an earlier stop already finalized) and an already-finished or already-destroyed
stream return at once, which is what lets an error path call it without knowing whether the success
path already did. Untracking and ending run in a `finally`, so a rejecting drain cannot strand a
stream that nothing else holds a handle on.

#### Scenario: buffered output is still complete on disk after the stop

- **GIVEN** a log capture whose child process has written data that is still buffered
- **WHEN** `stopLogCapture` resolves
- **THEN** the output file contains every byte the child produced

#### Scenario: the stop's signal is never delivered

- **GIVEN** a stop whose SIGINT delivery fails, so the provider returns a failure response early
- **WHEN** that early return runs
- **THEN** the write stream is ended, flushed and untracked first, and the failure response is what the caller receives

#### Scenario: finalizing twice, or finalizing a capture that never started

- **GIVEN** a path that was never opened, or one an earlier stop already finalized
- **WHEN** finalization runs
- **THEN** it resolves without throwing and without hanging

### Requirement: The drain wait is bounded, and its timeout degrades to a truncated log

Waiting for a stopped capture's `stdout` to reach EOF MUST be bounded — `LOG_DRAIN_TIMEOUT_MS`,
5000 ms. By the time a provider finalizes it has already awaited the child's `exit`, so the pipe is
draining a closed descriptor and reaches EOF in a few ticks; the bound exists for a child that
somehow outlives its own exit event. On timeout the source is `unpipe`d from the destination
**before** the stream is ended — a chunk arriving after `end()` raises
`ERR_STREAM_WRITE_AFTER_END`, which `pipe` re-emits as an unhandled `error` — a warning naming the
file is logged, and the stop still completes. **The accepted degradation is a possibly incomplete
log, never a stop that does not return**: an unbounded wait would hang the CLI, which is strictly
worse than a truncated diagnostic artifact.

#### Scenario: a child outlives its exit event

- **GIVEN** a stopped capture whose `stdout` has not reached EOF after 5 s
- **WHEN** the drain wait times out
- **THEN** the source is detached, a warning names the output file as possibly incomplete, the stream is ended and flushed, and the stop resolves

## Design Decisions

### One shared write-stream registry serves both log providers

**Decision**: The write stream a log provider pipes `stdout` into is created and tracked by
`LogWriteStreamRegistry` in `packages/device-node/src/device/logWriteStream.ts`, and each provider
calls its `finalize`/`finalizeQuietly` in place of a bare `stdout.unpipe()`. The registry is a field
on each provider instance, and the module is absent from the package barrel.

**Why**: `stopLogCapture` receives only `{ process, outputFilePath }`, so it needs a way back to the
stream `startLogCapture` opened. Running the measured diff the mirror rule demands
([/device-node/android-ios-mirror.md](/device-node/android-ios-mirror.md)), the two providers'
versions of that bookkeeping come back identical modulo a log-prefix string — the affirmative case
that rule describes — so the shape it prescribes is a single-purpose, zero-branch-import leaf at the
two providers' common parent, kept out of the barrel. Per-instance rather than module-global because
a stream's lifetime belongs to the provider that opened it, and a process-wide map would keep
accumulating entries for captures whose provider is long gone.

**Rejected**: (a) a private `Map` in each provider — duplicates the one case the mirror rule says to
share; (b) widening `LogCaptureProvider` so the stream travels through `LogCaptureManager` — changes
a cross-package interface and puts a Node stream in the manager's vocabulary for no gain; (c)
keeping `unpipe()` and calling `end()` immediately — ends the destination before `stdout` has
drained, which truncates the file in a new way and errors on the in-flight write; (d) a
module-level singleton registry — the entry outlives the provider, so a leaked entry is unbounded
growth in a process-wide object rather than garbage collected with its owner.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### The finalization call site documents why detaching is not a flush

**Decision**: The comment at each provider's finalization call states the `unpipe()` semantics — a
detached pipe leaves the destination unended, so buffered output is dropped and the file the CLI
copies next is truncated — rather than restating the call it sits above.

**Why**: This truncation raises no error anywhere: a short log reads as a quiet device, so nothing
in a run's output distinguishes the two. The fact a future reader needs is the reason the
finalization cannot be simplified back to a detach, and that reason is not derivable from the code
in front of them. A comment restating the call carries none of it, and a comment asserting the data
is flushed while nothing ends the stream actively certifies the defect.

**Rejected**: (a) a comment restating the call (`// flush and close the stream`) — reads as a
guarantee, and nothing checks it against what the code does; (b) no comment at all — the next
reader re-derives "detaching is enough" from a pipe that visibly works.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects
