# Plan: A CI Verdict For Every Push, Enforced

**Change**: 260728-xn7o-ci-verdict-every-push-required-check
**Intake**: `intake.md`

## Requirements

### CI: A completed verdict per push

#### R1: CI runs are never cancelled by a newer push
`.github/workflows/ci.yml` MUST **remove the `concurrency:` block entirely** — both
`cancel-in-progress` and `group`. The `on:` triggers MUST NOT change: `synchronize` is a default
`pull_request` activity type and already fires on every push to an open PR, so the trigger already
does what the change requires.

> **Revised after review — the original requirement did not deliver its own guarantee.** It
> mandated `cancel-in-progress: false` while *retaining* `group: ci-${{ github.ref }}`, on the
> reasoning that the group merely serialises same-ref runs. That is wrong, and it reintroduces the
> exact defect this change exists to remove. `cancel-in-progress` governs only the **in-progress**
> run; GitHub *separately* cancels an existing **pending** run whenever a newer one queues into the
> same group. So with the group retained: push #1 runs, push #2 goes pending, push #3 arrives and
> **cancels #2** — one more commit with a single cancelled run and no verdict. The npm-cache
> justification for keeping it does not survive scrutiny either: `actions/setup-node`'s cache save
> fails soft on a concurrent write (a warning, not an error), so there was nothing to protect.
>
> **Scope precisely** (second review finding): pending-cancellation is the behaviour of the
> **default `queue: single`**, not of every possible group. A group carrying `queue: max` keeps all
> three runs. So the accurate statement is "a group with the default queue evicts pending runs" —
> **not** "any group at all". The block is still removed, but because parallel runs give the fastest
> unconditional per-push feedback (see the rejected alternative below), not because a group is
> inherently unsafe.

**Rejected alternative — `group` + `cancel-in-progress: false` + `queue: max`.** This is a **real,
valid** configuration and it would also satisfy R1 *up to its cap* — runs beyond the 100-pending
limit are cancelled again, so it delivers the guarantee in every realistic case here, not
unconditionally. `concurrency.queue` accepts `single` (the
default, at most one pending run per group — which is what makes pending-cancellation the default
behaviour) or `max` (up to 100 pending runs, FIFO); `queue: max` combined with
`cancel-in-progress: true` is a workflow validation error. Verified against GitHub's workflow-syntax
reference, not asserted.

> **This paragraph previously claimed no `queue` key exists in GitHub Actions and that it "is a
> GitLab concept" — a fabrication, corrected here.** It was written confidently, propagated into
> memory, and caught by review. The feature postdates the author's knowledge cutoff; the lesson is
> that "this key does not exist" is a claim about the world that must be checked against the vendor
> docs before it is recorded, exactly like the `workflow_dispatch` merge-ref premise corrected in
> R4(c). Two fabricated premises in one change is a pattern, not an accident.

It is rejected on **true grounds**, which are a trade-off rather than an impossibility:

- `queue: max` **serialises** — a run waits for the one ahead of it. Removing the block lets every
  push run independently with no workflow-level queueing (start time subject only to runner
  capacity), so per-push feedback arrives in ~1m30s rather than N×1m30s. Feedback speed is the
  point of a PR gate.
- `queue: max` caps pending runs at **100**, beyond which runs are cancelled again. Removing the
  block has no cap, so the guarantee holds unconditionally rather than up to a limit.
- Nothing here needs serialising. The npm cache was the only candidate justification and
  `actions/setup-node` fails soft on a concurrent cache write.

`queue: max` would be the right choice for a workflow that must not run concurrently with itself —
`release.yml` is that shape, and it is deliberately left alone.

**Out of scope — `release.yml`.** It carries the same `group` + `cancel-in-progress: false` pair
and therefore the same pending-cancellation property, but it is manually dispatched, so three rapid
triggers are not a real scenario and serialising releases is desirable. It is correct as written and
MUST NOT be changed here.

