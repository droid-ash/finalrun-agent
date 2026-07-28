# Intake: A CI Verdict For Every Push, Enforced

**Change**: 260728-xn7o-ci-verdict-every-push-required-check
**Created**: 2026-07-28

## Origin

> make a change that we run ci check on every commit for a pr Opened against main

Asked immediately after PR #164 shipped, where the CI gate produced **zero runs** and the omission
was invisible — no failing check, just an absent one. The user had asked the same question earlier
in this initiative (*"does the CI check trigger on every commit?"*); this is the follow-up that
turns the answer into enforcement.

### The trigger already does what was asked — the gaps are elsewhere

Investigation before writing this intake found that `on: pull_request: branches: [main]` already
fires on **every push** to an open PR: the default activity types are
`[opened, synchronize, reopened]`, and `synchronize` is exactly "a new commit was pushed to the
PR head". So the trigger needs no change. Three *other* things were leaving commits unverified,
and two of them are real:

1. **`cancel-in-progress: true` aborts runs that never get replaced.** Not theoretical — **11
   commits already in this repo's history have exactly one CI run, cancelled, and were never
   re-verified**: `979f9fe 1af5f62 6f6a878 a6fa8ac 9dc9821 ed63afd 47e5550 e64e911 edff0af
   2a6c084 3206d15`. Each was a PR head at the moment it was pushed.
2. **CI was not a required check.** `main` has no classic branch protection; it is governed by
   ruleset `14531661` (`deletion`, `creation`, `pull_request` with 1 approving review) which
   carried **no `required_status_checks` rule**. So a PR whose `test` check was cancelled, skipped,
   or absent at its tip was fully mergeable — nothing objected.
3. **A conflicting PR gets no runs at all** — the #164 case. GitHub cannot build the test-merge
   commit, so no `pull_request` workflow runs.

**Correction to the initial reading of #164, recorded so it is not repeated downstream:** gap 3 is
a *feedback* failure, not a merge-safety failure. A conflicting PR cannot be merged regardless, and
resolving the conflict fires `synchronize` and produces a run. What made #164 dangerous was that a
reviewer (human or agent) reading the PR saw no failing check and could reasonably conclude the
gate had passed. The genuine merge-safety hole is gap 2 combined with gap 1: a **cancelled or
absent check at the PR tip** was mergeable.

### Already applied out-of-band

Gap 2 is a repository *setting*, not code — it cannot ship in a PR. With the user's explicit
approval it was applied directly to ruleset `14531661` before this intake was written:

```json
{ "type": "required_status_checks",
  "parameters": { "strict_required_status_checks_policy": false,
                  "do_not_enforce_on_create": false,
                  "required_status_checks": [ { "context": "test", "integration_id": 15368 } ] } }
```

Verified after the write: all four rules present, the `pull_request` rule's
`required_approving_review_count: 1` intact, and PR #164 still `MERGEABLE` with `test` SUCCESS.
The ruleset was backed up before the PATCH. This change's job is to make that setting **legible in
the repo** — a setting nobody has written down is a setting that gets undone.

## Why

**The problem.** The gate this initiative spent 14 changes building could be skipped without
anybody noticing, in three different ways, and had already been skipped 11 times. Worse, the
failure mode is *silent in the safe direction* — an absent check looks exactly like a clean one.
Every other part of the gate fails loudly: a type error exits 2, a missing script exits 1, a
failing test exits 1. Only the question "did the gate run at all?" had no answer.

**What happens if we don't fix it.** The gate keeps reporting success by omission. A cancelled run
on a PR tip merges unverified; a reviewer reads "no failing checks" as "checks passed". The 11
unverified commits are the measure of how often this already happens on a repo with one active
contributor — the rate scales with push frequency, so it gets worse, not better.

**Why `cancel-in-progress: false` rather than something cleverer.** The setting exists to save CI
minutes when a developer pushes rapidly, and it is the right default for a repo where only the tip
matters. It is the wrong default here because this initiative's whole premise is that *every*
commit on a PR is gated. A full run is ~1m30s; the cost of never cancelling is a few extra
minutes per active PR, against a guarantee that no pushed commit lacks a verdict.

> **Two residual inaccuracies in this section's prose, corrected here rather than rewritten
> in place** (the original wording is left standing so the correction notes above remain readable
> against it):
> 1. "no pushed commit lacks a verdict" and, further down, "every pushed commit on a PR gets its own
>    completed verdict" both state a **per-commit** guarantee. The guarantee is **per push**: a push
>    of N commits fires one `synchronize` and produces one run, at the tip. Per-commit verification
>    is an explicit Non-Goal of this very change, so the prose contradicts it.
> 2. "only a ruleset can" overstates. Classic branch protection can also require status checks; this
>    repo simply has none, so the conclusion holds *here*. The general form is "only a repo-level
>    protection rule can — here, ruleset `14531661`."
>
> The authoritative statements are in `docs/memory/ci/pr-quality-gate.md`, which carries the
> corrected wording for both.

