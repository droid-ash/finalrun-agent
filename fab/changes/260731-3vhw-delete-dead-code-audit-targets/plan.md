# Plan: Delete Dead Code From the Four Audit Targets

**Change**: 260731-3vhw-delete-dead-code-audit-targets
**Intake**: `intake.md`

## Requirements

### Dead-Code Deletion: Android Driver

#### R1: Whole-file deletion of TestActions.kt
The file `drivers/android/app/src/androidTest/java/app/finalrun/android/action/TestActions.kt` MUST be deleted as a whole file, and the deletion MUST be preceded by a fresh re-derivation (not the intake's or audit's numbers) proving (a) the file contains no live code beyond at most its `package` declaration and (b) the symbol `TestActions` has zero references anywhere else in the repo (Kotlin sources, Gradle files, and repo-wide sweep). Kotlin has no registration file, so no companion edit is made.

- **GIVEN** the current working tree at apply time
- **WHEN** the re-derivation confirms ≤1 non-comment line and zero external references
- **THEN** the file is deleted and the derivation commands + results are recorded as evidence
- **AND** if the re-derivation contradicts the intake (live code or references found), the deletion is NOT performed and the discrepancy is reported instead

### Dead-Code Deletion: iOS Driver

#### R2: Commented-out code blocks removed from XCTestManager.swift; file and live class stay
Only the commented-out *code* blocks inside `drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift` MUST be deleted. The file, its live `XCTestManager` class, all live methods, and genuine documentation comments on live code MUST stay. `project.pbxproj` MUST NOT be touched. Block boundaries MUST be re-derived at apply time (intake line numbers are hints only). After editing, the diff MUST be mechanically verified: every removed line matches `^\s*//` or is a blank line orphaned between removed blocks — `git diff -U0 -- <file> | grep '^-' | grep -v '^---' | grep -vcE '^-\s*(//|$)'` MUST output `0`.

- **GIVEN** `XCTestManager` is live (instantiated in `GrpcDriverServer.swift`) and the file interleaves live code with commented-out code blocks
- **WHEN** the commented-out code blocks are deleted
- **THEN** the mechanical per-line check over the file's diff outputs 0 (zero live lines removed)
- **AND** the file still contains the live class, its live methods, and documentation comments on live code
- **AND** `git status` shows no change to `project.pbxproj`

### Dead-Code Deletion: packages/common Constants

#### R3: Zero-reference exports deleted from constants.ts, chain- and barrel-aware
Every export in `packages/common/src/constants.ts` MUST have its reference count re-derived (word-boundary search across all of `packages/`, excluding `constants.ts` itself and build output). An export MUST be deleted iff its re-derived external reference count is zero, with chain-awareness (a symbol referenced only by another *dead* export in the file is itself dead and deleted with it; a symbol referenced by a *live* export stays) and barrel-awareness (`packages/common/src/index.ts` re-export lines are not consumers — the barrel is `export * from './constants.js'`, so no per-symbol barrel lines exist). Section header comments whose entire section is deleted go with the section. The audit's "27" is NOT a quota — the re-derived set governs.

- **GIVEN** the re-derived per-export reference counts
- **WHEN** deletion is applied
- **THEN** exactly the zero-reference exports (plus dead-chain members and orphaned section headers) are removed
- **AND** every surviving export has at least one re-derived external reference (directly or via a live in-file consumer)
- **AND** the per-export derivation evidence is recorded

### Dead-Code Deletion: packages/cli and packages/device-node

#### R4: Dead code in cli/device-node derived from scratch and deleted
Within `packages/cli` and `packages/device-node` only, dead code MUST be derived (not confirmed from any audit list) as: (a) exported symbols with zero references outside their defining file (word-boundary search across `packages/`, minus barrel re-export lines and minus tests whose sole subject is the dead symbol), (b) contiguous commented-out *code* blocks (documentation comments stay — e.g. the finalization-contract docs in `packages/device-node/src/device/logWriteStream.ts` are load-bearing per `docs/memory/device-node/log-capture.md`), (c) unused private code the compiler or ESLint `no-unused-vars` can prove dead. Only what the evidence proves is deleted; a small diff is the correct outcome if little is found — no hunting to a line total. A test file whose sole subject is a deleted symbol is deleted with it; no other test is touched.