- **GIVEN** an in-flight CI run on a PR head
- **WHEN** a new commit is pushed to the same PR
- **THEN** the in-flight run completes (it is never aborted) and the new push starts its own run
- **AND** the `on:` block is byte-identical to `main`'s

- **GIVEN** three commits pushed to one PR in rapid succession — the discriminating case, which two
  pushes cannot detect
- **WHEN** all three `synchronize` events have fired
- **THEN** all three runs reach a terminal conclusion and **none** is `cancelled`
- **AND** no `concurrency` key exists in `ci.yml` to queue or evict any of them

#### R2: A comment states why there is no concurrency group at all
The existing comment (`# Cancel superseded runs: a new push to the same ref aborts the in-flight
run.`) describes a block that no longer exists, and MUST be **replaced** by a comment standing where
the block stood — not deleted, leaving the removal unexplained. It SHALL state that **every push**
to a PR keeps its own completed verdict, and SHALL intercept the two distinct instincts a later
reader will have: re-adding `cancel-in-progress: true` to save CI minutes, and re-adding a bare
`concurrency.group` (which looks harmless but restores pending-cancellation).

The second warning MUST name the mechanism precisely: it is a group **left on the default
`queue: single`** that evicts pending runs. A group carrying `queue: max` would not. Wording that
blames groups in general is the over-generalisation the re-review caught, and it also makes the
comment easy to dismiss once a reader learns `queue: max` exists.

**Wording precision (must-fix from review).** The guarantee is **per push**, never "per commit". A
push of N commits fires one `synchronize` and produces one run at the tip. Saying "every pushed
commit gets a verdict" is false and directly contradicts this plan's own per-commit Non-Goal. Every
occurrence — in `ci.yml` comments and in memory — MUST read "every push".

- **GIVEN** a reader of `ci.yml` considering `cancel-in-progress: true` to save minutes, or re-adding a `concurrency.group`
- **WHEN** they read the comment where the block used to be
- **THEN** they find both reasons stated — a cancelled run at a PR tip is an unverified commit that reads as clean, and a group on the default `queue: single` re-enables cancellation of pending runs
- **AND** no text anywhere in the change claims a per-commit guarantee

#### R3: The `test` job name is documented as a required-check contract
A comment on the `jobs.test` key SHALL record that the job name `test` is the status-check
context required by the repo's `main` ruleset (id `14531661`), pinned to the GitHub Actions app
(`integration_id: 15368`), and that renaming the job detaches the required check. The failure
mode is fail-closed — the required check never reports, so PRs block rather than merge
unverified — but the symptom (a perpetually "Expected" check) does not point at the cause, which
is why the comment is the guard.

- **GIVEN** a future change that renames the `test` job
- **WHEN** its author reads the job definition
- **THEN** the comment tells them the name is referenced by ruleset `14531661` and must be updated there too

### Memory: The enforcement half of the gate

#### R4: `docs/memory/ci/pr-quality-gate.md` documents who enforces the gate
The memory file SHALL be updated (present-truth style, FKF rules) to record:
(a) every push to an open PR against `main` produces its own completed verdict — runs are not
cancelled, and the `synchronize` default activity type is what makes "every push" true;
(b) the `test` check is required by ruleset `14531661`, pinned to the GitHub Actions app
(`integration_id: 15368`) so a same-named check from another integration cannot satisfy it, and
non-strict (a branch need not be up to date with `main` to merge);
(c) recovery when a run is genuinely absent (the conflicting-PR case): push — an empty commit
works — or close and reopen the PR (`reopened` is a default activity type). `workflow_dispatch`
is still not the answer, but **the reason originally given for that was false and MUST NOT be
written into memory**: the required check is matched by `(context, app id)` on the PR's **head**
commit — empirically, PR #164's `test` check run carries `head_sha` equal to the PR's `headRefOid`,
not a merge ref — so a dispatched run on the head branch *would* satisfy it. The accurate grounds
are that `ci.yml` deliberately carries no `workflow_dispatch` trigger (a declared Non-Goal), and
that a dispatched run verifies the branch tip in isolation rather than the merge result a
`pull_request` run checks out, so it would satisfy the required check on a **weaker** signal. If
the merge-ref reasoning is mentioned at all, it MUST be scoped to fork PRs, where the dispatch runs
in the fork;
(d) the feedback-vs-merge-safety distinction: a conflicting PR with no run is a *feedback* gap
(it cannot merge regardless), while the *merge-safety* hole is a cancelled or absent check at a
mergeable PR tip — which the required check now closes.
The stale `cancel-in-progress: true` claim in the existing "PR CI gate stages" requirement MUST
be corrected (superseded statements are removed, not narrated). The file's `description:`
frontmatter MUST stay accurate, one line, ≤500 chars, change-id-free, and indexes MUST be
regenerated via `fab memory-index`.