**Why the required check is the load-bearing half.** Workflow edits alone cannot close gap 2. No
`on:` configuration can make GitHub refuse a merge — only a ruleset can. This is why the setting
was applied even though the code change is what the user asked for: without it, `cancel-in-progress:
false` improves coverage but still permits merging a PR whose check never reported.

## What Changes

### 1. Stop cancelling superseded runs

`.github/workflows/ci.yml`:

```yaml
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: false
```

The `concurrency` group is retained deliberately — it still serialises runs on the same ref, which
keeps the npm cache from being written by two runs at once. Only the cancellation changes.

> **Corrected during review — this paragraph is wrong as written, kept for traceability.**
> Retaining the group does not merely serialise; it keeps *pending* runs cancellable.
> `cancel-in-progress` governs only the in-progress run, while GitHub separately cancels an existing
> **pending** run whenever a newer one queues into the same group. Three rapid pushes therefore
> still lose push #2 — the exact defect this change exists to remove. The `concurrency` block is
> removed entirely instead. The npm-cache justification does not hold either: `actions/setup-node`'s
> cache save fails soft on a concurrent write.
>
> **A second correction, from the re-review.** The first correction overreached in two ways. It said
> "any concurrency group at all" reintroduces the defect — but pending-cancellation is the behaviour
> of the **default `queue: single`**; a group with `queue: max` keeps every pending run. And it
> rejected `queue: max` by claiming no such key exists in GitHub Actions ("a GitLab concept"). That
> was a **fabrication**: `concurrency.queue` accepts `single` or `max` (≤100 pending, FIFO), and
> `queue: max` with `cancel-in-progress: true` is a validation error. Verified against GitHub's
> workflow-syntax reference. The block is still removed — parallel runs give the fastest
> unconditional per-push feedback, with no 100-run cap and no FIFO latency — but that is a
> trade-off, not an impossibility. See `plan.md` R1.

The existing comment (`# Cancel superseded runs: a new push to the same ref aborts the in-flight
run.`) becomes false the moment this lands and MUST be rewritten, not left. It SHALL state why
cancellation is off — that every pushed commit on a PR gets its own completed verdict — so the
next person who reaches for `cancel-in-progress: true` to save minutes sees the reason it is off.

### 2. Record that the job name is now a contract

The required check names the context `test`, which is the `jobs.test` key in `ci.yml`. Renaming
that job silently detaches the required check from the workflow. The failure is **fail-closed** —
the required check never reports, so PRs block rather than merge unverified — which is the safe
direction, but the diagnosis is not obvious from the symptom.

A comment on the job SHALL record that the name is referenced by ruleset `14531661` and must not
be renamed without updating it. No code change; this is the cheapest available guard against a
rename that would take the gate offline.

### 3. Document the enforced contract in memory

`docs/memory/ci/pr-quality-gate.md` currently documents the gate's five stages and their
`--if-present` semantics. It does not record **who enforces the gate**, which is now half of it.
Add:

- Every push to an open PR against `main` produces its own completed verdict; runs are no longer
  cancelled. The `synchronize` activity type is what makes "every push" true, and it is a default
  type rather than something the workflow opts into.
- The `test` check is required by ruleset `14531661`, pinned to the GitHub Actions app
  (`integration_id: 15368`) so a same-named check from another integration cannot satisfy it.
  Non-strict: a branch need not be up to date with `main` to merge.
