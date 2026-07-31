# Plan: Correct False and Stale Factual Claims

**Change**: 260731-xkfl-correct-false-stale-claims
**Intake**: `intake.md`

## Requirements

### Fab Policy: comment-policy example must not carry a fabricated measurement

#### R1: Remove the false 67/18 ratio from code-quality.md
The CI-and-workflow paragraph of `fab/project/code-quality.md` `## Comments` MUST NOT cite any
comment-to-functional line ratio for `.github/workflows/drivers.yml`. The deletion-test argument
carries the example alone. The retained citations (ruleset `14531661`, `build.gradle.kts:104`,
the drivers.yml-vs-ci.yml paths-filter rationale) MUST be preserved and are verified to still
exist in `drivers.yml` (lines 21/29/42 cite the ruleset; line 52 cites `build.gradle.kts:104`).

- **GIVEN** the current paragraph citing "67 comment lines against 18 functional lines"
- **WHEN** the paragraph is rewritten
- **THEN** no numeric line-count or ratio claim about drivers.yml remains, and the ruleset /
  gradle citations and paths-filter rationale survive intact

### Fab Policy: sweep-scope bullet must reflect the shipped sweep

#### R2: Rewrite the "planned" sweep bullet in code-review.md to past tense
The sweep-scope bullet in `fab/project/code-review.md` `## Project-Specific Review Rules` MUST
state that the restatement-comment sweep already shipped (change `260731-vxq1-comment-content-sweep`,
PR #171, merged commit `7b38afc`) so no future agent re-runs it. The scope rules themselves
(rationale claims out of scope, mixed-block handling, CI/workflow coverage) MUST remain.

- **GIVEN** the bullet describing a "planned" sweep "executed as a separate later change"
- **WHEN** it is rewritten
- **THEN** it references the merged change/PR in past tense and keeps the scope rules

### Source Comments: citations must state verified reasons and name real symbols

#### R3: Correct the env.ts shim comment's constitution misattribution
The re-export shim comment in `packages/common/src/env.ts` (currently lines 7–9) MUST NOT claim
the constitution's Test Integrity rule forbids editing tests (constitution line 14 explicitly
permits updating tests to match the spec). The comment SHALL state the verified retention
reason: consumer compatibility — `packages/common/src/test/env.test.ts` still imports
`parseModel`/`parseReasoningLevel` through `../env.js`, and the shim keeps that import path
working. The export block itself MUST NOT change.

- **GIVEN** the comment citing the constitution as forbidding a test edit
- **WHEN** it is corrected
- **THEN** it states the consumer-compatibility reason without citing the constitution, and the
  `export { ... } from './constants.js'` statement is byte-identical

#### R4: Repoint the two rotted logger.ts:103-105 citations with durable anchors
Both citations of `packages/common/src/logger.ts:103-105` — in
`packages/device-node/src/device/logWriteStream.ts` (~line 89) and
`docs/memory/device-node/log-capture.md` (~line 167) — MUST be repointed to the loop's current
location using a line-number-free anchor (the sink loop in `Logger._emit`,
`packages/common/src/logger.ts`; verified currently at lines 99–101, still unguarded). The
adjacent `packages/cli/src/reportWriter.ts:132` citation in the same sentences SHOULD likewise
become line-free (`ReportWriter.createLoggerSink()` is now at line 128 — that citation has
rotted too).

- **GIVEN** the two comments citing `logger.ts:103-105`
- **WHEN** they are rewritten
- **THEN** each cites `Logger._emit`'s sink loop by name without line numbers, the unguardedness
  claim is preserved (verified true), and no other content of the blocks changes

#### R5: Replace used-by attributions naming symbols that do not exist in this repo
Five headers MUST stop naming Dart-predecessor symbols that exist nowhere in the codebase, and
name grep-verified real consumers instead:

1. `packages/common/src/constants.ts` (~line 11, AI feature names): `FinalRunAgent` → the real
   consumers (goal-executor's `AIAgent.ts`/`VisualGrounder.ts`/`ActionExecutor.ts`/`ai/schemas.ts`
   select prompts/models per feature; `workspace.ts` keys per-feature config overrides).