- **GIVEN** a reader asking "who enforces the CI gate, and what happens when a run is absent?"
- **WHEN** they read `docs/memory/ci/pr-quality-gate.md`
- **THEN** they find the per-push verdict guarantee, the required-check pinning, the recovery procedure, and the feedback/merge-safety distinction

### Verification: Observational, not local

#### R5: The local gate holds and the workflow parses; the scheduling proof is deferred to the PR
The change MUST NOT regress the local gate: `npm run build --workspaces`, `npm run typecheck`,
`npm run test:workspaces`, and `npm run lint` all exit 0 (failure judged by **exit code and fail
count**, never by a test-count line). `ci.yml` MUST parse as valid YAML (a malformed workflow
silently stops running — which, with a required check in place, blocks every PR). The
*scheduling* behaviour cannot be observed locally: the proof is that this change's own PR shows one
**completed** `test` run per push with none cancelled. **The discriminating case is THREE rapid
pushes, not two** — with a concurrency group present, two pushes produce one in-progress and one
pending run and both still complete, so two pushes cannot detect pending-cancellation at all. The
third push is what evicts the pending second. That proof — and the run IDs/conclusions the intake
asks for — belongs to the ship/review-pr stages, after the PR exists; apply records the deferral,
not the proof.

- **GIVEN** this change applied locally
- **WHEN** the four gate commands run
- **THEN** each exits 0 and the counts match the branch baseline
- **GIVEN** the change's PR is open
- **WHEN** three commits are pushed in rapid succession
- **THEN** all three get completed `test` runs and none is `cancelled` (verified at ship/review-pr, not at apply)

### Non-Goals

- Touching the `on:` triggers in any way — no `workflow_dispatch` (a dispatched head-branch run
  *would* satisfy the required check, since the check matches on `(context, app id)` at the PR's
  head commit; it is rejected because it verifies the branch tip in isolation rather than the merge
  result a `pull_request` run checks out — a **weaker** signal for the same green check), no
  `ready_for_review` (drafts already fire `opened`/`synchronize`; YAGNI until a `draft == false`
  guard exists), no explicit activity-type list (`synchronize` is already a default)
- Per-commit verification within a multi-commit push — N× the minutes to catch an intermediate
  commit the tip already fixes; the user chose a verdict per push
- `strict_required_status_checks_policy: true` — offered and declined; forces a rebase/merge on
  every PR before it can land
- Modifying repo settings — the `required_status_checks` rule was already added to ruleset
  `14531661` out-of-band (a repo setting cannot ship in a PR); this change makes it legible, not
  applied
- Touching CodeRabbit (legacy status context, deliberately not required) or promoting lint
  `warn` → `error` (still blocked on clearing the remaining warnings)

### Design Decisions

#### Every push keeps its verdict; the ruleset makes the verdict required
**Decision**: The `concurrency:` block is removed from `ci.yml` entirely (no group, no
`cancel-in-progress`), paired with the `test` check being required on `main` via ruleset
`14531661` (pinned to the GitHub Actions app, `integration_id: 15368`, non-strict), applied
out-of-band as a repo setting. *(Revised in rework cycle 1 — originally `cancel-in-progress:
false` with the group retained, which review proved does not deliver the guarantee; see R1.)*
**Why**: Cancelled runs are aborted verdicts that never get replaced — 11 commits in this repo's
history carry exactly one, cancelled, CI run. `cancel-in-progress` governs only the in-progress
run, and GitHub separately cancels a *pending* same-group run when a newer one queues into a
group on the default `queue: single`, so a group left on that default loses the middle run of
three rapid pushes — removing the block (rather than switching to `queue: max`) keeps every push
running independently, with no workflow-level queue and no pending cap. And no `on:` configuration can make GitHub refuse a
merge; only a repo-level protection rule can (here, ruleset `14531661` — classic branch
protection could too, but `main` carries none), which is why the setting is the load-bearing
half. The absence failure mode is silent in the safe-looking direction: no failing check reads
as checks passed.
**Rejected**: (a) keeping the `concurrency` group with `cancel-in-progress: false` — pending
runs stay cancellable, and the npm-cache argument fails (`actions/setup-node`'s cache save fails
soft on concurrent writes); (b) `group` + `cancel-in-progress: false` + `queue: max` — valid and
sufficient for R1, rejected as a trade-off (serialised N×~1m30s feedback, a 100-pending cap,
nothing to serialise; right for `release.yml`'s must-not-run-concurrently shape — see R1);
(c) a matrix job verifying every commit within a push — N× minutes for intermediates the tip
already fixes; (d) strict up-to-date policy — rebase churn on every PR; (e) a bare unpinned
`test` context — satisfiable by any integration reporting that name.
*Introduced by*: 260728-xn7o-ci-verdict-every-push-required-check

## Tasks

### Phase 2: Core Implementation

- [x] T001 In `.github/workflows/ci.yml`: **remove the `concurrency:` block entirely** (both `group` and `cancel-in-progress`) and replace the now-orphaned "Cancel superseded runs" comment with one standing where the block stood, explaining that every **push** keeps its own completed verdict and warning against re-adding either `cancel-in-progress: true` *or* a bare `group` <!-- R1, R2 --> <!-- rework: keeping the group left pending runs cancellable, so the requirement's own guarantee was not delivered; wording also claimed a per-commit guarantee that contradicts the Non-Goal --> <!-- rework: rework cycle 2: the bare-group warning must name the DEFAULT queue: single as the mechanism — a group with queue: max keeps pending runs, so 'any group at all' is wrong -->
- [x] T002 In `.github/workflows/ci.yml`: add a comment on the `jobs.test` key recording that the job name is the required-check context of ruleset `14531661`, pinned to the GitHub Actions app (`integration_id: 15368`), and that renaming it detaches the check (fail-closed) <!-- R3 -->
- [x] T003 [P] Update `docs/memory/ci/pr-quality-gate.md`: correct the stale `cancel-in-progress: true` claim, add the enforcement requirement (per-**push** verdicts, required check + pinning + non-strict, absent-run recovery, feedback-vs-merge-safety distinction), add the Design Decision, keep `description:` accurate/≤500 chars/change-id-free, then run `fab memory-index` <!-- R4 --> <!-- rework: three false claims to correct — the retained-group guarantee, the workflow_dispatch merge-ref reasoning, and per-commit vs per-push wording; plus a scenario that inverts which run is queued behind which --> <!-- rework: rework cycle 2: memory carries a fabricated claim that no concurrency.queue key exists (it does: single/max) and over-generalises pending-cancellation to any group; also needs the [skip ci] exception clause and 'only a repo-level protection rule' instead of 'only a ruleset' -->

### Phase 3: Integration & Edge Cases

- [x] T004 Verify: YAML parse of `.github/workflows/ci.yml` is clean; run `npm run build --workspaces`, `npm run typecheck`, `npm run test:workspaces`, `npm run lint` and record counts **with exit codes**; confirm the `on:` block is unchanged vs `main` and that `git diff` shows the `concurrency:` block fully removed with no other functional change <!-- R5 --> <!-- rework: the concurrency assertion inverted — the block must now be absent, not preserved --> <!-- rework: rework cycle 2: re-verify after the rationale corrections -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `ci.yml` contains **no `concurrency` key at all** (no `group`, no `cancel-in-progress`); the `on:` block is byte-identical to `main`'s; `release.yml` is untouched
      <!-- re-verified (rework cycle 2): js-yaml 4.3.0 parse OK exit 0; recursive walk finds no `concurrency` key at ANY depth; jobs keys exactly ["test"] with no name: override; `on:` block byte-identical to origin/main (string compare) and deep-equal parsed ({pull_request:{branches:[main]},push:{branches:[main]}}); only top-level key removed vs base is `concurrency`, none added; jobs.test parsed body deep-equal to base (this cycle's edit is comment-only); git diff origin/main -- .github/workflows/release.yml is empty; 12/12 assertions pass, script exit 0 -->
- [x] A-002 R2: a comment standing where the `concurrency:` block stood explains that every **push** keeps its own completed verdict, warns against re-adding `cancel-in-progress: true` for CI minutes, and separately warns against re-adding a bare `concurrency.group` (which silently restores cancellation of PENDING runs); the stale "Cancel superseded runs" wording is gone; no per-commit claim anywhere
      <!-- verified (rework cycle 2): ci.yml lines 18-31 — "every push to a PR keeps its own completed verdict"; bullet 1 warns against cancel-in-progress: true ("trades a few minutes per active PR for unverified commits"); bullet 2 warns against a bare group and now names the mechanism precisely per R2 — "On the default `queue: single`, GitHub cancels an existing PENDING run whenever a newer run queues into the same group … so a group left on that default silently restores cancellation" — and records `queue: max` as the real alternative rejected on trade-off grounds (keeps up to 100 pending runs FIFO but serialises feedback to N × ~1m30s; nothing here needs serialising — setup-node's cache save fails soft). No "any group at all" over-generalisation remains; grep finds no "pushed commit"/"per-commit guarantee" wording in ci.yml or docs/memory -->
- [x] A-003 R3: a comment on `jobs.test` names ruleset `14531661` and `integration_id: 15368`, and states that renaming the job detaches the required check fail-closed
      <!-- verified against the live ruleset: GET /repos/droid-ash/finalrun-agent/rulesets/14531661 → required_status_checks [{context: "test", integration_id: 15368}]; /apps/github-actions → id 15368; jobs has exactly the key `test` with no `name:` override, so the check context is `test` -->
- [x] A-004 R4: `docs/memory/ci/pr-quality-gate.md` documents the per-push verdict guarantee via the actual mechanism (no concurrency group exists; `cancel-in-progress` covers only the in-progress run while GitHub cancels pending same-group runs; `synchronize` is a default type), the required-check pinning and non-strict policy, the absent-run recovery (empty commit / close-reopen; `workflow_dispatch` is not the answer for the accurate reason), and the feedback-vs-merge-safety distinction
      <!-- verified (rework cycle 2): Scheduling bullet scopes pending-cancellation to a group on the DEFAULT `queue: single` and records `concurrency.queue: max` as the real, valid alternative (≤100 pending FIFO; a validation error with cancel-in-progress: true) rejected as a trade-off — serialised N × ~1m30s feedback, a 100-pending cap, nothing to serialise (setup-node fails soft) — never as an impossibility; release.yml parenthetical now states it "must not run concurrently with itself … the shape a queued group suits"; the requirement opening adds the documented [skip ci]/[no ci] exception with its fail-closed property (no run → no check → the required check blocks the merge); "only a ruleset can" is now "only a repo-level protection rule can (here, ruleset 14531661; classic branch protection can also require status checks, but main carries none)"; the workflow_dispatch clause keeps the rework-cycle-1 accurate grounds (deliberately no trigger; head-branch dispatch would satisfy the (context, app id) match but on the weaker branch-tip signal; merge-ref reasoning scoped to fork PRs); the DD's Rejected (b) states the corrected queue: max grounds — the "queue is a GitLab concept"/"accepts only group and cancel-in-progress" fabrication is gone (grep for "GitLab"/"no such key"/"accepts only" over docs/memory is clean) -->


### Behavioral Correctness

- [x] A-005 R4: no stale `cancel-in-progress: true` claim remains in memory; the body is present-truth (no transition narration), the `description:` is one line, ≤500 chars, change-id-free, and `docs/memory/index.md` + `docs/memory/ci/index.md` were regenerated by `fab memory-index`, not hand-edited
      <!-- re-verified (rework cycle 2): grep over docs/ finds no `cancel-in-progress: true`, no retained-group claim, no "any group at all", no "GitLab concept"/"no such key" fabrication, no "only a ruleset can"; superseded statements rewritten in place (the "PR CI gate stages" sentence, the Scheduling bullet, the scenario GIVEN, and the DD Why/Rejected each state only current truth); pr-quality-gate description = 492 chars, 1 line, change-id-free, still routes; docs/memory/ci/index.md frontmatter description recomposed to include the enforcement half (403 chars, 1 line, change-id-free) and `fab memory-index` regenerated docs/memory/index.md wholesale (body rows untouched by hand; the only warning is the pre-existing size advisory on pr-quality-gate.md) -->


### Scenario Coverage

- [x] A-006 R5: build, typecheck, test, and lint each exit 0 on this branch with recorded counts, and `ci.yml` parses as valid YAML
      <!-- re-run after the rework-cycle-2 edits: build exit 0; typecheck exit 0; test:workspaces exit 0 with 460 tests / 460 pass / **0 fail** (75+19+91+67+58+150; judged by exit code AND every `ℹ fail` line being 0, never by the count line); lint exit 0 with "✖ 78 problems (0 errors, 78 warnings)". js-yaml 4.3.0 parse exit 0. All four match the branch baseline exactly -->
- [x] A-007 R5: the plan/PR records that the scheduling proof (one completed `test` run per push, none cancelled, **three** rapid pushes as the discriminating case) is deferred to the change's own PR — apply does not claim it
- [x] A-011 R1/R5: **the deferred scheduling proof, now discharged on PR #165.** Three pushes inside 95s, each producing its own run, **zero cancelled**: `09ec02e` 10:38:44→10:40:23 success · `eaac482` 10:39:06→10:41:23 success · `934e34f` 10:40:19→10:41:51 success (runs 30351575034 / 30351599177 / 30351681611). Two independent properties are demonstrated, not one: (a) **no eviction** — push #3 queued at 10:40:19 while #2's run was still active, and #2 completed anyway, which is the exact case a group on the default `queue: single` would have lost; (b) **no serialisation** — all three windows overlap, and GitHub permits at most one *running* job per concurrency group, so concurrent runs on one ref prove no group is in effect. `gh run list … --json conclusion` filtered for `cancelled` returns 0.
      <!-- verified (rework cycle 1): R5 states the proof "belongs to the ship/review-pr stages … apply records the deferral, not the proof" and that three pushes are the discriminating case (with a group present, two pushes both complete — one in progress, one pending — so two cannot detect pending-cancellation); Notes § "Deferred verification" now says the same; the memory scenario is likewise the three-push case. No local overclaim anywhere -->


### Edge Cases & Error Handling

- [x] A-008 R1: no `on:` trigger was added or removed (no `workflow_dispatch`, no explicit activity types) — the diff to `ci.yml` touches only the removed `concurrency:` block, its replacement comment, and the `jobs.test` comment
      <!-- re-verified (rework cycle 2): `on:` block byte-identical to origin/main (string compare of the extracted block) and parsed `on` = {pull_request: {branches:[main]}, push: {branches:[main]}} deep-equal to base; jobs.test body deep-equal to base (comments do not parse); the only top-level key delta vs base is the removed `concurrency`. No repo-settings mutation anywhere in the diff; worktree touches only ci.yml + docs/memory/ci/{pr-quality-gate,index}.md + docs/memory/index.md (regenerated) + the change folder, no source/test paths (asserted by script over git status); release.yml diff vs origin/main is empty -->


### Code Quality

- [x] A-009 Pattern consistency: the new comments match `ci.yml`'s existing comment style (prose comments above the thing they explain); the memory edit follows FKF present-truth and four-field Design Decision shape
      <!-- verified: both new comments are prose blocks immediately above their subject, matching the existing 10-line header and 7-line typecheck comments; the new Design Decision carries all four fields (Decision / Why / Rejected / *Introduced by*) and its heading names the topic, not the change-id; no transition narration in the new body prose -->
- [x] A-010 No unnecessary duplication: the enforcement story is stated once in memory (requirement + DD), not repeated per section; `ci.yml` comments point at the ruleset rather than restating the memory file
      <!-- verified: full statement lives in one new Requirement; the Overview carries a one-sentence summary and "PR CI gate stages" carries only the config fact plus a cross-reference; the DD carries rationale only. ci.yml comments cite the ruleset id / integration_id rather than duplicating memory prose. (Parsimony pass and Deletion Candidates correctly skipped — change_type is `ci`.) -->


## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- **Deferred verification (scheduling proof)**: this change alters how CI is *scheduled*; nothing
  about that is provable locally. The change's own PR must show one **completed** `test` run per
  push with **none cancelled** — **three** pushes in rapid succession are the discriminating case
  (per R5: with a group present, two pushes both still complete — one in progress, one pending —
  so two cannot detect pending-cancellation; the third is what would evict the pending second).
  The run IDs and conclusions the intake asks apply to record can only exist once the PR does, so
  recording them belongs to ship/review-pr.
- **Measured gate baseline (T004, this branch = base `5e0ccc7`)**: `npm run build --workspaces`
  exit 0; `npm run typecheck` exit 0; `npm run test:workspaces` exit 0 with **460 tests / 460
  pass / 0 fail** across the six workspaces (150+91+75+67+58+19; judged by exit code + `fail 0`
  lines, not the count line); `npm run lint` exit 0 with **0 errors / 78 warnings**. YAML parse
  of `ci.yml` clean via js-yaml 4.3.0 (exit 0; PyYAML not installed in this environment). Note:
  the intake's "469 tests" baseline was measured on the o3me branch — this branch's base holds
  **460**; the change moves none of these numbers.
- **Ordering risk (PR #164)**: this branch is based at `5e0ccc7` (PR #163) and does NOT contain
  PR #164's edits, which touch the same two files (`ci.yml`, `docs/memory/ci/pr-quality-gate.md`).
  If #164 merges first, expect a merge of `main` at ship with both edits kept — they are adjacent,
  not contradictory.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The memory-file update runs at apply (T003), not deferred wholly to hydrate | The intake's What Changes §3 names it as one of the three change areas and the change's whole point is legibility; hydrate merges as current truth idempotently, so doing it here cannot conflict | S:85 R:90 A:90 D:85 |
| 2 | Certain | The scheduling proof and run-ID recording are deferred to ship/review-pr | The intake says "Apply SHALL record the run IDs and conclusions", but the runs it means belong to this change's own PR, which does not exist at apply time; claiming the proof locally would be fabrication | S:80 R:90 A:90 D:85 |
| 3 | Confident | The `description:` frontmatter is recomposed to include the enforcement half, trimming lower-value routing detail to stay ≤500 chars | FKF requires the description to keep routing accurately after a body edit; enforcement is now half the gate. Which clauses to trim is a judgment call | S:65 R:90 A:80 D:70 |
| 4 | Confident | The #164 conflict is left to ship (no pre-emptive merge of `main` at apply) | #164 is not merged at this branch's base; merging `main` mid-apply would import unreviewed state, and the intake already prescribes the resolution (keep both edits) | S:70 R:85 A:80 D:75 |

4 assumptions (2 certain, 2 confident, 0 tentative).
