---
type: memory
description: "ReportWriter (packages/cli/src/reportWriter.ts) — the run directory it emits (runner.log, input/, tests/<id>/, summary.json, run.json), the secret-redaction contract every write path crosses, device-log copy-then-redact, first-failure precedence, and the emitted-JSON key-omission contract that makes an absent optional field part of the schema"
---
# Report Writer (cli)

`ReportWriter` (`packages/cli/src/reportWriter.ts`) owns everything written under one run directory: the runner log, the `input/` snapshot of what the run was asked to do, per-test artifacts and records, and the two run-level files. It is constructed per run with `{ runDir, envName, platform, runId, bindings }`; `init()` creates the directory and truncates `runner.log`.

Four public emit orchestrators — `writeRunInputs`, `writeTestRecord`, `writeTestFailureRecord`, `finalize` — delegate to private `_write*`/`_copy*` methods and to module-private pure helpers. Two shapes are shared rather than repeated per orchestrator: `_writeJson(relativePath, value)` is the single JSON emit (`JSON.stringify(value, null, 2)`, utf-8, run-dir-relative) and `durationMsBetween(startedAt, completedAt)` the single `Math.max(0, …)` duration clamp.

## Run Directory Layout

- `runner.log` — appended by `createLoggerSink()`, `appendLogLine()` and `appendRawBlock()`, all synchronous `fs.appendFileSync` with no guard of their own, all redacted before the write.
- `input/run-context.json`, `input/env.snapshot.yaml`, `input/env.json`, `input/tests/<testId>.yaml` + `.json`, and `input/suite.snapshot.yaml` + `input/suite.json` — written by `writeRunInputs`. A `.yaml` snapshot is copied only when the definition carries a `sourcePath`; without one no YAML lands and the record's `snapshotYamlPath` is `undefined`. `toDisplayPath` renders a path inside the workspace root as a workspace-relative posix path and anything outside it as the full posix path.
- `tests/<testId>/` — `actions/NNN.json`, `screenshots/NNN.jpg`, `recording<ext>`, `device.log`, `result.json`. `_ensureTestArtifactDirs` creates `actions/` and `screenshots/` for both the success and the synthetic-failure path.
- `summary.json` and `run.json` — written by `finalize`.

## Secret Redaction

Every value that reaches a file crosses `redactResolvedValue(value, bindings)` (exported from `@finalrun/common`, defined in its `repoPlaceholders.ts`), which rewrites a resolved secret value back to its `${secrets.<key>}` placeholder: runner-log lines, a test record's `message` and `analysis`, step JSON (action text and url, analysis, thought, trace and timing detail strings), the synthetic failure message, and the copied device log.

The environment snapshots carry reference forms only — `env.snapshot.yaml` mirrors the *config* `secrets` map (the `${ENV_VAR}` placeholder form) and `env.json` carries `secretReferences` (key plus env-var name). No resolved secret value is written anywhere beneath the run directory, and `reportWriter.test.ts` holds that as a whole-`runDir` sweep over every emitted file after a full lifecycle rather than as per-site assertions.

## Device Log Artifact Flow

The `_copyLogArtifact(testId, deviceLog, bindings)` private method handles device logs:

1. **Target path**: `path.posix.join('tests', testId, 'device.log')` relative to the run directory.
2. **Source validation**: `fsp.access(sourcePath)`; a missing source warns and returns `undefined` — no throw, no artifact. `_copyRecordingArtifact` behaves the same way, so a recording or log whose `filePath` points at a vanished file leaves the record field `undefined` instead of failing the run.
3. **Size guard**: warns if the raw file exceeds 50 MB (redaction holds the entire file in memory), but still proceeds.
4. **Copy**: `fsp.copyFile` from the source into the run directory.
5. **Copy-then-redact in place**: reads the copied file back, applies `redactResolvedValue(raw, bindings)`, and writes only if redaction actually changed the content. Any throw inside that read/redact/write step is caught, the copied file is unlinked and `undefined` is returned — an unredactable log is dropped rather than shipped partly redacted. *(That failure branch is a recorded coverage gap: reaching it needs a copy made unreadable mid-flow, which no `fs`-stub-free test can arrange.)*
6. **Returns** the relative path string for inclusion in `TestResult`.

The capture itself is produced device-side and never written into the run directory — see [/device-node/log-capture.md](/device-node/log-capture.md). This copy is the only route from the device tmpdir into the report.

## writeTestRecord Integration

