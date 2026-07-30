# Intake: CI Cost Guards and Carried-Forward Defects

**Change**: 260730-eyvt-ci-cost-guards-carried-defects
**Created**: 2026-07-30

## Origin

One-shot `/fab-new` invocation, no prior conversation. The user's raw input:

> CI hygiene and carried-forward defects. Four items, all measured from PR #167. (1) Add
> timeout-minutes to both jobs in .github/workflows/drivers.yml -- a hung xcodebuild can currently
> burn up to 360 minutes at the 10x macos-latest billing rate. (2) Add a paths filter to drivers.yml
> so it only runs on PRs touching driver code, AND add a concurrency block with cancel-in-progress
> so superseded pushes cancel in flight. Measured cost today: the ios job takes 5m36s to 7m28s
> billed at 10x, drivers.yml runs on every PR including pure-docs ones, and three pushes on PR #167
> burned roughly 200 billable minutes. Both levers are wanted -- this is a confirmed user decision,
> do not re-litigate coverage versus cost, just implement both. (3) Fix the open() persistent error
> listener in logWriteStream.ts that code review flagged and deliberately left open. (4) Add
> .github/ to the expected write areas in the git-pr skill so the next workflow edit does not trip
> its guard.

**Scope correction — item 4 was split out; this is a THREE-item change.** After intake was first
generated, the operator (confirmed by the user) dropped item 4 entirely. It is filed as **backlog
item `ax7i`** with the full diagnosis and will be fixed **upstream in fab-kit** instead. (`ax7i` is
tracked outside this repository — there is no `fab/backlog.md` on this branch or anywhere in its
history, so do not expect to resolve the ID locally.) The reason
is the one intake had already surfaced: `.claude/skills/git-pr/SKILL.md` is gitignored and
kit-deployed, so any edit is outside version control, invisible in the PR diff, and lost on the next
fab-kit upgrade — patching this machine would have looked like a fix while decaying silently. Two
hard constraints follow for every downstream stage:

- **No file under `~/.fab-kit/` may be edited.**
- **`.claude/skills/git-pr/SKILL.md` must not be edited.**

The `/git-pr` expected-area guard therefore still omits `.github/` when this change ships. That is
accepted and out of scope: this change modifies `.github/workflows/drivers.yml`, which is **tracked**,
so it stages via `git add -u` and the guard — which fires only on *untracked* files outside the
expected areas — is never reached. The guard remains a latent trip-hazard for whoever next adds a
*new* file under `.github/`, which is exactly what `ax7i` covers.

**Key decisions carried in from the user's input** (do not revisit):

- The paths filter **and** the concurrency block both ship. The coverage-versus-cost trade was
  already decided by the user; this change implements, it does not re-argue.
- Item 3 is a defect fix code review already flagged and consciously deferred — the fix is wanted
  now, not the re-triage.
- Item 4 is **not** in scope. See the scope correction above before touching anything outside the
  three areas listed in What Changes.

**Verified against the repo during intake** (each of these is measurement, not assumption):

