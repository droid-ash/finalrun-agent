---
type: memory
description: "Per-test device log capture: manager, providers, Device integration"
---
# Log Capture (device-node)

Per-test device log capture for Android (logcat) and iOS (simctl log stream), mirroring the recording pipeline architecture.

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
- **Process stop**: SIGINT + `_waitForExit` (listens for `exit` event via `once`), then unpipes stdout. Both providers use this pattern.
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
