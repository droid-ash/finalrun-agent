# Intake: Drivers CI Compile Gate + Audit Defect Fixes

**Change**: 260730-zga4-drivers-ci-gate-audit-defects
**Created**: 2026-07-30

## Origin

> Add a CI compile gate for drivers/ (Kotlin + Swift), then fix ~20 confirmed defects found during a repo-wide comment-quality audit. Excludes dead-code deletion, the comment sweep, policy encoding, and packages/report-web.

**Interaction mode**: conversational. This change is the first of a planned sequence produced by a repo-wide audit, not a standalone request.

**How this arose.** The user asked how to apply the guidance in <https://javascript.info/comments> to this codebase. That article's nine points were distilled into a rubric (points 1–4: a comment explaining *what* code does is a smell, fix by restructuring; points 5–8: architecture, function contracts, rationale, and subtle behaviour MUST be written; point 9: the same comment text can be good or bad depending on whether it says what or why, so the judgement is not mechanizable). Seven read-only subagents then audited **all 234 code files** in the repo against that rubric — every file, with line counts, comment counts, and a `TESTED`/`UNTESTED` verdict per refactor target. Full per-file evidence lives in seven reports written during that session (`audit-common.md`, `audit-device-node.md`, `audit-report-web.md`, `audit-cli.md`, `audit-goal-executor-cloud.md`, `audit-drivers.md`, `audit-build-tooling.md`).

The audit's headline result was that **the comment problems were the smaller finding**. It surfaced ~4,900 lines of dead code, ~497 missing good comments, and roughly twenty confirmed runtime defects — several of which are silent data loss. The user chose to sequence the defect work first, as change **A+B**:

- **A** — a CI compile gate for `drivers/`, because none exists.
- **B** — the confirmed defects.

Later changes (explicitly out of scope here) will handle dead-code deletion, the comment sweep, and encoding the comment policy into `fab/project/code-quality.md` / `code-review.md`.

**Decisions taken during the conversation** (each recorded as a graded assumption below):

| Question asked | User's answer |
|---|---|
| Adopt jsdom/testing-library to unblock `report-web`'s 12 DOM-blocked refactors? | "leave it" — `report-web` is out of scope entirely |
| Make ESLint rules blocking in CI? | "leave it" — no lint-enforcement change |
| Start with A+B? | Yes |
| Android never overrides the `Swipe` RPC — implement, error, or defer? | "let's not change behavior we are just refactoring" — leave `Swipe` untouched |
| `AccessibilityStreamer` promises 5s bounds stability the code never implemented — fix code or comment? | Delete the false promise |
| Three divergent hierarchy traversals — unify or document? | Document the divergence, defer unification |
| CI gate scope? | Both platforms on every PR |
| Scope conflict: "don't change behavior" vs. B being ~20 behaviour fixes? | **All 11 behaviour fixes** — B proceeds as originally approved |

## Why

**1. `drivers/` has no verification of any kind.** `grep -rniE 'drivers|gradle|xcode|kotlin|swift|android|ios' .github/workflows/` returns **no matches**. `package.json:18-20` defines `build:drivers`, `build:drivers:android`, and `build:drivers:ios`, and no workflow calls any of them. There is no ktlint, detekt, or swiftlint config in the repo.

The test situation is worse than "untested". `drivers/android/app/src/androidTest/` **is the driver itself** — 24 of 25 Kotlin files — where a single `@Test` starts the gRPC server and blocks forever; there are **zero assertions in the entire tree**. The only file under `app/src/test/` is `ExampleUnitTest.kt`, whose body is `assertEquals(4, 2+2)`. iOS has no unit-test target at all. Compounding this, `fab/project/config.yaml` lists `drivers/` under `source_paths` while its `test_paths` are TypeScript-only globs (`**/*.test.ts`, `**/*.spec.ts`), so no pattern can ever match a Kotlin or Swift test.

**Consequence of not fixing:** a bad edit to 48 native files is not caught by a failing test — it is caught by a dead device in someone's manual session. This also blocks the next planned change: deleting ~4,900 lines of dead native code is only safe behind a compile gate.

**2. The defects include silent data loss and a function that is wrong for every input.**

