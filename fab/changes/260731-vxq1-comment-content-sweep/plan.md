# Plan: Comment Content Sweep

**Change**: 260731-vxq1-comment-content-sweep
**Intake**: `intake.md`

## Requirements

### Comments: Restatement Removal (Part 1)

#### R1: Per-claim restatement sweep across source trees
All source files under `packages/` and `drivers/` (TypeScript, Kotlin, Swift — including test files, excluding generated code, vendor dirs, and `node_modules`) SHALL be swept for comments that fail the deletion test in `fab/project/code-quality.md` `## Comments`. The unit of judgement MUST be the individual claim: mixed blocks are edited, not deleted; rationale, non-obvious constraints, external references, and measured data are exempt with no ratio cap. Ambiguous claims MUST be kept. CI/workflow/build/config files MUST receive zero part-1 edits. The actual candidate count MUST be re-derived (the ~146 audit figure is unverified) and reported as found/removed/kept.

- **GIVEN** a comment claim whose entire content is recoverable from the adjacent code, names, and structure
- **WHEN** the sweep evaluates it
- **THEN** that claim (and only that claim) is removed, leaving adjacent rationale sentences byte-for-byte intact
- **AND** blank-line residue from removed blocks is cleaned up

- **GIVEN** a comment claim that is arguably rationale or arguably restatement
- **WHEN** the sweep evaluates it
- **THEN** it is kept (false-keep bias)

#### R2: Commented-out code is out of scope
Commented-out code blocks SHALL NOT be deleted by this change — dead-code deletion was PR #170's scope and the intake's non-goals prohibit it here.

- **GIVEN** a block of commented-out code (e.g., disabled `debugLog` lines)
- **WHEN** the part-1 sweep encounters it
- **THEN** it is left in place

### Comments: Security-Control Documentation (Part 2)

#### R3: Four verified security controls documented in-code
A rationale comment SHALL be added at each of the four verified control sites, stating what the control defends against and how, verified against the full code (not the intake summary), in each file's existing comment idiom:

1. `packages/cli/src/testCompiler.ts` — `VARIABLE_REFERENCE_PATTERN` matches only `${variables.*}`; `${secrets.*}` tokens deliberately stay literal in compiled LLM prompts (the prompt instructs the model to echo them verbatim), so secret values never reach prompts, provider logs, or compiled artifacts.
2. `packages/cli/src/reportArtifactStream.ts` — after the lexical `resolveArtifactPath` check, containment is re-checked on `fsp.realpath` of both root and resolved path, defeating symlink-based traversal that a purely lexical check misses.
3. `packages/common/src/repoPlaceholders.ts` — `redactResolvedValue` sorts secret values longest-first before building the single-pass alternation, so when one secret's value is a substring of another's the longer match wins and no fragment of the longer secret survives redaction.
4. `drivers/android/.../action/DeviceActions.kt` — `enterText` routes through `uiDevice.executeShellCommand("input text ...")` only when every char is ASCII (`code < 128`) and not in `shellMetachars`; anything else takes the clipboard paste path, preventing shell command injection via test-controlled text.

- **GIVEN** each control site
- **WHEN** the comment is added
- **THEN** it names the defended-against attack and the mechanism, passes the deletion test (states the threat model the code cannot show), and changes no code line

### Comments: Factual Corrections (Part 3)

#### R4: Three operator-named corrections applied with verified values
The three intake-verified corrections SHALL be applied:

- `.github/workflows/drivers.yml` line 6: "the 48 native files" → 44 (verified: 24 Kotlin + 20 Swift)
- `.github/workflows/drivers.yml` line ~10: "24 of 25 Kotlin files" → "23 of 24 Kotlin files" (verified: PR #170 deleted `TestActions.kt`; matches `docs/memory/ci/pr-quality-gate.md` phrasing)
- `packages/common/src/constants.ts` line 2: drop the stale "358 lines / ~30%" claim entirely; keep the line-1 rationale ("Port of constants/lib/constants.dart — ONLY the CLI-relevant subset") and do not assert any unverifiable upstream number

The two `drivers.yml` edits MUST be character-minimal — these two numeric claims are the ONLY permitted edits in that file; every rationale sentence stays byte-for-byte. `ci.yml` receives zero edits.

- **GIVEN** `.github/workflows/drivers.yml`
- **WHEN** the change's full diff for that file is inspected
- **THEN** it contains exactly two hunks touching only the numeric claims "48"→"44" and "24 of 25"→"23 of 24"

#### R5: Discovered factual corrections verified against code first
Additional factually-wrong comments (~10 estimated, unverified) discovered during the sweep SHALL each be verified against the code they describe before any rewrite. If the comment is wrong and the code is right: rewrite (or delete if the corrected claim would be restatement). If the comment is right and the CODE is wrong: change NOTHING and record it as a prominent comment-right-code-wrong finding in the change results.

- **GIVEN** a comment describing behavior the code does not have, where the code's behavior is the intended one
- **WHEN** part 3 processes it
- **THEN** the comment is rewritten to describe actual behavior

- **GIVEN** a comment-code divergence where the comment states the intent and the code is defective
- **WHEN** part 3 processes it
- **THEN** neither is changed and the finding is reported prominently

### Invariant: Comments-Only Diff

#### R6: Zero runtime-behavior change
The full change diff MUST touch only comment lines (and blank lines left by removed comments). No renames, no refactors, no dead-code deletion, no policy-file edits (`code-quality.md`/`code-review.md` are inputs), no CI/config edits beyond R4's two drivers.yml hunks. Repo checks (build, typecheck, lint, tests) MUST stay green.

- **GIVEN** the completed change
- **WHEN** `git diff` is inspected and the repo's checks run
- **THEN** every added/removed/edited line is a comment or blank line, and all checks pass

### Non-Goals

- Fixing any code found defective during part 3 — reported, not fixed
- Deleting commented-out code — dead-code cleanup was PR #170
- Editing `fab/project/code-quality.md` / `code-review.md` — binding inputs
- Any edit to `.github/workflows/ci.yml`, build scripts, or config files

### Follow-Ups (recorded, deliberately not done here — comments-only change)

- **`DeviceActions.kt` `enterText` gate gap (carried-forward code defect)**: the shell-safety gate `text.all { it.code < 128 && it !in shellMetachars }` does not block ASCII control characters — `\n` (10) and `\r` (13) pass `code < 128` and are absent from `shellMetachars`, so test-controlled text containing a newline still reaches `executeShellCommand("input text ...")` and may be reinterpreted as command syntax. The gate narrows the injection surface; it does not close it. Follow-up: also require `it.code >= 32`, or route control-char text to the clipboard path. Found during review of this change's part-2 comment; fixing it here would violate the comments-only invariant.
- **`FrAccessibilityListener.kt` `stop()` does not stop (comment-right-code-wrong)**: the doc says "Stops listening for accessibility events", but the code only sets `isListening = false` — it never calls `uiAutomation.setOnAccessibilityEventListener(null)`, and `onAccessibilityEvent` never consults `isListening`, so toast capture continues after `stop()`. The comment states the intent; the code doesn't implement it. Per part 3's rule, both were left untouched — this is a bug report for a follow-up fix change. **Hydrate-stage addendum**: the entire listener is unreferenced repo-wide (no caller of `start()`/`stop()`/`getToastAccessibilityNode()`/`isToastTimedOut()` outside the file itself), so the divergent path never executes — the right follow-up is dead-code deletion (PR #170's category), not a behavior fix.

## Tasks

### Phase 1: Setup

- [x] T001 Build the part-1 candidate inventory: extract all comment lines from `packages/` and `drivers/` source files (excluding node_modules/dist/build/generated), classify each claim as restatement / rationale / ambiguous / factually-wrong per the deletion test, and record the derived counts <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 Apply part-1 restatement removals across `packages/` TypeScript files, per-claim, keeping rationale sentences intact and cleaning blank-line residue <!-- R1 -->
- [x] T003 Apply part-1 restatement removals across `drivers/` Kotlin and Swift files, per-claim, leaving commented-out code blocks in place <!-- R1 --> <!-- rework: review should-fix — restore the ordering-constraint claim deleted at ScreenStreamer.kt:141 ("set flag first" before cancelChildren so a launched-but-unstarted coroutine bails at its guard); rephrase without the changelog numbering. Per code-review.md ambiguity bias it should have been kept. Only this one claim — the rest of T003 stands. -->
- [x] T004 [P] Add the four security-control comments: `packages/cli/src/testCompiler.ts` (secrets-vs-variables), `packages/cli/src/reportArtifactStream.ts` (realpath symlink re-check), `packages/common/src/repoPlaceholders.ts` (longest-first redaction), `drivers/android/app/src/androidTest/java/app/finalrun/android/action/DeviceActions.kt` (shell-metachar + ASCII gate) — each verified against the full code before writing <!-- R3 --> <!-- rework: review must-fix — the DeviceActions.kt comment falsely claims the clipboard fallback "never touches a shell" (pasteText calls executeShellCommand("input keyevent 279") at ~line 260); correct to: never puts the TEXT on a shell command line (only fixed keyevent). Also should-fix: soften the protection claim — the ASCII+metachar gate does NOT block ASCII control chars (\n=10, \r=13 pass code<128 and are not in shellMetachars, and sh -c treats newline as a statement separator), so the gate narrows, not closes, the injection surface; record that gap as a carried-forward code defect for a follow-up change (do NOT fix the code). Other three comments verified accurate — do not touch them. -->
- [x] T005 [P] Apply the three operator-named part-3 corrections: `.github/workflows/drivers.yml` "48"→"44" and "24 of 25"→"23 of 24" (character-minimal, nothing else in that file), and `packages/common/src/constants.ts` line-2 stale-ratio rewrite keeping the line-1 rationale <!-- R4 -->

### Phase 3: Integration & Edge Cases

- [x] T006 Process factually-wrong comments discovered during T001 (e.g., `DeviceActions.kt` "Scale to 50%" vs `0.7f`, `getScreenshotInByteArray` KDoc claiming Base64): verify each against code, rewrite where the code is right, and record any comment-right-code-wrong cases as findings without touching either <!-- R5 -->
- [x] T007 Verify the comments-only invariant: inspect the full `git diff` to confirm only comment/blank lines changed, `drivers.yml` has exactly the two numeric hunks, `ci.yml` is untouched; then run the repo checks (build, typecheck, lint, tests) and confirm green <!-- R6 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: Restatement claims failing the deletion test are removed across `packages/` and `drivers/`, with derived counts (found/removed/kept-ambiguous) reported in the change results
- [x] A-002 R3: All four security-control sites carry a comment stating the defended-against attack and the mechanism, matching the file's comment idiom
- [x] A-003 R4: `drivers.yml` reads "44 native files" and "23 of 24 Kotlin files"; `constants.ts` no longer asserts the 358-line/~30% ratio but keeps the CLI-relevant-subset rationale
- [x] A-004 R5: Every discovered part-3 rewrite was verified against code; any comment-right-code-wrong case is reported as a finding with both comment and code unchanged

### Behavioral Correctness

- [x] A-005 R1: Mixed blocks were edited per claim — no rationale sentence was deleted alongside adjacent restatement (deleting rationale is must-fix severity)
- [x] A-006 R2: No commented-out code block was deleted

### Scenario Coverage

- [x] A-007 R4: The `drivers.yml` diff contains exactly two hunks, each touching only the corrected numeric claim; every rationale sentence in the file is byte-for-byte unchanged
- [x] A-008 R6: `git diff` for the whole change contains only comment-line and blank-line modifications; `ci.yml` and `fab/project/*.md` are untouched

### Edge Cases & Error Handling

- [x] A-009 R1: Ambiguous claims (arguably rationale) were kept, and CI/workflow/build/config files received zero part-1 edits

### Code Quality

- [x] A-010 Pattern consistency: added comments match each file's existing comment idiom (line comments, KDoc, JSDoc as appropriate)
- [x] A-011 No unnecessary duplication: no comment restating what adjacent code shows was introduced by this change (anti-pattern: restatement comments)

### Security

- [x] A-012 R3: Each of the four security comments accurately describes the control's actual verified behavior (no drift from code), so the control cannot be mistaken for unnecessary complexity — re-verified after rework: `testCompiler.ts:3-11` (pattern matches only `${variables.*}`; Execution Rules at :55-56 instruct the model to echo secret tokens; substitution only in `resolveRuntimePlaceholders`, called from `ActionExecutor.ts:365,697`), `reportArtifactStream.ts:62-67` (`resolveArtifactPath` at :21-32 is purely lexical; the realpath re-check at :67-71 rejects escaping symlinks), `repoPlaceholders.ts:35-40` (longest-first sort at :43 feeds the single alternation built at :55-60, so the longer secret wins the match), and `DeviceActions.kt:227-237` (fast path at :242 interpolates the text into `input text …`; gate at :238-239 is ASCII + `shellMetachars`; `\n`/`\r` pass both, so the comment correctly states the gate *narrows* rather than closes the surface; the rejected path `pasteText` at :248-285 sets the clipboard via `ClipboardManager` and makes exactly one shell call, the fixed `input keyevent 279` at :265 — the earlier "never touches a shell" claim is gone). The one residual is a wording caveat, not drift: see the review's should-fix on the "interpreted by the device shell" mechanism.

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Commented-out code blocks (disabled `debugLog` lines etc.) are kept — they are dead code in comment form, and dead-code deletion is an explicit non-goal; ambiguity bias also says keep | Intake non-goals prohibit dead-code deletion (PR #170's scope); policy ambiguity rule resolves the "is it a comment claim" question toward keep | S:75 R:85 A:85 D:80 |
| 2 | Confident | Local verification runs the npm workspace checks (build/typecheck/lint/tests); Kotlin/Swift comment edits are verified by diff inspection (comment-only lines) since gradle/xcodebuild are CI-side gates not available in this environment | Intake names CI as the enforcement of the no-behavior-change constraint; comment-only diffs in Kotlin/Swift cannot change compilation | S:70 R:80 A:80 D:75 |
| 3 | Confident | Part-3 discovered candidates found during T001 are processed in the same pass as part 1 (same read-code-and-compare act); the ~10 estimate is not forced — actual count reported | Intake explicitly says candidates beyond the named three are discovered during the part-1 scan | S:75 R:85 A:80 D:80 |
| 4 | Certain | `report-web` build configs (`tsup.config.ts`, `vite.config.ts`) count as config files exempt from part 1 | Policy: "build scripts, and config files generally" are exempt from the restatement sweep | S:85 R:90 A:90 D:85 |

4 assumptions (1 certain, 3 confident, 0 tentative).
