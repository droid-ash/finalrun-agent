# Intake: Harden Drivers CI Workflow and Correct False Claims

**Change**: 260731-0sg1-harden-drivers-ci-workflow
**Created**: 2026-07-31

## Origin

One-shot `/fab-new` invocation carrying five enumerated findings from an independent adversarial review of PRs #168–#172 (the review enumerated real workflow runs and the repo ruleset). The user's raw input, condensed per finding:

> Harden the drivers CI workflow (`.github/workflows/drivers.yml`) and correct false claims in it.
> **ONE**: no `workflow_dispatch`, no `schedule`, and both triggers are paths-filtered — the native gate cannot be run on demand against tip of main, and a `macos-latest` runner-image rotation goes undetected until a red build lands on an unrelated PR. Add `workflow_dispatch`; consider a low-frequency schedule and explain the choice.
> **TWO**: the `ios` job has no dependency cache (android has `cache: gradle`). `build-drivers-ios.sh` deletes DerivedData every run, so all 22 packages in `Package.resolved` re-resolve from github.com every run — the dominant cost at 10x macOS billing and the dominant variance the timeout absorbs. Add SPM caching.
> **THREE**: the stated ios worst case is wrong. The comment near lines 138–144 cites 9m20s worst-of-five and ~2.7x headroom; the true worst across all 17 recorded runs is 10m03s (run id 30572535194, a `pull_request` run on PR #168's own branch), so real headroom is 25/10.05 ≈ 2.49x. The comment was accurate when authored and falsified 14 seconds later by the push that shipped it — prefer a formulation that does not rot; the fragile five-run sample is the underlying problem. The android half (lines 110–113) is still correct; leave it.
> **FOUR**: the native file count is ambiguous. At base commit 0ad8580, 48 = 25 Kotlin + 20 Swift + 3 gradle.kts. PR #170 deleted one Kotlin file, so under that definition it is now 47, but the file says 44 (silently switched to Kotlin+Swift only). State the definition alongside the number.
> **FIVE**: the `proto/**` paths-filter justification holds only for Android. Android compiles proto from source; iOS compiles committed generated Swift and there is no Swift codegen in this repo, so a proto change that desyncs iOS produces a GREEN ios job. Correct the claim so nobody reads a green drivers run as proof the iOS side is in sync.
> **HARD CONSTRAINT**: `fab/project/code-quality.md` exempts CI/workflow files from the restatement sweep and treats deleting rationale as must-fix severity — do NOT remove or reword the rationale blocks. Factual corrections and additive configuration changes only.
> This PR edits drivers.yml and will trigger the drivers workflow on itself, costing macOS minutes — expected and acceptable.
> Do NOT commit or `git add` `fab/backlog.md` under any circumstance — intentionally untracked scratch; the git-pr expected-area guard would otherwise stage untracked files under `fab/`.

Local verification performed at intake (this worktree, tip of `c8-ci-hardening` = post-#172 main): `find drivers -name '*.kt' | wc -l` = 24, `*.swift` = 20, `*.gradle.kts` = 3 → 47 under the original definition, 44 under Kotlin+Swift-only — both halves of finding FOUR confirmed. `grep -c '"identity"' .../swiftpm/Package.resolved` = 22 — finding TWO's package count confirmed. `scripts/build-drivers-ios.sh:11` is `rm -rf "$DERIVED_DATA_PATH"` (`drivers/ios/.derived-data`) — the DerivedData wipe confirmed.

## Why

1. **Pain point**: `drivers.yml` is the only automated verification the native drivers have, and it is invisible except when a driver path changes. Because nothing pins the toolchain (floating `macos-latest`; Xcode settings live only in the project file), a runner-image rotation breaks the build *silently* — the failure surfaces later as a red check on an unrelated PR that happened to touch a driver path, where it reads as that PR's fault. Separately, the file's own rationale comments now carry three factually wrong or ambiguous claims (findings THREE/FOUR/FIVE), and this repo's comment policy holds these rationale blocks up as the canonical positive example (`code-quality.md` § Comments cites drivers.yml by name) — false claims in the exemplar corrode trust in the whole policy. And every ios run pays ~22 SPM network resolutions at the 10x macOS rate for nothing.
2. **If not fixed**: image rotations keep landing as misattributed red builds; the 25-minute timeout keeps absorbing github.com network variance as its dominant noise source; readers keep trusting a 9m20s worst case that is stale, a 44 that silently changed definition, and a proto-filter justification that overstates what a green ios job proves (the dangerous one — someone will read green as "iOS proto bindings are in sync" when the gate structurally cannot check that).
3. **Why this approach**: additive triggers + a cache step + surgical comment corrections keep the workflow's contract intact (additive to ruleset 14531661, no job named `test`, concurrency semantics unchanged) and comply with the hard constraint — rationale blocks are corrected in place, never removed or reworded beyond the false claims themselves.

## What Changes

All changes are to `.github/workflows/drivers.yml` only. No build-script edits, no ci.yml edits.

### 1. On-demand + scheduled triggers (finding ONE)

Add to the `on:` block:

```yaml
  # Rationale to carry (new comment, additive): the paths-filtered triggers mean
  # nothing exercises this gate between driver changes, while macos-latest and the
  # unpinned Xcode toolchain rotate underneath it. workflow_dispatch gives an
  # on-demand run against any ref; the weekly schedule bounds how stale "green"
  # can get, so an image rotation surfaces as a scheduled-run failure attributable
  # to the rotation, not as a red check on whichever unrelated PR next touches a
  # driver path.
  workflow_dispatch:
  schedule:
    - cron: '17 5 * * 1'   # weekly, Mon 05:17 UTC — non-zero minute per GitHub guidance to avoid top-of-hour load spikes
```

**Schedule choice (weekly, explained)**: the failure mode being detected — runner-image/toolchain rotation — changes on a cadence of weeks-to-months, so daily adds ~7x the macOS cost (each scheduled run ≈ 7–10 macOS-minutes ≈ 70–100 billable at 10x) for negligible latency gain, while monthly lets a rotation hide for up to 31 days, which is the current failure mode barely improved. Weekly bounds staleness to 7 days at ~4 macOS runs/month. Note `schedule` ignores `paths` filters by design and runs against the default branch tip — exactly the "tip of main" coverage finding ONE asks for. Known platform caveat worth a comment line: GitHub auto-disables cron on 60 days of repo inactivity, acceptable here (an inactive repo isn't merging PRs that a stale green would mislead).

**Concurrency interaction (verified, no change needed)**: the existing group key `github.event_name == 'pull_request' && github.ref || github.run_id` sends `workflow_dispatch` and `schedule` events down the `run_id` branch — each run alone in its group, never cancelled, never queued — same as push-to-main today. The concurrency block is untouched.

### 2. SPM dependency cache for the ios job (finding TWO)

Insert an `actions/cache` step in the `ios` job between checkout and the build step:

```yaml
      # build-drivers-ios.sh wipes DerivedData every run (rm -rf at line 11), so
      # without a cache all 22 packages in Package.resolved re-resolve from
      # github.com on every run — the dominant cost at the 10x macOS rate and the
      # dominant variance the 25-minute cap has to absorb. This caches SPM's
      # GLOBAL clone cache (~/Library/Caches/org.swift.swiftpm), which survives
      # the DerivedData wipe: xcodebuild's package resolution copies from it
      # instead of cloning over the network. Keyed on Package.resolved so a
      # dependency bump repopulates; restore-keys makes a stale cache a partial
      # hit (only changed packages re-clone), not a miss.
      - uses: actions/cache@v4
        with:
          path: ~/Library/Caches/org.swift.swiftpm
          key: spm-${{ runner.os }}-${{ hashFiles('drivers/ios/finalrun-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved') }}
          restore-keys: |
            spm-${{ runner.os }}-
```

Rejected alternative: `-clonedSourcePackagesDirPath` pointing at a cacheable path — it would work but requires editing `build-drivers-ios.sh`, and this change is scoped to additive workflow configuration; the global-cache approach needs no script change.

### 3. Correct the ios worst-case comment (finding THREE)

The comment at current lines 138–144 keeps its full rationale (job-level timeout, why the tighter relative bound, the 10x billing arithmetic, red-job-beats-generous-cap) — only the falsified sample claim is corrected, and reformulated so it cannot rot the same way:

- Replace "Worst `ios` run observed across five recorded runs: 9m20s (5m36s, 5m57s, 6m57s, 7m28s, 9m20s — the longest being the push-to-main run), so 25 leaves ~2.7x headroom." with a dated, run-id-anchored formulation, e.g.: "Worst `ios` run across all 17 runs recorded as of 2026-07-31: 10m03s (run 30572535194, a pull_request run on PR #168's own branch), so 25 leaves ~2.5x headroom. Stated as a dated observation deliberately: the previous version of this comment cited a worst-of-five sample that was falsified 14 seconds after it shipped, by its own push's run — a fixed sample rots; an as-of date makes later, slower runs a reason to re-derive, not a contradiction."
- The exact wording is apply's to settle; the requirements are: 10m03s / run id 30572535194 / 17 runs / as-of date present; ~2.49–2.5x headroom (25/10.05); no enumerated fixed sample as the load-bearing claim; existing rationale sentences preserved.
- The android half (lines 110–113: 2m36s worst-of-five, ~5.8x) is **left byte-identical** — the review verified it still holds.

### 4. Disambiguate the native file count (finding FOUR)

Line 6's "the 44 native files" becomes a self-defining figure: "the 47 native build-input files (24 Kotlin + 20 Swift + 3 *.gradle.kts)" — restoring the original definition from base commit 0ad8580 (48 = 25 Kotlin + 20 Swift + 3 gradle.kts, minus the one Kotlin file PR #170 deleted) and stating the definition inline so the next deletion cannot silently change what the number means. Counts verified in this worktree (see Origin). The surrounding sentence's rationale is otherwise untouched.

### 5. Correct the proto/** justification (finding FIVE)

The `proto/**` bullet (current lines 50–54) keeps its Android claim verbatim (`build.gradle.kts:104` protobuf source dir — verified accurate) and gains the iOS caveat: iOS compiles the **committed generated Swift** under `drivers/ios/finalrun-ios-test/Generated/`, and there is no Swift codegen anywhere in this repo — so a proto change that desyncs the generated Swift still produces a GREEN ios job. The corrected comment must say explicitly that `proto/**` earns its place for the Android compile only, and that a green `ios` job is NOT evidence the committed Swift bindings match the proto. Additive sentences; the existing Android rationale is not reworded.

### Constraints binding apply

- **Comment policy (hard constraint)**: `fab/project/code-quality.md` § Comments exempts CI/workflow files from the restatement sweep and `fab/project/code-review.md` grades deleting-rationale as **must-fix**. Every existing rationale sentence in drivers.yml survives except the specific false claims being corrected (the five-run ios sample, the bare "44", the unqualified proto justification). Corrections replace false numbers with true ones; they do not compress, reword, or delete adjacent rationale.
- **The two `paths` lists stay byte-identical** (the file's own stated invariant) — no paths changes are in scope anyway.
- **No job named `test`** — no new jobs are added at all.
- **Self-triggering cost accepted**: this PR touches drivers.yml, which is in its own paths filter, so the PR run costs macOS minutes — expected and acceptable per the user.
- **`fab/backlog.md` must never be staged or committed** — it is intentionally untracked scratch. The git-pr expected-area guard stages untracked files under `fab/`, so the ship stage must explicitly avoid `git add fab/` patterns that would sweep it in (stage `fab/changes/260731-0sg1-.../` paths explicitly, never `fab/` wholesale).

## Affected Memory

- `ci/pr-quality-gate`: (modify) the drivers.yml gate description gains: workflow_dispatch + weekly schedule triggers (and why — unpinned toolchain rotation detection), the SPM global-cache step for the ios job (and the DerivedData-wipe coupling with `build-drivers-ios.sh` that makes the global cache the right target), and the corrected timeout-derivation facts (10m03s worst, dated-observation formulation). The proto/iOS-desync caveat (a green ios job does not prove committed Swift bindings match the proto) also belongs here and/or in `drivers/grpc-contract` — hydrate to place it where the compile-only-ceiling claim already lives.

## Impact

- **Files**: `.github/workflows/drivers.yml` only. No source, script, or ci.yml changes.
- **Systems**: GitHub Actions (new triggers, new cache entries under the repo's 10 GB cache quota — one ~small SPM cache entry per Package.resolved hash); billing (weekly scheduled macOS run ≈ 70–100 billable min/month, offset by SPM cache savings on every PR/push run).
- **Contracts intact**: additive to ruleset 14531661 (nothing here is a required check); concurrency semantics unchanged for all event types; paths lists unchanged and byte-identical.
- **Tests**: none applicable — the workflow itself is exercised by the PR that ships it (self-triggering, accepted). `actionlint`/YAML validity should be checked locally if available.

## Open Questions

*(none — all decisions resolved from the input or verified locally; see Assumptions)*

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Add `workflow_dispatch` to `on:` | Explicit instruction in finding ONE | S:95 R:90 A:95 D:95 |
| 2 | Confident | Add a **weekly** schedule (`cron: '17 5 * * 1'`) rather than daily/monthly/none | Explicitly delegated ("consider a low-frequency schedule; explain your choice"); weekly bounds toolchain-rotation staleness to 7 days at ~4 macOS runs/month — daily is ~7x cost for negligible latency gain, monthly barely improves the status quo | S:75 R:90 A:80 D:65 |
| 3 | Certain | SPM caching via `actions/cache` on the **global** SPM cache `~/Library/Caches/org.swift.swiftpm`, keyed on `hashFiles(...Package.resolved)` with a `restore-keys` prefix | The script's DerivedData wipe (`rm -rf`, line 11) rules out caching DerivedData; the global clone cache survives the wipe and needs no build-script edit; `-clonedSourcePackagesDirPath` rejected as it requires editing `build-drivers-ios.sh` (out of additive-config scope) | S:80 R:90 A:80 D:70 |
| 4 | Certain | ios worst-case correction values: 10m03s, run 30572535194, 17 recorded runs, headroom 25/10.05 ≈ 2.49x; android half untouched | All values supplied verbatim by the review; android half explicitly excluded | S:95 R:85 A:90 D:90 |
| 5 | Certain | Reformulate the timing claim as a **dated observation** ("worst across all N runs recorded as of {date}, run {id}") instead of an enumerated fixed sample | The review names sample-rot as the underlying problem and asks for a non-rotting formulation; an as-of-dated, run-id-anchored claim cannot be falsified by later runs, only superseded | S:80 R:90 A:85 D:70 |
| 6 | Certain | File count becomes "47 native build-input files (24 Kotlin + 20 Swift + 3 *.gradle.kts)" with the definition stated inline | Definition and history supplied by the review; counts independently verified in this worktree (24/20/3) | S:90 R:90 A:95 D:90 |
| 7 | Certain | proto/** correction: Android justification stays verbatim; add that iOS compiles committed generated Swift with no repo codegen, so a proto desync yields a green ios job | Explicit instruction; `build.gradle.kts:104` claim re-verified as still accurate | S:95 R:85 A:90 D:90 |
| 8 | Certain | Concurrency block untouched — `workflow_dispatch`/`schedule` events fall to the `github.run_id` branch of the existing group expression (never cancelled, never queued) | Deterministic from the existing group expression (ternary on `event_name == 'pull_request'`, else `run_id`); verified by reading the file | S:85 R:90 A:95 D:90 |
| 9 | Certain | Comment corrections are surgical: false claims replaced, all adjacent rationale sentences preserved unmodified | Hard constraint in the input; `code-quality.md` § Comments + `code-review.md` must-fix severity for rationale deletion | S:95 R:80 A:95 D:95 |
| 10 | Certain | Ship stage must never stage `fab/backlog.md` (untracked scratch); stage change artifacts by explicit path, never `git add fab/` wholesale | Explicit instruction, with the git-pr expected-area-guard failure mode named by the user | S:95 R:75 A:95 D:95 |

10 assumptions (9 certain, 1 confident, 0 tentative, 0 unresolved).
