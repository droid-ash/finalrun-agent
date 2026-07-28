---
type: memory
description: "report-web is a Vite React SPA + importable UI library; pure view-model/log/format/route logic under src/ui and src/ is pinned by characterization tests; the device-log viewer is DeviceLogPanel.tsx; manifest loading and the 500-line device-log tail read live in packages/cli/src/reportViewModel.ts"
---
# Report Rendering (report-web)

`packages/report-web` renders every local test report a user reads. It ships two builds from one
source tree: a Vite SPA (`dist/app`, copied into `packages/cli/dist/report-app/` and hosted by the
CLI report server, `packages/cli/src/reportServer.ts`) and a tsup library (`dist/ui`, `dist/routes`)
exported as `@finalrun/report-web/ui` and `@finalrun/report-web/routes` for downstream consumers.
Rendering is React components under `src/ui/components/` and `src/ui/pages/`; there is no
`renderers.ts` — the pure decision logic lives in dedicated DOM-free modules.

## Requirements

### Requirement: Pure logic modules are DOM-free and pinned by characterization tests
The decision layer MUST stay importable without a DOM: `src/ui/viewModel.ts` (run/test status
derivation via `classifyTestStatus` — `aborted` wins over `success`, a `run_failure` **first** step
turns a failed test into `error`; test-list joining; summary counting; report-title derivation;
artifact-path rewriting), `src/ui/logs.ts` (device-log timestamp/level parsing and
recording-start filtering), `src/ui/format.ts`, `src/ui/routes.ts`, `src/fetchers.ts`, and
`src/ui/icons.ts`. Their behaviour is pinned by mutation-verified characterization tests in
`src/ui/test/` and `src/test/` (run via the package's strict tsx runner — see
[/ci/pr-quality-gate.md](/ci/pr-quality-gate.md)).

#### Scenario: a silent misreport is caught by the pinned status derivation
- **GIVEN** a failed test whose first step has `actionType: 'run_failure'`
- **WHEN** `classifyTestStatus` is altered to report it as a plain `failure`
- **THEN** `src/ui/test/viewModel.test.ts` fails

### Requirement: Artifact references resolve run-scoped, with absolute URLs passed through
`toReportViewModel()` MUST rewrite every relative artifact reference (paths block, suite and
selected-test snapshots, per-test recording/device-log/preview/result/snapshot paths, per-step
screenshot/step-json, firstFailure paths) through `buildRunScopedArtifactPath(runId, path)` →
`/artifacts/<runId>/<encoded segments>`, and MUST pass absolute `http(s)://` (and
protocol-relative `//`) URLs through unchanged — cloud stores assets as absolute CDN/S3 URLs, and
encoding them into a local route breaks `<video>`/`<img>` loading. `buildArtifactRoute()`
(`src/ui/routes.ts`) throws on `.`/`..` traversal segments.

### Requirement: `artifacts.ts` stays a runtime-empty type barrel
`src/artifacts.ts` MUST export types only (`ReportIndexViewModel`, `ReportRunManifest`,
`ReportManifestTestRecord`, …) and carry zero runtime exports and no Node built-ins: it ships to
browsers via the UI library. The shapes are kept in lockstep with
`packages/cli/src/reportViewModel.ts`, where the runtime loaders live. The zero-runtime-export
contract is pinned by `src/test/artifacts.test.ts`.

## Device Log Viewer

`DeviceLogPanel.tsx` (`src/ui/components/`) renders the inline viewer when a test has a
`deviceLogFile`. `TestDetailSection.tsx` mounts it with `logText: test.deviceLogTailText ?? ''`.

- Structure: `<div class="device-log-inline">` carrying a search input, a match counter, level
  filter chips (All / Errors / Warnings wired to `handleLogFilter` from
  `src/ui/client/runDetailController.ts`), the parsed line list, and a
  `<a class="device-log-download" … download>Download full log</a>` link pointing at the
  run-scoped `deviceLogFile` route.
- Lines come from `parseDeviceLogLines(logText, recordingStartedAt)` (`src/ui/logs.ts`): empty
  input → no lines ("No log content available." placeholder); lines whose parsed timestamp
  (Android threadtime `MM-DD HH:MM:SS.mmm` with reference-year resolution, or iOS compact
  `YYYY-MM-DD HH:MM:SS.mmm`) predates `recordingStartedAt` are dropped; untimestamped lines are
  kept; levels map iOS `E`/`Ef`→error, `W`/`Wf`→warn and Android `F`/`E`→error, `W`→warn,
  everything else info.
- Search/keyboard behaviour (document-level listeners, Cmd+F capture) is attached by
  `runDetailController.ts` — DOM-dependent, untested (the follow-up's scope).

### Server-Side Tail Read

The tail read happens in `packages/cli/src/reportViewModel.ts` during manifest enrichment
(`enrichRunManifestRecord` → `readDeviceLogTail`):
- Reads the full device log artifact; splits on `\n` with a **500-line** cap
- Over the cap, returns `[… N lines truncated]` as the first line followed by the last 500 lines
- Result stored as `deviceLogTailText` on `ReportManifestTestRecord`

### Schema Version

`loadRunManifestRecord()` in `packages/cli/src/reportViewModel.ts` accepts manifest
`schemaVersion` `2` and `3` and throws on anything else. Version 2 manifests load without error;
device log fields are simply `undefined`.

## Design Decisions

### Test the DOM-free logic layer first, without a DOM environment
**Decision**: The characterization suite covers exactly the seven DOM-free modules (view model,
logs, format, routes, fetchers, icons, artifacts) through `node --test` + tsx, stubbing only the
process globals actually crossed (`globalThis.fetch`, `Date.now`, restored in `finally`).
Components and `runDetailController.ts` stay untested until a DOM test environment
(`jsdom`/`happy-dom`) is argued in its own change.
**Why**: The pure layer is where a silent misreport would originate — a wrong status or
misattributed failure is believed, which is worse than a crash — and it needs no new dependency.
A DOM environment is a testing-infrastructure decision, not a backfill.
**Rejected**: Bundling a DOM library into the backfill — mixes a dependency decision into a
tests-only change; testing through the React components — needs that same infrastructure to reach
logic that is directly importable today.
*Introduced by*: 260727-e5nk-backfill-report-web-logic-tests