2. `packages/common/src/constants.ts` (~line 153, planner action keys): `HeadlessGoalExecutor` →
   the real consumers (`AIAgent.ts` normalizes the planner response onto these keys;
   `ActionExecutor.ts`/`TestExecutor.ts` route on them). The adjacent sentence "These must match
   the strings the planner LLM outputs" MUST also be corrected: verified false — the planner
   emits snake_case `action_type` strings which `AIAgent`'s `FIXED_PROMPT_ACTIONS` map normalizes
   onto these keys.
3. `packages/common/src/models/Hierarchy.ts` (lines 2–3): `FinalRunAgent`/`HeadlessActionExecutor`
   → verified consumers (goal-executor's `AIAgent.ts`, `ActionExecutor.ts`, `TestExecutor.ts`,
   plus device-node).
4. `drivers/android/.../androidTest/.../grpc/DriverServiceImpl.kt` (~line 39): drop
   "replaces ActionProcessor" — no `ActionProcessor` exists in-repo (grep + `git log -S` show
   only this comment); keep the true "handles all incoming RPC calls from packages/device-node".
5. `drivers/android/.../androidTest/.../grpc/GrpcDriverServer.kt` (~line 13): drop
   "replaces WebSocketServerImpl" — same verification; keep the true server description.

- **GIVEN** each header naming a nonexistent symbol
- **WHEN** it is rewritten
- **THEN** every consumer named is grep-verifiable in the current tree and no executable line
  changes

### Memory: fps defaults attributed to the correct paths

#### R6: Correct the fps-default attribution in grpc-contract.md
`docs/memory/drivers/grpc-contract.md` (fps requirement section, ~lines 127–130) MUST state:
an omitted `fps` on the gRPC `StartStreaming` path defaults to **24**
(`GrpcDriverServer.swift` `defaultStreamingFps = 24`, adopting `driver.proto`'s documented
`// Default: 24`), while `XCViewHierarchyManager`'s `defaultStreamingFps` of **1** defaults the
legacy WebSocket timer path — deliberately not aligned, since aligning them would change RPC
behaviour rather than guard arithmetic. The clamp content (1–60) stays.

- **GIVEN** the passage claiming an omitted fps defaults to 1 and "the proto's documented 24 is
  not adopted"
- **WHEN** it is rewritten after reading `GrpcDriverServer.swift` and `driver.proto`
- **THEN** each default is attributed to its correct path, matching the Swift code and its
  comments (verified: `GrpcDriverServer.swift:130-137,651`; `XCViewHierarchyManager.swift:39,64`;
  `driver.proto:170`)

### Docs: codebase walkthrough factual corrections

#### R7: Correct the five false claims in docs/codebase-walkthrough.md
1. "monorepo with 5 packages" → **7** (adds `cloud-core`, `local-runtime` — verified by
   `ls packages/`); the architecture tree and the "Why 5 packages?" heading/table gain the two
   missing packages with descriptions verified from their `package.json`.
2. `runTestCommand()` line range → re-derived **`bin/finalrun.ts:372-485`** (verified by
   definition line + brace balance).
3. "(18 types)" for `DeviceAction.ts` → **22** concrete action classes (counted).
4. The `packages/cli/src/` Package Map table: the six rows whose files live in
   `packages/common/src/` (`checkRunner.ts`, `testLoader.ts`, `testSelection.ts`, `workspace.ts`,
   `appConfig.ts`, `env.ts`) are moved/re-labelled to the correct package; the two miscredited
   functions are fixed (`parseModel()` is defined in `constants.ts` and only re-exported through
   env; `resolveApiKey()` lives in `packages/cli/src/apiKey.ts`); rows citing files that no
   longer exist anywhere (`reportTemplate.ts`, `reportIndexTemplate.ts` — verified absent) are
   corrected or removed.
5. `packages/cli/src/checkRunner.ts` (§4 File header) → `packages/common/src/checkRunner.ts`.

- **GIVEN** each claim
- **WHEN** corrected
- **THEN** every count/path/range/attribution written matches a fresh measurement of the tree

### Pipeline State: 3vhw bookkeeping completed

