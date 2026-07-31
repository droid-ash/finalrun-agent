---
type: memory
description: "The gRPC contract in proto/finalrun/driver.proto, shared across Kotlin, Swift and TypeScript: `x_percent`/`y_percent` are 0–1 fractions not percentages, screenshot `quality` defaults to 5, `reserved 4;` guards a retired tag, the streaming interval is a Double division, fps clamped 1–60, an unimplemented RPC returns `success = false`, the three Android hierarchy traversals diverge on purpose. Native changes are compile-verified only; a green ios job never proves committed Swift matches the proto."
---
# gRPC Driver Contract (drivers)

**Domain**: drivers

## Overview

`proto/finalrun/driver.proto` is the contract between three independent implementations: the Kotlin
driver under `drivers/android/app/src/androidTest/` (an instrumentation host), the Swift driver under
`drivers/ios/finalrun-ios-test/` (an XCUITest runner), and the TypeScript client in
`packages/device-node/src/grpc/`. Nothing in the build checks them against one another, and the
proto's own generated types cannot express a unit or a default — so anything the schema leaves
unstated is a divergence waiting to happen, and the conventions below are stated in the proto *and*
at each implementation deliberately.

## Requirements

### Requirement: `x_percent` and `y_percent` are 0–1 fractions, not 0–100 percentages

`PointPercent`'s `x_percent`/`y_percent` are **fractions in `0.0..1.0`** despite the field names. The
screen centre is `{0.5, 0.5}` and `{0.0, 0.0}` — the top-left corner — is a valid point. A driver
converts with `x_percent * screen_width`; a `/ 100` anywhere in that conversion puts every tap within
a few pixels of the origin. All three implementations MUST agree: the TypeScript client sends
fractions (`PointPercent.fromJson`'s fixtures in
`packages/common/src/models/test/DeviceAction.test.ts`), the Swift driver multiplies without a
divisor (`GrpcDriverServer.swift`), and Kotlin's `getXYPercentOnScreen`
(`drivers/android/.../TestUtils.kt`) multiplies by `getScreenWidth()`/`getScreenHeight()` directly.

**The range MUST be documented on the proto message and restated at each conversion site.** A
`double x_percent` declaration carries no range, and an undocumented range across three independent
implementations is precisely how two of them come to disagree — silently, because a tap near the
origin still lands on *something* and the RPC still reports success.

#### Scenario: a centre tap on a 1080×1920 screen

- **GIVEN** `xPercent = 0.5`, `yPercent = 0.5`
- **WHEN** the Android driver converts the point
- **THEN** it resolves to `(540, 960)`, the screen centre

#### Scenario: an edge tap

- **GIVEN** `xPercent = 0.0`, `yPercent = 0.25`
- **WHEN** the Android driver converts the point
- **THEN** it resolves to a coordinate on the left edge — `0.0` is a coordinate, not an error

### Requirement: `null` from `getXYPercentOnScreen` means out of range

`getXYPercentOnScreen` keeps its nullable return, and `null` means the caller sent a coordinate
outside `0.0..1.0` — most likely a 0–100 caller, whose point would otherwise resolve far off screen.
The guard is expressed as membership in the named `SCREEN_FRACTION_RANGE` (`0.0..1.0`), which also
covers `NaN`: Kotlin's `ClosedFloatingPointRange.contains` uses `<=`, and `NaN` is in no range. The
guard is Android-only — iOS multiplies unguarded — which is a documented asymmetry in *validation*,
not a divergence in the computed value.

`null` MUST stay meaningful, because `DriverServiceImpl.tapPercent` converts it into an explicit
`TapPercent failed` response with `success = false`. A guard that rejected a legitimate coordinate
(such as `0.0`) would fail a valid tap; no guard at all would make that failure path dead and turn a
client bug into a tap at a truncated off-screen coordinate.

#### Scenario: a 0–100 caller

- **GIVEN** `xPercent = 42.0`
- **WHEN** `getXYPercentOnScreen` runs
- **THEN** it returns `null` and `tapPercent` reports the failure instead of tapping

#### Scenario: `NaN`

- **GIVEN** `xPercent = NaN`
- **WHEN** the range check runs
- **THEN** the value is out of range and `null` is returned

### Requirement: Screenshot `quality` defaults to 5 in every implementation

An omitted `quality` field means **5** everywhere: `driver.proto` documents `Default: 5` on all four
screenshot request messages, `GrpcDriverClient.ts` sends `quality ?? 5` at all three screenshot call
sites, Android reads `DeviceActions.DEFAULT_QUALITY = 5`, and the Swift driver's
`defaultScreenshotQuality` is `5`, read by both `getScreenshot` and `getRawScreenshot`. A default
that differs per platform makes the same request produce different payload sizes and different image
fidelity depending on which device answered it.

