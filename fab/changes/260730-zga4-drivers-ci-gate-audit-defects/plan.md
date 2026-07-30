# Plan: Drivers CI Compile Gate + Audit Defect Fixes

**Change**: 260730-zga4-drivers-ci-gate-audit-defects
**Intake**: `intake.md`

## Requirements

> **Verification asymmetry — stated up front, not papered over.** The TypeScript
> defects (R9–R15) each carry a real regression test that fails against the
> unfixed source. The native defects (R4–R8, in Kotlin and Swift) carry **none**,
> and this change does not create a harness for them: `drivers/android/app/src/androidTest/`
> *is* the driver (a single `@Test` starts a gRPC server and blocks forever; zero
> assertions in the tree), the only file under `app/src/test/` is an
> `assertEquals(4, 2+2)` scaffold, and iOS has no test target at all. The new
> compile gate (R1) is the **only** automated verification those five fixes get —
> it proves they compile and link, never that a tap now lands in the right place.
> Behavioural confirmation needs a manual device session, which is out of scope.
> This is a stated, accepted limitation (intake assumption 14, carried below as
> assumption 13), not an oversight.

### CI: Drivers compile gate

#### R1: Both native drivers MUST compile on every pull request
A workflow at `.github/workflows/drivers.yml` MUST build the Android driver
(debug + androidTest APK pair) and the iOS driver (`build-for-testing`) on every
`pull_request` targeting `main` and on `push` to `main`. It MUST invoke the
existing `scripts/build-drivers-android.sh` and `scripts/build-drivers-ios.sh`
rather than restating their build commands. The iOS job MUST run on a macOS
runner. Neither job may execute `androidTest` or any XCUITest — the gate is
compile-only. The workflow MUST NOT alter `.github/workflows/ci.yml`, and MUST
NOT declare a job named `test` (ruleset `14531661` pins that context to
`ci.yml`'s job).

- **GIVEN** a pull request that breaks Kotlin or Swift compilation
- **WHEN** the drivers workflow runs
- **THEN** the corresponding job fails and the breakage is visible on the PR
- **AND** `ci.yml`'s `test` job and its required-check contract are untouched

- **GIVEN** the drivers workflow
- **WHEN** its steps are read
- **THEN** each platform's build is a single call to the repo's existing build
  script, and no step runs an instrumentation or UI test

#### R2: fab `test_paths` MUST be able to match a native test file
`fab/project/config.yaml` lists `drivers/` under `source_paths` while its
`test_paths` are TypeScript-only globs, so no pattern can ever match a Kotlin or
Swift test. `test_paths` MUST additionally carry `**/src/test/**/*.kt`,
`**/src/androidTest/**/*.kt`, and `**/*Tests.swift`. This is tooling
configuration and MUST NOT change product behaviour.

- **GIVEN** `fab/project/config.yaml`
- **WHEN** its `test_paths` are matched against `drivers/android/app/src/test/java/app/finalrun/android/ExampleUnitTest.kt`
- **THEN** a pattern matches

### Drivers: cross-language gRPC contract

#### R3: The proto MUST state the contract the language can enforce, and the units it cannot
`proto/finalrun/driver.proto` MUST replace the prose comment
`// Field 4 was deep_link - removed now` in `LaunchAppRequest` with a
`reserved 4;` statement, so reuse of tag 4 is a compile/parse error rather than a
silent misdeserialisation of old wire bytes (proto-loader resolves the schema at
runtime). `PointPercent` MUST document that `x_percent`/`y_percent` are **0–1
fractions, not 0–100 percentages** — the undocumented range is how Android and
iOS diverged. The `reserved` statement MUST NOT break the runtime proto-loader
resolution or require regenerating the committed
`drivers/ios/finalrun-ios-test/Generated/finalrun/driver.pb.swift`.

- **GIVEN** the edited `driver.proto`
- **WHEN** `@grpc/proto-loader` loads it and `grpc.loadPackageDefinition` resolves `finalrun.driver.DriverService`
- **THEN** every RPC still resolves and `LaunchAppRequest` carries no field 4
- **AND** `npm run build`, `npm run typecheck` and `npm run test:workspaces` stay green

#### R4: Android `tapPercent` MUST treat `x_percent` as a 0–1 fraction and MUST accept `0.0`
`getXYPercentOnScreen` in
`drivers/android/app/src/androidTest/java/app/finalrun/android/TestUtils.kt`
MUST NOT divide by 100 — the TypeScript client sends 0–1 fractions
(`packages/common/src/models/test/DeviceAction.test.ts:19,29,35,45`,
`packages/device-node/src/device/test/Device.test.ts:188`) and iOS already
multiplies without the divisor. The `xP == 0.0 || yP == 0.0` rejection MUST go:
`0.0` is a left/top-edge coordinate, not an error. The nullable return MUST be
kept and its `null` MUST instead mean **out of range** (`< 0.0` or `> 1.0`, which
also covers `NaN`), so the caller's existing failure path at
`DriverServiceImpl.kt:82-83` stays reachable and meaningful. The function MUST
carry a comment recording the unit contract.

- **GIVEN** a 1080×1920 screen and `xPercent = 0.5`, `yPercent = 0.5`
- **WHEN** `getXYPercentOnScreen` runs
- **THEN** it returns `(540, 960)` — the screen centre, not `(5, 9)`

- **GIVEN** `xPercent = 0.0`, `yPercent = 0.25`
- **WHEN** `getXYPercentOnScreen` runs
- **THEN** it returns a coordinate on the left edge rather than `null`

- **GIVEN** `xPercent = 42.0` (a 0–100 caller, or a client bug)
- **WHEN** `getXYPercentOnScreen` runs
- **THEN** it returns `null` and `tapPercent` reports the failure instead of tapping an off-screen point

#### R5: The iOS screenshot `quality` default MUST be 5
`drivers/ios/finalrun-ios-test/GrpcDriverServer.swift` MUST default `quality` to
`5` at both `getScreenshot` and `getRawScreenshot`, matching the three live
implementations (`GrpcDriverClient.ts` sends `quality ?? 5` at all three call
sites, Android uses 5, the proto documents `Default: 5` at four sites). The
`// Match Dart default` citation MUST be dropped — there are no `.dart` files in
this repo, so it is unverifiable and contradicted by every live consumer.

- **GIVEN** a `GetScreenshotRequest` with no `quality` field set
- **WHEN** the iOS driver handles it
- **THEN** it compresses at quality 5, the same as Android and the same as the proto documents

#### R6: The iOS streaming frame interval MUST be computed in floating point
`drivers/ios/finalrun-ios-test/Managers/XCViewHierarchyManager.swift` MUST NOT
compute the timer interval as `Double(1/(fps ?? 1))` — that division happens in
`Int`, so every fps above 1 truncates to `0` and the timer fires as fast as the
run loop allows. The division MUST happen in `Double`, and the fps MUST be
clamped to the same `1...60` range Android uses. The fix MUST cite the Android
precedent (`TestUtils.kt`'s `calculateFrameDelay`, which documents exactly this
trap).

- **GIVEN** `StartStreaming` with `fps = 24`
- **WHEN** `startStreaming` schedules the timer
- **THEN** the interval is ≈0.0417 s, not `0`

#### R7: iOS MUST NOT report success for an action it does not perform
`copyText`, `pasteText`, `hideKeyboard`, `getAppList` and `setLocation` in
`GrpcDriverServer.swift` MUST return `success = false` with an explanatory
message instead of `success = true` while doing nothing, matching the shape
Android already returns for its own unimplemented actions
(`DriverServiceImpl.kt:124-129,182`) and the shape iOS's own `back` already uses.
Implementing the five natively is out of scope.

- **GIVEN** a `CopyText` RPC against the iOS driver
- **WHEN** it returns
- **THEN** `success` is `false` and the message names the action as unsupported on iOS, so a caller can distinguish "done" from "silently ignored"

#### R8: `AccessibilityStreamer` MUST document what it does, and only that
`drivers/android/.../data/hierarchy/AccessibilityStreamer.kt` MUST NOT claim
`findStableFocusedNodeInRoot` waits for element bounds to "stay the same for 5
seconds": the loop never resets `initialBounds`, returns on the *first* matching
reading, and returns the node unconditionally when the polls run out — the
guarantee does not exist and never did. The false promise MUST be deleted (not
implemented) and replaced with an accurate description. The three hierarchy
traversals MUST be documented so a reader can see which RPC gets which tree:
`getHierarchy` is **visibility-filtered** (`processNodeRecursive` keeps a child
only when `isVisibleToUser || insideWebView`) over cached roots and is what
**streaming** uses; `getHierarchyForStreamingRefreshed` is **unfiltered** over
refreshed roots and is what `GetHierarchy` and `GetScreenshotAndHierarchy` use;
`getHierarchyForStreaming` is unfiltered over cached roots and serves the legacy
WebSocket path and `DeviceActions.getHierarchy()`. **No behaviour changes**:
unification would alter what the planner LLM sees, in native code with zero tests.

- **GIVEN** the edited file
- **WHEN** a reader looks for the 5-second stability guarantee
- **THEN** no comment claims one, and the polling loop's real exit conditions are described

- **GIVEN** the three traversal entry points
- **WHEN** their doc comments are read
- **THEN** each names its filtering, its root-cache behaviour, and its callers, and no traversal body has changed

### device-node: log capture

#### R9: A log capture's write stream MUST be ended and flushed before the stop resolves
`AndroidLogcatProvider.stopLogCapture` and `IOSLogProvider.stopLogCapture`
currently call only `params.process.stdout.unpipe()` under a comment claiming the
stream is flushed and closed. `unpipe()` detaches the pipe **without** ending the
destination, so buffered log data is dropped and the file is silently truncated.
Both providers MUST instead let the child's `stdout` drain to EOF, end the write
stream, and wait for its flush, so the file is complete when the stop resolves
(the CLI copies it immediately afterwards — see `/cli/report-writer.md`). The
comment MUST describe what the code does. The tracking needed to reach the stream
from `stopLogCapture` MUST live in one shared single-purpose module at
`packages/device-node/src/device/`, the nearest common parent of the two
providers, per the measured-diff rule in `/device-node/android-ios-mirror.md`:
the two bodies would otherwise be identical modulo a log prefix. It MUST NOT be
re-exported from the package barrel.

- **GIVEN** a log capture whose child process has written data that is still buffered
- **WHEN** `stopLogCapture` resolves
- **THEN** the output file on disk contains every byte the child produced

- **GIVEN** a capture that was never started, or a second stop for the same file
- **WHEN** the stream finalisation runs
- **THEN** it resolves without throwing and without hanging

### device-node: Android/iOS mirror

#### R10: The compressed recording MUST replace the original by rename alone
`IOSRecordingProvider._compressVideo` does `rm(original)` and then
`rename(compressed, original)`. A same-directory `rename` overwrites atomically
on POSIX, so the `rm` is not merely redundant — if the `rename` fails after it,
the recording is gone. The `rm` MUST be removed and the rename MUST overwrite the
target directly. The bare `-crf 40` MUST be a named constant.

- **GIVEN** a compressed file and a `rename` that fails
- **WHEN** `_compressVideo` returns
- **THEN** the original recording still exists at its path

- **GIVEN** a compression that succeeds
- **WHEN** `_compressVideo` returns
- **THEN** the original path holds the compressed video and no `-small` sibling remains

#### R11: Driver recovery MUST NOT re-execute a mutating action
`IOSSimulator._withDriverRecovery` re-executes `fn()` after a driver restart,
contradicting `GrpcDriverClient._unaryCall`'s documented default of 0 retries
*"to prevent duplicating mutating actions"* — a tap or text entry can be applied
twice. After a restart, only operations whose replay is observably harmless MAY
be re-executed: the read-only captures (`captureState`, `getScreenshot`,
`getHierarchy`, `getScreenshotAndHierarchy`, `checkAppInForeground`) and the
idempotent driver-state sync `updateAppIds`, which a freshly restarted driver
needs anyway. Every device-touching action (`tap`, `tapPercent`, `longPress`,
`enterText`, `eraseText`, `scrollAbs`, `rotate`, `hideKeyboard`, `pressKey`,
`launchApp`) MUST NOT be replayed: the driver still restarts, but the original
error is surfaced. An operation not named MUST default to *not* replayed. The two
comments MUST be reconciled so they no longer contradict.

- **GIVEN** a `tap` whose call throws and a driver process that has exited
- **WHEN** `_withDriverRecovery` handles it
- **THEN** the driver is restarted, `fn` is called exactly once in total, and the original error propagates

- **GIVEN** a `getScreenshot` whose call throws and a driver process that has exited
- **WHEN** `_withDriverRecovery` handles it
- **THEN** the driver is restarted and the capture is retried once

#### R12: A registered disconnection handler MUST actually be invoked
`Device._disconnectionCallback` is assigned by `listenForDeviceDisconnection` and
never invoked, so registering a handler silently has no effect. `Device` MUST
invoke it when it observes a lost connection — an action that failed while
`runtime.isConnected()` is `false` — passing the device UUID and a reason, and
MUST notify at most once per registration (a subsequent
`listenForDeviceDisconnection` re-arms it).

- **GIVEN** a registered `onDeviceDisconnected` handler and a runtime whose action throws while reporting not-connected
- **WHEN** `executeAction` handles the failure
- **THEN** the handler is invoked once with the device UUID and a reason naming the failure, and the action still returns a failure response

- **GIVEN** the same handler and a second failing action
- **WHEN** `executeAction` handles it
- **THEN** the handler is not invoked again

#### R15: `killDriver` MUST be named for what it does
`CommonDriverActions.close()` and `CommonDriverActions.killDriver()` have
identical bodies — both close the gRPC channel and leave the instrumentation host
/ XCUITest runner running. `killDriver` MUST be renamed to `closeDriverChannel`
and both methods MUST document what they actually do, so the next reader does not
collapse two identical bodies or trust the name. **No runtime behaviour changes**;
the `DeviceAgent`/`DeviceRuntime`/`Device.killDriver()` names on the public
interface stay as they are (out of this change's scope) and are documented rather
than renamed.

- **GIVEN** the edited `CommonDriverActions`
- **WHEN** a reader looks for a method that terminates the driver process
- **THEN** none claims to, and both channel-closing methods say so

### cli: host preflight

#### R13: Command-on-PATH probing MUST work on Windows
`packages/cli/src/hostPreflight.ts`'s default `resolveCommand` shells to `which`
unconditionally, so every `checkCommandOnPath` result on a Windows host is a
silent false negative. It MUST use `where` on `win32` and `which` elsewhere,
following the existing `win32` branch pattern in `upgradeCommand.ts:54` and
`reportServerManager.ts:93` rather than introducing a platform abstraction.
`where` can print several matches, one per line; the first is what the shell
would run. The branch MUST be reachable by a test.

- **GIVEN** `process.platform === 'win32'`
- **WHEN** a command is resolved
- **THEN** `where <command>` is executed and the first output line is returned as the resolved path

- **GIVEN** any other platform
- **WHEN** a command is resolved
- **THEN** `which <command>` is executed, exactly as before

### cloud-core: submit pipeline

#### R14: The millisecond-timeout env parser MUST exist once
`packages/cloud-core/src/upload.ts` validates `FINALRUN_UPLOAD_TIMEOUT_MS` with
`Number.isFinite`, so `1.5` passes a check whose own message says *"must be a
positive integer"*; `submit.ts` was already corrected to `Number.isInteger` and
covered by a test, and the fix never propagated. Both call sites MUST use one
shared parser in a new internal module at `packages/cloud-core/src/`, keeping the
`Number.isInteger`/`<= 0` guard and the exact message wording
(`Invalid <VAR>=<json>: must be a positive integer (milliseconds).`). The guard
MUST keep testing the parsed **value**, never the literal's spelling, so `'1e3'`
and `'0x10'` stay accepted and `'1.5'` is rejected (`/cloud-core/submit-pipeline.md`).
The existing test at `submit.test.ts:652-657` MUST keep passing **unmodified**.

- **GIVEN** `FINALRUN_UPLOAD_TIMEOUT_MS='1.5'`
- **WHEN** `upload.ts` is loaded
- **THEN** it throws `Invalid FINALRUN_UPLOAD_TIMEOUT_MS="1.5": must be a positive integer (milliseconds).`

- **GIVEN** `FINALRUN_UPLOAD_TIMEOUT_MS='1e3'`
- **WHEN** `upload.ts` is loaded
- **THEN** the timeout is 1000 ms and nothing is thrown

- **GIVEN** the unchanged `submit.test.ts` module-load test
- **WHEN** the suite runs
- **THEN** it passes byte-for-byte unmodified

### Repository verification

#### R16: The repo's own gate MUST stay green
`npm run build`, `npm run typecheck`, `npm run test:workspaces` and `npm run lint`
MUST all succeed after the change, and `npm run lint` MUST report no new
warning categories beyond the pre-existing `max-lines-per-function` /
`complexity` set.

- **GIVEN** the completed change
- **WHEN** build, typecheck, tests and lint run in that order
- **THEN** all four exit 0

### Non-Goals

- The `Swipe` RPC — left entirely untouched (no implementation, no explicit error).
- Dead-code deletion (~4,900 lines: `TestActions.kt`, `XCTestManager.swift`, unreferenced constants).
- The comment/documentation sweep, and encoding the comment policy into `code-quality.md` / `code-review.md`.
- All structural refactors of the rubric's points 1–3.
- Everything in `packages/report-web`.
- Any change to ESLint rule severity or CI lint enforcement.
- Unifying the three hierarchy traversals (R8 documents the divergence only).
- Implementing the five iOS actions natively (R7 reports them as unsupported).
- A Kotlin or Swift unit-test harness. The compile gate is the native fixes' only verification.

### Design Decisions

#### The drivers gate is a separate additive workflow, not a job in `ci.yml`
**Decision**: The compile gate lands as a new `.github/workflows/drivers.yml`
with two jobs (`android` on `ubuntu-latest`, `ios` on `macos-latest`), each a
single call to the existing `scripts/build-drivers-*.sh`. `ci.yml` is not edited.
Like `ci.yml`, it carries no `concurrency` block.
**Why**: `ci.yml`'s `test` job name is a contract with ruleset `14531661`, and its
job graph is a required-check surface — a new job inside it is a new way to
detach or stall that check. A separate file keeps the gate additive and lets the
iOS half sit on a different runner OS without a matrix. Omitting `concurrency`
follows the same reasoning `ci.yml` records: a bare group on the default
`queue: single` silently restores cancellation of pending runs, and a cancelled
run reads exactly like a clean one.
**Rejected**: (a) adding two steps to the `test` job — the iOS build needs macOS,
which the job cannot provide, and it would put a slow native build in front of
the required check; (b) a matrix job over `[ubuntu, macos]` — the two builds share
no steps beyond checkout; (c) restating the gradle/xcodebuild invocations in the
workflow — two copies of a build contract that already exists as a script, and
the iOS script's `-Runner.app` assertions would be lost.
*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

#### `null` from `getXYPercentOnScreen` means out-of-range, not zero
**Decision**: The `xP == 0.0 || yP == 0.0` guard is replaced by a `0.0...1.0`
range guard rather than deleted outright, keeping the nullable return type.
**Why**: The caller at `DriverServiceImpl.kt:82-83` already converts `null` into
an explicit `TapPercent failed` response. Deleting the guard would make that path
dead and turn a client bug (a 0–100 caller, or `NaN`) into a tap at a
Kotlin-truncated off-screen coordinate; keeping the arity and re-pointing `null`
at genuinely invalid input costs one line, changes no signature, and makes the
existing error path mean something. The guard is Android-only — iOS multiplies
unguarded — which is a deliberate, documented asymmetry rather than a new
divergence in the computed value.
**Rejected**: (a) removing the guard and making the return non-nullable — ripples
into the caller and discards the only validation of a cross-language unit
contract that the proto cannot express; (b) clamping out-of-range input to
`0.0...1.0` — silently taps somewhere the caller did not ask for, which is the
same class of defect as the `/100` bug.
*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

#### Replay after a driver restart is opt-in per operation, keyed on the name the call sites already pass
**Decision**: `_withDriverRecovery` consults a module-level set of operation
names that are safe to replay (the read-only captures plus `updateAppIds`);
everything else restarts the driver and rethrows. An unlisted name defaults to
*not* replayed.
**Why**: Every call site already passes `opName`, so the classification costs no
new parameter and no call-site churn, and the default falls the safe way — a
newly added mutating action is not replayed until someone deliberately lists it.
`updateAppIds` is listed because a restarted driver has *lost* its app-id list, so
replay is required for correctness, and it mutates driver state only, never the
device.
**Rejected**: (a) disabling re-execution wholesale — smaller, but it also gives up
the recovery for the read-only captures, which is the case the mechanism was
built for and where replay is observably harmless; (b) a `retryAfterRestart`
boolean at each of the 16 call sites — the same information spread over 16 places
to be kept consistent by hand; (c) parsing the gRPC error to decide — the
existing comment is explicit that process state, not error text, is the source of
truth.
*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

#### The shared timeout parser is extracted for de-duplication; tests still reach it through module load
**Decision**: `parseTimeoutMsFromEnv(envVar, defaultMs)` moves into a new
internal `packages/cloud-core/src/timeoutEnv.ts`, imported by `submit.ts` and
`upload.ts` and absent from the package barrel. `submit.test.ts`'s existing test
is not modified and keeps reaching the throw by dropping the require-cache entry
and re-requiring `submit.js`.
**Why**: `/cloud-core/submit-pipeline.md` records that the contract must be stated
once; two copies is how one of them ended up looser than its own error message.
The extraction is justified by the duplication, and the module-load seam the test
already uses is unaffected, so the test's proof survives untouched.
**Rejected**: (a) fixing `Number.isFinite` → `Number.isInteger` in place —
corrects today's divergence and leaves the mechanism that produced it; (b)
importing `upload.ts`'s generic parser from `submit.ts` — makes the more heavily
tested module depend on the untested one and leaves the parser in a module about
uploading; (c) exporting the parser from the barrel — it is an internal detail of
two modules, not API. The rejected alternative recorded in memory (exporting a
timeout parser *so tests can reach it*) does not apply: the test path is
unchanged.
*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

#### One shared write-stream registry serves both log providers
**Decision**: The write stream a log provider pipes `stdout` into is created and
tracked by a shared `LogWriteStreamRegistry` in
`packages/device-node/src/device/logWriteStream.ts`, and each provider calls its
`finalize(outputFilePath, stdout)` in place of the old `unpipe()`.
**Why**: `stopLogCapture` receives only `{ process, outputFilePath }`, so it needs
a way back to the stream `startLogCapture` opened. Running the measured diff the
mirror rule demands (`/device-node/android-ios-mirror.md`), the two providers'
versions of that bookkeeping come back identical modulo a log-prefix string, so
this is a proven duplicate rather than parallel shape — a single-purpose,
zero-branch-import leaf at the two providers' common parent, kept out of the
barrel, is the shape that rule prescribes.
**Rejected**: (a) a private `Map` in each provider — the one case the mirror rule
says to share, duplicated; (b) widening `LogCaptureProvider` so the stream travels
through `LogCaptureManager` — changes a cross-package interface and puts a
Node stream in the manager's vocabulary for no gain; (c) keeping `unpipe()` and
calling `end()` immediately — ends the destination before `stdout` has drained,
which truncates the file in a new way and errors on the in-flight write.
*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

#### R7's blast radius is one live planner path: `hideKeyboard` on iOS
**Decision**: The five iOS handlers report `success = false`, as R7 requires, and
the behaviour change is **recorded rather than softened**. Of the five, only
`hideKeyboard` is reachable from TypeScript through the driver today
(`IOSSimulator.ts:131` → `CommonDriverActions.hideKeyboard()` → the gRPC
`HideKeyboard` RPC), so a planner step emitting `PLANNER_ACTION_HIDE_KEYBOARD`
(`ActionExecutor.ts:222`) against an iOS device now returns a failure where it
previously returned success. The other four reach nobody: `setLocation` goes to
the simulator through `simctl` (`IOSSimulator.ts:228`), never the driver, and
`copyText`, `pasteText` and `getAppList` have no planner path at all.
**Why**: The success those handlers returned was false — the keyboard was never
dismissed — so a planner that "succeeded" then reasoned about a screen that had
not changed. One newly-failing action, visible in the run report, is the outcome
R7 asks for; a silent no-op is the defect it exists to remove. Recording the
radius here means hydrate and the PR body carry it, so the first person to see an
iOS `hideKeyboard` failure knows it is this change and not a regression.
**Rejected**: (a) leaving `hideKeyboard` returning `success = true` while fixing
the other four — keeps the one lie that has a live consumer and fixes the four
that have none, which is exactly backwards; (b) implementing `hideKeyboard`
natively — out of scope per R7, in native code with no test harness; (c) mapping
the failure to a soft skip in `ActionExecutor` — hides the same information one
layer up, in a package this change does not touch.
*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

## Tasks

### Phase 1: The gate and its tooling

- [x] T001 [P] Add `.github/workflows/drivers.yml`: `pull_request` → `main` plus `push` → `main`, no `concurrency` block, an `android` job on `ubuntu-latest` (checkout, `actions/setup-java@v4` JDK 17 + gradle cache, `./scripts/build-drivers-android.sh`) and an `ios` job on `macos-latest` (checkout, `./scripts/build-drivers-ios.sh`); comments must state why it is compile-only, why `androidTest` is never executed, and that no job here may be named `test` <!-- R1 -->
- [x] T002 [P] Add `**/src/test/**/*.kt`, `**/src/androidTest/**/*.kt`, `**/*Tests.swift` to `test_paths` in `fab/project/config.yaml` <!-- R2 -->

### Phase 2: Cross-language contract and the native drivers (compile-verified only)

- [x] T003 [P] In `proto/finalrun/driver.proto`: replace the `// Field 4 was deep_link - removed now` comment in `LaunchAppRequest` with `reserved 4;`, and document the 0–1 fraction contract on `PointPercent`; then verify `@grpc/proto-loader` still resolves `finalrun.driver.DriverService` and that the committed `driver.pb.swift` needs no regeneration <!-- R3 -->
- [x] T004 [P] In `drivers/android/app/src/androidTest/java/app/finalrun/android/TestUtils.kt`: drop the `/ 100` on both axes in `getXYPercentOnScreen`, replace the `xP == 0.0 || yP == 0.0` rejection with a `0.0..1.0` range guard, and add a KDoc recording the unit contract and the iOS/TypeScript agreement <!-- R4 -->
- [x] T005 [P] In `drivers/ios/finalrun-ios-test/GrpcDriverServer.swift`: change the `quality` default from `10` to `5` at `getScreenshot` and `getRawScreenshot`, drop the `// Match Dart default` citation, and cite the three implementations that agree on 5 <!-- R5 --> <!-- rework: SHOULD-FIX — GrpcDriverServer.swift:111's `private static let defaultScreenshotQuality` sits in a `@MainActor final class` and is read from two `nonisolated func`s (:489, :525) on a target building at SWIFT_VERSION 6.0 strict concurrency. Likely legal under SE-0412, but NO Swift toolchain exists in this environment so it is unverifiable locally and its first compile is the PR itself. Make it `private nonisolated static let` — one keyword, removes the risk entirely. -->
- [x] T006 [P] In `drivers/ios/finalrun-ios-test/Managers/XCViewHierarchyManager.swift`: compute the streaming timer interval as `1.0 / Double(fps)` with fps clamped to `1...60`, and document the integer-division trap citing Android's `calculateFrameDelay` <!-- R6 -->
- [x] T007 [P] In `drivers/ios/finalrun-ios-test/GrpcDriverServer.swift`: make `copyText`, `pasteText`, `hideKeyboard`, `getAppList` and `setLocation` return `success = false` with a "not supported on iOS" message, matching the shape of the file's own `back` and Android's unimplemented actions <!-- R7 --> <!-- rework: SHOULD-FIX (record, do not revert — the behaviour change is authorised by R7) — of the five actions, `hideKeyboard` is the ONLY one still reachable from TypeScript via the driver (IOSSimulator.ts:131 → CommonDriverActions.hideKeyboard() → gRPC); `setLocation` goes via simctl (IOSSimulator.ts:228) and copyText/pasteText/getAppList have no planner path. So any planner step emitting PLANNER_ACTION_HIDE_KEYBOARD on iOS now returns success:false where it previously returned success:true. Record this blast radius in the plan's Design Decisions so hydrate and the PR body carry it. -->
- [x] T008 [P] In `drivers/android/.../data/hierarchy/AccessibilityStreamer.kt`: delete the false 5-second bounds-stability promise on `findStableFocusedNodeInRoot` and replace it with an accurate description; add KDoc to `getHierarchy`, `getHierarchyForStreaming` and `getHierarchyForStreamingRefreshed` naming each one's filtering, root-cache behaviour and callers. No behaviour changes <!-- R8 -->

### Phase 3: TypeScript defects, each with a regression test

- [x] T009 Add `packages/device-node/src/device/logWriteStream.ts` (open/track/finalize a piped log write stream, not barrel-exported); use it in `AndroidLogcatProvider` and `IOSLogProvider` in place of `stdout.unpipe()`, correcting the comment; add `packages/device-node/src/device/test/logCaptureProviders.test.ts` proving the output file is complete after `stopLogCapture` and that a double stop is harmless <!-- R9 --> <!-- rework: MUST-FIX — R9 unmet on all four error paths. `finalize()` is skipped when SIGINT delivery fails (AndroidLogcatProvider.ts:134-137, IOSLogProvider.ts:111-114) and in both outer catch blocks when `_waitForExit` throws (AndroidLogcatProvider.ts:156-164, IOSLogProvider.ts:133-141), so the stream is never ended and its registry entry never deleted — fd leak, still-truncated log, unbounded growth in the process-wide defaultLogCaptureManager singleton. Finalize in a `finally` (or before every early return). ALSO: logWriteStream.ts:59-62 deletes the registry entry BEFORE awaiting `_drain`, and `_drain` can reject (`finished(source)` rejects on a stdout `error` and Promise.race propagates it), leaving the stream neither ended nor tracked — capture the stream first, finalize in a `finally`. Add error-path coverage to logCaptureProviders.test.ts. -->
- [x] T010 [P] In `packages/device-node/src/device/IOSRecordingProvider.ts`: drop the `fsp.rm(originalFilePath)` before the rename, name the `-crf 40` constant, and extend `test/IOSRecordingProvider.test.ts` to prove the original survives a failing rename and is replaced on success <!-- R10 -->
- [x] T011 [P] In `packages/device-node/src/device/ios/IOSSimulator.ts`: add the replay-after-restart classification to `_withDriverRecovery` so mutating actions are not re-executed; reconcile the comment with `GrpcDriverClient._unaryCall`'s retry rationale; extend `test/IOSSimulator.test.ts` to prove a `tap` runs once and a capture is retried <!-- R11 --> <!-- rework: NICE-TO-HAVE (accepted — this change's own thesis is comment accuracy) — GrpcDriverClient.ts:345-348 says replay happens "only for the read-only set in REPLAYABLE_AFTER_DRIVER_RESTART", but that set also contains `updateAppIds`, which its own doc says is not read-only. Reword to "the read-only set plus the idempotent `updateAppIds`". -->
- [x] T012 [P] In `packages/device-node/src/device/Device.ts`: invoke `_disconnectionCallback` once per registration when an action fails while the runtime reports not-connected; extend `test/Device.test.ts` to prove it fires with UUID + reason and does not fire twice <!-- R12 --> <!-- rework: SHOULD-FIX — Device.ts:127-132 runs `_notifyIfDisconnected` inside `executeAction`'s catch with neither `this._runtime.isConnected()` nor the user-supplied `_disconnectionCallback` guarded. A throwing handler escapes the catch and makes `executeAction` REJECT instead of returning the `{success:false, message:'Action failed: …'}` response R12 promises, replacing the original error. Wrap the notify body in its own try/catch and add a test for a throwing listener. -->
- [x] T013 [P] In `packages/cli/src/hostPreflight.ts`: extract the default command resolution into `resolveCommandPath(command, overrides?)` branching to `where` on `win32` and taking the first output line; extend `src/test/hostPreflight.test.ts` to pin both platform branches <!-- R13 -->
- [x] T014 [P] Add `packages/cloud-core/src/timeoutEnv.ts` with the shared `parseTimeoutMsFromEnv`; use it from `submit.ts` and `upload.ts`, deleting both local copies; extend `src/test/submit.test.ts` with an `upload.js` module-load test for `1.5` / `1e3`, leaving the existing `FINALRUN_SUBMIT_TIMEOUT_MS` test unmodified <!-- R14 -->
- [x] T015 [P] In `packages/device-node/src/device/shared/CommonDriverActions.ts`: rename `killDriver` to `closeDriverChannel`, document both it and `close()`, and update the two call sites in `device/ios/IOSSimulator.ts` and `device/android/AndroidDevice.ts` (documenting there that the public `killDriver` name closes a channel) <!-- R15 --> <!-- rework: SHOULD-FIX — R15's "retained public `killDriver` names are documented rather than renamed" clause is only partly met. The two platform implementations were documented (AndroidDevice.ts:270, IOSSimulator.ts:316) but the two interface declarations (DeviceRuntime.ts:62, packages/common/src/interfaces/DeviceAgent.ts:33) and the `Device.killDriver()` facade (Device.ts:271) were not — a reader arriving at the interface still sees a name promising to kill a process. Document all three. -->

### Phase 4: Verification

- [x] T016 Run `npm run build`, `npm run typecheck`, `npm run test:workspaces`, `npm run lint`; confirm all four are green and that lint reports no new warning categories <!-- R16 -->

## Execution Order

- Phase 1 and Phase 2 are independent of each other and of Phase 3.
- Within Phase 2, T005 and T007 touch the same file (`GrpcDriverServer.swift`) — run them sequentially despite the `[P]` marker on each.
- Within Phase 3, T009 must land before T016; T010–T015 are independent of one another.
- T016 runs last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `.github/workflows/drivers.yml` exists, triggers on `pull_request` → `main` and `push` → `main`, builds Android on `ubuntu-latest` and iOS on `macos-latest`, and each platform's build is a single call to the repo's existing `scripts/build-drivers-*.sh`
- [x] A-002 R2: `fab/project/config.yaml` `test_paths` includes the two Kotlin globs and the Swift glob, and `source_paths` is unchanged
- [x] A-003 R3: `proto/finalrun/driver.proto` carries `reserved 4;` in `LaunchAppRequest` (with the prose comment gone) and documents `x_percent`/`y_percent` as 0–1 fractions
- [x] A-004 R4: `getXYPercentOnScreen` multiplies without dividing by 100 and no longer rejects `0.0`
- [x] A-005 R5: both iOS screenshot handlers default `quality` to `5` and no `Match Dart default` citation remains
- [x] A-006 R6: the iOS streaming timer interval is a `Double` division with the fps clamped to `1...60`
- [x] A-007 R7: all five iOS no-op actions return `success = false` with an explanatory message
- [x] A-008 R8: no comment claims 5-second bounds stability, and all three hierarchy traversals carry doc comments naming filtering, root cache and callers
- [x] A-009 R9: both log providers end the write stream and wait for its flush, via one shared module at `packages/device-node/src/device/` that is not barrel-exported, and the misleading comment is corrected — **MET (review cycle 2)**: every exit from `startLogCapture`/`stopLogCapture` in both providers now finalizes — success path via the throwing `finalize()` (`AndroidLogcatProvider.ts:158`, `IOSLogProvider.ts:135`), failed-SIGINT early return and outer catch via `finalizeQuietly` (`AndroidLogcatProvider.ts:140`, `:173`; `IOSLogProvider.ts:117`, `:150`), start-failure via `finalizeQuietly` (`AndroidLogcatProvider.ts:110`, `IOSLogProvider.ts:87`); `logWriteStream.ts:78-87` untracks and ends in a `finally` so a rejecting `_drain` cannot strand the stream, and the untracked early return at `:65-67` makes it idempotent
- [x] A-010 R10: `_compressVideo` renames over the original with no preceding `rm`, and `-crf 40` is a named constant
- [x] A-011 R11: `_withDriverRecovery` re-executes only the classified replayable operations, and the contradicting comments are reconciled
- [x] A-012 R12: `Device` invokes `_disconnectionCallback` on the observed-disconnection path
- [x] A-013 R13: `hostPreflight` resolves commands with `where` on `win32` and `which` elsewhere
- [x] A-014 R14: one shared `parseTimeoutMsFromEnv` serves both `submit.ts` and `upload.ts`, and neither module keeps a local copy
- [x] A-015 R15: `CommonDriverActions.killDriver` is renamed `closeDriverChannel`, both channel-closing methods are documented, and both call sites are updated

### Behavioral Correctness

- [x] A-016 R4: a 0.5/0.5 tap on a 1080×1920 screen resolves to the screen centre rather than the top-left corner, and an out-of-range input returns `null` so `tapPercent` reports a failure *(source-verified only — no Kotlin harness; see A-036)*
- [x] A-017 R9: a regression test proves the log file contains everything the child wrote after `stopLogCapture` resolves, and fails against the `unpipe()`-only source
- [x] A-018 R10: a regression test proves the original recording survives a failing rename
- [x] A-019 R11: a regression test proves a mutating action's `fn` is invoked exactly once across a driver restart, while a read-only capture is retried
- [x] A-020 R12: a regression test proves the disconnection handler fires once with the device UUID and a reason, and not a second time
- [x] A-021 R13: a test pins `where` on `win32` (first output line returned) and `which` elsewhere
- [x] A-022 R14: `FINALRUN_UPLOAD_TIMEOUT_MS='1.5'` is rejected with the exact documented message while `'1e3'` is accepted as 1000
- [x] A-023 R15: no runtime behaviour changed — the renamed method still only closes the gRPC channel

### Scenario Coverage

- [x] A-024 R3: the proto still loads through `@grpc/proto-loader` and `finalrun.driver.DriverService` resolves with every RPC after the `reserved` statement is added, and the committed generated Swift is unchanged
- [x] A-025 R14: the pre-existing `submit.test.ts:652-657` module-load test passes byte-for-byte unmodified
- [x] A-026 R16: `npm run build`, `npm run typecheck`, `npm run test:workspaces` and `npm run lint` all exit 0

### Edge Cases & Error Handling

- [x] A-027 R9: finalising a stream that was never opened, already finished, or already finalised resolves without throwing and without hanging
- [x] A-028 R4: `NaN` and values outside `0.0..1.0` return `null` rather than a truncated coordinate *(source-verified only — Kotlin `ClosedFloatingPointRange.contains` uses `<=`, so `NaN` is out of range; see A-036)*
- [x] A-029 R11: an operation name not in the replay classification defaults to *not* replayed
- [x] A-030 R1: no job in the new workflow is named `test`, and `.github/workflows/ci.yml` is byte-for-byte unchanged

### Code Quality

- [x] A-031 Pattern consistency: new code follows the naming and structural patterns of surrounding code — injected `execFileFn`/`spawnFn` seams in device-node, the `win32` branch shape from `upgradeCommand.ts`, Android's KDoc style for the native comments
- [x] A-032 No unnecessary duplication: the write-stream bookkeeping and the timeout parser each exist once, placed at their call sites' nearest common parent and kept out of the package barrels
- [x] A-033 No god functions: every function added or edited stays under the 50-line bar (and the repo's 60-line ESLint ceiling)
- [x] A-034 No magic values: `-crf 40`, the `where`/`which` locators, the fps clamp bounds and the replay classification are named constants
- [x] A-035 Readability over cleverness: each fix is accompanied by a comment stating *why*, and every comment that previously described behaviour the code did not have is corrected rather than left standing

### Non-Testable Native Fixes (explicit limitation)

- [x] A-036 R4/R5/R6/R7/R8: the five native fixes are verified by compilation only. No Kotlin or Swift behavioural test is invented, stubbed, or claimed anywhere in this change, and the plan and PR say so plainly

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- The Android and iOS builds cannot be executed in this apply environment (no JDK, no Android SDK, no Xcode). The workflow is the mechanism that runs them; its first real execution is on the PR.

## Deletion Candidates

- `packages/device-node/src/device/shared/CommonDriverActions.ts:243` (`close()`) / `:259` (`closeDriverChannel()`) — byte-identical bodies kept under two names; one becomes redundant as soon as `DeviceRuntime.killDriver()` / `DeviceAgent.killDriver()` are retired (explicitly out of this change's scope per R15)
- `drivers/ios/finalrun-ios-test/Generated/finalrun/driver.pb.swift:317` — the generated `/// Field 4 was deep_link - removed now` comment is now orphaned: the proto line it mirrors is gone, and a regeneration would emit nothing there
- No production symbol, file, branch or config was made unused by this change — the `fs` imports the two log providers no longer need are already removed, and both `_withDriverRecovery` branches and every new constant have live call sites

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The gate is a new additive `.github/workflows/drivers.yml` with `android`/`ios` jobs, no `concurrency` block, `ci.yml` untouched | Intake fixes both platforms, every PR, compile-only, script reuse and "do not alter ci.yml"; only the file and job names were free, and `ci.yml`'s own recorded reasoning settles the `concurrency` omission | S:85 R:85 A:85 D:80 |
| 2 | Confident | No `paths:` filter on the iOS job — it runs on every PR | Open question 3 decided inline: intake assumption 6 is Certain that both platforms run on every PR, and nothing in the repo evidences a macOS-minutes constraint. Reversible in one line if one appears | S:80 R:85 A:70 D:80 |
| 3 | Confident | `getXYPercentOnScreen` keeps its nullable return, with `null` re-pointed from "a zero coordinate" to "out of `0.0..1.0`" | Open question 1 decided inline: the intake names the range guard as the alternative, and it keeps the caller's existing error path live instead of dead. Clamping was rejected as the same class of silent-wrong-coordinate defect | S:70 R:70 A:70 D:65 |
| 4 | Confident | `_withDriverRecovery` replays only a named set of read-only/idempotent operations; anything unlisted is not replayed | Open question 2 decided inline: the per-action classification is the more correct option and costs nothing because `opName` is already threaded through all 16 call sites, and its default falls safe | S:70 R:75 A:75 D:65 |
| 5 | Confident | `updateAppIds` is classified replayable | A restarted driver has lost its app-id list, so replay is required for correctness; it mutates driver state only, never the device, so it is not the duplication hazard the rule targets | S:60 R:75 A:75 D:60 |
| 6 | Confident | The write-stream bookkeeping is one shared `logWriteStream.ts` leaf at `packages/device-node/src/device/` | The mirror rule requires a measured diff before sharing; the two providers' versions come back identical modulo a log prefix, which is the affirmative case the rule describes, and the placement/barrel rules follow `infra/commandFailure.ts` | S:75 R:80 A:85 D:75 |
| 7 | Confident | `Device` invokes the disconnection callback when an action fails while the runtime reports not-connected, at most once per registration | The intake prefers invoking over documenting, and no disconnection *event* source exists to subscribe to — a failed action with `isConnected() === false` is the only place `Device` observes a lost connection. Notifying once per registration avoids a per-action storm | S:55 R:70 A:65 D:55 |
| 8 | Confident | The `killDriver` rename is confined to `CommonDriverActions`; the `DeviceAgent`/`DeviceRuntime`/`Device` method names are documented, not renamed | Intake B12 scopes the rename to `CommonDriverActions`; renaming the public interface method would ripple through `@finalrun/common`, goal-executor and four test stubs for a change whose stated contract is "no runtime behaviour changes" | S:75 R:80 A:80 D:70 |
| 9 | Confident | The Windows fix is extracted into an exported `resolveCommandPath(command, overrides?)` so the branch is test-reachable | The default `resolveCommand` closes over module-level `execFileAsync` and `process.platform`, neither injectable, so the branch would otherwise ship untested in a package with 11 test files. The overrides object is a defaulted parameter, not a platform abstraction | S:65 R:80 A:75 D:65 |
| 10 | Certain | The shared parser lands in a new internal `packages/cloud-core/src/timeoutEnv.ts`, absent from the barrel, and `submit.test.ts` is not modified | Intake B10 asks for the extraction explicitly and requires the existing test's behaviour be preserved exactly; the module-load seam that test uses is untouched by moving the function | S:80 R:85 A:85 D:80 |
| 11 | Confident | iOS unsupported-action messages read `"<Action> not supported on iOS"` | Matches the intake's own wording and the precedent already in the same file (`back`), while matching Android's *shape* (`success = false` plus an explanatory message), which is what the requirement asks for | S:70 R:85 A:70 D:60 |
| 12 | Confident | The iOS fps is clamped to `1...60` and its default stays `1`, not the proto's 24 | Clamping mirrors Android's `coerceIn(1, 60)` precedent the fix is told to follow; changing the default would be a second behaviour change beyond the integer-division defect | S:65 R:70 A:75 D:60 |
| 13 | Tentative | The native fixes (R4–R8) ship compile-verified only, with no behavioural test | Carried from intake assumption 14. No Kotlin/Swift unit-test harness exists and this change does not create one, so a wrong native fix reaches real devices. R4 is partly mitigated because the correct behaviour is pinned by the TypeScript client's own fixtures; R5/R6/R7/R8 are not | S:65 R:35 A:50 D:45 |
| 14 | Certain | `reserved 4;` is safe for both the runtime proto-loader path and the committed generated Swift | Verified in this change: the proto is loaded through `@grpc/proto-loader` and `DriverService` resolves; protoc/SwiftProtobuf emit nothing for a reserved range, so `driver.pb.swift` needs no regeneration | S:75 R:85 A:80 D:85 |
| 15 | Certain | `test_paths` gains exactly the three globs the intake names | Given verbatim in intake A2; it is tooling configuration with no product behaviour attached | S:90 R:90 A:90 D:90 |

15 assumptions (4 certain, 10 confident, 1 tentative).