`getXYPercentOnScreen` in `drivers/android/.../TestUtils.kt:16-23` computes `((xP * screenWidth) / 100)`. The TypeScript client sends **fractions in 0–1**, never 0–100 — confirmed by `packages/common/src/models/test/DeviceAction.test.ts:19` (`PointPercent.fromJson({ xPercent: 0.25, yPercent: 0.75 })`) and `:29`, `:35`, `:45`, plus `packages/device-node/src/device/test/Device.test.ts:188` (`xPercent: 0.5, yPercent: 0.5`). So a centre tap at `0.5` on a 1080-wide screen resolves to `(0.5 * 1080) / 100 = 5.4 → 5` pixels. **Android `tapPercent` taps the top-left corner for every input.** iOS (`GrpcDriverServer.swift:141`, `Int(request.point.xPercent * Double(screenSize.width))`) is correct.

Three further defects silently destroy or corrupt data: log write-streams are never `.end()`ed (truncated logs, under a comment claiming they are flushed and closed), a recording is deleted before a rename that may fail (recording lost), and an iOS fps computation is integer division that always yields `0`.

**3. Why this approach over alternatives.** The gate must come first because five of the eleven fixes are in native code with no other verification. Splitting A from B would leave those five re-blocked. Splitting B's TypeScript fixes out would ship the safest half and leave the worst defect (Android `tapPercent`) in place. The gate plus the fixes is the smallest coherent unit.

## What Changes

### A1. New CI workflow: drivers compile gate