| Claim | Verification |
|-------|--------------|
| No `timeout-minutes` anywhere in `.github/workflows/` | `grep -rn "timeout-minutes" .github/workflows/` → no matches, so all four workflows sit on GitHub's 360-minute default |
| `drivers.yml` has no `paths` filter and no `concurrency` block | Read of the file: `on:` carries only `branches: [main]` on both triggers |
| `ios` job durations | Five real runs: 336 s, 357 s, 417 s, 448 s, 560 s — worst observed **9m20s** (the `push`-to-main run), the four PR runs in the 5m36s–7m28s band the user quoted |
| `android` job durations | Same five runs: 57 s, 58 s, 140 s, 153 s, 156 s — worst observed **2m36s** |
| Only `test` is a required check | Ruleset `14531661` → `required_status_checks: [{context: test, integration_id: 15368}]`. The `android` and `ios` jobs are **not** required, which is what makes a paths filter safe here (see Why) |
| The Android build compiles the shared proto | `drivers/android/app/build.gradle.kts:104` → `srcDir(rootDir.resolve("../..").resolve("proto"))`. A change to `proto/finalrun/driver.proto` can break the Android compile, so `proto/**` **must** be in the paths filter |
| iOS does **not** build from `proto/` | `drivers/ios/finalrun-ios-test/Generated/finalrun/driver.pb.swift` and `driver.grpc.swift` are committed generated sources under `drivers/`, already covered by `drivers/**` |
| `open()` attaches no `error` listener | Read of `packages/device-node/src/device/logWriteStream.ts:42-46` — `createWriteStream` is returned bare |
| This change's own files are all tracked | `git ls-files` covers `.github/workflows/drivers.yml`, `packages/device-node/src/device/logWriteStream.ts` and `test/logCaptureProviders.test.ts`, so `/git-pr` stages them with `git add -u` and its untracked-file guard is never reached — which is why dropping item 4 does not block shipping this change |

## Why

**Items 1 and 2 — the `ios` job is the most expensive thing in this repo's CI, and nothing bounds
it.** `macos-latest` bills at **10× the Linux rate**, and the job currently runs on every pull
request targeting `main` regardless of what the PR touches. Three concrete costs stack up:

1. **No upper bound.** With no `timeout-minutes`, a hung `xcodebuild` — an SPM resolve stuck on a
   network stall, a simulator that never boots — runs to GitHub's 360-minute default. At 10× that
   is **3,600 billable minutes for a single wedged job**, and nothing in the repo prevents it today.
   The fix is two lines and the risk it removes is unbounded.
2. **Work that cannot be relevant still runs.** `drivers.yml` gates the native Kotlin/Swift trees.
   A pure-docs PR, a `fab/` artifact commit, a change confined to `packages/report-web` — none can
   affect either native build, and all of them currently pay for a full Android **and** iOS compile.
3. **Superseded runs are paid for in full.** PR #167 took three pushes; each one started a fresh
   `ios` job and no earlier run was ever cancelled, for roughly **200 billable minutes** where one
   run's worth was actually informative. The only run whose verdict mattered was the one at the tip.

**Why a paths filter is safe here but would not be on `ci.yml`.** A `paths` filter means the
workflow does not run *at all* when nothing matching changed — the check is absent, not green. For a
**required** check that is fatal: the PR would block forever on a check that never reports. Ruleset
`14531661` requires exactly one context, `test`, which resolves to `ci.yml`'s job. `drivers.yml`'s
`android` and `ios` jobs are additive and required by nothing, so their absence blocks no merge.
This is why the filter goes on `drivers.yml` and must never be copied to `ci.yml` without also
adding the always-runs sentinel-job pattern.

**Why a concurrency block here does not contradict the repo's recorded no-cancellation rule.**
`docs/memory/ci/pr-quality-gate.md` argues at length that `ci.yml` must carry no `concurrency` key,
because a cancelled run at a mergeable PR tip is an unverified commit that reads exactly like a
clean one. That argument is load-bearing **because `test` is the required check** — the cancelled
run is the very thing the merge gate consults. `drivers.yml` is not that check. A cancelled
`drivers` run is visibly `cancelled`, gates no merge, and the commit it skipped is superseded by
the push that cancelled it. So the guarantee the rule protects is untouched; what is traded is
native-compile coverage of commits that are no longer the tip.

Two parts of that rationale still apply verbatim and shape the design below: (a) GitHub cancels an
existing **pending** run whenever a newer run queues into the same group on the default
`queue: single`, so a bare `group` reintroduces cancellation even where `cancel-in-progress` is
false; and (b) the `push`-to-main run is a post-merge safety net whose verdict nothing supersedes.
The block is therefore **scoped to `pull_request` events** — see What Changes § 2.

