# Intake: Batched Refactor of `device-node` — 23 Warnings

**Change**: 260727-6z9b-batch-refactor-device-node
**Created**: 2026-07-27

## Origin

Tenth change in the code-quality initiative, and the **second batched refactor** — applying the
method established by `260726-fnwt-batch-refactor-goal-executor` (PR #159, merged `7b453e8`), which
cleared 19 warnings in one change after the preceding six had cleared ~4.5 apiece.

That change's lesson is now recorded in `docs/memory/ci/pr-quality-gate.md` as a Design Decision: a
refactor's unit of work is **one package's tested functions**, not one or two of them, because
per-change pipeline cost is fixed and — the second-order reason — cross-sibling duplication is only
visible with the whole family in scope at once. This change is that DD's second application.

> User direction: "start next".

**Package selected by measurement.** `device-node` carries **29 source warnings**, the largest
remaining concentration, and has 91 tests. Mapping each warning-carrying file to its test file gives
a clean split:

| File | Warnings | Tests |
|------|----------|-------|
| `discovery/DeviceDiscoveryService.ts` | **8** | 6 |
| `infra/android/AdbClient.ts` | 4 | 15 |
| `infra/ios/SimctlClient.ts` | 3 | 10 |
| `device/ScreenshotCapture.ts` | 2 | 4 |
| `device/RecordingManager.ts` | 2 | 5 |
| `device/Device.ts` | 2 | 5 |
| `grpc/GrpcDriverSetup.ts` | 1 | 11 |
| `device/AndroidRecordingProvider.ts` | 1 | 5 |
| **In scope** | **23** | **61** |
| `grpc/setup/IOSSimulatorSetup.ts` | 2 | **none** |
| `device/LogCaptureManager.ts` | 2 | **none** |
| `grpc/setup/AndroidDeviceSetup.ts` | 1 | **none** |
| `device/AndroidLogcatProvider.ts` | 1 | **none** |
| **Excluded** | **6** | — |

## Why

**Problem.** 23 warnings sit in the package that drives every physical interaction with a device —
discovery, adb, simctl, screenshots, recording, gRPC setup. These are the functions a contributor
must read to change device behaviour, and several are among the longest left in the repo
(`_probeIOSSimulators` 137 lines, `_probeAndroidConnected` 125, `RecordingManager.startRecording` 89).

**Consequence if not fixed.** 112 warnings remain overall, of which 77 are in source; this batch is
the single largest remaining tranche. The rules cannot be promoted from `warn` to `error` — the
initiative's endpoint — while any source violation stands.

**One risk this batch has that #159 did not, stated plainly.** In `goal-executor` the coverage was
generous (15 and 32 tests for two files). Here it is thinner and unevenly distributed: the file with
by far the **most** warnings, `DeviceDiscoveryService.ts` (8), has the **fewest tests relative to its
size** (6). `ScreenshotCapture.ts` has 4 tests for two 70+ line functions. Test count alone is a
weaker safety net than last time, so the **differential-harness technique is not optional here** —
see What Changes §4. That technique does not depend on coverage at all: it compares the pre-change
and post-change functions directly over shared mocks, so it is strongest exactly where tests are
thinnest.

## What Changes

### 1. `discovery/DeviceDiscoveryService.ts` — 8 warnings, 5 functions

| Line | Function | Lines | Complexity too? |
|------|----------|-------|-----------------|
| 75 | `constructor` | — | ✅ (complexity only) |
| 159 | `_probeAndroidConnected` | 125 | ✅ |
| 293 | `_probeAndroidTargets` | 75 | |
| 376 | `_probeIOSSimulators` | 137 | ✅ |
| 547 | `_startAndroidEmulator` | 80 | |
| 636 | `_waitForStartableEntry` | — | ✅ (complexity only) |

**Read the three `_probe*` methods together first.** They are the same operation per platform —
enumerate candidates, filter to ready ones, map to a `ProbeResult`. That is a sibling family in the
sense of PR #159, and the shared shape is where most of the 8 warnings will fall. As before: factor only
what is genuinely common, and leave a platform difference its own path rather than forcing it
through a shared abstraction.

### 2. `infra/android/AdbClient.ts` (4) and `infra/ios/SimctlClient.ts` (3) — 7 warnings

| File:line | Function | Lines | Complexity too? |
|-----------|----------|-------|-----------------|
| `AdbClient.ts:708` | `toggleAirplaneMode` | 61 | |
| `AdbClient.ts:835` | `togglePermissions` | 72 | ✅ |
| `AdbClient.ts:1058` | `_toFailureResult` | — | ✅ |
| `SimctlClient.ts:455` | `_listInstalledAppMetadata` | — | ✅ |
| `SimctlClient.ts:574` | `_applyApplesimutilsPermissions` | 69 | |
| `SimctlClient.ts:713` | `_toFailureResult` | — | ✅ |

**Note the cross-file duplicate: `_toFailureResult` exists in both, both flagged for complexity.**
This is the android/ios mirror flagged in the initiative's original assessment as the repo's one
structural DRY opportunity. **Investigate whether the two are genuinely the same function.** If they
are, a single shared helper serves principle 2 directly and clears two warnings at once.

**But do not force it.** The original assessment also warned this mirror is a YAGNI trap: the two
platforms are genuinely different, and a shared abstraction imposed on incidentally-similar code is
worse than the duplication. Compare them honestly, extract only if the logic is the same, and if it
is not, say so and fix them independently. A shared helper must live somewhere sensible — do not
create a cross-package dependency or a grab-bag utility module for it.

### 3. Remaining files — 8 warnings, 7 functions

`device/Device.ts:82` `executeAction` (71L + complexity) · `device/RecordingManager.ts:76`
`startRecording` (89L) and `:175` `stopRecording` (70L) · `device/ScreenshotCapture.ts:247`
`_captureWithRetry` (72L) and `:326` `_waitForStableScreen` (77L) ·
`device/AndroidRecordingProvider.ts:70` `startRecordingProcess` (82L) ·
`grpc/GrpcDriverSetup.ts:171` `_connectWithPolling` (complexity).

These are largely independent; treat them as ordinary extractions unless a shared shape emerges.

### 4. Verification obligation — differential harnesses are REQUIRED here

The memory DD records that a batched refactor's equivalence claim is proved by a differential
harness: compile the pre-change version alongside the refactored one, run both over identical mocks,
and diff the full returned value, any accumulated arrays, the captured log stream, and the external
call sequence — with **negative controls** proving the harness detects the regression classes at
risk.

In #159 that was strong practice. **Here it is the primary safety net**, because coverage is thin
relative to the change surface (§Why). Harnesses are throwaway — not committed, and no test file may
be edited. At minimum cover: the three `_probe*` methods, both `_toFailureResult` implementations
(before and after any sharing), `Device.executeAction`, and `RecordingManager.startRecording`.

### 5. Binding constraints (from the recorded Design Decisions)

- **Every extracted helper MUST itself be ≤60 lines and complexity ≤12.** Net count MUST fall by ~23.
- **Per-call local context objects** for accumulating state — never new instance fields or
  module-level mutable state.
- **Phase-outcome union** where early-exit control must stay visible; variants are per-orchestrator
  (a `continue` variant where the caller has nothing to continue is dead surface).
- **`finally` scope follows the acquisition**, every acquisition independently. This package spawns
  processes and holds device handles — if any refactored function acquires a resource, its release
  must sit in a `finally` whose `try` opens immediately after the acquisition.
- **`max-depth` and `no-unused-vars` MUST stay at ZERO** tree-wide.
- **Refactor incrementally**, running `npm run test --workspace=@finalrun/device-node` after each
  function, so a break localises to the step that caused it.
- **NO test file may change.** A required edit is evidence of behaviour change, not a chore.

### Out of scope

- The four **untested** files (6 warnings): `IOSSimulatorSetup.ts`, `LogCaptureManager.ts`,
  `AndroidDeviceSetup.ts`, `AndroidLogcatProvider.ts`. They need the characterization route first.
- Every warning outside `device-node`; the 35 test-file warnings.
- Promoting rules from `warn` to `error`; `report-web` backfill; Dependabot; the two dead constructs
  recorded in #159; `GrounderResponseConverter` characterization; splitting the `ci` memory domain.
- **Any behaviour change.** Pure restructuring.

## Affected Memory

Verify, do not assume. `docs/memory/device-node/log-capture.md` documents `LogCaptureManager`'s
public surface — that file is **excluded** from this change, so it should be unaffected, but confirm.
Hydrate MUST grep `docs/memory/**` for the refactored function names, the `_probe*` family, and any
description of the discovery / recording / screenshot sequences. If a memory file describes the
internal structure of a refactored function, that IS a required update.

If the `_toFailureResult` sharing lands, consider whether the android/ios mirror — long noted as this
repo's structural DRY question — now has a recorded answer worth capturing.

## Impact

- **Modified**: the 8 in-scope source files. **No test file should change.**
- **Expected diff**: large but structural — comparable to #159 (~900 lines reorganised), spread
  across more files but with smaller per-file surface.
- **Risk**: **higher than #159 despite similar volume**, because coverage is thinner and unevenly
  distributed, and because this package drives real device I/O (process spawning, adb/simctl
  invocation) that tests necessarily mock. The differential harnesses in §4 are the mitigation, along
  with per-function incremental verification.
- **Expected outcome**: warnings **112 → ~89** (23 cleared); tests **368 unchanged, 0 fail, no test
  file edited**; `max-depth` and `no-unused-vars` still zero; 0 errors.

## Open Questions

- If the two `_toFailureResult` implementations differ materially, is clearing them independently
  acceptable? (Yes — Assumptions #4: an honest split beats a forced abstraction.)
- Where would a shared android/ios helper live? (Deliberately unspecified — it depends on whether
  the sharing is warranted at all; see Assumptions #4.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Batch `device-node`'s tested files in one change | The recorded batching DD's second application; 23 warnings is the largest remaining tranche | S:90 R:80 A:90 D:90 |
| 2 | Certain | Exclude the four untested files (6 warnings) | Same rule that excluded `GrounderResponseConverter` from #159 — restructuring untested code is what this initiative has avoided since #154 | S:90 R:85 A:95 D:95 |
| 3 | Confident | Read the three `_probe*` methods as a family before extracting | Same-operation-per-platform; #159 showed cross-sibling duplication is only visible with the family in scope, and this is where most of the 8 warnings sit | S:75 R:75 A:85 D:75 |
| 4 | Confident | Investigate sharing the duplicated `_toFailureResult`, but do not force it | It is the repo's one long-noted structural DRY opportunity; equally it is the original assessment's named YAGNI trap. Compare honestly; if the logic differs, fix independently and say so | S:70 R:70 A:80 D:65 |
| 5 | Certain | Differential harnesses are REQUIRED, not optional | Coverage is thin relative to surface — the 8-warning file has 6 tests. The technique is independent of coverage, so it is strongest exactly where tests are weakest | S:85 R:75 A:90 D:90 |
| 6 | Certain | Every extracted helper ≤60 lines and ≤12 complexity; net count MUST fall | Recorded DD; otherwise the refactor relocates warnings rather than clearing them | S:90 R:85 A:95 D:90 |
| 7 | Certain | Refactor incrementally with per-function test runs | 18 functions across 8 files — more files than #159, so localising a break matters more, not less | S:85 R:80 A:90 D:85 |
| 8 | Certain | No test file may change | Behaviour-preserving refactor; a required test edit is evidence of behaviour change (constitution's Test Integrity principle) | S:90 R:80 A:90 D:90 |
| 9 | Certain | `finally` scope follows the acquisition, every acquisition | This package spawns processes and holds device handles; two bugs in this initiative came from violating this rule | S:85 R:75 A:90 D:90 |
| 10 | Confident | Hydrate must actively verify memory | `device-node` has its own memory domain; the excluded `LogCaptureManager` is documented there, so proximity alone warrants a check | S:75 R:85 A:85 D:80 |

10 assumptions (7 certain, 3 confident, 0 tentative, 0 unresolved).