#### R8: Complete 3vhw's review-pr record
`fab/changes/260731-3vhw-delete-dead-code-audit-targets/.status.yaml` MUST record `review-pr`
as `done` with a `completed_at`, reflecting merged PR #170. Preferred mechanism: fab tooling with
the change-name override (`fab status finish 3vhw review-pr`; state pre-verified via
`fab preflight 3vhw` → `review-pr: active`); direct YAML edit only if the tooling refuses.

- **GIVEN** `progress.review-pr: active` with no `completed_at`
- **WHEN** the finish command runs
- **THEN** `progress.review-pr: done` and `stage_metrics.review-pr.completed_at` is set

### Nice-to-haves

#### R9: constants.ts header wording and Hierarchy.ts unverifiable figure
1. `packages/common/src/constants.ts` line 1: replace the "CLI + goal-executor + device-node"
   enumeration (marginally stale) with a claim verified at apply time (the subset this repo's
   TypeScript packages actually use).
2. `packages/common/src/models/Hierarchy.ts` line 2: drop the "~108KB" figure (no Dart sources
   exist in this repo or its history to verify it).

- **GIVEN** the two comments
- **WHEN** reworded
- **THEN** neither carries an unverifiable or stale claim

### Non-Goals

- No runtime behaviour changes, renames, or refactors — comment/doc/YAML content only.
- The wider rot discovered in `docs/codebase-walkthrough.md`'s report-web section (report-web is
  now a Vite React SPA, not Next.js; its Package Map table lists files that no longer exist) is
  corrected ONLY where the five in-scope claims force an edit to the same block; the rest is
  reported, not fixed.
- `fab/backlog.md` is never created, staged, or committed (currently absent — verified).

## Tasks

### Phase 1: Setup

*(none — verification sweep performed at plan generation; evidence recorded in Requirements)*

### Phase 2: Core Implementation

- [x] T001 [P] Rewrite the drivers.yml example sentence in `fab/project/code-quality.md` § Comments to drop the 67/18 ratio, preserving ruleset/gradle citations and paths-filter rationale <!-- R1 -->
- [x] T002 [P] Rewrite the sweep-scope bullet in `fab/project/code-review.md` § Project-Specific Review Rules to past tense referencing PR #171 / `260731-vxq1-comment-content-sweep` <!-- R2 -->
- [x] T003 [P] Correct the shim comment in `packages/common/src/env.ts` to the verified consumer-compatibility reason; no executable change <!-- R3 -->
- [x] T004 [P] Repoint the `logger.ts:103-105` citation in `packages/device-node/src/device/logWriteStream.ts` to a line-free `Logger._emit` anchor (and line-free `createLoggerSink` reference) <!-- R4 -->
- [x] T005 [P] Repoint the same citation in `docs/memory/device-node/log-capture.md` identically; re-check the file's `description:` still routes <!-- R4 -->
- [x] T006 [P] Replace the five false used-by attributions (constants.ts ×2, Hierarchy.ts, DriverServiceImpl.kt, GrpcDriverServer.kt) with grep-verified consumers; correct the adjacent false "must match the strings the planner LLM outputs" sentence <!-- R5 --> <!-- rework: Hierarchy.ts replacement header names device-node, which references neither Hierarchy nor HierarchyNode anywhere — drop "and device-node"; real unnamed consumer GrounderResponseConverter.ts may be named instead. Also (nice-to-have) constants.ts:11-13 says ai/schemas.ts selects "prompts/models" — it selects the response schema (FEATURE_SCHEMAS). -->
- [x] T007 [P] Rewrite the fps-default passage in `docs/memory/drivers/grpc-contract.md` attributing 24 to gRPC `StartStreaming` and 1 to the legacy WebSocket path <!-- R6 -->
- [x] T008 [P] Correct the five walkthrough claims in `docs/codebase-walkthrough.md` (package count 7, `runTestCommand` 372-485, 22 action types, Package Map table paths/functions, checkRunner path) <!-- R7 --> <!-- rework: (must-fix) the two rewritten report-web lines (~:33, :62) keep the false "optional / alternative to built-in server" claim — the built-in server HOSTS the Vite bundle (reportServer.ts resolves report-app; copyReportApp.mjs + buildRuntimeTarball.mjs hard-fail without report-web/dist) — reword both lines only. (should-fix) bin/finalrun.ts row landed in the cli/src table but lives at packages/cli/bin/; "(22 types)" conflates classes with the 24 type-string discriminators — say "22 concrete action classes"; §10.1 still says "Next.js App"/"Next.js App Router" contradicting the corrected :33/:62 — fix those two labels, leave the wider report-web Package Map file-list rot reported-not-fixed per Non-Goals. -->
- [x] T009 Complete 3vhw's record via `fab status finish 3vhw review-pr` (state pre-verified `active`) <!-- R8 -->
- [x] T010 [P] Apply the two nice-to-have rewordings (constants.ts line 1, Hierarchy.ts ~108KB) <!-- R9 -->

