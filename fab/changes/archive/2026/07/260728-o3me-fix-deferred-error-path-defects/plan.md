# Plan: Fix Deferred Error-Path Defects

**Change**: 260728-o3me-fix-deferred-error-path-defects
**Intake**: `intake.md`

## Requirements

### device-node: SimctlClient `_trimmed` type safety

#### R1: `_trimmed` handles non-string values instead of throwing
`SimctlClient._trimmed` (`packages/device-node/src/infra/ios/SimctlClient.ts:550`) MUST return `undefined` for any non-string value instead of casting and calling `.trim()`. A non-string plist field (e.g. a numeric `CFBundleVersion`) SHALL degrade that one field to its existing fallback (`|| fallbackName`, `?? null`, the `com.apple.` prefix default) rather than aborting enumeration of the entire app list. The method's doc comment MUST be rewritten — its current rationale explains why the unsafe cast was *preserved*, which expires with this fix. **Test kind: regression** — the new test MUST fail on the pre-fix source and pass after.

- **GIVEN** `simctl listapps` output where one app record carries `CFBundleVersion: 771` (a number)
- **WHEN** `listInstalledApps` parses the records
- **THEN** the app is enumerated with `version: null` and every other app in the listing is returned normally
- **AND** no `TypeError: value?.trim is not a function` escapes into the command result

### device-node: bounded diagnostic buffers

#### R2: `_spawnScrcpy` output buffers are bounded
The `stdoutChunks`/`stderrChunks` arrays in `AndroidRecordingProvider._spawnScrcpy` (`packages/device-node/src/device/AndroidRecordingProvider.ts:232-249`) MUST be bounded using the in-repo ring idiom (`push`, then `shift()` when length exceeds the cap — see `AndroidDeviceSetup.ts:245`): retain the most recent N chunks, drop the oldest. **Test kind: regression** — drive more than N chunks through a stubbed child process and assert the retained length is capped and the retained content is the tail.

- **GIVEN** a scrcpy child process that emits more than the bound's worth of stderr chunks and then exits during the startup window
- **WHEN** `_formatStartupExit` composes the failure detail
- **THEN** the detail contains only the most recent N chunks (the tail), not the earliest ones

#### R3: `_spawnEmulatorWithCapture` output buffers are bounded
The `capture.stdoutChunks`/`capture.stderrChunks` arrays in `DeviceDiscoveryService._spawnEmulatorWithCapture` (`packages/device-node/src/discovery/DeviceDiscoveryService.ts:611-619`) MUST be bounded with the same ring idiom. **Test kind: regression** — same shape as R2, observed through the `CommandTranscript` on the startup diagnostic.

- **GIVEN** a detached emulator child that emits more than the bound's worth of output chunks and a startup that fails or times out
- **WHEN** `_emulatorTranscript` builds the `CommandTranscript`
- **THEN** the transcript carries only the most recent N chunks

> **Extended during review.** The buffer has **three** writers, not two: the `once('error')` handler also pushes `error.message`. The first pass capped only the two stream handlers, leaving the third able to take the buffer to N+1 — bounded (the listener is `once`) but inconsistent with the method's own doc comment calling the buffers a bounded ring. All three push sites MUST honour the cap.

- **GIVEN** exactly N chunks already buffered — the cap reached with nothing yet dropped — and the child then emitting `error`
- **WHEN** the `once('error')` handler pushes the error message
- **THEN** the message is retained, the oldest chunk is evicted, and the buffer stays at N

