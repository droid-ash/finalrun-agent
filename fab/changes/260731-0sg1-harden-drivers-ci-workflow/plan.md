# Plan: Harden Drivers CI Workflow and Correct False Claims

**Change**: 260731-0sg1-harden-drivers-ci-workflow
**Intake**: `intake.md`

## Requirements

### CI: On-demand and scheduled triggers for the drivers gate

#### R1: workflow_dispatch and weekly schedule triggers
The `on:` block of `.github/workflows/drivers.yml` MUST gain `workflow_dispatch:` and `schedule:` (cron `'17 5 * * 1'` — weekly, Monday 05:17 UTC, non-zero minute per GitHub's top-of-hour load guidance) triggers, carried with a rationale comment explaining: the paths-filtered triggers mean nothing exercises the gate between driver changes while `macos-latest` and the unpinned Xcode toolchain rotate underneath it; `workflow_dispatch` gives an on-demand run against any ref; the weekly schedule bounds how stale "green" can get (7 days, ~4 macOS runs/month) so an image rotation surfaces as a scheduled-run failure attributable to the rotation, not as a red check on whichever unrelated PR next touches a driver path; `schedule` ignores `paths` filters by design and runs the default-branch tip; and GitHub auto-disables cron after 60 days of repo inactivity (acceptable — an inactive repo isn't merging PRs a stale green would mislead).

- **GIVEN** the drivers workflow with paths-filtered `pull_request` and `push` triggers only
- **WHEN** this change lands
- **THEN** the workflow can be dispatched on demand against any ref and runs weekly against the default-branch tip regardless of paths filters
- **AND** the existing `pull_request`/`push` triggers and their `paths` lists are unchanged

#### R2: Concurrency block untouched
The existing `concurrency:` block MUST NOT be modified. `workflow_dispatch` and `schedule` events already fall to the `github.run_id` branch of the group ternary (`github.event_name == 'pull_request' && github.ref || github.run_id`), so each such run is alone in its group — never cancelled, never queued.

- **GIVEN** the existing group expression ternary on `event_name == 'pull_request'`
- **WHEN** a `workflow_dispatch` or `schedule` run starts
- **THEN** its group key is its own `run_id` and no concurrency change is needed
- **AND** the `concurrency:` block is byte-identical to before this change

### CI: SPM dependency cache for the ios job