- **GIVEN** the derivation over the two packages
- **WHEN** deletions are applied
- **THEN** every deleted item has recorded zero-reference (or commented-out-code, or compiler-proof) evidence
- **AND** no test unrelated to a deleted symbol is modified or deleted

### Cross-Cutting: Evidence, Scope, Verification

#### R5: Per-deletion evidence recorded
For every deleted item, the derivation command and its result MUST be recorded in this plan's `## Notes` (task evidence) section, so review can audit the evidence instead of re-trusting the deleter.

- **GIVEN** any deletion performed under R1–R4
- **WHEN** review reads this plan
- **THEN** the evidence (command + result) for that deletion is present in `## Notes`

#### R6: Deletions only; scope guard
The change MUST make no behavior changes, no refactors, no renames, no reformatting of surviving code, and MUST NOT touch `proto/`, `project.pbxproj`, workflow files, or config. Dead code discovered outside the four targets is noted for follow-up, not deleted.

- **GIVEN** the final working-tree diff
- **WHEN** inspected file-by-file
- **THEN** only the four targets' files (and dead-symbol-dedicated tests, if any) are changed, and every hunk is a pure deletion (no added live code)

#### R7: Local TypeScript verification green; native compile deferred to the drivers CI gate
The repo's TypeScript verification MUST pass locally exactly as ci.yml runs it: `npm ci` (dependencies present), `npm run build --workspaces`, `npm run typecheck`, `npm run test:workspaces`, `npm run lint`. Native (Kotlin/Swift) compilation is NOT runnable locally (no Android SDK / no macOS); its verification is the drivers CI gate (`.github/workflows/drivers.yml`, path-triggered by `drivers/**`) on the PR — this MUST be stated explicitly in the result, never claimed as locally verified.

- **GIVEN** all deletions applied
- **WHEN** the four workspace commands run locally
- **THEN** all four exit 0
- **AND** the result report notes that native compile verification is deferred to the drivers CI gate on the PR

### Non-Goals

- Comment-quality improvements on surviving code — a separate planned change
- Deleting `XCTestManager.swift` or editing `project.pbxproj` — the class is live
- Dead-code deletion outside the four targets (other packages, `proto/`, workflows) — note-only
- Hitting the audit's ~4,900-line aggregate — the re-derived sets govern

## Tasks

### Phase 1: Setup

- [x] T001 Install workspace dependencies: `npm ci` at repo root (node_modules was absent in this worktree) <!-- R7 -->

### Phase 2: Core Implementation (deletions)

- [x] T002 [P] Re-derive TestActions.kt evidence (line count, non-comment line count, zero references in `drivers/android` and repo-wide) and delete `drivers/android/app/src/androidTest/java/app/finalrun/android/action/TestActions.kt`; record evidence in `## Notes` <!-- R1, R5 -->
- [x] T003 [P] Re-derive commented-out code block boundaries in `drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift`, delete only those blocks (live class, live methods, doc comments stay; `project.pbxproj` untouched), then run the mechanical diff check (`git diff -U0 -- <file> | grep '^-' | grep -v '^---' | grep -vcE '^-\s*(//|$)'` must output 0); record boundaries + check output in `## Notes` <!-- R2, R5 -->
- [x] T004 [P] Re-derive reference counts for every export in `packages/common/src/constants.ts` (word-boundary grep across `packages/`, excluding the file itself; chain- and barrel-aware) and delete exactly the zero-reference exports plus dead chains and orphaned section headers; record the full per-export count table in `## Notes` <!-- R3, R5 -->
- [x] T005 [P] Derive dead code in `packages/cli` and `packages/device-node` (unreferenced exports, commented-out code blocks, compiler-provable unused code) and delete only what the evidence proves, deleting a test file only if its sole subject was deleted; record evidence in `## Notes` <!-- R4, R5 -->

### Phase 3: Integration & Verification

