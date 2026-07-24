---
type: memory
description: "ReportWriter artifact handling including device log copy and redaction"
---
# Report Writer (cli)

`ReportWriter` (`packages/cli/src/reportWriter.ts`) handles copying test artifacts into the report directory and building `TestResult` records for `run.json`.

## Device Log Artifact Flow

The `_copyLogArtifact(testId, deviceLog, bindings)` private method handles device logs:

1. **Target path**: `path.posix.join('tests', testId, 'device.log')` relative to the run directory.
2. **Source validation**: checks `fsp.access(sourcePath)`; returns `undefined` if missing (no error thrown).
3. **Size guard**: warns if raw file exceeds 50 MB (redaction holds entire file in memory), but still proceeds.
4. **Copy**: `fsp.copyFile` from temp source to report target.
5. **Write-then-redact**: reads the copied file back, applies `redactResolvedValue(raw, bindings)` from `@finalrun/common/repoPlaceholders`, writes redacted content back. Only writes if redaction actually changed the content.
6. **Returns** the relative path string for inclusion in `TestResult`.

## writeTestRecord Integration

In `writeTestRecord()`, `_copyLogArtifact` is called after `_copyRecordingArtifact`. Three fields are populated on the `TestResult`:
- `deviceLogFile` -- relative path (e.g., `tests/auth-login/device.log`)
- `deviceLogStartedAt` -- ISO 8601 timestamp from `DeviceLogCaptureResult`
- `deviceLogCompletedAt` -- ISO 8601 timestamp from `DeviceLogCaptureResult`

These fields are `undefined` when log capture was unavailable or failed to start.

## Schema Version

`RunManifest.schemaVersion` was bumped from `2` to `3` to accommodate the new `TestResult` fields. The type is `2 | 3` for backward compatibility.