**A "match the Dart default" justification MUST NOT be used to raise this value.** There are no
`.dart` files in this repository (`git ls-files | grep -c '\.dart$'` is 0), so the claim cannot be
checked against anything in the tree, and every live consumer of the contract contradicts it.

The Swift constant is declared `private nonisolated static let`: both readers are `nonisolated func`s
on a `@MainActor final class`, and an immutable `Sendable` static is safe to read from any isolation —
`nonisolated` states what is already true in a form the target's SWIFT_VERSION 6.0 strict concurrency
checking cannot read differently.

#### Scenario: a screenshot request omits `quality`

- **GIVEN** a `GetScreenshotRequest` with no `quality` field set
- **WHEN** any of the three implementations handles it
- **THEN** it compresses at quality 5

### Requirement: A retired field tag is reserved in the schema, not described in a comment

`LaunchAppRequest` carries `reserved 4;` for the tag that held `deep_link`. A prose comment MUST NOT
stand in for it: `@grpc/proto-loader` resolves this schema at **runtime**, so a reused tag 4 would
silently misdeserialise old wire bytes with no error anywhere, while `reserved` makes the reuse a
parse failure. This is the general rule for this file — where the language can enforce a constraint,
the constraint is written in the language and the comment carries only what it cannot express (units,
defaults, cross-implementation agreements).

`reserved` costs nothing downstream: every RPC still resolves through `@grpc/proto-loader`, and
protoc/SwiftProtobuf emit nothing for a reserved range, so the committed
`drivers/ios/finalrun-ios-test/Generated/finalrun/driver.pb.swift` needs no regeneration.

#### Scenario: the proto is loaded at runtime

- **GIVEN** the edited `driver.proto`
- **WHEN** `@grpc/proto-loader` loads it and `grpc.loadPackageDefinition` resolves `finalrun.driver.DriverService`
- **THEN** every RPC resolves and `LaunchAppRequest` carries no field 4

### Requirement: The streaming frame interval is a floating-point division, with fps clamped 1–60

A streaming timer's interval is `1.0 / Double(fps)`, and the division MUST happen in `Double`. Written
as `Double(1 / fps)` the division happens in `Int` first, so **every** fps above 1 truncates to `0`
and the timer fires as fast as the run loop allows — a fully-loaded run loop and a hierarchy snapshot
per tick, for a request that asked for 24 frames a second. Both drivers state the trap where the
computation lives: Android's `TestUtils.calculateFrameDelay` uses `1000.0 / fps.toDouble()`, and the
Swift `XCViewHierarchyManager` cites it.