- [x] T006 Scope-guard audit of the working-tree diff: only intended files changed; every hunk is deletion-only; no `proto/`, `project.pbxproj`, workflow, or config changes <!-- R6 -->
- [x] T007 Run local TypeScript verification exactly as ci.yml: `npm run build --workspaces`, `npm run typecheck`, `npm run test:workspaces`, `npm run lint` — all must pass; record outcomes in `## Notes`, and note that native compile is deferred to the drivers CI gate on the PR <!-- R7 -->

## Execution Order

- T001 blocks T007 (verification needs node_modules); T002–T005 are parallelizable and independent of T001
- T006 and T007 run after all of T002–T005

## Acceptance

### Functional Completeness

- [x] A-001 R1: `TestActions.kt` no longer exists; recorded evidence shows re-derived ≤1 non-comment line and zero external references at deletion time
- [x] A-002 R2: `XCTestManager.swift` still exists with its live class and methods; the re-derived commented-out code blocks are gone; `project.pbxproj` is unchanged
- [x] A-003 R3: Every zero-reference export (per recorded re-derivation) is deleted from `constants.ts`; every surviving export has a re-derived live reference (direct or via a live in-file consumer)
- [x] A-004 R4: All deletions in `packages/cli`/`packages/device-node` carry recorded zero-reference / commented-out-code / compiler-proof evidence

### Behavioral Correctness

- [x] A-005 R6: The diff contains no added live code, no renames, no reformatting of surviving code — deletions only

### Removal Verification

- [x] A-006 R3: No dangling references remain to any deleted symbol (workspace typecheck passes; repo-wide grep for deleted symbol names finds no live consumer)

### Scenario Coverage

- [x] A-007 R7: `npm run build --workspaces`, `npm run typecheck`, `npm run test:workspaces`, `npm run lint` all pass locally after the deletions
- [x] A-008 R2: The mechanical per-line diff check for `XCTestManager.swift` output 0 (recorded in `## Notes`)

### Edge Cases & Error Handling

- [x] A-009 R4: No test file was deleted or modified except one whose sole subject is a deleted symbol (if any); the constitution's Test Integrity rule is upheld
- [x] A-010 R7: The result explicitly states native (Kotlin/Swift) compile verification is deferred to the drivers CI gate on the PR, not claimed locally

### Code Quality

- [x] A-011 Pattern consistency: surviving code is untouched in style and structure (no reformatting introduced by the deletions)
- [x] A-012 **N/A**: No unnecessary duplication — N/A-leaning for a deletion-only change — verify no code was duplicated or moved as part of any deletion

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

### Task Evidence (R5)