#### R4: The bound is shared; a push helper is extracted only on a measured diff
Fixes R2 and R3 MUST share a single named bound constant (no magic number duplicated across the two sites). A shared *push helper* MUST only be extracted if a measured diff of the two accumulator bodies shows they are identical (per the mirror rule from change #160, `docs/memory/device-node/android-ios-mirror.md`): the two sites have different shapes — one closes over local arrays and logs each chunk, the other mutates a `capture` object field silently — so a forced helper to satisfy DRY is prohibited. Any shared module MUST be a single-purpose, zero-import leaf at the nearest common parent of its call sites and MUST stay out of the package barrel.

- **GIVEN** the two `on('data')` accumulator bodies in `AndroidRecordingProvider.ts` and `DeviceDiscoveryService.ts`
- **WHEN** the bodies are diffed against each other
- **THEN** the bound constant is shared, and the push logic is shared only if the diff is empty modulo the array reference; otherwise each site keeps its own push-and-cap statements

### cli: sessionRunner

#### R5: Platform derivation delegates to `DeviceInfo.getPlatform()`
`packages/cli/src/sessionRunner.ts:202` MUST use `deviceInfo.getPlatform()` instead of re-deriving `deviceInfo.isAndroid ? PLATFORM_ANDROID : 'ios'` (which also hardcodes the bare `'ios'` string where the model uses `PLATFORM_IOS`). This is **behaviour-preserving**: `PLATFORM_IOS === 'ios'` (`packages/common/src/constants.ts:8`). **Test kind: characterization** — the test MUST pass on the pre-edit source AND after the edit; a fails-before test is impossible here and MUST NOT be fabricated.

- **GIVEN** a prepared session for an Android device and one for an iOS device
- **WHEN** `establishDeviceSession` derives the session platform
- **THEN** the Android session's platform is `'android'` and the iOS session's platform is `'ios'`, both before and after the edit

#### R6: `adbPath` is guarded, not asserted away
`installAppOverride`'s Android branch (`packages/cli/src/sessionRunner.ts:332`) MUST throw a descriptive `Error` when `params.adbPath` is nullish, in the same shape and voice as the adjacent device-serial guard (`'Android device serial is required to install an app override.'`), and the `params.adbPath!` non-null assertion MUST be removed. **Test kind: regression** — invoking the app-override install path with a null `adbPath` MUST produce the descriptive error after the fix and does not before.

- **GIVEN** `prepareTestSession` with `appOverridePath` set, an Android device selected, and `getADBPath()` resolving to `null`
- **WHEN** the app-override install path runs
- **THEN** a descriptive `Error` is thrown instead of passing `null` (silenced by `!`) into `installAndroidApp`

### cloud-core: submit pipeline

#### R7: The timeout parser matches its own error message
`parseSubmitTimeoutMs` (`packages/cloud-core/src/submit.ts:59-68`) MUST additionally require `Number.isInteger(parsed)`, so the guard matches the message's promise of "a positive integer (milliseconds)". The narrowing rejects fractional *values* only: `'1e3'` and `'0x10'` denote the integers `1000` and `16` and MUST continue to be accepted — the check tests the parsed value, never the literal's spelling; a string-format regex is prohibited. **Test kind: regression by conversion** — the existing characterization assertion for `'1.5'` (`packages/cloud-core/src/test/submit.test.ts:582-588`) MUST be converted to `assert.throws(reload, /Invalid FINALRUN_SUBMIT_TIMEOUT_MS/)` with its comment rewritten (NOT deleted), and `'1e3'` (and `'0x10'`) MUST be added to the accepted set so the narrowing is pinned in both directions.

- **GIVEN** `FINALRUN_SUBMIT_TIMEOUT_MS='1.5'`
- **WHEN** the module is (re)loaded
- **THEN** it throws `Invalid FINALRUN_SUBMIT_TIMEOUT_MS…`
- **AND** `'1e3'` and `'0x10'` overrides load without throwing, before and after the fix

#### R8: The acquisition-side temp-zip window is closed
`zipAppBundle` (`packages/cloud-core/src/appBundle.ts`) MUST open its cleanup scope **before** `zip.writeZip(zipPath)`, not after it: any throw before the `return` SHALL unlink the temp zip (cleanup errors ignored, per the existing `submit.ts` idiom) and rethrow the original error. The success path continues to return the path — the caller owns cleanup when `isTempZip` is true. **Test kind: regression** (two windows, two tests).

> **Corrected during review.** This requirement originally said the scope opens *after* `writeZip`, inheriting an error from the intake that treated `writeZip` as atomic. It is not: adm-zip's `writeFileTo` does `openSync(path,'w')` → `writeSync` → `closeSync` → `chmodSync` (`node_modules/adm-zip/util/utils.js:65-95`), so the file exists from the `openSync` onward and a throw from any later step leaves it behind — where a scope opening after the call can never see it. Widening the scope is behaviour-neutral on success, and unlinking a never-created path is already swallowed.

- **GIVEN** a `.app` directory input and an `fs.statSync` that throws after the zip is written
- **WHEN** `prepareAppForUpload` runs
- **THEN** the original error propagates and no `finalrun-app-*.zip` is left in `os.tmpdir()`

- **GIVEN** a `.app` directory input and an `fs.chmodSync` that throws for the output path — the final step of adm-zip's write, so the zip is complete and closed by then
- **WHEN** `prepareAppForUpload` runs
- **THEN** the original error propagates and no `finalrun-app-*.zip` is left in `os.tmpdir()`

### Non-Goals

- `AndroidDeviceSetup` / `IOSSimulatorSetup` `appendLog` — already bounded (cap 20, `shift()`); they are the source of the idiom, not targets
- `IOSRecordingProvider` — accumulates nothing; the asymmetry with Android is verified-correct (no startup-diagnostic consumer). Do not "fix" it
- `AndroidLogcatProvider` / `IOSLogProvider` stderr handlers — log-capture lifecycle, not this queue
- No refactoring — function-length/depth/complexity work is finished for these files; touch only what each fix requires
- The `ci` memory-domain split — stays queued as a separate `/docs-reorg-memory` job

## Tasks

### Phase 1: device-node fixes (test-first, fails-before demonstrated)

- [x] T001 Add regression test to `packages/device-node/src/infra/ios/test/SimctlClient.test.ts`: listing with one numeric `CFBundleVersion` record yields that app with `version: null` and keeps every other app; run against the unfixed source and record the FAIL <!-- R1 -->
- [x] T002 Fix `_trimmed` in `packages/device-node/src/infra/ios/SimctlClient.ts` (`typeof value === 'string' ? value.trim() : undefined`) and rewrite its doc comment; rebuild and record T001's test passing <!-- R1 -->
- [x] T003 Measure the diff between the two `on('data')` accumulator bodies (AndroidRecordingProvider vs DeviceDiscoveryService); record the result; introduce the shared bound constant as a zero-import leaf module at `packages/device-node/src/` (the call sites' nearest common parent), not exported from the barrel <!-- R4 -->
- [x] T004 Add regression test to `packages/device-node/src/device/test/AndroidRecordingProvider.test.ts`: >20 stderr chunks then startup exit — failure detail carries only the tail; record the FAIL before the fix <!-- R2 -->
- [x] T005 Bound both chunk arrays in `_spawnScrcpy` (`packages/device-node/src/device/AndroidRecordingProvider.ts`) with the ring idiom + shared constant; record T004's test passing <!-- R2 -->
- [x] T006 Add regression test to `packages/device-node/src/discovery/test/DeviceDiscoveryService.test.ts`: emulator start emitting >20 chunks then failing — diagnostic transcript carries only the tail; record the FAIL before the fix <!-- R3 -->
- [x] T007 Bound both capture arrays in `_spawnEmulatorWithCapture` (`packages/device-node/src/discovery/DeviceDiscoveryService.ts`) with the ring idiom + shared constant; record T006's test passing <!-- R3 -->

### Phase 2: cli fixes

- [x] T008 Add characterization test to `packages/cli/src/test/sessionRunner.test.ts` asserting session platform is `'android'` for an Android device and `'ios'` for an iOS device; run against the UNMODIFIED source and record the PASS <!-- R5 -->
- [x] T009 Replace `packages/cli/src/sessionRunner.ts:202` with `const platform = deviceInfo.getPlatform();`; record T008's test still passing <!-- R5 -->
- [x] T010 Add regression test to `packages/cli/src/test/sessionRunner.test.ts`: Android app-override install with `getADBPath()` returning `null` rejects with the new descriptive error; record the FAIL before the fix <!-- R6 -->
- [x] T011 Add the `adbPath` guard to `installAppOverride`'s Android branch in `packages/cli/src/sessionRunner.ts` (same shape/voice as the device-serial guard) and drop the `!`; record T010's test passing <!-- R6 -->

### Phase 3: cloud-core fixes

- [x] T012 Convert the `'1.5'` `assert.doesNotThrow` in `packages/cloud-core/src/test/submit.test.ts:582-588` to `assert.throws(reload, /Invalid FINALRUN_SUBMIT_TIMEOUT_MS/)`, rewrite the comment (do not delete), and add `'1e3'` and `'0x10'` to the accepted set; record the converted assertion FAILING before the source fix and the accepted-set additions passing before it <!-- R7 -->
- [x] T013 Narrow the guard in `parseSubmitTimeoutMs` (`packages/cloud-core/src/submit.ts`) to require an integer value (no string-format regex); record T012's test passing <!-- R7 -->
- [x] T014 Add regression test to `packages/cloud-core/src/test/submit.test.ts`: `prepareAppForUpload` on a `.app` directory with `fs.statSync` stubbed to throw leaves `tempZipArtifacts()` unchanged and propagates the error; record the FAIL before the fix <!-- R8 -->
- [x] T015 Open the cleanup scope immediately after `zip.writeZip(zipPath)` in `packages/cloud-core/src/appBundle.ts` (catch → `unlinkSync` with ignored cleanup errors → rethrow); record T014's test passing <!-- R8 -->

### Phase 4: Full gate

- [x] T016 Run the full gate: `npm test` (all workspaces), `npm run lint`, `npm run typecheck`, `npm run build --workspaces`. Confirm: 0 test failures with ≥460 tests and exit 0; exactly 78 warnings / 0 errors (zero new); `max-depth` and `no-unused-vars` both at zero; typecheck and build exit 0 <!-- R1 R2 R3 R4 R5 R6 R7 R8 -->

### Phase 5: Review-driven corrections

Both items came from the review's should-fix list; neither was a failing test or a requirements mismatch, so the verdict stood at pass and these were applied on top rather than through a rework cycle.

- [x] T017 Add regression test to `packages/device-node/src/discovery/test/DeviceDiscoveryService.test.ts`: drive exactly `MAX_DIAGNOSTIC_OUTPUT_CHUNKS` stderr chunks, then emit `error`; assert the message is retained and the oldest chunk evicted. Record the FAIL before the fix <!-- R3 -->
- [x] T018 Cap the `once('error')` push site in `DeviceDiscoveryService._spawnEmulatorWithCapture` with the same shape as the two stream handlers <!-- R3 -->
- [x] T019 Add regression test to `packages/cloud-core/src/test/submit.test.ts`: stub `fs.chmodSync` (adm-zip's final write step) to throw for `finalrun-app-*` and assert `tempZipArtifacts()` is unchanged. Record the FAIL before the fix <!-- R8 -->
- [x] T020 Move `zip.writeZip(zipPath)` inside the cleanup scope in `packages/cloud-core/src/appBundle.ts`, and correct the comment that described the acquisition as atomic <!-- R8 -->
- [x] T021 Re-run the full gate after Phase 5 <!-- R1 R2 R3 R4 R5 R6 R7 R8 -->

## Execution Order

- Within each fix pair, the test task precedes its source-fix task (that ordering is what demonstrates fails-before for regression tests, and passes-before for the R5 characterization test)
- T003 blocks T005 and T007 (both consume the shared bound constant and the measured-diff decision)
- T016 runs last

## Acceptance

### Functional Completeness

- [x] A-001 R1: `_trimmed` returns `undefined` for non-string values; its doc comment no longer explains a preserved unsafe cast — *verified*: verified `SimctlClient.ts:546-548`; doc comment `:533-545` rewritten — no preserved-cast rationale remains
- [x] A-002 R2: `_spawnScrcpy`'s stdout and stderr buffers are capped via the ring idiom, retaining the most recent chunks — *verified*: verified `AndroidRecordingProvider.ts:246-260`
- [x] A-003 R3: `_spawnEmulatorWithCapture`'s capture buffers are capped the same way — *verified*: verified `DeviceDiscoveryService.ts:618-629`
- [x] A-004 R4: one shared named bound constant is used by both sites; no push helper was extracted without a measured-diff justification, and the measurement result is recorded — *verified*: one constant `MAX_DIAGNOSTIC_OUTPUT_CHUNKS` (`diagnosticBuffer.ts:19`), 5 call sites (Android stdout/stderr; emulator stdout/stderr and the `once('error')` handler), no barrel export; measurement recorded at `diagnosticBuffer.ts:12-16`
- [x] A-005 R5: `sessionRunner.ts` derives platform via `deviceInfo.getPlatform()`; the duplicated ternary and bare `'ios'` literal are gone — *verified*: verified `sessionRunner.ts:202`; `PLATFORM_ANDROID` still used at :327/:397/:812/:955/:985 so the import is not orphaned
- [x] A-006 R6: the Android install branch guards `adbPath` with a descriptive error mirroring the sibling guard; the `!` assertion is removed — *verified*: verified `sessionRunner.ts:331-333`, `!` removed at :335
- [x] A-007 R7: `parseSubmitTimeoutMs` rejects fractional values via `Number.isInteger` on the parsed value; no string-format regex was added — *verified*: verified `submit.ts:63`; no regex added
- [x] A-008 R8: a throw between `writeZip` and `return` unlinks the temp zip and rethrows the original error — *verified*: verified `appBundle.ts:99-118`; reviewer re-derived the orphan empirically

### Behavioral Correctness

- [x] A-009 R1: the regression test demonstrably failed on the pre-fix source and passes after — *verified*: reviewer re-derived: reverting `_trimmed` makes the listing return `[]` and the test fails (device-node 91/94)
- [x] A-010 R2: the buffer-bound regression test demonstrably failed before and passes after, and asserts tail retention — *verified*: reviewer re-derived: reverting the two `shift()` guards fails the test with `chunk01..chunk25` all retained
- [x] A-011 R3: same demonstrated fails-before/passes-after for the emulator capture bound — *verified*: reviewer re-derived: reverting the capture guards fails the transcript tail assertions
- [x] A-012 R5: the characterization test passed on the UNMODIFIED source and still passes after the edit — *verified*: reviewer re-derived: pristine `sessionRunner.ts` (both cli fixes reverted) — the platform test PASSES, only the adbPath test fails
- [x] A-013 R6: the adbPath-guard regression test demonstrably failed before and passes after — *verified*: reviewer re-derived: restoring `params.adbPath!` fails the test (cli 151/152)
- [x] A-014 R7: the converted `'1.5'` assertion failed before the source fix and passes after; `'1e3'` and `'0x10'` are accepted both before and after — *verified*: reviewer re-derived: with `Number.isFinite` restored the `1.5` assertion fails with "Missing expected exception"; the `60000`/`1e3`/`0x10` loop passed BEFORE the fix and passes after
- [x] A-015 R8: the temp-zip regression test demonstrably failed before and passes after — *verified*: reviewer re-derived: pristine `appBundle.ts` leaves exactly one extra `finalrun-app-*.zip` in `os.tmpdir()`

### Scenario Coverage

- [x] A-016 R1: one malformed plist field degrades only that field — the rest of the app listing still enumerates — *verified*: pre-fix the whole listing collapsed to `[]`; post-fix both apps enumerate with `version: null` on the malformed one
- [x] A-017 R7: the test comment still explains the message/parser contract (rewritten, not deleted), and the accepted set pins integral-value spellings — *verified*: verified `submit.test.ts:612-623`

### Edge Cases & Error Handling

- [x] A-018 R8: cleanup failure in the new catch is itself swallowed (ignore-cleanup-errors idiom) and the original error propagates unchanged — *verified*: verified `appBundle.ts:111-117`
- [x] A-019 R6: the error message names the missing precondition (adb) in the same voice as the device-serial guard — *verified*: verified: 'adb path is required to install an Android app override.'
- [x] A-024 R8: a throw from *inside* `writeZip`, after the file exists but before the call returns, leaves no orphan — *verified*: fails-before re-derived by moving `writeZip` back outside the scope — cloud-core exit 1, `fail 1`, the failing test being exactly the new one; restored → exit 0, `pass 21 / fail 0`
- [x] A-025 R3: the `once('error')` push honours the cap like the two stream handlers, retaining the error message and evicting the oldest chunk — *verified*: fails-before re-derived by removing the cap — device-node exit 1, `fail 1`, only the new test failing; restored byte-identical → exit 0, `pass 95 / fail 0`

### Code Quality

- [x] A-020 Pattern consistency: new code follows the naming and structural patterns of surrounding code (ring idiom shape, guard shape, unlink idiom) — *verified*: ring idiom, guard shape and unlink idiom all match their in-repo precedents
- [x] A-021 No unnecessary duplication: `getPlatform()` reused instead of re-derived; the bound constant shared instead of duplicated; no forced helper — *verified*: verified — see A-004/A-005
- [x] A-022 No magic numbers: the retention bound is a named constant — *verified*: verified `diagnosticBuffer.ts:19`
- [x] A-023 Gate: zero new lint warnings (78 baseline), 0 errors, `max-depth` and `no-unused-vars` at zero, full suite green, typecheck and build exit 0 — *verified*: observed: build exit 0, typecheck exit 0, test exit 0 with 466 tests / 466 pass / 0 fail, lint exit 0 with 78 warnings / 0 errors, `max-depth` and `no-unused-vars` both 0

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `packages/cloud-core/src/test/submit.test.ts:612-618` — the former "Characterization, not endorsement" comment block was the only thing keeping the message/parser mismatch documented; it was correctly rewritten rather than deleted, and no other code became redundant. Recorded so the question is answered explicitly.
- **No true deletions.** Every fix is local and additive on an error path: `PLATFORM_ANDROID` remains used at `sessionRunner.ts:327/397/812/955/985` after the `getPlatform()` delegation, the `!`-removal leaves no orphaned type, and `lint` reports zero `no-unused-vars`. Nothing became unreachable.
- *Consolidation (not deletion) candidate, deferred by design*: the push-and-cap statement pair is now written five times (`AndroidRecordingProvider.ts:246-250,254-258`; `DeviceDiscoveryService.ts:618-623,624-629,630-640` — the last is the emulator `once('error')` handler). R4's measured-diff test is applied at accumulator-body granularity and correctly rejects a shared helper there, but a `pushBounded(buffer, chunk)` leaf beside the constant would collapse all five. Left for a future change rather than forced here.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | R2/R3 regression tests observe the bound through public seams (startup-failure message detail; startup-diagnostic transcript) rather than reaching into private fields | Both consumers join the retained chunks into user-visible text, so the cap and tail-retention are observable behaviour; private-field access would couple tests to structure | S:65 R:85 A:80 D:70 |
| 2 | Confident | The shared bound constant lives in a new zero-import leaf module at `packages/device-node/src/` root, not exported from the barrel | The mirror rule requires shared code at the nearest common parent of its call sites (`device/` and `discovery/` → `src/`), single-purpose, out of the barrel | S:60 R:85 A:80 D:65 |
| 3 | Confident | Fix 6 error message: `'adb path is required to install an Android app override.'` | Mirrors the sibling guard's shape/voice (`'Android device serial is required to install an app override.'`); repo prose refers to adb in lowercase | S:60 R:90 A:80 D:70 |
| 4 | Confident | Fix 7 uses catch → `unlinkSync` (ignored cleanup errors) → rethrow, not `finally` | The success path must NOT unlink — the caller owns cleanup when `isTempZip` is true — so an unconditional `finally` is wrong here; the catch mirrors `submit.ts`'s ignore-cleanup-errors unlink idiom | S:70 R:85 A:85 D:75 |
| 5 | Confident | The narrowed guard is `!Number.isInteger(parsed) \|\| parsed <= 0` | `Number.isInteger` subsumes `Number.isFinite` (NaN/±Infinity are not integers), so the combined check covers every previously rejected input plus fractional values, with no redundant clause | S:75 R:90 A:90 D:80 |
| 6 | Certain | `'0x10'` is added to the accepted set alongside the required `'1e3'` | Intake correction 3 names both spellings as MUST-keep-working; pinning both directions of the narrowing is exactly the converted test's job | S:80 R:90 A:90 D:85 |

6 assumptions (1 certain, 5 confident, 0 tentative).