`fps` MUST be clamped to `1...60` (`streamingFpsRange`), matching Android's `coerceIn(1, 60)`. The
clamp guards the divisor: in `GrpcDriverServer.swift`'s integer `1_000_000_000 / fps`, an fps of `0`
is a division by zero and a negative fps a negative-to-`UInt64` conversion — both Swift traps that
kill the XCUITest runner — while the floating-point paths (`calculateFrameDelay`,
`XCViewHierarchyManager`) turn an fps below 1 into an unbounded or negative interval. The upper
bound of 60 is the chosen cap on hierarchy-snapshot load shared by all three paths, not a measured
ceiling. An omitted `fps` on the
gRPC `StartStreaming` path defaults to `24` on both drivers (`GrpcDriverServer.swift`'s
`defaultStreamingFps`, and the inline `if (request.hasFps()) request.fps else 24` in Android's
`DriverServiceImpl.startStreaming` — both adopting the proto's documented default);
`XCViewHierarchyManager`'s `defaultStreamingFps` of `1` defaults only the legacy WebSocket timer
path. The two are deliberately not aligned — aligning them would change the RPC's behaviour rather
than just guard its arithmetic.

#### Scenario: streaming at 24 fps

- **GIVEN** `StartStreaming` with `fps = 24`
- **WHEN** the timer is scheduled
- **THEN** the interval is ≈0.0417 s, not `0`

#### Scenario: an out-of-range fps

- **GIVEN** `fps = 240`
- **WHEN** the timer is scheduled
- **THEN** the value is clamped to 60

### Requirement: An RPC a driver does not implement returns `success = false`

A handler that performs no action MUST return `success = false` with a message naming the action as
unsupported, never `success = true`. A fabricated success is worse than an error: the caller cannot
distinguish "done" from "silently ignored", so a planner reasons about a screen that never changed
and a test passes having never performed the step. On iOS this covers `copyText`, `pasteText`,
`hideKeyboard`, `getAppList` and `setLocation`, via the shared `unsupportedOnIOS(_:)` helper — except
`getAppList`, which returns `FRAppListResponse` and sets the same three fields inline, because an
empty `apps` list with `success = true` is indistinguishable from a device with no apps installed.
The shape matches what Android already returns for its own unimplemented actions and what iOS's own
`back` handler uses. Implementing the five natively is out of scope of the reporting fix.

**The live blast radius is `hideKeyboard`.** Of the five, only `hideKeyboard` is reachable from
TypeScript through the driver: a planner step emitting `PLANNER_ACTION_HIDE_KEYBOARD`
(`ActionExecutor.ts`) reaches `IOSSimulator.ts:131` → `CommonDriverActions.hideKeyboard()` → the gRPC
`HideKeyboard` RPC, which answers `success: false`. `setLocation` reaches the simulator through
`simctl` (`IOSSimulator.ts:228`), never the driver, and `copyText`, `pasteText` and `getAppList` have
no planner path at all. An iOS `hideKeyboard` failure in a run report is this contract working, not a
regression: the keyboard was never dismissed either way.

#### Scenario: a CopyText RPC against the iOS driver

- **GIVEN** a `CopyText` RPC
- **WHEN** it returns
- **THEN** `success` is `false` and the message names the action as unsupported on iOS

### Requirement: The three Android hierarchy traversals diverge, and the divergence is documented rather than unified

`AccessibilityStreamer.kt` exposes three hierarchy traversals that return **different trees for the
same screen**, and each MUST document its filtering, its root-cache behaviour and its callers:

- **`getHierarchy`** — visibility-filtered (`processNodeRecursive` descends into a child only when
  `child.isVisibleToUser || insideWebView`) over the **cached** window roots (`getWindowRootsFast`).
  Callers: the two streaming paths — `DriverServiceImpl.startStreaming` (the gRPC `StartStreaming`
  stream) and `ScreenStreamer.startStreaming` (the legacy WebSocket frame loop).
- **`getHierarchyForStreaming`** — **unfiltered** over the cached roots, so a strictly larger tree
  than `getHierarchy`. Despite the name, streaming does not use it: callers are
  `ScreenStreamer.sendHierarchy` and `DeviceActions.getHierarchy()`.
- **`getHierarchyForStreamingRefreshed`** — **unfiltered** over **refreshed** roots
  (`getWindowRoots`). Same node set as `getHierarchyForStreaming`; the difference is cache freshness,
  which costs a refresh per call. Callers: the gRPC `GetHierarchy` and `GetScreenshotAndHierarchy`
  RPCs.

So a client receives a visibility-filtered tree while streaming and an unfiltered one from
`GetHierarchy`/`GetScreenshotAndHierarchy`, and the planner prompt is built from whichever it got.
Unification MUST NOT be performed as a side effect of another change: it alters what the planner LLM
sees, in native code with zero test coverage, and belongs in its own change with evidence.

`findStableFocusedNodeInRoot` in the same file offers **no** bounds-stability guarantee despite its
name: `initialBounds` is captured once and never re-captured, the loop returns on the first reading
that matches it, and the node is returned unconditionally once the ten 500 ms polls are exhausted.
Both exits produce the same value, so the loop's only observable effect is a delay of up to ~5 s for
a node whose bounds keep changing. Its result is "the focused node", never "a node that has settled".

#### Scenario: two RPCs are asked for the hierarchy of one screen

- **GIVEN** a screen with an off-screen subtree
- **WHEN** a client calls `StartStreaming` and then `GetHierarchy`
- **THEN** the streaming tree omits the invisible nodes and the `GetHierarchy` tree includes them

### Requirement: A native change ships compile-verified only

There is **no Kotlin or Swift unit-test harness in this repository**, and this contract's native side
cannot be behaviourally tested by anything in the tree: `drivers/android/app/src/androidTest/` *is*
the driver (a single `@Test` starting a gRPC server and blocking forever, zero assertions anywhere),
the only file under `app/src/test/` is an `assertEquals(4, 2+2)` scaffold, and `drivers/ios` has no
test target. The `.github/workflows/drivers.yml` compile gate
([/ci/pr-quality-gate.md](/ci/pr-quality-gate.md)) is the only automated verification native code
gets, and it proves compilation and linking — never that a tap lands where it was asked to. That gate
is also **path-filtered**: it runs only when a diff touches one of the paths it names (the list, and
why `proto/**` is on it, are in that file), so a change that breaks a native build while touching no
listed path merges with no automated verification at all — which makes widening the filter part of
adding any new native build input.

**The ceiling is lower on the iOS side of this contract than on the Android side: a green `ios` job is
not evidence the committed Swift bindings match `driver.proto`.** The Android driver compiles the proto
**from source** (`drivers/android/app/build.gradle.kts:104` puts the repo-root `proto` directory on the
protobuf source path), so a schema edit that breaks Kotlin fails the `android` job. iOS compiles the
**committed generated** Swift at `drivers/ios/finalrun-ios-test/Generated/finalrun/driver.pb.swift`,
and there is **no Swift codegen anywhere in this repository** — nothing regenerates that file, and
nothing compares it against the schema. A proto edit that leaves it untouched therefore desyncs the
iOS bindings, and the `ios` job compiles and links that untouched file and reports green. Keeping
the committed Swift in step with `driver.proto` is a **manual obligation of every proto change**, and
no CI signal substitutes for it: `proto/**` sits on the gate's paths filter for the Android compile's
sake ([/ci/pr-quality-gate.md](/ci/pr-quality-gate.md)), which means the workflow *runs* on a proto
edit but cannot check the half that has no generator.

A change to Kotlin or Swift in this repo is therefore **source-verified plus compile-verified**, and
MUST be described that way. Behavioural confirmation needs a manual device session. Where a native
change's correct behaviour happens to be pinned by the TypeScript side — the 0–1 fraction contract is
the case, fixed by the client's own test fixtures — say so, and where it is not (the screenshot
default, the fps arithmetic, the unsupported-action responses, the streamer's documentation), do not
imply otherwise.

#### Scenario: a native fix is prepared in an environment with no native toolchain

- **GIVEN** a development environment with no JDK, no Android SDK and no Xcode
- **WHEN** a Kotlin or Swift change is made
- **THEN** it cannot be compiled locally, the pull request's `drivers` workflow run is its first execution, and the change records that its verification is compilation rather than behaviour

#### Scenario: a proto edit that leaves the committed Swift untouched

- **GIVEN** a change to `proto/finalrun/driver.proto` that does not regenerate
  `drivers/ios/finalrun-ios-test/Generated/finalrun/driver.pb.swift`
- **WHEN** the `drivers` workflow runs (it does — `proto/**` is on its paths filter)
- **THEN** the `android` job compiles the edited schema from source, while the `ios` job compiles the
  stale committed Swift and reports **green** — the desync is invisible to every automated check in the
  repository and is caught only by regenerating or reading the bindings

## Design Decisions

### `null` from `getXYPercentOnScreen` means out-of-range, not zero

**Decision**: The Android conversion keeps a nullable return, guarded by a `0.0..1.0` range test
rather than by a zero test and rather than being made non-nullable.

**Why**: `DriverServiceImpl.tapPercent` already converts `null` into an explicit `TapPercent failed`
response, so the arity is worth keeping and the only question is what `null` should mean. Pointing it
at genuinely invalid input costs one line, changes no signature, and makes an existing error path mean
something; a zero test instead rejects a legitimate left/top-edge tap, and no test at all makes the
path dead and turns a client bug (a 0–100 caller, or `NaN`) into a tap at a Kotlin-truncated
off-screen coordinate. The guard being Android-only is a deliberate, documented asymmetry in
validation — iOS multiplies unguarded — not a divergence in the computed value.

**Rejected**: (a) removing the guard and making the return non-nullable — ripples into the caller and
discards the only validation of a cross-language unit contract the proto cannot express; (b) clamping
out-of-range input into `0.0..1.0` — silently taps somewhere the caller did not ask for, which is the
same class of defect as a `/100` on a fraction; (c) adding the same guard to iOS for symmetry — a
behaviour change on a platform with no reported defect, in code with no test harness.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### An unimplemented RPC reports failure, and the one live consumer is recorded rather than exempted

**Decision**: The five iOS no-op handlers return `success = false`, and the blast radius is written
down rather than softened. `hideKeyboard` is the one action of the five with a live TypeScript consumer
through the driver, so a planner step emitting `PLANNER_ACTION_HIDE_KEYBOARD` against an iOS device
surfaces a failure.

**Why**: A success reported by a handler that performs nothing is false — the keyboard is not
dismissed — so a planner that "succeeds" goes on to reason about a screen that has not changed. One
honestly-failing action, visible in the run report, is the outcome this rule exists to produce; a
silent no-op is the defect it removes. Recording the radius is what lets the first person to see an
iOS `hideKeyboard` failure recognise it as the contract working instead of a regression to bisect.

**Rejected**: (a) leaving `hideKeyboard` returning `success = true` while fixing the other four —
keeps the one lie that has a live consumer and fixes the four that have none, exactly backwards; (b)
implementing `hideKeyboard` natively — feature work in code with no test harness, and a different
change; (c) mapping the failure to a soft skip in `ActionExecutor` — hides the same information one
layer up, in a package the fix does not touch.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### The three hierarchy traversals are documented, deliberately not unified

**Decision**: Each traversal's filtering, root-cache behaviour and callers are stated in its doc
comment, and no traversal body is changed. The divergence stands.

**Why**: The three trees are what the planner prompt is built from, so unifying them changes what the
LLM sees on every step — a behaviour change to the product's core loop, made in native code with zero
test coverage, with no way to observe the difference short of a manual session. Documenting first is
what makes a later unification arguable: a reader can see which RPC returns which tree and decide,
with evidence, which one is right. Leaving them undocumented is the state in which someone "aligns"
them as a tidy-up.

**Rejected**: (a) unifying on the visibility-filtered traversal — silently shrinks what
`GetHierarchy` returns, and the planner's behaviour on the smaller tree is unmeasured; (b) unifying on
the unfiltered traversal — silently grows every streaming frame's payload and prompt; (c) leaving the
divergence undocumented as a known quirk — the quirk is invisible from any single call site, which is
how three traversals came to exist.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### A false guarantee in a comment is deleted, not implemented

**Decision**: `findStableFocusedNodeInRoot`'s doc comment describes what its polling loop does — and
states outright that it offers no bounds-stability guarantee. No stability wait is implemented to make
the name true.

**Why**: The loop cannot deliver the guarantee its name suggests: `initialBounds` is never re-captured
and the node is returned unconditionally when the polls run out. That behaviour is what every caller
is built against, so implementing a real wait would change streaming latency in native code with no
test coverage — a behaviour change disguised as making a comment true. Stating the absence costs
nothing and removes the trap for the next reader.

**Rejected**: (a) implementing the wait so the name becomes accurate — a latency change in untested
native code, adopted to justify a comment; (b) renaming the function instead — the misleading part is
the promise in the comment, and the rename would touch call sites for no behavioural gain; (c) leaving
the comment and noting the discrepancy elsewhere — a false guarantee at the definition outranks a
correction anywhere else.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### The proto states what the language can enforce, and comments carry only what it cannot

**Decision**: A constraint the schema language can express is written in the language — `reserved 4;`
for a retired tag — and the comments in `driver.proto` are reserved for what it cannot: units,
defaults, and which implementations must agree.

**Why**: Runtime schema resolution is what makes the distinction load-bearing here. A comment saying a
tag was removed is invisible to `@grpc/proto-loader`, so reusing the tag produces silent
misdeserialisation of old wire bytes rather than any error; `reserved` turns the same mistake into a
parse failure at load. The inverse also holds: a `double x_percent` cannot express "a fraction in
0..1", so that fact has nowhere to live *but* a comment, and omitting it leaves three implementations
each to guess. The rule sorts each fact to the place that can enforce it.

**Rejected**: (a) a comment alone for the retired tag — the case that produces a silent wire-format
defect; (b) omitting the unit comment because the proto "should be self-describing" — the type system
here cannot describe it, and three implementations each guessed; (c) encoding the range as a
validation-carrying wrapper message — a schema change rippling through three generated clients to
express what one sentence and one Kotlin guard already cover.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### Native verification is stated at its real ceiling

**Decision**: A change to Kotlin or Swift in this repo is described as compile-verified and
source-verified, never as tested. No Kotlin/Swift harness is invented to close the gap, and no native
behaviour claim is presented as confirmed.

**Why**: The tree offers no way to confirm one: the Android instrumentation tree is the driver rather
than a test suite, and iOS has no test target, so a green pipeline says only that the code builds.
Claiming more is the exact failure this whole file exists to prevent — an assertion of a property that
nothing in the repo checks. Stating the ceiling also prices the next decision
honestly: deleting native code, or unifying the hierarchy traversals, is a manual-session risk, not a
suite-covered refactor.

**Rejected**: (a) writing a token native test so the tree "has coverage" — a test that asserts
nothing reads as coverage and is worse than a recorded gap; (b) building the harness inside a defect
fix — a harness is its own change with its own argument, and bundling it hides which half a review
certified; (c) declaring the native fixes verified on the strength of the compile gate — the gate
proves linking, and the defects being fixed are arithmetic and response-shape defects that compile
perfectly well either way.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects
