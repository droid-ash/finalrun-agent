# Intake: Delete Dead Code From the Four Audit Targets

**Change**: 260731-3vhw-delete-dead-code-audit-targets
**Created**: 2026-07-31

## Origin

> Delete dead code, roughly 4,900 lines, at near-zero risk. Four targets from the code audit, all reported as unreferenced. (1) TestActions.kt in the Android driver tree — 1,291 lines of which 1,290 are commented out, zero references anywhere. (2) XCTestManager.swift in the iOS driver tree — 437 commented lines, zero callers. (3) 27 unreferenced constants in packages/common/src/constants.ts. (4) Dead code in the cli and device-node packages. Re-derive every reference count yourself before deleting anything — do not trust the audit numbers, verify them. This PR touches driver paths so the drivers CI compile gate will run on it, which is the safety net that makes the native deletions checkable. Extra care on the native deletions specifically: on an earlier change to this repo, internal review passes missed a Swift crash that only an external reviewer caught, so do not treat a clean internal review as sufficient evidence for the Kotlin and Swift removals.

**Interaction mode**: one-shot, detailed directive. This is the explicitly planned successor to `260730-zga4-drivers-ci-gate-audit-defects`, whose intake deferred "dead-code deletion (~4,900 lines: `TestActions.kt` 1,291 lines, `XCTestManager.swift` 437 lines with zero callers, 27 unreferenced constants in `packages/common/src/constants.ts`, and others)" to a later change and named the drivers compile gate as its prerequisite. That gate now exists (`.github/workflows/drivers.yml`, merged in PR #167/#168 era) and path-triggers on `drivers/**`, so the prerequisite is satisfied.

**Provenance of the target list**: a repo-wide comment-quality audit (seven read-only subagents over all 234 code files, documented in the zga4 intake). The per-file audit reports (`audit-common.md`, `audit-drivers.md`, `audit-cli.md`, `audit-device-node.md`, etc.) were session artifacts and are **not committed to the repo** — only the headline numbers survive, quoted in the zga4 intake. This matters for target 4 (below): its candidate list must be re-derived entirely from scratch.

**Binding user directives** (verbatim intent, each carried into What Changes):
1. Re-derive every reference count before deleting — audit numbers are hints, not evidence.
2. The drivers CI compile gate is the safety net that makes the native deletions checkable — it must actually run and pass on this PR.
3. A clean internal review is NOT sufficient evidence for the Kotlin/Swift removals — an earlier change's Swift crash survived internal review passes and was caught only by an external reviewer. Native deletions need mechanical per-line verification plus the external review stage.

## Why

**Problem.** The audit surfaced ~4,900 lines of dead code. Dead code is not free: `TestActions.kt` is a 1,292-line file whose only live line is its `package` declaration; `XCTestManager.swift` carries ~480 lines of commented-out code interleaved with a live, actively-used class; `constants.ts` exports whole families of constants nothing imports, under header comments that falsely claim consumers ("used by HeadlessActionExecutor" — re-derived reference count: zero). Every reader (human or agent) pays the cost of distinguishing live from dead, and the false header comments actively misdirect.

**Consequence of not fixing.** The audit's follow-up sequence stalls: the comment-quality sweep (a later planned change) would waste effort improving comments on code that should not exist, and the misleading "used by" headers keep training readers on wrong facts.

**Why this approach.** Deletion-only, verification-heavy, behind two existing CI gates. The zga4 change built the drivers compile gate *specifically* so this deletion would be checkable; the TypeScript side is covered by the required `test` check (ruleset 14531661: `npm ci` → build → typecheck → test → lint). The alternative — trusting the audit's counts and deleting wholesale — is explicitly ruled out by the user, and intake verification already proved that right: the audit's "XCTestManager.swift … zero callers" is **factually wrong at file level** (the class is instantiated at `GrpcDriverServer.swift:49`); only the commented blocks inside it are dead.

## What Changes

Deletions only. No refactors, no renames, no behavior changes, no reformatting of surviving code. Each target follows the same discipline: **re-derive the reference evidence, record it, then delete exactly what the evidence covers.**

### Target 1: Delete `drivers/android/app/src/androidTest/java/app/finalrun/android/action/TestActions.kt` (whole file)

**Verified at intake** (re-derived, not taken from the audit):
- File is 1,292 lines (audit said 1,291 — likely a trailing-newline counting difference).
- `grep -cv '^\s*//'` → exactly **1 non-comment line**: line 1, `package app.finalrun.android.action`.
- `grep -rn "TestActions" drivers/android --include="*.kt" --include="*.gradle*"` excluding the file itself → **zero references**. Kotlin has no header/registration file (unlike Xcode's pbxproj), so file deletion needs no companion edit.

**Action**: delete the file. Apply must re-run both derivations above before deleting (the working tree may have moved since intake).

**Verification**: the drivers workflow's Android job (Gradle debug + androidTest APK build via `scripts/build-drivers-android.sh`) must compile green with the file gone.

### Target 2: Delete the commented-out code blocks inside `drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift` (file stays)

**Verified at intake — the audit claim needs correction**: the audit reported "437 commented lines, zero callers", which reads as a dead file. It is not:
- `XCTestManager` is **live**: `GrpcDriverServer.swift:49` (`private let testManager = XCTestManager()`), `:97` (property of a nested type), `:141` (init injection alongside `XCViewHierarchyManager`). It is also registered in `finalrun-ios.xcodeproj/project.pbxproj`.
- The file is 859 lines total, of which 529 are `//`-prefixed. The dead portion is the contiguous commented-out **code** blocks, located at intake as: lines 300–339 (40 lines), 346–707 (362 lines), 729–754 (26 lines), 806–858 (53 lines) — ~481 lines in blocks over 20 lines. The audit's 437 does not match any single derivation; the re-derived block boundaries govern.

**Action**: delete only the commented-out *code* blocks. The live class, its methods, and genuine documentation comments on live code all stay. Apply must re-derive the exact block boundaries (line numbers above will shift as sibling changes land) and verify each deleted line is comment-only. The file is NOT deleted, and `project.pbxproj` is NOT touched.

**Verification**: the drivers workflow's iOS job (`xcodebuild build-for-testing` via `scripts/build-drivers-ios.sh` on macOS) must compile green. Additionally, because Swift is the language where this repo has a documented review miss (see Binding directive 3), the diff for this file must be mechanically checked: every removed line matches `^\s*//` (or is a blank line orphaned between removed blocks), zero live lines removed.

### Target 3: Delete re-derived-unreferenced constants from `packages/common/src/constants.ts`

**Verified at intake** (spot-check of 14 of the file's exports, `grep -rw {NAME} packages --include="*.ts"` excluding the defining file):

| Dead (0 external refs) | Live (refs) |
|---|---|
| `ACTION_TYPE_TAP` | `PLATFORM_ANDROID` (93), `PLATFORM_IOS` (62) |
| `STATUS_SUCCESS`, `STATUS_RUNNING`, `STATUS_COMPLETED` | `FEATURE_PLANNER` (18) |
| `DEFAULT_SWIPE_DURATION_MS` | `PLANNER_ACTION_TAP` (17), `PLANNER_ACTION_DEEPLINK` (7) |
| `ENV_BASE_URL`, `ENV_DEBUG` | `MODEL_FORMAT_EXAMPLE` (6), `DEFAULT_MAX_ITERATIONS` (2) |

The spot-check confirms the audit's *direction* (whole families are dead — the `ACTION_TYPE_*` family's header comment "used by HeadlessActionExecutor to route actions" is false) while proving deletion must be **per-constant**: dead and live constants sit adjacent in the same sections.

**Action**: for **every** export in the file (constants, types, interfaces, functions — the file also holds `parseModel`, `ParsedModel`, `FeatureOverride`, etc.), re-derive references across all of `packages/` (word-boundary grep on the symbol name, all `.ts` files, excluding `constants.ts` itself). Delete exactly the exports with zero references. The audit's "27" is **not a target count** — the re-derived set governs, whether it is 24 or 31. Derivation cares:
- **Chain references**: a constant referenced only from within `constants.ts` by another *dead* export is itself dead (delete the chain together); one referenced by a *live* export (e.g., `FEATURE_*` members inside the live `ALL_FEATURES` array) is live.
- **Barrel re-exports**: check whether `packages/common/src/index.ts` re-exports `constants.ts`; a barrel line mentioning the symbol is not a real consumer.
- Header comments claiming usage are evidence of nothing (already proven false once).
- Section header comments whose entire section is deleted go with the section.

**Verification**: workspace `tsc` typecheck + full test suite via the required `test` check.

### Target 4: Dead code in `packages/cli` and `packages/device-node` — re-derived from scratch

The audit's per-file findings for these packages are not in the repo, so there is no list to verify — the candidate set must be **derived, not confirmed**. Intake reconnaissance found:
- **No whole-file dead candidates**: every non-test, non-index `.ts` file in both packages has its basename referenced from at least one other file.
- One contiguous commented block >15 lines: `packages/device-node/src/device/logWriteStream.ts` (a ~22-line block; the file's other ~43 comment lines look like genuine contract documentation — `docs/memory/device-node/log-capture.md` documents this file's finalization contract, so its doc comments are load-bearing and must survive).

**Action**: within these two packages only, derive dead code as: (a) exported symbols with zero references outside their defining file (word-boundary grep across `packages/`, minus barrels and tests-of-the-dead-symbol), (b) contiguous commented-out code blocks (not documentation comments), (c) unused private functions/variables the compiler or ESLint `no-unused-vars` can prove dead. Delete only what the evidence proves; **do not hunt to hit a line total** — the audit's ~4,900 aggregate includes "and others" beyond these four targets and is not a commitment. If re-derivation finds little here, the correct outcome is a small diff, not a padded one. When a dead export's only other reference is its own dedicated test, delete the test with it (a test of deleted code is itself dead).

**Verification**: workspace typecheck + full test suite. Any test deleted must be a test *of a deleted symbol*, never a test whose failure is inconvenient.

### Cross-cutting: evidence and review discipline

- **Evidence recording**: apply records, per deleted item, the derivation command and its zero-reference result (in the plan's task notes or commit message body) — so review can audit the evidence instead of re-trusting the deleter.
- **Native-deletion evidence bar** (Binding directive 3): for the Kotlin and Swift diffs, a clean internal review is insufficient. Required: (a) the mechanical per-line comment-only check for XCTestManager.swift, (b) the drivers workflow visibly triggered and green on the PR (this change touches `drivers/**`, matching the workflow's path filter — verify the check actually appears on the PR rather than assuming), (c) the pipeline's external review stage (`review-pr`) runs before this change is considered done.
- **No `proto/`, no `project.pbxproj`, no workflow, no config changes.** If a derivation surfaces dead code outside the four targets, note it for a follow-up change; do not expand scope.

## Affected Memory

None expected — this is an implementation-only deletion with no spec-level behavior change. Intake verified that no `docs/memory/` file references `TestActions`, `XCTestManager`, or the spot-checked dead constants. Hydrate should re-verify against the final deleted-symbol list (in particular that `docs/memory/device-node/log-capture.md` and `android-ios-mirror.md` still describe only surviving code in `logWriteStream.ts`).

## Impact

- `drivers/android/app/src/androidTest/java/app/finalrun/android/action/TestActions.kt` — deleted (~1,292 lines).
- `drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift` — commented blocks removed (~480 lines by intake derivation; re-derived count governs), file and live class remain.
- `packages/common/src/constants.ts` — re-derived-dead exports removed (~27 per audit; re-derived count governs).
- `packages/cli/`, `packages/device-node/` — re-derived dead code removed (scale unknown until derivation; possibly small).
- CI: no workflow changes. The PR exercises both gates — drivers.yml (path-matched by `drivers/**`) and ci.yml's required `test` check.
- Downstream: unblocks the planned comment-quality sweep (dead code no longer inflates its scope).

## Open Questions

- None blocking. All directives were explicit; ambiguities were resolvable from repo evidence (see Assumptions).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `TestActions.kt` is deleted as a whole file, not merely stripped of comments | Re-derived at intake: 1 non-comment line (the `package` declaration), zero references repo-wide; a package-declaration-only file has no reason to exist | S:90 R:90 A:95 D:95 |
| 2 | Certain | `XCTestManager.swift` is NOT deleted as a file — only its commented-out code blocks are removed | Re-derived at intake: the class is live (`GrpcDriverServer.swift:49/97/141`, registered in pbxproj); the audit's "zero callers" is wrong at file level. User's own framing ("437 commented lines") supports block-deletion reading | S:80 R:90 A:95 D:85 |
| 3 | Confident | Only commented-out *code* is deleted from XCTestManager.swift; documentation comments on live code survive | The change is dead-code deletion, not a comment sweep (the sweep is a separate planned change per the zga4 intake); 529 comment lines ≠ 481 block lines, the difference being live-code docs | S:70 R:85 A:85 D:70 |
| 4 | Certain | Constants deletion criterion: an export is deleted iff its re-derived reference count outside `constants.ts` is zero (chain- and barrel-aware); the audit's "27" is not a quota | User directive says re-derive everything; spot-check proved dead/live constants interleave, so a count-driven deletion would be wrong | S:85 R:85 A:90 D:85 |
| 5 | Confident | Target 4 scope: dead code in cli/device-node is derived from scratch (unreferenced exports, commented-out code blocks, compiler-provable unused code), bounded to those two packages; a small result is acceptable | Audit reports are not in the repo, so there is nothing to confirm — only derive. Intake recon found no whole-file candidates, suggesting the real set is modest | S:40 R:85 A:80 D:55 |
| 6 | Certain | No behavior change anywhere: deletions only, no refactors/renames/reformatting of surviving code | Explicit in the request ("near-zero risk", deletion framing throughout); mirrors the zga4 conversation's standing "don't change behavior" posture | S:95 R:90 A:95 D:95 |
| 7 | Certain | Native-deletion evidence bar: mechanical per-line verification + drivers gate visibly green on the PR + external `review-pr` stage; clean internal review alone is insufficient for the Kotlin/Swift diffs | Verbatim user directive, grounded in a documented prior miss (Swift crash caught only by external reviewer) | S:90 R:80 A:90 D:90 |
| 8 | Confident | A test file whose sole subject is a deleted symbol is deleted with it; no other test is touched | Standard dead-code semantics; constitution's Test Integrity rule forbids bending tests, and deleting a dead symbol's test is conformance, not accommodation | S:60 R:85 A:85 D:75 |

8 assumptions (5 certain, 3 confident, 0 tentative, 0 unresolved).