In `writeTestRecord()`, `_copyLogArtifact` is called after `_copyRecordingArtifact` and before `_writeStepArtifacts`. Three fields are populated on the `TestResult`:
- `deviceLogFile` -- relative path (e.g., `tests/auth-login/device.log`)
- `deviceLogStartedAt` -- ISO 8601 timestamp from `DeviceLogCaptureResult`
- `deviceLogCompletedAt` -- ISO 8601 timestamp from `DeviceLogCaptureResult`

These fields are `undefined` when log capture was unavailable, failed to start, or produced no file. `status` comes from `resolveTestStatus` — `aborted` passes through unchanged, otherwise success/failure — and `durationMs` is clamped at 0.

`writeTestFailureRecord` emits the pre-execution failure record instead: a placeholder JPEG at `screenshots/001.jpg`, exactly one `run_failure` step at `actions/001.json` carrying the redacted message, and a `result.json` with `success: false`, `status: 'error'` and that single step.

## Manifest

`run.json` is written with `schemaVersion: 3`. `RunManifest.schemaVersion` is typed `2 | 3`, and both `reportViewModel.ts` and `runIndex.ts` accept exactly those two and throw on anything else, so a v2 report stays readable.

`_toRunManifestTest` enriches each `TestResult` from the snapshot `writeRunInputs` recorded — `workspaceSourcePath`, snapshot paths, `bindingReferences`, `authored`, `effectiveGoal` — falling back to the test name with empty authored arrays for a test that was never registered. Step counts derive from the record's own steps; `selectPreviewScreenshotPath` prefers the first failed step's screenshot and otherwise takes the first step that has one.

First-failure resolution has two levels, both order-sensitive:

- **Per test** (`findTestFirstFailure`) — the first non-successful step, whose `message` is `errorMessage ?? trace.failureReason ?? test.message`. All three rungs are load-bearing and pinned independently.
- **Per run** (`findRunFirstFailure`) — the first failed test's own `firstFailure`; else one synthesized from that test (`message`, `previewScreenshotPath`); else `diagnosticsSummary`; else absent.

## Design Decisions

### The output contract is the emitted bytes, not the returned record
**Decision**: Optional manifest and summary fields are assigned straight from their optional source — `run.failurePhase`, `run.diagnosticsSummary`, `run.firstFailure`, `paths.runContextJson`, a test's `analysis` — and `JSON.stringify` drops them when they are `undefined`, while `run-context.json`'s `reasoning`/`features` are spread in conditionally. Absence in the file is therefore part of the schema: giving one of these a default (`''`, `null`, `{}`) changes the emitted JSON even though nothing about the in-memory object reads differently. Tests assert key absence by parsing the written file.
**Why**: The report viewer and `runIndex` read these files, so the only shape that matters is what reaches disk. The returned `TestResult`/`RunSummary` still carries the undefined-valued keys that never get serialized, so an assertion on the return value cannot distinguish "omitted" from "present and undefined" — the one distinction a restructuring is most likely to lose while every existing test stays green.
**Rejected**: (a) asserting on the returned record — blind to exactly this difference; (b) conditional spreads at every optional site for symmetry with `run-context.json` — it restates at ten sites what one `JSON.stringify` rule already guarantees, and each spread is another branch against the complexity ceiling.
*Introduced by*: 260727-18tg-characterize-refactor-cli-giants

### `ReportWriter`'s instance fields are its cross-method contract, not split-introduced state
**Decision**: `_inputEnvironment`, `_inputSuite`, `_inputTests`, `_testSnapshots`, `_cliContext`, `_modelContext`, `_appContext`, `_runTarget` and `_runContextJsonPath` stay instance fields. The per-call-context rule in [/ci/pr-quality-gate.md](/ci/pr-quality-gate.md) governs state that a *phase split* introduces; these predate any split and exist to carry `writeRunInputs`/`setRunContext` data forward to a `finalize` call that happens much later on the same writer.
**Why**: Their lifetime *is* the writer's, which is the class's reason to exist — the manifest's `input` block and every snapshot-derived field in `_toRunManifestTest` come from data captured in an earlier call. Converting them to a per-call context would change what `finalize` can see, which is a design change rather than the behaviour-preserving extraction a characterization-backed refactor is allowed to make.
**Rejected**: Rewriting them into a context object for uniformity with `TestRunContext`/`GoalRunState` — the two rules answer different questions, and applying the newer one here would silently empty the manifest's input snapshot.
*Introduced by*: 260727-18tg-characterize-refactor-cli-giants