- **Recovery when a run is genuinely absent** (the #164 case): there is no re-run button for a run
  that never started, and `workflow_dispatch` would not help — a manually dispatched run reports
  against a branch ref, not the PR's merge ref, so it cannot satisfy the PR's required check. The
  working recoveries are to push (including an empty commit) or to close and reopen the PR, since
  `reopened` is a default activity type.
- The accurate distinction between the *feedback* failure (conflicting PR, no run, unmergeable
  anyway) and the *merge-safety* failure (cancelled or absent check at the tip, previously
  mergeable). Recording the correction matters more than recording the incident.

### Non-Goals

- **Per-commit verification of every commit within a push.** A push of N commits fires one
  `synchronize` and CI verifies the tip. Verifying each intermediate commit needs a matrix job
  enumerating the push's commits — N× the minutes to catch a broken intermediate commit that the
  tip already fixes. Explicitly considered and declined by the user in favour of a verdict per
  push.
- **`strict_required_status_checks_policy: true`** (require the branch up to date with `main`).
  Considered and declined: it guarantees CI ran against the real merge result but forces a
  rebase/merge on every PR before it can land.
- **`workflow_dispatch`.** Would not satisfy a PR's required check (wrong ref), so it does not
  serve the goal.

  > **Corrected during review — the parenthetical is wrong, kept for traceability.** The required
  > check matches on `(context, app id)` at the PR's **head** commit, not a merge ref — verified
  > empirically: PR #164's `test` check run carries `head_sha` equal to the PR's `headRefOid`. So a
  > dispatched head-branch run *would* satisfy it. The conclusion stands on different grounds: a
  > dispatched run verifies the branch tip in isolation rather than the merge result a
  > `pull_request` run checks out, so it would turn the required check green on a **weaker** signal.
  > The merge-ref reasoning holds only for fork PRs. See `plan.md` R4(c).
- **Adding `ready_for_review` to the activity types.** Draft PRs already fire `opened` and
  `synchronize`; the extra type would only matter if the workflow later gained a
  `draft == false` guard. YAGNI.
- **Touching CodeRabbit.** It reports a legacy status context, not a check-run, and is
  deliberately NOT a required check — an automated reviewer's opinion should not gate a merge.
- **Promoting lint rules from `warn` to `error`.** Still the initiative's endpoint, still blocked
  on reaching zero warnings (currently 78).

## Affected Memory

- `ci/pr-quality-gate.md`: (modify) the gate's enforcement half — a verdict per push rather than
  per-PR-tip, the required `test` check and its app pinning, the recovery procedure for an absent
  run, and the feedback-vs-merge-safety distinction

## Impact

**One workflow file** (`.github/workflows/ci.yml`, ~4 lines plus comments) and **one memory file**.
No source, no tests, no dependencies. The behavioural change is entirely in CI scheduling.

**Verification is unusual for this repo and worth stating plainly**: the change alters how CI is
*scheduled*, which cannot be proven by running the suite locally. The proof is observational — the
change's own PR must show a completed `test` run for **each** of its pushes, with none cancelled.
*(Corrected during review: **three** rapid pushes are the discriminating case, not two — two
pushes yield one in-progress and one pending run and both still complete even with a group present,
so two cannot detect pending-cancellation. See `plan.md` R5.)* Two pushes in quick succession are
the discriminating case: on `main` today the first would be
cancelled; after this change both must complete. Apply SHALL record the run IDs and conclusions.

**Ordering risk.** PR #164 is open and unmerged, and it touches both `ci.yml` (a comment naming
`local-runtime`'s no-op typecheck) and `docs/memory/ci/pr-quality-gate.md`. This change branches
from `origin/main` and touches the same two files, so a conflict is likely if both are open at
once. #164 should merge first; if it has not, expect to merge `main` in and resolve — keeping both
edits, since they are adjacent rather than contradictory.

**Gate baseline to hold**: 469 tests / 0 failures, 78 warnings / 0 errors, typecheck and build
exit 0. This change should move none of them.

## Open Questions

None. Both material forks — per-push versus per-commit coverage, and whether to require the check
— were put to the user and decided before this intake was written.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The trigger is left alone; only cancellation changes | Verified that `synchronize` is a default activity type and already fires per push, so the user's ask is satisfied by removing cancellation rather than by adding a trigger. Changing `on:` would be churn | S:85 R:90 A:95 D:90 |
| 2 | Certain | Per-push verdicts, not per-commit-within-a-push | Put to the user with both designs and their costs; they chose a verdict per push. Recorded as a Non-Goal so a later reader does not reopen it | S:95 R:85 A:85 D:95 |
| 3 | Certain | The required check is applied as a repo setting, out-of-band, and documented here | A ruleset cannot ship in a PR, and no workflow config can make GitHub refuse a merge. The user approved it explicitly; it was backed up first and verified after | S:90 R:75 A:90 D:90 |
| 4 | Confident | Remove the `concurrency` block entirely, group included — **reversed during review** | Originally decided the opposite (keep the group, protect the npm cache). Review proved the group leaves *pending* runs cancellable, so the guarantee failed for three rapid pushes; A scored down from 90 because the mechanism was asserted, not checked | S:80 R:90 A:55 D:70 |
| 5 | Confident | Pin the required check to the GitHub Actions app id (15368) rather than matching the bare context name | A bare `test` context could be satisfied by any integration reporting that name; pinning makes the gate's identity explicit. Read from the live check-run rather than assumed | S:60 R:85 A:85 D:80 |
| 6 | Confident | Non-strict required check (branch need not be current with main) | Strict mode was offered and declined. On an active `main` it forces a rebase on every PR; the marginal safety does not pay for the churn at this repo's scale | S:75 R:85 A:75 D:80 |
| 7 | Certain | The stale `cancel-in-progress` comment is rewritten to explain why cancellation is OFF | A comment that contradicts the config is worse than none, and the next reader's instinct will be to re-enable cancellation to save minutes. The comment is the only place that instinct can be intercepted | S:70 R:90 A:85 D:80 |
| 8 | Confident | Verification is observational — the change's own PR must show one completed run per push | Scheduling behaviour cannot be proven by a local suite run. **Corrected during review**: three rapid pushes are the discriminating case, not the two written here — two both complete even with a group present, so only the third exposes pending-cancellation | S:70 R:80 A:70 D:75 |

8 assumptions (4 certain, 4 confident, 0 tentative, 0 unresolved).