### Phase 3: Integration & Edge Cases

- [x] T011 Verify zero runtime impact: `git diff` inspection confirms only comment/doc/YAML lines changed (no executable-line change in any `.ts`/`.kt` file), and `fab/backlog.md` remains absent/unstaged <!-- R1 R3 R4 R5 R9 --> <!-- rework: re-verify after rework edits. Also apply remaining review nice-to-haves if verified: grpc-contract.md may cite Android DriverServiceImpl.kt:494 alongside the Swift default; code-review.md's retained "~146 audit findings" should be marked as the audit's unverified estimate or dropped. -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `fab/project/code-quality.md` carries no numeric ratio for drivers.yml; ruleset `14531661` and `build.gradle.kts:104` citations and the paths-filter rationale remain — verified: `drivers.yml:21,29,42` cite the ruleset, `:52` cites `build.gradle.kts:104`, `:40-45` carry the paths-filter-vs-ci.yml rationale
- [x] A-002 R2: the code-review.md sweep bullet is past tense and names the merged change/PR — verified `7b38afc` = "docs: Comment Content Sweep (#171)" and `fab/changes/260731-vxq1-comment-content-sweep` exists
- [x] A-003 R3: env.ts shim comment states consumer compatibility, cites no constitution prohibition; exports unchanged — verified `packages/common/src/test/env.test.ts:6` imports `parseModel`/`parseReasoningLevel` from `../env.js`; export block byte-identical in the diff
- [x] A-004 R4: both citations anchor to `Logger._emit`'s sink loop without line numbers; unguardedness claim retained — verified `logger.ts:99-101` loop has no try/catch, `reportWriter.ts:128` `createLoggerSink()` is a bare `fs.appendFileSync`, installed via `Logger.addSink` at `testRunner.ts:317`
- [x] A-005 R5: none of the five headers names `FinalRunAgent`, `HeadlessGoalExecutor`, `HeadlessActionExecutor`, `ActionProcessor`, or `WebSocketServerImpl`; every named consumer greps in-tree — re-verified independently after rework: the five false symbols are gone from all five headers (the only surviving `FinalRunAgent` hits are `AIAgent.ts:1,199,201`, all naming the *Dart* file `FinalRunAgent.dart` — out of scope and true). constants.ts:11-14 verifies (`AIAgent.ts:23-29,321,891-903` and `VisualGrounder.ts:7,51` select prompts/models per feature; `ai/schemas.ts:194-200` keys `FEATURE_SCHEMAS`; `workspace.ts:7,80,467` keys overrides off `ALL_FEATURES`). constants.ts:156-159 verifies (`AIAgent.ts:1142-1155` `FIXED_PROMPT_ACTIONS` maps snake_case `action_type` → `PLANNER_ACTION_*`; `ActionExecutor.ts:210-233` handler map; `TestExecutor.ts:562,590` terminals). **Rework finding resolved**: `Hierarchy.ts:2-4` no longer names `device-node` (confirmed zero `Hierarchy`/`HierarchyNode` references there) and now names four verified importers — `AIAgent.ts:22`, `ActionExecutor.ts:6`, `TestExecutor.ts:7`, `GrounderResponseConverter.ts:5`
- [x] A-006 R6: grpc-contract.md attributes 24 to gRPC StartStreaming (proto-adopted) and 1 to the legacy WebSocket path — verified `GrpcDriverServer.swift:130-137,651`, `XCViewHierarchyManager.swift:39,64`, `driver.proto:170` (Android `DriverServiceImpl.kt:494` also defaults 24)
- [x] A-007 R7: walkthrough says 7 packages, `finalrun.ts:372-485`, 22 types, table paths/functions match `git ls-files` and real definitions, checkRunner path is `packages/common/src` — independently re-measured after rework: `ls packages/` = 7 (`cloud-core`/`local-runtime` descriptions match their `package.json:5`); `runTestCommand` spans 372→485 (brace-balanced, next decl at 487); 22 concrete `DeviceAction` subclasses; `parseModel` defined `constants.ts:92`, `parseReasoningLevel` `constants.ts:44`, `resolveApiKey` in `cli/src/apiKey.ts:3`, every moved row's file+function verified (`runCheck` `checkRunner.ts:52`, `loadTest` `testLoader.ts:86`, `loadWorkspaceConfig` `workspace.ts:431`, `CliEnv` `env.ts:29`, …); `reportTemplate.ts`/`reportIndexTemplate.ts` absent from `git ls-files`; §4 header now `packages/common/src/checkRunner.ts`. **Rework findings resolved**: (must-fix) `:38` and `:62` now state report-web is served by the CLI's report server and is a build-time dependency — verified `cli/src/reportServer.ts:10,23-36`, `cli/scripts/copyReportApp.mjs:14-28` (bails), `local-runtime/scripts/buildRuntimeTarball.mjs:130-134` (bails); (should-fix) `bin/finalrun.ts` moved to its own `### packages/cli/bin/` subsection (`:1117-1121`), `:1100` now reads "(22 concrete action classes)", and §10.1 `:682,685` now read "React SPA (`report-web`)" / "Vite + React SPA"
- [x] A-008 R8: 3vhw `.status.yaml` shows `review-pr: done` with `completed_at` — `completed_at: "2026-07-31T12:20:33Z"`
- [x] A-009 R9: constants.ts line 1 and Hierarchy.ts line 2 carry no stale/unverifiable claims — `~108KB` dropped; enumeration replaced with an enumeration-free claim