**Item 3 — an unhandled stream `error` takes the CLI down mid-run.**
`LogWriteStreamRegistry.open()` returns `fs.createWriteStream(path)` with no `error` listener, and
both providers then `stdout.pipe(stream)`. `pipe()` does **not** forward destination errors to the
source, and an `'error'` event with zero listeners is thrown by Node as an uncaught exception. The
window is the entire capture: `createWriteStream` opens its fd asynchronously (an `EACCES`, a
missing `finalrun-logs` directory, `EMFILE` all surface here), and every later write can fail
(`ENOSPC`). The only place an error is currently observed is `await finished(stream)` inside
`_endAndFlush`, which does not exist as a listener until `finalize` runs — and which
`_endAndFlush` then skips anyway via its `stream.destroyed` early return, because an errored
stream auto-destroys. So today the same defect has two faces: **a crash before finalize, and a
silently successful stop after it.** Both are closed by recording the error at `open()` time.

## What Changes

### 1. `timeout-minutes` on both `drivers.yml` jobs

Add a job-level `timeout-minutes` to each job. Job level, not step level, so checkout and
toolchain setup are inside the bound.

```yaml
jobs:
  android:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps: ...

  ios:
    runs-on: macos-latest
    timeout-minutes: 25
    steps: ...
```

**Values and their derivation.** Both are ≥ 2× the worst duration actually observed across the five
recorded runs, rounded up for cold-cache and runner-image variance:

| Job | Observed durations | Worst | `timeout-minutes` | Headroom | Worst-case billable |
|-----|-------------------|-------|-------------------|----------|---------------------|
| `android` | 57 s, 58 s, 140 s, 153 s, 156 s | 2m36s | **15** | ~5.8× | 15 (1× Linux) |
| `ios` | 336 s, 357 s, 417 s, 448 s, 560 s | 9m20s | **25** | ~2.7× | 250 (10× macOS) |

The `ios` bound is deliberately the tighter of the two *relative to its worst run*, because it is
the job whose minutes cost 10×. The 25-minute cap replaces a 360-minute default: worst-case
exposure for a wedged job drops from ~3,600 billable minutes to 250.

Add a comment above each value recording the measured worst-case run it derives from, so a future
reader can tell a measured bound from a guessed one. A spurious timeout is a red job that a re-run
clears — visible and self-correcting — which is the failure direction to prefer over a cap so
generous it defeats its own purpose.

### 2. Paths filter and concurrency block on `drivers.yml`

**Paths filter — applied to both triggers.** The filter list is the definition of "driver-relevant"
and getting it wrong silently narrows the only automated verification native code has, so it is
derived from what the two builds actually consume:

```yaml
on:
  pull_request:
    branches: [main]
    paths:
      - 'drivers/**'
      - 'proto/**'
      - 'scripts/build-drivers-android.sh'
      - 'scripts/build-drivers-ios.sh'
      - '.github/workflows/drivers.yml'
  push:
    branches: [main]
    paths:
      - 'drivers/**'
      - 'proto/**'
      - 'scripts/build-drivers-android.sh'
      - 'scripts/build-drivers-ios.sh'
      - '.github/workflows/drivers.yml'
```

Each entry earns its place:

- **`drivers/**`** — both native trees, their gradle files, the gradle wrapper, the Xcode project,
  and the committed generated Swift under `drivers/ios/finalrun-ios-test/Generated/`.
- **`proto/**`** — **load-bearing and easy to miss.** `drivers/android/app/build.gradle.kts:104`
  adds the repo-root `proto` directory as a protobuf source dir, so the Android driver compiles
  `proto/finalrun/driver.proto` from source on every build. A proto edit can break the Kotlin
  compile with no file under `drivers/` changing at all — exactly the class of change PR #167's
  `reserved 4;` fix touched. Omitting this entry would make the gate blind to it.
- **The two build scripts** — each job's single `run:` step is `./scripts/build-drivers-*.sh`. A
  change to either script changes what the gate does.
- **`.github/workflows/drivers.yml`** — so a change to the gate is verified by the gate.