*(appended during apply, per task; all greps use plain GNU grep — the session's `grep` alias to ugrep was bypassed via `command grep` after `-cv` count discrepancies were observed)*

#### T002 — TestActions.kt (deleted whole file, 1,292 lines)

Re-derived at deletion time (2026-07-31):

- `wc -l TestActions.kt` → **1292**
- `command grep -v '^\s*//' TestActions.kt | wc -l` → **1** (line 1: `package app.finalrun.android.action` — the only non-comment line)
- `command grep -rn "TestActions" drivers/android --include="*.kt" --include="*.gradle*" | grep -v "action/TestActions.kt" | wc -l` → **0**
- Repo-wide: `command grep -rn "TestActions" . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=fab | grep -v "action/TestActions.kt" | wc -l` → **0**

Result: file deleted (`rm`). Matches intake derivation exactly.

#### T003 — XCTestManager.swift (508 lines removed; file now 351 lines, was 859)

Re-derived commented-out *code* block boundaries (pre-deletion line numbers). Each range pre-verified comment-only via `sed -n "${s},${e}p" | command grep -vcE '^\s*//'` → **0** for every range:

| Range (pre-deletion) | Lines | Content |
|---|---|---|
| 75–80 | 6 | dead `volumeup`/`volumedown` case branches in `performPressKeyAction` |
| 194 | 1 | dead `screenshotBase64String` line in `performTapAction` |
| 250–251 | 2 | dead `deleteCount`/`deleteText` lines in `performEnterTextAction` |
| 299–339 | 41 | commented-out body of `prepareForTest` (40 comment lines + orphaned blank line 299); the empty function shell stays (live caller in `startTest`) |
| 346–707 | 362 | commented-out `findNodeUntilTimeout`, `isDeviceAction`, `performDeviceAction`, `performTestStep` |
| 729–754 | 26 | commented-out `isViewVisibleOnScreen` |
| 770–779 | 10 | commented-out `waitUntilKeyboardIsPresented` |
| 781–787 | 7 | dead `XCTestResponse` construction inside live `sendTestResponse` |
| 806–858 | 53 | commented-out `getTargetNode` |

Total removed: **508** (507 comment lines + 1 orphaned blank). Binding mechanical check:
`git diff -U0 -- drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift | grep '^-' | grep -v '^---' | grep -vcE '^-\s*(//|$)'` → **0** (zero live lines removed). Added lines: **0**. `project.pbxproj`: untouched (`git status --porcelain` → empty). Surviving 22 `^\s*//` lines are the file header (6) and 16 documentation comments on live code. Brace balance verified (0). Class, `XCTestDelegate`, `XCTestCommand`, and all live methods intact.

#### T004 — constants.ts (30 dead exports + orphaned section headers; 43 lines removed, file now 149 lines, was 192)

Derivation: for **every** one of the file's 70 exports:
`command grep -rwn "$NAME" packages/ --exclude-dir=node_modules --exclude-dir=dist | grep -v '^packages/common/src/constants.ts:' | wc -l`
(all file types under `packages/`, word-boundary, excluding the defining file and build output). Barrel note: `packages/common/src/index.ts` re-exports via wildcard `export * from './constants.js'` — no per-symbol barrel lines exist to discount.

**Deleted — external_refs=0, and zero in-file references from any live export** (in-file occurrence count = 1 = own declaration, for every deleted symbol):

- `ACTION_TYPE_TAP`, `ACTION_TYPE_LONG_PRESS`, `ACTION_TYPE_SCROLL`, `ACTION_TYPE_SCROLL_ABS`, `ACTION_TYPE_INPUT_TEXT`, `ACTION_TYPE_BACK`, `ACTION_TYPE_HOME`, `ACTION_TYPE_ROTATE`, `ACTION_TYPE_HIDE_KEYBOARD`, `ACTION_TYPE_PRESS_KEY`, `ACTION_TYPE_LAUNCH_APP`, `ACTION_TYPE_KILL_APP`, `ACTION_TYPE_SET_LOCATION`, `ACTION_TYPE_WAIT`, `ACTION_TYPE_DEEPLINK`, `ACTION_TYPE_SWITCH_TO_PRIMARY_APP`, `ACTION_TYPE_CHECK_APP_IN_FOREGROUND`, `ACTION_TYPE_GET_SCREENSHOT_AND_HIERARCHY`, `ACTION_TYPE_GET_APP_LIST` (19 — whole section dead; its header comment "used by HeadlessActionExecutor to route actions" was false and went with the section)
- `STATUS_SUCCESS`, `STATUS_FAILURE`, `STATUS_ERROR`, `STATUS_ABORTED`, `STATUS_RUNNING`, `STATUS_COMPLETED` (6 — whole section dead, header went with it)
- `DEFAULT_ACTION_TIMEOUT`, `DEFAULT_STABILITY_CHECK_DELAY_MS`, `DEFAULT_SWIPE_DURATION_MS` (3 — "Defaults" section header STAYS: `DEFAULT_MAX_ITERATIONS` ext=2, `DEFAULT_GRPC_PORT_START` ext=8 are live)
- `ENV_BASE_URL`, `ENV_DEBUG` (2 — whole "Environment variable keys" section dead, header went with it)

**Kept — re-derived external reference counts** (chain-live cases called out):
`PLATFORM_ANDROID`=93, `PLATFORM_IOS`=62, `FEATURE_PLANNER`=18, `FEATURE_GROUNDER`=22, `FEATURE_VISUAL_GROUNDER`=12, `FEATURE_SCROLL_INDEX_GROUNDER`=13, `FEATURE_INPUT_FOCUS_GROUNDER`=12, `FEATURE_LAUNCH_APP_GROUNDER`=12, `FEATURE_SET_LOCATION_GROUNDER`=11, `ALL_FEATURES`=4, `FeatureName`=23, `REASONING_LEVELS`=3, `ReasoningLevel`=12, `SUPPORTED_AI_PROVIDERS`=1*, `SupportedProvider`=1*, `SUPPORTED_AI_PROVIDERS_LABEL`=3, `MODEL_FORMAT_EXAMPLE`=6, `PROVIDER_ENV_VARS`=5, `ParsedModel`=1*, `parseModel`=24, `FeatureOverride`=2, `FeatureOverrides`=16, `ModelDefaults`=13, `DEFAULT_MAX_ITERATIONS`=2, `DEFAULT_GRPC_PORT_START`=8, `PLANNER_ACTION_TAP`=17, `PLANNER_ACTION_LONG_PRESS`=4, `PLANNER_ACTION_TYPE`=7, `PLANNER_ACTION_SCROLL`=4, `PLANNER_ACTION_BACK`=4, `PLANNER_ACTION_HOME`=4, `PLANNER_ACTION_ROTATE`=10, `PLANNER_ACTION_HIDE_KEYBOARD`=4, `PLANNER_ACTION_PRESS_ENTER`=4, `PLANNER_ACTION_LAUNCH_APP`=9, `PLANNER_ACTION_SET_LOCATION`=4, `PLANNER_ACTION_WAIT`=6, `PLANNER_ACTION_COMPLETED`=11, `PLANNER_ACTION_FAILED`=5, `PLANNER_ACTION_DEEPLINK`=7.

\* `SUPPORTED_AI_PROVIDERS`/`SupportedProvider`/`ParsedModel`: their sole external ref each is an import line in `packages/common/src/env.ts` that env.ts never uses — but all three are **chain-live** (consumed inside `constants.ts` by the live `parseModel` (ext=24), `PROVIDER_ENV_VARS` (ext=5), and `SUPPORTED_AI_PROVIDERS_LABEL` (ext=3)), so they stay. **Follow-up note (out of scope, packages/common):** `env.ts` lines 11/14/15 import these three symbols without using them — unused-import cleanup for a later change; not touched here (outside the four targets).

Result: `git diff --numstat` → 0 added / 43 deleted. Deleted set (30) vs audit's "27": the re-derived set governs per intake. Zero test files referenced any deleted constant (the grep covered tests).

#### T005 — packages/cli + packages/device-node (derived from scratch; 2 dead functions deleted, 20 lines)

**(a) Unreferenced exports.** Enumerated all 184 declared exports (`export (const|let|var|function|class|interface|type|enum) NAME`) in non-test sources of both packages; for each: `command grep -rwn "$NAME" packages/ --exclude-dir=node_modules --exclude-dir=dist | grep -v "^$FILE:" | wc -l`, with barrel `index.ts` re-export lines counted separately and discounted. 41 symbols had zero external references; 39 of those are used *inside* their own file (internal helpers/types that happen to carry `export`) — deleting them would break their file, and stripping only the `export` keyword is a refactor, not a deletion, so they stay untouched. Exactly 2 had zero references anywhere (external refs = 0, in-file occurrences = declaration only), confirmed by a final repo-wide sweep (`--exclude-dir={.git,node_modules,dist,fab}`) → **0**:

- `isInteractive()` — `packages/cli/src/localRuntime.ts` (deleted with its doc comment + orphaned boundary blanks; 11 lines)
- `resolveCliCacheRoot()` — `packages/cli/src/runtimePaths.ts` (deleted with adjoining blank; 9 lines)

Neither orphaned any import or helper (`resolveCliPackageVersion` ext-refs > 0 via `localRuntime.ts`; `resolveFinalRunRootDir` ext-refs > 0). No test's sole subject was either symbol (zero test references existed), so **no test file was deleted or modified**.

**(b) Commented-out code blocks.** Scanned all contiguous `^\s*//` runs ≥ 4 lines in both packages (awk run-length scan) — 43 runs, all genuine documentation (file headers, contract docs). The intake's one candidate — the 22-line block at `packages/device-node/src/device/logWriteStream.ts:87–108` — is on inspection **load-bearing rationale documentation** for the guarded `Logger.e` call (it explicitly cross-references `docs/memory/cli/session-runner.md` and ends "Do not remove the guard by citing that memory entry"), NOT commented-out code. **Kept.** A pattern sweep for commented-out code lines (`^\s*//\s*(const|let|if \(|return|…;$|…{$)` etc.) found only one hit, which is prose. Zero commented-out code deleted.

**(c) Compiler/ESLint-provable unused code.** `npx eslint packages/cli/src packages/cli/bin packages/device-node/src` → exit 0, 23 warnings, **all** `max-lines-per-function`/`complexity` (pre-existing, out of scope); **zero `no-unused-vars`, zero `prefer-const`**. Nothing to delete under (c).

Total for Target 4: 20 lines across 2 files — a small diff, which the intake explicitly declares the correct outcome ("do NOT hunt to hit a line total").

#### T006 — Scope-guard audit

`git status --porcelain` shows exactly 5 changed code files (plus the untracked fab change folder):
`D TestActions.kt`, `M XCTestManager.swift`, `M localRuntime.ts`, `M runtimePaths.ts`, `M constants.ts`.
`git diff --numstat` (excluding `fab/`): 0 added / 1,864 deleted total (1,293 + 508 + 11 + 9 + 43 — git counts TestActions.kt as 1,293 because its last line has no trailing newline; `wc -l` says 1,292). Added lines across all code diffs: **0** — every hunk is a pure deletion. `proto/`, `.github/`, `project.pbxproj`, `package.json`, workflows, and config: untouched (the only `*.yaml` status hit is this change's own untracked `fab/changes/.../.status.yaml` pipeline artifact). No renames, no reformatting of surviving code.

#### T007 — Local verification (ci.yml sequence)

After `npm ci` (exit 0; node_modules was absent in this worktree):

| Command | Result |
|---|---|
| `npm run build --workspaces` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run test:workspaces` | exit 0 — 546 tests across 6 workspaces, 546 pass, 0 fail, 0 skipped |
| `npm run lint` | exit 0 — 42 warnings, all pre-existing `max-lines-per-function`/`complexity` (non-blocking by design, phase 1); zero errors |

**Native compile verification was NOT run locally** (no Android SDK, no macOS available in this environment). The Kotlin deletion (TestActions.kt) and Swift deletion (XCTestManager.swift blocks) are verified by the drivers CI gate (`.github/workflows/drivers.yml`, path-triggered by `drivers/**`) on the PR — per the intake's binding directive 2/3, that check must be visibly triggered and green on the PR, and the external `review-pr` stage must run, before the native deletions count as verified.

### Review-Stage Evidence Re-Derivation (independent, 2026-07-31)

Review re-ran every derivation from scratch rather than trusting the numbers above. All reproduced:

| Claim | Review's independent command | Result |
|---|---|---|
| TestActions.kt = 1292 lines, 1 non-comment line | `git show HEAD:…/TestActions.kt \| grep -nvE '^\s*//'` | one line — `1:package app.finalrun.android.action` ✓ |
| `TestActions` zero references | `grep -rw TestActions .` (excl. `.git`/`node_modules`/`dist`/`fab`) and `git grep -w TestActions HEAD -- ':!fab/'` | 0 in working tree **and** 0 at HEAD excluding the file itself ✓ |
| androidTest sourceset not emptied | `find drivers/android/app/src/androidTest -type f` | 23 files remain; `action/` still holds `DeviceActions.kt`, `NodeMatchResult.kt` ✓ |
| Swift mechanical check | `git diff -U0 -- …/XCTestManager.swift \| grep '^-' \| grep -v '^---' \| grep -vcE '^-\s*(//\|$)'` | **0** ✓ |
| Swift added lines | `git diff -U0 -- …/XCTestManager.swift \| grep '^+' \| grep -v '^+++' \| wc -l` | **0** ✓ |
| Swift hunk boundaries match the recorded table | `git diff -U0 … \| grep '^@@'` | `-75,6 -194,1 -250,2 -299,41 -346,362 -729,26 -770,10 -781,7 -806,53` = 508 — exact match ✓ |
| No hidden Swift hazard from comment removal | `grep '"""'` and `grep '/\*'` on the HEAD version; grep removed lines for `swiftlint`/`#if`/`#endif`/`MARK:` | zero multi-line string literals, zero block comments, zero directives removed — comment removal cannot alter semantics ✓ |
| Swift live code still balanced/intact | brace + paren count over non-comment lines of the surviving file | 67/67 braces, 153/153 parens; `XCTestManager`, `XCTestDelegate`, `XCTestCommand` and all 14 live methods present ✓ |
| Swift surviving comments = 22 (6 header + 16 doc) | `grep -cE '^\s*//'` on surviving file | 22 ✓ |
| All 30 deleted constants unreferenced | per-symbol `grep -rw` over the whole repo **and** `git grep -w <sym> HEAD` excluding the defining file | 0/0 for every one of the 30 ✓ |
| All 40 surviving constants still referenced | per-symbol `grep -rwn` over `packages/` excluding `constants.ts` | every survivor ext ≥ 1; all 40 counts match the recorded table exactly ✓ |
| `SUPPORTED_AI_PROVIDERS` / `SupportedProvider` / `ParsedModel` chain-live | read `constants.ts` + `env.ts` | in-file consumers at `constants.ts:45,46,48,55,68,96,104`; also part of the `export {…} from './constants.js'` block in `env.ts` ✓ (see correction below) |
| `isInteractive`, `resolveCliCacheRoot` unreferenced (incl. tests) | `grep -rw` repo-wide + `git grep -w … HEAD` | 0/0 for both ✓ |
| Deletions did not orphan neighbours | `grep -rw resolveCliPackageVersion resolveFinalRunRootDir` | both still referenced (`finalrun.ts`, `localRuntime.ts`, `reportServerManager.ts`) ✓ |
| `FINALRUN_CACHE_DIR` behaviour preserved | `grep -rw FINALRUN_CACHE_DIR` | still honoured by `packages/device-node/src/runtimeAssets.ts:12`; the deleted CLI helper had no callers ✓ |
| Scope guard | `git status --porcelain`, `git diff --numstat`, `git status --porcelain proto/ .github/ '*.pbxproj' …` | exactly 5 code files; 0 added / 1864 deleted; no `proto/`, `.github/`, pbxproj, `package.json`, tsconfig, or workflow change ✓ |
| Memory drift | `grep -rn` in `docs/` for every deleted symbol + `TestActions` + `XCTestManager` | 0 hits — no memory/doc file references deleted code ✓ |
| TS verification | `npm run build --workspaces` / `typecheck` / `test:workspaces` / `lint` | exit 0 / 0 / 0 / 0; **546 tests, 546 pass, 0 fail** (123+22+120+68+58+155); lint 42 warnings, 0 errors — matches the recorded table ✓ |
| External reviewer (Codex→Claude cascade) | `codex exec --sandbox read-only` over the diff, prompted for dangling references, Swift compile hazards, and smuggled behaviour changes | **NO FINDINGS** ✓ |

**Correction to T004's follow-up note.** T004 states that `packages/common/src/env.ts` "lines 11/14/15 import these three symbols without using them — unused-import cleanup for a later change." That is wrong: lines 8–16 of `env.ts` are a single `export { … } from './constants.js'` **re-export statement**, not an import — the symbols are deliberately re-exported as part of `@finalrun/common`'s public surface, and that path is consumed (e.g. `packages/common/src/test/env.test.ts:6` imports `parseModel` from `../env.js`). No follow-up cleanup is warranted; acting on the note as written would delete live public API. The deletion decisions themselves are unaffected (all three symbols were correctly kept).

## Deletion Candidates

Strictly, this change made **nothing** newly redundant — removing comment lines cannot orphan live
code, and the three TypeScript deletions were already unreferenced. What the review did surface is
**pre-existing dead live code** now plainly visible in `XCTestManager.swift` once its 508 lines of
commented-out code stopped hiding it. All of it is out of scope here (R2 scopes this change to
commented-out *code* blocks; R6 forbids editing live code), so it is recorded for a follow-up change
per the intake's "note it for a follow-up change; do not expand scope" rule:

- `drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift:327` — `private func getForegroundApp(_:)` has zero call sites and is a line-for-line duplicate of the live `XCViewHierarchyManager.getForegroundApp` (`XCViewHierarchyManager.swift:340`), which is what every real caller in `GrpcDriverServer.swift` uses.
- `drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift:16` — `let constant_executeTestStep` is a file-scope global with zero live references in the entire iOS tree.
- `drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift:18-33` — `enum XCTestCommand` (14 cases) is declared and never referenced by any live code.
- `drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift:42,48` — `stopTest` is assigned in `startTest` and never read.
- `drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift:44,50` — `timeoutStartTime` is assigned in `startTest` and never read.
- `drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift:40,292-295` — `findNodeTimer` / `invalidateTestTimer()` form a closed loop: the timer is never assigned, so the invalidate call from `startTest` is a permanent no-op.
- `drivers/ios/finalrun-ios-test/Managers/XCTestManager.swift:289-290,51` — `prepareForTest(_:)` is now an empty function body plus its single call site in `startTest`; both go together (deliberately deferred here by plan Assumption 2, since removing it means editing live code).
- `packages/cli`, `packages/device-node` (39 symbols, enumerated in T005) — carry an `export` keyword but are only used inside their own file. Dropping the keyword is a refactor, not a deletion, so it is correctly out of scope; worth a dedicated visibility-tightening change.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Swift deletion scope = ALL commented-out *code* fragments in the file (including sub-20-line ones: dead `volumeup`/`volumedown` case branches, single-line dead statements in `performTapAction`/`performEnterTextAction`/`sendTestResponse`, the 10-line `waitUntilKeyboardIsPresented` block), not only the four >20-line blocks located at intake | Intake's criterion is code-vs-documentation (its Assumption 3); the ">20 lines" was the audit-location heuristic, and intake says re-derived boundaries govern. Every extra line still satisfies the mechanical `^\s*//` check, so risk is unchanged | S:65 R:85 A:80 D:70 |
| 2 | Certain | `prepareForTest` stays as an (already-behaviorally-empty) function with an empty body after its commented-out body is deleted; its live caller in `startTest` is not touched | Deleting the function would require editing live code (the call site), violating the deletions-only scope; the function already did nothing | S:80 R:90 A:95 D:90 |
| 3 | Confident | Blank lines orphaned between/inside removed comment blocks are removed with the blocks | Explicitly permitted by the binding mechanical check (`^-\s*(//|$)` allows blank removed lines); leaving them would strand floating blanks | S:70 R:95 A:90 D:85 |
| 4 | Confident | TS reference derivation greps all file types under `packages/` (not only `.ts` — also `.mjs`/`.js` in `packages/cli/bin|scripts`), excluding `dist/` build output and `node_modules` | `packages/cli` ships live `.mjs` scripts and a `bin/` entry; counting only `.ts` could miss a real consumer, and build output is derived, never a consumer | S:60 R:90 A:85 D:80 |
| 5 | Confident | Target-4 export enumeration covers exported symbols in non-test source files of the two packages; per-package barrel `index.ts` wildcard/named re-export lines are not consumers | Mirrors the intake's barrel rule for Target 3; a barrel line re-exports a name, it does not use it | S:65 R:85 A:85 D:75 |
| 6 | Certain | Local verification commands are `npm run build --workspaces`, `npm run typecheck`, `npm run test:workspaces`, `npm run lint`, after `npm ci` | Read directly from `.github/workflows/ci.yml` and root `package.json` — deterministic | S:90 R:95 A:100 D:95 |

6 assumptions (2 certain, 4 confident, 0 tentative).