Add a workflow that builds both native drivers on every PR (both platforms, per the user's decision — an Android-only gate would leave 20 Swift files unguarded and would not make the later deletion change safe).

- **Android**: Gradle build producing the **debug + androidTest APK pair**. Both are required: the driver lives under `app/src/androidTest/`, so it runs as an instrumentation test and a release build produces artifacts that cannot host the driver. Reuse `scripts/build-drivers-android.sh` (17 lines, currently called by no workflow) rather than duplicating the Gradle invocation.
- **iOS**: `xcodebuild build-for-testing` (not plain `build`) — `build-for-testing` is what emits the `-Runner.app` that `scripts/build-drivers-ios.sh:22-25` requires and asserts at `:32-35`. Requires a macOS runner.
- **Compile only, no test execution.** Running `androidTest` would start the gRPC server and block forever (it contains zero assertions), so there is nothing meaningful to execute. The gate proves the code compiles and links.

Do **not** alter `ci.yml`'s existing job graph or the `test` check required by ruleset 14531661. This is additive.

### A2. `fab/project/config.yaml` — `test_paths` cannot match native tests

```yaml
# current — TypeScript-only, while source_paths includes drivers/
test_paths:
    - "**/*.test.ts"
    - "**/*.spec.ts"
```

Add Kotlin/Swift patterns so fab tooling can see native tests at all (e.g. `**/src/test/**/*.kt`, `**/src/androidTest/**/*.kt`, `**/*Tests.swift`). This is tooling configuration and changes no product behaviour.

### B1. Android `tapPercent` — wrong for every input

`drivers/android/app/src/androidTest/java/app/finalrun/android/TestUtils.kt:16-23`:

```kotlin
fun getXYPercentOnScreen(xP: Double, yP: Double): Pair<Int, Int>? {
    val screenWidth = getScreenWidth()
    val screenHeight = getScreenHeight()
    if (xP == 0.0 || yP == 0.0) return null          // ← B2: rejects a valid coordinate
    val x = ((xP * screenWidth) / 100).toInt()       // ← B1: /100 on a 0–1 fraction
    val y = ((yP * screenHeight) / 100).toInt()
    return Pair(x, y)
}
```

Remove the `/ 100` on both axes so the conversion matches the 0–1 fraction the client sends and matches iOS. Add a comment recording the unit contract (`x_percent` is a 0–1 fraction, not 0–100) — the proto declares only `double x_percent` with no documented range (`proto/finalrun/driver.proto:19-22`), which is how the two platforms diverged.

### B2. Android `tapPercent` — `0.0` rejected

Same function: `if (xP == 0.0 || yP == 0.0) return null` makes a tap at the left or top edge return `null`, which surfaces as a failure. `0.0` is a legitimate coordinate. Remove the guard. If a null-guard is genuinely wanted, it should reject out-of-range values (`< 0.0 || > 1.0`), not zero.

### B3. iOS screenshot `quality` default is the outlier

`drivers/ios/finalrun-ios-test/GrpcDriverServer.swift:465` and `:501`:

```swift
let quality = request.hasQuality ? Int(request.quality) : 10  // Match Dart default
```

Three live implementations agree on **5** — `packages/device-node/src/grpc/GrpcDriverClient.ts:289`, `:309`, `:323` all send `quality: quality ?? 5`; Android uses 5; `proto/finalrun/driver.proto:129`, `:139`, `:147`, `:156` all document `Default: 5`. iOS's `10` cites "Match Dart default", and **there are no `.dart` files in this repo** (`git ls-files | grep -c '\.dart$'` = 0), so the justification is unverifiable and contradicted by every live consumer. Change both sites to `5` and drop the stale Dart citation.

### B4. iOS fps calculation is integer division

`drivers/ios/finalrun-ios-test/.../XCViewHierarchyManager.swift:51` — `Double(1/(fps ?? 1))`. The division happens in `Int` before the `Double` conversion, so `1/24 == 0`. Android hit this same trap, fixed it, and documented it in `TestUtils.kt:31-42` (`calculateFrameDelay`, using `1000.0 / fps.toDouble()` with a KDoc explaining the floating-point requirement). Mirror that fix on iOS and cite the Android precedent.

### B5. Log write-streams are never closed

`packages/device-node/src/device/AndroidLogcatProvider.ts:142` and `packages/device-node/src/device/IOSLogProvider.ts:119` both carry the comment `// Flush and close the write stream piped from stdout` above code that calls only `stdout.unpipe()`. The `writeStream` is never `.end()`ed on **any** path, so buffered log data is lost — device logs are silently truncated. Call `.end()` (awaiting the `finish` event where the caller needs the file complete before reading it) and correct the comment to describe what the code does.

### B6. Recording is deleted before a rename that can fail

`packages/device-node/src/device/IOSRecordingProvider.ts:223-224` does `rm(original)` and then `rename(compressed, original)`. A same-directory `rename` overwrites atomically on POSIX, so the `rm` is unnecessary — and if the `rename` fails after the `rm`, **the recording is gone**. Drop the `rm` and rename directly over the target. Also name the bare `-crf 40` magic number.

### B7. Mutating actions can execute twice

`packages/device-node/src/device/ios/IOSSimulator.ts:352` — `_withDriverRecovery` re-executes `fn()` after a driver restart. This directly contradicts `packages/device-node/src/grpc/GrpcDriverClient.ts:342`, which states retries default to 0 *"to prevent duplicating mutating actions"*. A tap or text entry can therefore be applied twice. Make the recovery path not re-execute mutating actions (or gate re-execution to read-only operations), and reconcile the two comments so they no longer contradict.

### B8. Disconnection notification does nothing

`packages/device-node/src/device/Device.ts:374` — `_disconnectionCallback` is assigned but **never invoked**, so registering a disconnection handler silently has no effect. Invoke it on the disconnection path, or if the feature is genuinely unimplemented in this TypeScript port, say so explicitly in a comment rather than presenting a working-looking API. Prefer invoking it.

### B9. `checkCommandOnPath` is wrong on every Windows host

`packages/cli/src/hostPreflight.ts:65` shells to `which` unconditionally. `packages/cli/src/upgradeCommand.ts:54` and `packages/cli/src/reportServerManager.ts:93` both branch on `win32`, so the codebase already knows Windows needs different handling. Every `checkCommandOnPath` result on Windows is a silent false negative. Use `where` on `win32`, following the existing pattern in those two files rather than introducing a new abstraction.

### B10. `upload.ts` timeout parser accepts non-integers

`packages/cloud-core/src/upload.ts:29` uses `Number.isFinite`, so `1.5` passes a check whose own error message says *"must be a positive integer"*. The sibling `packages/cloud-core/src/submit.ts:63-66` was already fixed to `Number.isInteger`, documented, and covered by a test at `submit.test.ts:652-657` — **the fix never propagated**, and `upload.ts` has zero tests. Change to `Number.isInteger` and extract the shared parser so the two copies cannot diverge again (this duplication is itself a point-2 finding from the audit).

### B11. iOS fabricates success for five no-op actions

`copyText`, `pasteText`, `hideKeyboard`, `getAppList`, and `setLocation` return `success = true` on iOS while doing nothing; Android returns explicit errors for the same actions. A caller cannot distinguish "done" from "silently ignored". Return explicit "not supported on iOS" errors matching Android's shape. **Implementing these five natively is out of scope** for a defect change.

### B12. `killDriver` kills no driver (no behaviour change)

`packages/device-node/src/device/shared/CommonDriverActions.ts:239-245` — `close()` and `killDriver()` have **identical bodies**, and `killDriver` closes a gRPC channel, leaving the instrumentation host / XCUITest runner alive. Two identical bodies invite the next reader to collapse them. Document what each actually does and rename `killDriver` to reflect it (e.g. `closeDriverChannel`). No runtime behaviour changes.

### B13. `driver.proto` — missing `reserved` statement

`proto/finalrun/driver.proto:97` reads `// Field 4 was deep_link - removed now`, and the file contains **no `reserved` statement anywhere**. proto-loader resolves the schema at **runtime**, so reusing tag 4 would silently misdeserialise old wire bytes with no error. Replace the comment with `reserved 4;` — one line of code that the language enforces, where prose cannot. This is the article's thesis exactly: the comment was doing a job the language does better.

### B14. `AccessibilityStreamer` — delete the false guarantee (no behaviour change)

`drivers/android/.../data/hierarchy/AccessibilityStreamer.kt:47-58` carries a comment promising element bounds "stay the same for 5 seconds", but the loop never resets `initialBounds` and `return node` at `:58` is unconditional — **the guarantee does not exist and never did**. Per the user's decision, delete the false promise rather than implement the wait. The current behaviour is what has always shipped; implementing a stability wait would change streaming latency in untested native code.

### B15. `AccessibilityStreamer` — document the three divergent traversals (no behaviour change)

The same file contains three hierarchy traversals: streaming uses a visibility-filtered path, while `GetHierarchy` and `GetScreenshotAndHierarchy` use an unfiltered path. Clients therefore receive **different trees depending on which RPC they call**, and the planner prompt consumes this. Per the user's decision: document which RPC returns which tree and why, and **change no behaviour**. Unification alters what the planner LLM sees, in native code with zero tests, and belongs in its own change with evidence.

### Explicitly NOT in this change

- `Swipe` RPC (`proto:266`, implemented on iOS, not overridden on Android → silent `UNIMPLEMENTED`) — left entirely untouched per the user's decision.
- Dead-code deletion (~4,900 lines: `TestActions.kt` 1,291 lines, `XCTestManager.swift` 437 lines with zero callers, 27 unreferenced constants in `packages/common/src/constants.ts`, and others).
- The comment/documentation sweep (~497 missing good comments, ~146 restatement removals, the four undocumented security controls, ~10 factually wrong comments).
- Encoding the comment policy into `fab/project/code-quality.md` and `code-review.md`.
- All structural refactors (points 1–3 of the rubric).
- **Everything in `packages/report-web`** — the user declined adopting a DOM test environment, so its 12 blocked refactors stay blocked.
- Making ESLint rules blocking in CI — the user declined.

## Affected Memory

- `ci/pr-quality-gate`: (modify) add the new drivers compile gate — both platforms on every PR, compile-only, and why no test execution (androidTest has zero assertions and blocks forever)
- `drivers/grpc-contract`: (new) new domain. The cross-language gRPC contract and its per-platform divergences: `x_percent` is a 0–1 fraction (not 0–100), screenshot `quality` defaults to 5 across all three implementations, `reserved 4;` replacing the deep_link prose, the fps floating-point requirement, and the documented three-traversal hierarchy divergence
- `device-node/log-capture`: (modify) write-streams must be `.end()`ed or log data is truncated
- `device-node/android-ios-mirror`: (modify) recording compression renames atomically without a prior `rm`; driver recovery must not re-execute mutating actions; `killDriver` closes a channel and kills nothing; `_disconnectionCallback` is now actually invoked
- `cloud-core/submit-pipeline`: (modify) the timeout parser is shared between `submit.ts` and `upload.ts` so the two cannot diverge again
- `cli/host-preflight`: (new) command-on-PATH probing is platform-branched (`where` on win32, `which` elsewhere)

## Impact

**Code areas**: `.github/workflows/` (new workflow), `fab/project/config.yaml`, `proto/finalrun/driver.proto`, `drivers/android` (2 files), `drivers/ios` (2 files), `packages/device-node` (6 files), `packages/cli` (1 file), `packages/cloud-core` (2 files).

**Cross-language contract**: `proto/finalrun/driver.proto` is consumed by Kotlin, Swift, and TypeScript. B1/B3/B13 change the contract's documented semantics; all three implementations must end up agreeing.

**Verification asymmetry — the key risk.** The six TypeScript defects (B5–B10) can carry real regression tests: `device-node` has 13 test files, `cli` has 11, `cloud-core` has 1. The five native defects (B1–B4, B14) **cannot** — the new gate proves they compile, not that a tap now lands in the right place. Behavioural confirmation of the native fixes requires a manual device session, which this change does not automate. B1 is the highest-confidence native fix because the correct behaviour is pinned by the TypeScript client's own test fixtures.

**Dependencies**: no new runtime dependencies. The iOS gate requires a macOS CI runner (`release.yml:144` already provisions a `windows-latest` runner, establishing the multi-OS precedent).

**Downstream**: the compile gate is a prerequisite for the planned dead-code deletion change.

## Open Questions

- Should `getXYPercentOnScreen` gain an out-of-range guard (`< 0.0 || > 1.0`) to replace the removed `xP == 0.0` check, or return the clamped coordinate? Current behaviour for out-of-range input is undefined on both platforms.
- Does `_withDriverRecovery` (B7) need a read-only/mutating classification per action, or is disabling re-execution wholesale acceptable? The former is more correct; the latter is smaller and safer in untested code.
- Is there a macOS runner budget constraint that should cap the iOS gate to `paths: drivers/ios/**` rather than every PR?

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `packages/report-web` excluded entirely; its 12 DOM-blocked refactors stay blocked | Asked — user answered "leave it" to adopting jsdom/testing-library | S:95 R:85 A:95 D:95 |
| 2 | Certain | No change to ESLint rule severity or CI lint enforcement | Asked — user answered "leave it" | S:95 R:90 A:95 D:95 |
| 3 | Certain | `Swipe` RPC left entirely untouched — no implementation, no explicit error | Asked — user answered "let's not change behavior we are just refactoring" | S:90 R:90 A:90 D:90 |
| 4 | Certain | Delete the false 5-second bounds promise rather than implement the wait | Asked — user chose "Delete the false promise"; current behaviour is what has always shipped | S:90 R:85 A:85 D:90 |
| 5 | Certain | Document the three-traversal hierarchy divergence; defer unification to its own change | Asked — user chose "Document the divergence, defer unification" | S:90 R:90 A:85 D:90 |
| 6 | Certain | CI gate covers both Android and iOS on every PR, compile-only | Asked — user chose "Both platforms on every PR" | S:90 R:80 A:85 D:90 |
| 7 | Certain | All 11 behaviour fixes included; the "don't change behavior" instruction applies only to `Swipe` | Asked — surfaced the conflict explicitly; user chose "All 11 behavior fixes (original B)" | S:95 R:60 A:85 D:90 |
| 8 | Certain | Screenshot `quality` default is 5; iOS's 10 is the defect | Determined from codebase — TS sends `?? 5` at all three call sites, Android uses 5, proto documents 5 at four sites, and the iOS "Match Dart default" citation refers to a Dart codebase with 0 files in this repo | S:85 R:85 A:85 D:85 |
| 9 | Confident | Android is the wrong side of the `tapPercent` divergence; remove `/100`, iOS is correct | Determined from codebase — the TS client's own fixtures use 0–1 fractions (`DeviceAction.test.ts:19,29,35,45`; `Device.test.ts:188`), never 0–100. Not user-confirmed, but the evidence is unambiguous | S:85 R:55 A:85 D:80 |
| 10 | Confident | Remove the zero-coordinate rejection in `getXYPercentOnScreen` — `0.0` is a legitimate tap coordinate | Inferred, not user-confirmed. A left/top-edge tap currently fails. Replacement range-guard left as an open question | S:70 R:70 A:75 D:75 |
| 11 | Confident | iOS's five no-op actions return explicit "not supported" errors matching Android, rather than being implemented natively | Implementing five native features is feature work, not defect repair, and would expand an already-large change | S:75 R:65 A:80 D:75 |
| 12 | Confident | Create a new `drivers/` memory domain for the cross-language gRPC contract | No `drivers` domain exists today (only ci, cli, cloud-core, common, device-node, report-web) and the proto contract has no natural home in any of them | S:70 R:80 A:80 D:70 |
| 13 | Confident | `hostPreflight` Windows fix follows the existing `win32` branch pattern from `upgradeCommand.ts:54` / `reportServerManager.ts:93` | Two in-repo precedents exist; introducing a new platform abstraction would exceed the defect's scope | S:75 R:80 A:85 D:75 |
| 14 | Tentative | The five native fixes ship compile-verified only, with no behavioural test | No native unit-test harness exists and this change does not create one. A wrong native fix reaches real devices and is expensive to discover. B1 is partly mitigated because the correct behaviour is pinned by the TS client's fixtures; B3/B4/B14 are not | S:65 R:35 A:50 D:45 |

14 assumptions (8 certain, 5 confident, 1 tentative, 0 unresolved).