`resources/android/` and `resources/ios/` are deliberately **absent**: they are the scripts' output
staging directories, not build inputs.

The list is duplicated verbatim under both triggers as a **deliberate choice, not a forced one**:
GitHub Actions **has** supported YAML anchors/aliases since **2025-09-18** (automatically enabled for
all users and repositories), so a `&anchor`/`*alias` pair would parse. Two short adjacent literal
lists are kept because they are trivially eyeball- and diff-verifiable, and because anchor support
specifically inside the `on:` trigger block is not something this change verifies. Keep the two lists
byte-identical and comment that they must stay in sync.

Filtering the `push` trigger too is intentional and safe: a merge whose diff touches no driver path
cannot break either native build, and a merge that *does* touch one still matches the filter and
still runs the post-merge net. The combination case is covered — if PR A changed `proto/` and PR B
changed `drivers/`, the merge commit for each matches the filter, so main is gated on the combined
tree.

**Concurrency block — scoped to pull requests.**

```yaml
# Supersede in-flight PR runs; never queue or evict a main run.
#
# On a pull_request the group is the PR ref, so a newer push cancels the run
# the previous push started — the measured waste this closes is PR #167's
# three pushes, ~200 billable minutes for one informative verdict. A cancelled
# `drivers` run is safe to trade away in a way a cancelled `ci` run is not:
# ruleset 14531661 requires only ci.yml's `test` context, so no merge gate
# consults this workflow, and the commit a cancellation skipped is by
# definition no longer the tip.
#
# On a push to main the group key is the run id, which is unique per run — so
# every main run is alone in its group and behaves exactly as it does today:
# not cancelled, and never queued behind or evicted by another. A bare
# `group: drivers-${{ github.ref }}` would NOT be equivalent: GitHub cancels an
# existing PENDING run whenever a newer run queues into the same group on the
# default `queue: single` (cancel-in-progress governs only the in-progress
# run), so two rapid merges would silently cost the middle one its verdict.
# See docs/memory/ci/pr-quality-gate.md for the long form of that footgun.
concurrency:
  group: drivers-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Both `concurrency.group` and `concurrency.cancel-in-progress` accept expressions, and
`github.event_name` is available at workflow level. The `A && B || C` ternary idiom is safe here
because `github.ref` is always a non-empty (truthy) string on both event types: a `pull_request`
resolves to `drivers-refs/pull/N/merge`, a `push` to `drivers-<run_id>`.

**Header comment and existing rationale must be corrected in the same change.** `drivers.yml:24-27`
currently reads:

```
# There is deliberately NO `concurrency:` block, for the reason ci.yml records
# at length: a bare group on the default `queue: single` lets a newer run
# cancel an existing PENDING one, and a cancelled run at a PR tip reads
# exactly like a clean one.
```

That comment is the direct negation of what this change ships and MUST be replaced, not left to
contradict the code below it. The replacement keeps the *reasoning* — the pending-eviction footgun
is still real, which is precisely why the group key is run-id-scoped on main — and records why the
conclusion differs for a non-required check. `ci.yml`'s own comment block (`ci.yml:18-31`) is
**not** touched: its rule is unchanged and still correct for the required check.

### 3. Persistent `error` listener in `LogWriteStreamRegistry.open()`

**File**: `packages/device-node/src/device/logWriteStream.ts`

The registry's map value becomes a small entry object so the first error can be remembered
alongside the stream:

```ts
interface LogStreamEntry {
  readonly stream: fs.WriteStream;
  error?: Error;
}

private readonly _streams = new Map<string, LogStreamEntry>();