#### R3: Global SPM clone cache via actions/cache@v4
The `ios` job MUST gain an `actions/cache@v4` step between checkout and the build step, with `path: ~/Library/Caches/org.swift.swiftpm`, `key: spm-${{ runner.os }}-${{ hashFiles('drivers/ios/finalrun-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved') }}`, and `restore-keys: spm-${{ runner.os }}-`. Its rationale comment MUST state: `build-drivers-ios.sh` wipes DerivedData every run (`rm -rf` at line 11), so without a cache all 22 packages in `Package.resolved` re-resolve from github.com on every run — the dominant cost at the 10x macOS rate and the dominant variance the 25-minute cap absorbs; the GLOBAL SPM clone cache survives the wipe (xcodebuild's package resolution copies from it instead of cloning over the network); keying on `Package.resolved` makes a dependency bump repopulate the cache; `restore-keys` makes a stale cache a partial hit, not a miss.

- **GIVEN** the `ios` job whose build script deletes `drivers/ios/.derived-data` on every invocation
- **WHEN** the job runs with a warm cache entry for the current `Package.resolved` hash
- **THEN** SPM package resolution copies from `~/Library/Caches/org.swift.swiftpm` instead of cloning 22 repositories from github.com
- **GIVEN** a PR that bumps a dependency in `Package.resolved`
- **WHEN** the exact-key lookup misses
- **THEN** the `spm-${{ runner.os }}-` restore-key restores the previous cache as a partial hit and only changed packages re-clone

### CI: Correct false and ambiguous claims in rationale comments

#### R4: ios timeout comment reformulated as a dated observation
The `ios` timeout comment MUST replace the falsified worst-of-five claim ("9m20s ... ~2.7x headroom") with a dated, run-id-anchored formulation: worst `ios` run across all 17 runs recorded as of 2026-07-31 is 10m03s (run 30572535194, a `pull_request` run on PR #168's own branch), so 25 minutes leaves ~2.5x headroom (25/10.05 ≈ 2.49). The comment MUST state why it is formulated as a dated observation: the prior worst-of-five claim was falsified 14 seconds after shipping by its own push's run — a fixed sample rots, while an as-of date is superseded by later slower runs rather than contradicted. Every existing rationale sentence in that block (job-level timeout placement, the deliberately-tighter-relative-bound reasoning, the 10x billing arithmetic, red-job-beats-generous-cap) MUST be preserved. No enumerated fixed sample may remain as the load-bearing claim.

- **GIVEN** the current comment citing "9m20s (5m36s, 5m57s, 6m57s, 7m28s, 9m20s ...)" and "~2.7x headroom"
- **WHEN** the correction lands
- **THEN** the comment cites 10m03s, run 30572535194, 17 runs, an as-of date of 2026-07-31, and ~2.5x headroom, and explains the dated-observation formulation
- **AND** the 10x billing arithmetic, the tighter-relative-bound reasoning, and the red-job-beats-generous-cap sentences survive unmodified

#### R5: android timeout comment byte-identical
The `android` job's timeout comment (2m36s worst-of-five, ~5.8x headroom) MUST remain byte-identical — the adversarial review verified it still holds.

- **GIVEN** the android timeout comment block
- **WHEN** the change's diff is inspected
- **THEN** no line of that block appears in the diff

#### R6: native file count self-defining
The header comment's "the 44 native files" MUST become "the 47 native build-input files (24 Kotlin + 20 Swift + 3 *.gradle.kts)" — the definition stated inline so a future deletion cannot silently change what the number means. The surrounding sentence MUST NOT otherwise be reworded.

- **GIVEN** the header comment citing a bare "44 native files"
- **WHEN** the correction lands
- **THEN** the count reads 47 with its definition (24 Kotlin + 20 Swift + 3 *.gradle.kts) inline, matching `find drivers` counts in this worktree

#### R7: proto/** justification scoped to the Android compile
The `proto/**` paths-filter bullet MUST keep its Android justification verbatim (`drivers/android/app/build.gradle.kts:104` protobuf source dir — re-verified accurate) and ADD that the justification holds for the Android compile only: iOS compiles the committed generated Swift under `drivers/ios/finalrun-ios-test/Generated/` and there is no Swift codegen anywhere in this repo, so a proto change that desyncs the committed Swift still produces a GREEN `ios` job — a green drivers run is NOT evidence the iOS bindings are in sync.

- **GIVEN** the current `proto/**` bullet justifying the entry via the Android protobuf source dir alone
- **WHEN** the correction lands
- **THEN** the Android sentences are unchanged and new sentences state the Android-only scope, the committed-Generated-Swift mechanism, and that a green ios job does not prove proto/Swift sync

### CI: Invariants preserved

#### R8: Workflow contract invariants
The change MUST NOT: delete or reword any existing rationale sentence beyond the specific false claims (comment policy — `code-quality.md` § Comments exempts CI files from restatement sweeps; `code-review.md` grades rationale deletion must-fix); break the byte-identity of the two `paths` lists; add any job (in particular none named `test`); or touch any file other than `.github/workflows/drivers.yml`. The result MUST parse as valid YAML.

- **GIVEN** the completed edit
- **WHEN** the two `paths` lists are extracted and compared, and the YAML is loaded by a parser
- **THEN** the lists are byte-identical, the parse succeeds, the only jobs are `android` and `ios`, and `git diff` shows changes only in `.github/workflows/drivers.yml`

### Non-Goals

- No edits to `scripts/build-drivers-ios.sh` or `build-drivers-android.sh` — the change is scoped to additive workflow configuration.
- No edits to `ci.yml`, the `paths` lists' contents, or the concurrency block.
- No toolchain pinning (pinning Xcode/macos versions is a different mitigation with its own trade-offs; this change makes rotation *detectable*, not impossible).
- No `fab/backlog.md` staging or commits — git operations belong to the ship stage.

### Design Decisions

#### Weekly schedule cadence over daily, monthly, or none
**Decision**: `schedule: [cron: '17 5 * * 1']` — weekly, Monday 05:17 UTC (non-zero minute per GitHub's guidance to avoid top-of-hour load spikes).
**Why**: The failure mode being detected — runner-image/toolchain rotation — changes on a cadence of weeks-to-months. Weekly bounds staleness to 7 days at ~4 macOS runs/month (each ≈ 7–10 macOS-minutes ≈ 70–100 billable at 10x). `schedule` ignores `paths` filters by design and runs the default-branch tip — exactly the "tip of main" coverage finding ONE asks for. Known caveat carried in the comment: GitHub auto-disables cron after 60 days of repo inactivity — acceptable, since an inactive repo isn't merging PRs a stale green would mislead.
**Rejected**: (a) daily — ~7x the macOS cost for negligible latency gain against a weeks-to-months failure cadence; (b) monthly — lets a rotation hide for up to 31 days, the current failure mode barely improved; (c) no schedule (`workflow_dispatch` only) — on-demand coverage requires someone to remember to run it, which is exactly the gap being closed.
*Introduced by*: 260731-0sg1-harden-drivers-ci-workflow

#### Global SPM clone cache over -clonedSourcePackagesDirPath
**Decision**: Cache SPM's global clone cache `~/Library/Caches/org.swift.swiftpm` via `actions/cache@v4`, keyed on the hash of the committed `Package.resolved`, with a `spm-${{ runner.os }}-` restore-key prefix.
**Why**: `build-drivers-ios.sh` wipes DerivedData every run (`rm -rf "$DERIVED_DATA_PATH"`, line 11), so caching DerivedData is off the table — but the global SPM clone cache lives outside DerivedData and survives the wipe: xcodebuild's package resolution copies from it instead of cloning 22 packages from github.com. Keying on `Package.resolved` repopulates the cache on a dependency bump; the restore-key makes a stale cache a partial hit (only changed packages re-clone) rather than a miss.
**Rejected**: `-clonedSourcePackagesDirPath` pointing at a cacheable path — it would work, but requires editing `build-drivers-ios.sh`, and this change is scoped to additive workflow configuration; the global-cache approach needs no script change.
*Introduced by*: 260731-0sg1-harden-drivers-ci-workflow

## Tasks

### Phase 1: Setup

- [x] T001 Read `.github/workflows/drivers.yml` in full and `scripts/build-drivers-ios.sh` (confirm the `rm -rf` DerivedData wipe at line 11); verify `drivers/ios/finalrun-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` exists with 22 package identities and the native file counts are 24 Kotlin + 20 Swift + 3 `*.gradle.kts` <!-- R3, R6 -->

### Phase 2: Core Implementation

- [x] T002 Add `workflow_dispatch:` and `schedule:` (cron `'17 5 * * 1'`) to the `on:` block of `.github/workflows/drivers.yml` with the rationale comment (toolchain-rotation detection, weekly staleness bound, schedule-ignores-paths-by-design + default-branch tip, 60-day auto-disable caveat); leave the existing triggers, `paths` lists, and `concurrency:` block untouched <!-- R1, R2 -->
- [x] T003 Insert the `actions/cache@v4` SPM cache step in the `ios` job between checkout and the build step (path `~/Library/Caches/org.swift.swiftpm`, key `spm-${{ runner.os }}-${{ hashFiles('...Package.resolved') }}`, restore-keys `spm-${{ runner.os }}-`) with the DerivedData-wipe/global-cache rationale comment <!-- R3 -->
- [x] T004 Replace the falsified ios worst-of-five sample claim with the dated, run-id-anchored formulation (10m03s, run 30572535194, 17 runs as of 2026-07-31, ~2.5x headroom, why-dated rationale), preserving every existing rationale sentence in the block; leave the android timeout comment byte-identical <!-- R4, R5 -->
- [x] T005 Change "the 44 native files" to "the 47 native build-input files (24 Kotlin + 20 Swift + 3 *.gradle.kts)" in the header comment without otherwise rewording the sentence <!-- R6 -->
- [x] T006 Add the iOS caveat to the `proto/**` paths-filter bullet (Android-compile-only justification, committed generated Swift under `drivers/ios/finalrun-ios-test/Generated/`, no Swift codegen in the repo, green ios job is not proto-sync evidence), keeping the Android sentences verbatim <!-- R7 -->

### Phase 3: Integration & Edge Cases

- [x] T007 Verify: YAML parses (python/node yaml load or `actionlint` if available); the two `paths` lists are byte-identical; the android timeout comment block and the `concurrency:` block are absent from `git diff`; `git diff --name-only` shows only `.github/workflows/drivers.yml` <!-- R8 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `on:` carries `workflow_dispatch:` and `schedule:` with cron `'17 5 * * 1'` and a rationale comment covering rotation detection, the weekly staleness bound, schedule-ignores-paths + default-branch-tip semantics, and the 60-day auto-disable caveat
- [x] A-002 R3: the `ios` job has an `actions/cache@v4` step between checkout and build with the exact path/key/restore-keys from R3 and the DerivedData-wipe rationale comment
- [x] A-003 R4: the ios timeout comment cites 10m03s / run 30572535194 / 17 runs / as-of 2026-07-31 / ~2.5x headroom and explains the dated-observation formulation; no enumerated fixed sample remains load-bearing
- [x] A-004 R6: the header comment reads "the 47 native build-input files (24 Kotlin + 20 Swift + 3 *.gradle.kts)"
- [x] A-005 R7: the `proto/**` bullet states the Android-only scope, the committed-Generated-Swift mechanism, and that a green ios job is not evidence of proto/Swift sync

### Behavioral Correctness

- [x] A-006 R2: the `concurrency:` block is byte-identical to before the change (dispatch/schedule events fall to the `run_id` branch without modification)
- [x] A-007 R5: the android timeout comment block is byte-identical (absent from the diff)

### Scenario Coverage

- [x] A-008 R8: the modified file parses as valid YAML and the two `paths` lists are byte-identical to each other

### Edge Cases & Error Handling

- [x] A-009 R8: no job named `test` exists in the file; the only jobs are `android` and `ios`; `.github/workflows/drivers.yml` is the only modified file

### Code Quality

- [x] A-010 Pattern consistency: new comments match the file's existing rationale-comment register (measured data, cross-file couplings cited by path:line, rejected alternatives)
- [x] A-011 No rationale deletion: every pre-existing rationale sentence survives except the three specific false/ambiguous claims (worst-of-five sample, bare "44", unqualified proto justification) — `code-review.md` grades rationale deletion must-fix
- [x] A-012 No restatement comments: every new comment states what the YAML cannot show (rationale, measured data, couplings), passing `code-quality.md`'s deletion test

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Place the trigger rationale comment inside the `on:` block immediately above `workflow_dispatch:`/`schedule:` (after the paths-filter commentary), not in the file header | Intake's YAML snippet shows the comment adjacent to the new keys; co-locating rationale with the configuration it explains is the file's established pattern | S:85 R:95 A:90 D:85 |
| 2 | Certain | Exact wording of the corrected ios timeout claim is settled at apply (intake: "the exact wording is apply's to settle") within the fixed factual bounds (10m03s, run 30572535194, 17 runs, as-of 2026-07-31, ~2.5x) | Explicitly delegated by the intake with all load-bearing values supplied; only prose phrasing is chosen here | S:90 R:90 A:90 D:85 |
| 3 | Confident | Write the cache step as `- uses: actions/cache@v4` with no `name:` field, matching the file's existing unnamed `uses:` steps (checkout, setup-java) | Both existing bare-action steps omit `name:`; the rationale comment above the step carries the explanation, mirroring the setup-java pattern | S:70 R:95 A:85 D:75 |

3 assumptions (2 certain, 1 confident, 0 tentative).
