# Intake: Comment Content Sweep

**Change**: 260731-vxq1-comment-content-sweep
**Created**: 2026-07-31

## Origin

One-shot `/fab-new` invocation. User's raw input:

> Sweep comment content across the codebase, under the comment policy that just merged to main in PR #169. Read fab/project/code-quality.md and fab/project/code-review.md FIRST -- that policy is binding on this change and it was written specifically to govern this sweep. Three parts. (1) Remove restatement comments: comments that restate what the code plainly says, per the policy deletion test. The audit estimated roughly 146 of these, but treat that number as unverified -- an earlier estimate from the same audit claimed 4,900 deletable lines and it verified out at 1,864, so re-derive the real count yourself and report what you actually find. Apply the policy per CLAIM, not per block and not per file: a single comment block may mix one rationale sentence and one restatement sentence, and only the restatement sentence is removed. The policy is explicit about this mixed-block case. (2) Document four security controls that are currently present in the code but completely undocumented: the secrets-versus-variables handling in testCompiler.ts, the symlink guard in reportArtifactStream.ts, the substring leak guard in repoPlaceholders.ts, and the command-injection blocklist in DeviceActions.kt. Read each control and describe what it actually defends against and how, so a future reader does not delete it as unnecessary. (3) Fix roughly 10 factually wrong comments -- comments describing behavior the code does not actually have. Verify each claim against the code before rewriting it, and report any where the comment turned out to be right and the code wrong, because that is a different and more serious finding. HARD CONSTRAINTS from the merged policy: non-obvious rationale is EXEMPT from this sweep with no ratio cap, and deleting rationale is must-fix severity. CI and workflow files are explicitly exempt -- do NOT touch .github/workflows/drivers.yml, whose 67-comment-to-18-functional-line ratio is named in the policy as the canonical fully-compliant example. This change is comments only: do not change any runtime behavior, do not rename anything, and do not refactor.

Key context from intake:

- This is the sweep that `fab/project/code-review.md` § Project-Specific Review Rules explicitly pre-announces: "the planned restatement-comment sweep (~146 audit findings, executed as a separate later change)". The policy (change `260731-jjey-comment-content-policy`, PR #169, merged as commit `7baca3b`) was written specifically to govern this change and is binding.
- All four named security-control files were located and their controls verified to exist at intake time (see What Changes part 2 for the verified anchors).
- The ~146 restatement count is explicitly flagged as unverified by the user, with a calibration precedent: the same audit's dead-code estimate of 4,900 lines verified out at 1,864 (change `260731-3vhw-delete-dead-code-audit-targets`, PR #170). The real count MUST be re-derived and the actual number reported.

**Operator scope correction (pre-apply, 2026-07-31)**: the original brief's "do NOT touch drivers.yml at all" was too broad. The merged policy exempts `drivers.yml` from the *restatement* sweep, not from *factual correction* — part 3 applies there. Three named part-3 candidates were supplied (source: an independent post-merge verification review of PR #170) and all three were **verified against the live tree at intake**:

1. `.github/workflows/drivers.yml` (~line 10): claims the androidTest tree is "24 of 25 Kotlin files". Verified false: 23 of 24 — PR #170 deleted `TestActions.kt` (find confirms 24 total `.kt`, 23 under androidTest, zero `TestActions.kt`). The identical claim was already corrected in `docs/memory/ci/pr-quality-gate.md` (~line 141, reads "23 of 24 Kotlin files"); the workflow duplicate was missed.
2. `.github/workflows/drivers.yml` (line 6): claims "the 48 native files". Verified false: 44 (24 Kotlin + 20 Swift). This error predates #170 — it came in with PR #167.
3. `packages/common/src/constants.ts` (line 2): claims "The Dart file has 358 lines; we carry over ~30%". Verified stale: `constants.ts` is now 149 lines / 40 exports after PR #170 removed ~30 exports, so the ratio no longer holds (the Dart source is external to this repo, so the 358 figure is also unverifiable here — the corrected comment must not re-assert unverifiable numbers).

Unchanged by the correction: rationale comments in `drivers.yml` are still NOT removed or reworded — its 67:18 ratio remains the canonical compliant example. Only these specific factual numbers change.

## Why

1. **The pain point**: the codebase audit found roughly 146 restatement comments (unverified count) — comments that fail the deletion test in `code-quality.md` `## Comments`. They add noise without information. Separately, four security controls exist in code with zero explanatory comments — a future reader cannot tell they are deliberate defenses and may remove them as unnecessary complexity. And roughly 10 comments actively lie: they describe behavior the code does not have, which is worse than no comment because readers trust comments over re-deriving behavior.

2. **The consequence of not fixing it**: restatement comments keep training readers to skim past comments, wrong comments keep misleading them, and the undocumented security controls remain one confident refactor away from silent deletion (e.g., the longest-first sort in `repoPlaceholders.ts` looks like an arbitrary style choice unless its leak-prevention purpose is stated).

3. **Why this approach**: the policy was deliberately landed first (PR #169) so this sweep executes a stated, reviewable standard instead of ad hoc judgement. The three parts are complementary applications of the same core rule — "a comment must state what the code cannot show": part 1 removes comments that state what the code shows, part 2 adds comments where the code cannot show the why, part 3 fixes comments that state what the code does NOT show.

## What Changes

Comments only, across `packages/` and `drivers/`. **No runtime behavior changes, no renames, no refactors.** The diff must be inert under any semantics-aware comparison: only comment lines (and blank lines left behind by removed comments) are added, removed, or edited.

### Part 1: Remove restatement comments (per-claim deletion test)

Scan all source files in `packages/` and `drivers/` (TypeScript, Kotlin, Swift) for comments that fail the deletion test: *if removing the comment leaves a competent reader able to recover everything it said from the code itself, it is restatement.*

- **Unit of judgement is the individual claim** — per `code-quality.md` `## Comments`: "A single block may mix both kinds — a rationale paragraph followed by a line restating the YAML key below it. Sweeping removes restatement sentences and keeps rationale sentences even when adjacent." A mixed block is edited, not deleted.
- **Exempt with no ratio cap**: rationale ("why this and not the alternative"), non-obvious constraints and cross-file couplings, references to external systems (ruleset IDs, tickets, vendor behavior), measured data. Deleting such a claim is **must-fix severity** per `code-review.md`.
- **Exempt entirely from part 1**: CI and workflow files (`.github/workflows/*.yml`, build scripts, config files generally). `.github/workflows/drivers.yml` (67 comment lines : 18 functional lines) is the policy's canonical fully-compliant example — no restatement removal and no rationale rewording there. `ci.yml` is likewise protected. **Per the operator scope correction, this exemption covers the restatement sweep only — part 3 factual corrections DO apply to `drivers.yml` (two specific numeric claims, see part 3).**
- **Ambiguity bias**: when a comment is arguably either kind, keep it (`code-review.md`: "A false keep costs a few lines; a false delete costs unrecoverable context").
- **Count verification**: the ~146 estimate is unverified. Re-derive the actual count during apply and report it in the results (found N candidates, removed M claims, kept K ambiguous). Calibration precedent: the same audit's 4,900-line dead-code estimate verified out at 1,864 lines, so material deviation from 146 is expected and must be reported, not forced to match.
- Doc-comment structures (JSDoc/KDoc) follow the same per-claim test — e.g., a `@param name - the name` line that adds nothing is restatement even when the summary sentence above it is kept.

### Part 2: Document four undocumented security controls

Each control was verified to exist at intake time. Add a comment at each site stating what the control defends against and how, so a future reader does not delete it as unnecessary. The apply agent MUST read each control in full and describe its *actual* behavior (verified against code, not against this summary):

1. **`packages/cli/src/testCompiler.ts` — secrets-versus-variables handling.** `VARIABLE_REFERENCE_PATTERN` (line ~3) matches only `${variables.*}` tokens; `interpolateVariables` substitutes those and deliberately leaves `${secrets.*}` tokens unresolved. The compiled prompt instead instructs the model to treat `${secrets.*}` placeholders as logical tokens and echo them verbatim (lines ~46–47). Defends against: secret values leaking into LLM prompts, model provider logs, and compiled test artifacts. Substitution happens only downstream at the point of use, never in prompt text.
2. **`packages/cli/src/reportArtifactStream.ts` — symlink guard.** After the initial `resolveArtifactPath` containment check, the handler re-checks containment on `fsp.realpath` of both the artifacts root and the resolved path (lines ~62–66), rejecting when the *real* path escapes the *real* root. Defends against: path traversal via symlinks — a symlink inside the artifacts directory pointing outside it passes a purely lexical containment check but is caught by the realpath comparison, preventing arbitrary file disclosure over the report HTTP stream.
3. **`packages/common/src/repoPlaceholders.ts` — substring leak guard.** `redactResolvedValue` sorts secret replacement entries by value length, longest first (line ~37), before substituting values with `${secrets.KEY}` placeholders. Defends against: partial secret leakage when one secret's value is a substring of another's — replacing the shorter value first would corrupt the longer value's occurrence so it no longer matches, leaving fragments of the longer secret in redacted output.
4. **`drivers/android/app/src/androidTest/java/app/finalrun/android/action/DeviceActions.kt` — command-injection blocklist.** `shellMetachars` (line ~236) defines the shell metacharacter set; text is routed through `uiDevice.executeShellCommand("input text ...")` only when every character is ASCII (`code < 128`) and not in that set; otherwise the code takes the non-shell input path. Defends against: command injection through the ADB shell — test-controlled text containing `;`, `$(...)`, backticks, etc. would otherwise be interpolated into a shell command line.

Comment style: match each file's existing comment idiom; state the defended-against attack and the mechanism, per the policy's qualifying content ("non-obvious constraints", "rationale"). These are rationale comments by construction and must pass the deletion test (they state what the code cannot show — the *threat model*).

### Part 3: Fix roughly 10 factually wrong comments

The audit identified roughly 10 comments describing behavior the code does not have (count similarly unverified). For each candidate:

1. **Verify the claim against the code first** — read the code the comment describes and establish what actually happens.
2. If the comment is wrong and the code is right: rewrite the comment to describe actual behavior (or delete it if the corrected claim would be restatement).
3. **If the comment is right and the code is wrong**: do NOT change either. Record it as a separate finding and report it prominently in the change results — a comment-code divergence where the code is the defect is a bug report, not a comment fix, and fixing the code is out of scope for this comments-only change (per the constitution's Test Integrity principle analog: the spec/intent may live in the comment).
4. Beyond the three named candidates below, no candidate list was provided — the apply agent identifies the remaining candidates during the part-1 scan (a comment that mis-describes behavior is discovered by the same read-the-code-and-compare act the deletion test requires).

**Three named candidates from the operator scope correction (all verified at intake — see Origin):**

- **`.github/workflows/drivers.yml` ~line 10** — "24 of 25 Kotlin files" → correct to **23 of 24** (PR #170 deleted `TestActions.kt`). Match the already-corrected phrasing in `docs/memory/ci/pr-quality-gate.md` ~line 141.
- **`.github/workflows/drivers.yml` line 6** — "the 48 native files" → correct to **44** (24 Kotlin + 20 Swift; error came in with PR #167).
- **`packages/common/src/constants.ts` line 2** — "The Dart file has 358 lines; we carry over ~30%" → the ratio is stale (`constants.ts` is now 149 lines / 40 exports after PR #170); rewrite so the comment no longer asserts the stale ratio or unverifiable upstream line count, while keeping the rationale claim ("port of `constants/lib/constants.dart` — ONLY the CLI-relevant subset"), which passes the deletion test and stays.

For the two `drivers.yml` fixes: change **only these numeric claims**, character-minimal edits — every rationale sentence in that file stays byte-for-byte intact.

### Explicit non-goals

- No runtime behavior change of any kind — the compiled output/bytecode-relevant content must be identical.
- No renames, no refactors, no dead-code deletion (that was PR #170).
- No part-1 (restatement) edits to `.github/workflows/*` or CI/build/config files; the only permitted edits there are the two named factual number corrections in `drivers.yml` (part 3). No rationale sentence in `drivers.yml` is removed or reworded.
- No fixes to code found wrong during part 3 — those are reported, not fixed.
- No policy edits — `code-quality.md` / `code-review.md` are inputs, not targets.

## Affected Memory

None expected. This change edits comments only — no spec-level behavior changes. The four security controls' *behavior* already exists and is unchanged; documenting them in-code does not alter system behavior. If part 3 surfaces a comment-right-code-wrong finding, that is reported in the change results for a future fix change (which would own any memory update).

## Impact

- **Scope**: comment lines across `packages/` (TypeScript) and `drivers/` (Kotlin, Swift). Estimated ~100–200 comment-line removals/edits (the ~146 figure is unverified; actual count reported at apply), 4 comment additions (security controls), ~10 comment rewrites.
- **Runtime impact**: none by construction — comments only.
- **Tests**: no test behavior changes; test files' comments are in scope for the same per-claim test.
- **CI**: existing gates (build/typecheck/test/lint, drivers compile gate) must stay green — they verify the no-behavior-change constraint.
- **Protected paths**: `.github/workflows/ci.yml` and CI/build/config files generally — zero edits, except `.github/workflows/drivers.yml`, which receives exactly the two named numeric corrections (48→44, 24-of-25→23-of-24) and nothing else; `packages/common/src/constants.ts` line 2 receives the stale-ratio rewrite.

## Open Questions

None — the user's input is unusually specific: scope, method (per-claim deletion test), exemptions, severity mapping, the four control sites, the verification duty on both counts, and the comments-only constraint are all stated or bound by the merged policy.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The sweep executes under `code-quality.md` `## Comments` + `code-review.md` sweep-scope rules verbatim: deletion test per claim, rationale exempt with no ratio cap, CI/workflow files exempt, ambiguity resolved toward keeping | User states the policy is binding; both files were read at intake and state exactly these rules | S:95 R:90 A:95 D:95 |
| 2 | Certain | Comments only — no runtime behavior change, no renames, no refactors; CI/config files untouched by the restatement sweep; `drivers.yml` receives only the two operator-named numeric corrections, with every rationale sentence intact | Explicit hard constraints in the user input, amended by the operator scope correction ("only these specific factual numbers change") | S:95 R:85 A:95 D:95 |
| 3 | Certain | The ~146 and ~10 counts are treated as unverified estimates; actual counts are re-derived during apply and reported (with the 4,900→1,864 calibration precedent named) | User explicitly instructs this, citing the prior estimate that verified out at 38% | S:90 R:90 A:90 D:90 |
| 4 | Confident | The four security-control comments describe the verified mechanisms found at intake: secrets left uninterpolated in prompts (testCompiler.ts), realpath containment re-check (reportArtifactStream.ts), longest-first secret replacement (repoPlaceholders.ts), shell-metachar + ASCII gate before `executeShellCommand` (DeviceActions.kt) — with apply re-verifying each against the full code before writing | All four verified present at the cited lines at intake; apply must still read each in full since intake read excerpts | S:85 R:80 A:85 D:80 |
| 5 | Confident | Part-3 candidates are identified by the apply agent during the sweep scan (no list was provided); a comment-right-code-wrong case is reported as a finding, never fixed in this change | User defines the handling but provides no candidate list; discovery-during-scan is the only available method and the user's phrasing ("verify each claim against the code") presumes the agent locates them | S:70 R:75 A:75 D:70 |
| 6 | Confident | Blank lines left by removed comment blocks are cleaned up (no double-blank residue), and mixed blocks are edited in place rather than deleted; this is formatting hygiene within the comments-only constraint, not refactoring | Follows from the per-claim rule and ordinary diff hygiene; leaving dangling blanks would fail lint in some files | S:60 R:85 A:80 D:75 |
| 7 | Confident | Scope of the part-1 scan is `source_paths` from config (`packages/`, `drivers/`) including test files, excluding generated code, vendor directories, and `node_modules`, plus the CI/workflow/config exemption | Matches config `source_paths` and `code-review.md` Review Scope ("skip generated code and vendor directories") | S:70 R:80 A:85 D:75 |
| 8 | Certain | The three operator-named part-3 corrections are applied with the verified values: drivers.yml "48 native files"→44 (24 Kotlin + 20 Swift), "24 of 25 Kotlin files"→23 of 24, and constants.ts's stale 358-line/~30% ratio rewritten without unverifiable numbers | All three independently verified against the live tree at intake (file counts by `find`, line count by `wc -l`, memory-file precedent at `pr-quality-gate.md` ~141); operator supplied source (post-merge verification review of PR #170) | S:90 R:90 A:95 D:90 |

8 assumptions (4 certain, 4 confident, 0 tentative, 0 unresolved).