### Behavioral Correctness

- [x] A-010 R3 R5: no executable line changed in any edited `.ts`/`.kt` file (git diff shows comment-only hunks) — verified mechanically: every added/removed line in `*.ts`/`*.kt` starts with `//`, `*`, or `/*`

### Scenario Coverage

- [x] A-011 R8: `fab preflight 3vhw` (or `fab status`) reflects a fully-done pipeline after the finish — `display_stage: review-pr`, `display_state: done`, all six stages `done`

### Edge Cases & Error Handling

- [x] A-012 R7: every replacement figure in the walkthrough was re-measured at apply time, not copied from the intake — independently re-measured during review; note the intake's own 103/44 drivers.yml figure was correctly NOT carried into any file

### Code Quality

- [x] A-013 Pattern consistency: rewritten comments follow `code-quality.md` § Comments (rationale-only, deletion-test-passing; no new restatement comments) — each rewritten header carries cross-file consumer coupling or retention rationale, none recoverable from the adjacent code
- [x] A-014 No unnecessary duplication: corrections edit existing blocks in place; no parallel/duplicate explanation added

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- `fab/backlog.md` must never be staged or committed (absent in this worktree; guard binds at ship)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | R1: remove the ratio with no replacement figure | Requester's preferred option; measurement is method-sensitive (this run's stripped-`#` count gives 138/53, not the intake's 103/44), so any written figure would invite the same rot | S:95 R:90 A:95 D:90 |
| 2 | Certain | R5: drop the Kotlin "replaces X" clauses instead of substituting a predecessor | `ActionProcessor`/`WebSocketServerImpl` exist nowhere in-repo (grep + `git log -S` hit only these comments); intake explicitly allows dropping when no real predecessor exists | S:90 R:90 A:95 D:90 |
| 3 | Confident | R5: also correct the adjacent "must match the strings the planner LLM outputs" sentence in constants.ts | Verified false (AIAgent's `FIXED_PROMPT_ACTIONS` maps snake_case prompt strings onto these keys); leaving a verified-false claim in a header this change edits contradicts the change's purpose | S:70 R:90 A:90 D:75 |
| 4 | Confident | R4: convert the adjacent `reportWriter.ts:132` citation to line-free in the same sentences | `createLoggerSink` is now at line 128 — the citation has already rotted; same durability rationale the requester gave for the logger anchor | S:70 R:90 A:90 D:80 |
| 5 | Confident | R7: correct/remove the `reportTemplate.ts`/`reportIndexTemplate.ts` rows while fixing the cli/src table | Claim 4's fix is "table paths checked against the actual files"; both files verified absent from the tree, so leaving the rows fails the check the fix prescribes | S:65 R:90 A:90 D:70 |
| 6 | Confident | R7: in the two blocks the package-count fix edits (tree + Why table), label report-web accurately as a Vite React SPA; leave the report-web Package Map table untouched and report the rot | report-web verified non-Next.js (`vite` scripts, SPA description); wider walkthrough rot is out of the intake's five claims | S:60 R:85 A:85 D:65 |
| 7 | Confident | R7: keep a corrected numeric range (372-485) for `runTestCommand` rather than dropping line numbers | Intake prescribes "line ranges re-derived" for this item (unlike Item 4, where it prescribes durable anchors); walkthrough style uses ranges | S:75 R:90 A:85 D:75 |
| 8 | Confident | R9: reword constants.ts line 1 to "the subset this repo's TypeScript packages actually use" without enumerating packages | Consumer set spans more than the three named packages (common itself, cloud-core/report-web via barrel); an enumeration-free claim is verifiable and rot-proof | S:70 R:90 A:85 D:75 |
| 9 | Certain | R9: drop the ~108KB figure outright | Intake offers "drop or mark unverifiable"; no Dart sources in repo or history, so dropping is the cleaner of the two offered options | S:85 R:95 A:90 D:85 |
| 10 | Certain | R8: `fab status finish 3vhw review-pr` (tooling path) | State pre-verified `review-pr: active` via `fab preflight 3vhw`; exactly the transition the tooling's finish performs | S:95 R:85 A:95 D:90 |
| 11 | Certain | R5 rework: name `GrounderResponseConverter` in the Hierarchy.ts header alongside AIAgent/ActionExecutor/TestExecutor (rework annotation made it optional) | Verified importer (`goal-executor/src/GrounderResponseConverter.ts:5` imports `HierarchyNode`); naming all four goal-executor consumers keeps the header complete after dropping the false device-node claim (device-node has zero `Hierarchy`/`HierarchyNode` references) | S:85 R:95 A:95 D:90 |
| 12 | Confident | R7 rework: move the `bin/finalrun.ts` row into a new `### packages/cli/bin/` subsection rather than relabeling it inside the `cli/src` table | Rework annotation allows "move/fix"; a dedicated subsection keeps every table's File column relative to its heading, matching the doc's existing convention | S:75 R:90 A:90 D:80 |
| 13 | Confident | R7 rework: in §10.1 fix only the two Next.js labels (header + Technology row), leaving the section's remaining framing ("Two Report Server Implementations", "When used") untouched | Rework annotation scopes the fix to "those two labels"; the wider report-web rot stays reported-not-fixed per plan Non-Goals | S:70 R:90 A:90 D:75 |
| 14 | Confident | T011 rework: keep the ~146 figure in code-review.md but mark it as the source audit's never-independently-verified estimate (rather than dropping it) | Annotation offers "marked … or dropped"; marking preserves the scope-size context while removing the false precision | S:65 R:90 A:90 D:70 |
| 15 | Confident | T011 rework: cite Android's fps default via the line-free anchor `DriverServiceImpl.startStreaming` instead of `:494` | Verified `if (request.hasFps()) request.fps else 24` at that method; line-free anchors are the durability convention this change already adopted for the twice-rotted logger citation | S:80 R:90 A:90 D:85 |

15 assumptions (5 certain, 10 confident, 0 tentative).