open(outputFilePath: string): fs.WriteStream {
  const stream = fs.createWriteStream(outputFilePath);
  const entry: LogStreamEntry = { stream };
  this._streams.set(outputFilePath, entry);

  // Attached here, before anything can pipe into the stream, and kept for the
  // stream's whole life. `createWriteStream` opens its fd asynchronously, so an
  // EACCES or a missing directory arrives as an `error` event well after this
  // returns, and every later write can fail the same way. `pipe()` does not
  // forward a destination's errors to the source, so with no listener the first
  // one is an unhandled 'error' — which Node throws, taking the CLI down in the
  // middle of a run. The error is RECORDED and not merely logged because
  // `_endAndFlush` early-returns on an errored (hence auto-destroyed) stream:
  // without the record, `finalize` would resolve and report a successful stop
  // over a log file that was never written.
  stream.on('error', (error) => {
    entry.error ??= error;
    Logger.e(
      `LogWriteStreamRegistry: log write stream failed: ${outputFilePath}`,
      error,
    );
  });

  return stream;
}
```

`finalize` surfaces the recorded error **after** its existing `try`/`finally`, so precedence is
unambiguous and nothing is masked:

```ts
async finalize(outputFilePath: string, source?: Readable | null): Promise<void> {
  const entry = this._streams.get(outputFilePath);
  if (!entry) {
    return;
  }
  const { stream } = entry;

  try {
    // ...unchanged drain + timeout-unpipe...
  } finally {
    // ...unchanged: untrack, then end and flush...
  }

  // Reached only when nothing above threw: a drain rejection or a flush error
  // is already the failure being reported, and re-throwing here would replace
  // it with a redundant one. A recorded write error still fails the stop, per
  // the existing contract — a log that could not be flushed is not a stop.
  if (entry.error) {
    throw entry.error;
  }
}
```

Unchanged by design: `finalizeQuietly` still catches and logs (its callers are already returning a
failure); the drain timeout still `unpipe`s before `end()`, which is what keeps
`ERR_STREAM_WRITE_AFTER_END` off this path in the first place; untracking and ending still happen on
every path in the `finally`; `finalize` stays idempotent for an untracked path.

**Behavioral nuance the plan must keep in view**: the documented timeout scenario ends "the stream
is ended and flushed, and the stop resolves". A recorded write error now makes such a stop *reject*
instead. This is not a regression of that scenario — the pre-`end()` `unpipe` means a timed-out
drain does not itself produce a write error — but if one did occur, rejecting is the correct
outcome under the existing "a write error rejects" contract, and the alternative (resolve over an
unwritten file) is the bug being fixed.

**Tests** extend `packages/device-node/src/device/test/logCaptureProviders.test.ts`, which already
unit-tests the registry directly (`LogWriteStreamRegistry ends and untracks the stream when the
source errors`, line 214) — registry tests stay in one file rather than starting a second one.
Cases to add:

1. `open()` attaches an `error` listener synchronously (`stream.listenerCount('error') > 0`
   immediately on return) — the regression guard for the defect itself.
2. A stream whose open fails (a path inside a non-existent directory) raises **no** uncaught
   `error`, and the subsequent `finalize` **rejects** with that error.
3. `finalizeQuietly` on that same path logs and **resolves**.
4. A normal open → write → `finalize` still resolves and untracks (no regression on the happy path).

## Affected Memory

- `ci/pr-quality-gate.md`: (modify) **Four** edit sites, not one — the requirement, the Overview,
  the superseded Design Decision, and the frontmatter:
  1. The **"Both native drivers compile on every pull request"** requirement (line 125) is no longer
     accurate on three counts and needs all three: the trigger is now path-filtered (so "every pull
     request" becomes "every pull request that touches a driver-relevant path", with the path list
     and *why `proto/**` is in it* recorded); the clause "Like `ci.yml`, the workflow carries **no
     `concurrency` block**, for the reason recorded below" must be replaced with the PR-scoped block
     and the run-id-on-main key; and both jobs now carry a measured `timeout-minutes`.
  2. The **Overview** sentence (line 11) — "Both run on `pull_request` targeting `main` and on
     `push` to `main` as a post-merge safety net" — becomes inaccurate for `drivers.yml` without a
     path qualifier: `ci.yml` still runs on both unconditionally, `drivers.yml` now only when a
     driver-relevant path changed. One qualifying clause, not a rewrite.
  3. The existing Design Decision **"The drivers gate is a separate additive workflow, not a job in
     `ci.yml`"** (around lines 293-312) is **superseded on three counts** and MUST be updated in
     place rather than left standing beside a new decision that contradicts it: its Decision line
     "Like `ci.yml`, it carries no `concurrency` block"; its **Why** paragraph justifying the
     omission ("Omitting `concurrency` follows the same reasoning `ci.yml` records…"); and its
     **rejected alternative (d)** — "a `paths:` filter confining the iOS job to `drivers/ios/**` —
     nothing in the repo evidences a macOS-minutes constraint, and the gate's purpose is to guard
     every PR, not only the ones that look native" — which **this change now adopts** (on measured
     cost data: 10× macOS billing, 9m20s worst `ios` run, PR #167's ~200 billable minutes). The
     part of that decision that still holds — separate file, not a job in `ci.yml`, no job named
     `test`, one script call per platform, and rejected alternatives (a)/(b)/(c) — stays.
  4. A new Design Decision records why a non-required additive gate may cancel where the required
     `test` check may not — the distinction is the whole basis of this change and is the thing a
     future reader will otherwise re-litigate. It MUST be written as the successor to the decision
     in (3), not as a second opinion beside it.
  The file's frontmatter `description:` also asserts the drivers gate shape and needs the same
  correction.
- `ci/index.md`: (modify, hand edit possible) Its `ci` **domain** description carries "a completed
  verdict per push (no `concurrency` block)". That clause is scoped to `ci.yml`, whose no-
  `concurrency` rule this change does not touch, so it stays **true** as written — this entry is
  guidance accuracy, not a stale claim. What is inaccurate is treating it as regenerated: the
  generated part of a domain index is its **table rows** (from each file's frontmatter
  `description:`); the domain index's **own** `description:` frontmatter is curated and preserved
  across regeneration — `fab memory-index --check` classifies "regen would wipe a curated
  description" as destructive loss (exit 2). So `fab memory-index` will refresh the
  `pr-quality-gate` row from that file's updated frontmatter, but if hydrate decides the domain
  description needs the drivers-gate nuance (path-filtered trigger, PR-scoped cancellation), it
  MUST hand-edit that `description:` line — a re-run will not produce it.
- `device-node/log-capture.md`: (modify) The write-stream finalization contract gains the
  persistent-listener requirement: `open()` MUST attach the `error` listener before the stream can
  be piped into and keep it for the stream's life, the first error MUST be recorded, and `finalize`
  MUST fail the stop on a recorded error rather than resolving over an unwritten file. The existing
  "Every exit from a capture's lifecycle finalizes its write stream" requirement and the
  `finalize`/`finalizeQuietly` split are unchanged; the `_endAndFlush` destroyed-stream early return
  now needs its interaction with the recorded error stated. It MUST also record the contract that
  the persistent listener itself carries: **the `error` listener MUST NOT throw.** It is the listener
  of last resort — a throw escapes `emit('error')`, which Node calls on a tick with no enclosing
  `try`, and becomes the `uncaughtException` the listener exists to prevent. That is why its
  `Logger.e` call is wrapped in a `try`/`catch` (the record is taken first, so a lost log line costs
  nothing the stop depends on), and why `finalizeQuietly`'s own `Logger.e` is now wrapped too:
  `finalize` re-throwing a recorded error is what first makes that catch reachable on ENOSPC, and
  `finalizeQuietly` MUST resolve for callers already returning a failure. `Logger.e` is fallible
  independently of the stream — an unguarded `fs.appendFileSync` sink reached through an unguarded
  sink loop — so the guard is not contingent on the two failures sharing a cause.
- `cli/session-runner.md`: (modify) Its Design Decision "An acquisition is recorded in the
  release-visible state before anything fallible follows it" carries **rejected alternative (a)**,
  "wrapping the log call in its own `try`/`catch`" (line 36). `logWriteStream.ts` now does exactly
  that, deliberately, so the rejection needs its scope stated: it is rejected **for the
  acquisition-ordering problem**, where the two statements can be reordered and reordering removes
  the window structurally, making a local catch a patch over one call site. In an `error` listener of
  last resort there is nothing to reorder — not throwing IS the contract — so there the `try`/`catch`
  is the structural fix, not a patch. Record the distinction and point at
  [/device-node/log-capture.md](/device-node/log-capture.md). Without it, memory keeps a rejected
  alternative that reads as forbidding precisely what `logWriteStream.ts` must do, and the only
  record of the distinction is a comment inside the file it protects.
- `drivers/grpc-contract.md`: (modify) Narrow scope — the "A native change ships compile-verified
  only" requirement calls `drivers.yml` "the only automated verification native code gets". Still
  true, but it now runs only on matching paths, so a native-breaking change outside the filter can
  merge ungated. One qualifying sentence plus a pointer to the path list.

The dropped item 4 contributes **no** memory entry: it is now backlog `ax7i`, to be fixed upstream
in fab-kit, and no memory domain covers agent tooling configuration in any case.

## Impact

**Code and config**

| Area | Change |
|------|--------|
| `.github/workflows/drivers.yml` | `timeout-minutes` on both jobs; `paths` on both triggers; new `concurrency` block; header comment at lines 24-27 replaced |
| `packages/device-node/src/device/logWriteStream.ts` | `_streams` map value becomes an entry object; `open()` attaches and records; `finalize` re-throws a recorded error after its `finally` |
| `packages/device-node/src/device/test/logCaptureProviders.test.ts` | Four new registry cases |

Three files, all tracked. This change touches nothing outside the repository.

**Explicitly not touched**

- `~/.fab-kit/**` and `.claude/skills/git-pr/SKILL.md` — **hard out-of-scope constraints** from the
  scope correction in Origin. The `/git-pr` expected-area fix is backlog `ax7i`, to be done upstream
  in fab-kit. No stage of this change may edit either path.
- `.github/workflows/ci.yml` — its no-`concurrency` rule is unchanged and still correct. Adding a
  paths filter or a cancelling group there would break the required check.
- `fab/project/config.yaml` — unchanged. (With item 4 dropped, the `source_paths` route to widening
  the `/git-pr` guard is moot; it was rejected on its own merits and that reasoning now lives in
  backlog `ax7i`.)
- Ruleset `14531661` — no required-check change. If `android`/`ios` are ever made required, the
  paths filter becomes a merge-blocking hazard and needs the always-runs sentinel-job pattern.
- Both `scripts/build-drivers-*.sh` — unchanged; they are filter inputs, not edit targets.
- `AndroidLogcatProvider` / `IOSLogProvider` — they call `open()`/`finalize()`/`finalizeQuietly()`
  and need no change; the fix is entirely inside the registry.

**Verification reach.** Items 1 and 3 are fully verifiable: the two YAML additions are
schema-checkable and the workflow run proves them, and the TypeScript fix has unit tests. Item 2's
paths filter has an asymmetry worth stating — a PR that *does* touch a driver path proves the filter
admits correctly, but proving it *excludes* correctly requires a PR touching none, which this PR is
not (it edits `.github/workflows/drivers.yml`, which is itself in the filter). Expect this PR's own
`drivers` run to fire; that is the filter working, not a failure. The concurrency block is only
exercised by two pushes in quick succession, so it ships source-verified unless the PR happens to
receive them.

## Open Questions

None. Every decision was resolvable from the user's input, the repo, or measured CI data; the one
place with a genuine trade (the timeout values) is recorded as a graded assumption below rather than
left open. Item 4's open question — which durability tier a local skill patch should target — left
with the item when it became backlog `ax7i`.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `proto/**` is in the paths filter | Not inferred — `drivers/android/app/build.gradle.kts:104` adds the repo-root `proto` dir as a protobuf source dir, so the Android driver compiles `proto/finalrun/driver.proto` from source. Omitting it would let a proto change break the Kotlin compile ungated | S:70 R:85 A:95 D:85 |
| 2 | Certain | The concurrency block goes on `drivers.yml` only, never `ci.yml`, and the existing `drivers.yml` header comment asserting "deliberately NO `concurrency:` block" is replaced in the same change | Ruleset `14531661` requires only `ci.yml`'s `test` context, so the recorded no-cancellation rule is scoped to the required check. Leaving the comment would make the file contradict itself | S:90 R:90 A:90 D:90 |
| 3 | Certain | New registry tests extend `logCaptureProviders.test.ts` rather than starting a `logWriteStream.test.ts` | That file already unit-tests `LogWriteStreamRegistry` directly (line 214), and memory records the `test/`-beside-the-code convention. A second file would split registry tests for no gain | S:60 R:90 A:95 D:90 |
| 4 | Certain | Change type is `ci`, overriding the `feat` the keyword inference actually produced | Two of the three items are workflow configuration and one is a runtime code fix, so `ci` leads; `feat` is wrong on every reading. `fab status set-change-type` marks it `explicit` so `fab status refresh` cannot revert it | S:80 R:95 A:85 D:70 |
| 5 | Confident | The concurrency group key is `github.ref` on `pull_request` and `github.run_id` on `push`, with `cancel-in-progress` expression-gated to `pull_request` | The user asked for cancellation of superseded pushes; all measured waste (PR #167's ~200 minutes) is PR-side. A bare `group: drivers-${{ github.ref }}` would let a third rapid merge evict the pending second main run — the exact footgun memory documents. Rejected: unconditional group + `cancel-in-progress: true` (simpler, walks into the footgun); no group at all (drops half the requested lever) | S:75 R:85 A:75 D:55 |
| 6 | Confident | `timeout-minutes: 15` (android) and `25` (ios) | User specified the mechanism, not the values. Derived as ≥2× the worst of five observed runs (2m36s / 9m20s), rounded up for cold-cache and macOS runner-image variance. `ios` is the tighter relative bound because its minutes bill at 10×. Reversible in one line; a spurious timeout is a visible red job, not silent damage | S:85 R:95 A:70 D:60 |
| 7 | Confident | The `paths` filter is applied to the `push`-to-main trigger as well as `pull_request`, though the user said "PRs" | A merge whose diff touches no driver path cannot break either native build, and the two-PR combination case still matches (each merge commit carries the driver-path diff). Skipping the 10× job on docs-only merges is the same saving the user asked for. Reversible by deleting five lines | S:65 R:90 A:75 D:65 |
| 8 | Confident | `finalize` re-throws a recorded write error **after** its existing `try`/`finally`, so an in-flight drain or flush rejection takes precedence | Both mean "the log is not known to be complete", so either satisfies the contract; throwing after the `finally` gets correct precedence for free and cannot mask the original. Rejected: throwing inside the `finally` (masks a drain rejection); logging only (leaves `_endAndFlush`'s destroyed-stream early return reporting a successful stop over an unwritten file — half the defect) | S:75 R:70 A:80 D:65 |
| 9 | Confident | The paths list is duplicated verbatim under both triggers instead of shared via a YAML anchor | Anchors are **available** — GitHub Actions shipped YAML anchors/aliases on 2025-09-18, automatically enabled for all users and repositories — so the duplication is a deliberate choice, not a forced one. Two short adjacent literal lists are trivially eyeball- and diff-verifiable, and anchor support specifically inside the `on:` trigger block is not something this change verifies; the keep-byte-identical comment is still the mitigation the duplication needs. Reversible: converting to an anchor later is a local edit | S:60 R:90 A:70 D:75 |

9 assumptions (4 certain, 5 confident, 0 tentative, 0 unresolved).
