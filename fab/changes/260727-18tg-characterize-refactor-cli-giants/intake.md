# Intake: Characterize and Refactor the Two Untested `cli` Giants

**Change**: 260727-18tg-characterize-refactor-cli-giants
**Created**: 2026-07-27

## Origin

Eleventh change in the code-quality initiative. The two batched refactors (#159 `goal-executor`,
#160 `device-node`) cleared 42 warnings between them by taking a package's **tested** functions in
one pass. Both deliberately excluded their untested files, as every change since #154 has.

That exclusion has now accumulated: `packages/cli` holds the **last two untested giants**, and they
are the largest remaining single blockers. Neither can be batched the way #159/#160 were, because
the safety net those relied on does not exist here. They need the characterization route proven in
#156 (`cloud-core`): write tests that pass against the **unmodified** source, verify they are
load-bearing, only then restructure.

> User direction: after being offered four options — continue batching, the characterization batch,
> draining the deferred-follow-up queue, or `report-web` backfill — the user chose the
> characterization batch: "start that".

## A concern with the scope as asked, stated before proceeding

**The two halves are not equally tractable, and one may not be completable under this project's own
rules.** Measured, not assumed:

| | `reportWriter.ts` | `sessionRunner.ts` |
|---|---|---|
| Size | 945 lines | 847 lines |
| Warnings | **7** (6 functions) | **4** (2 functions) |
| Runtime imports | `fs`, `fsp`, `path`, `YAML` — the rest are type-only | `DeviceNode`, `CliFilePathUtil`, `TerminalRenderer` |
| Nature | Pure file-writer: given data, emit JSON/YAML/artifacts | Orchestrates a live device session end-to-end |
| Injection seam | not needed — real temp dirs suffice | **none exists** |
| Incidental coverage | already exercised via `testRunner.test.ts` | none |

`reportWriter` is the `cloud-core` situation almost exactly: stub nothing, use `fs.mkdtempSync`
workspaces, assert on files actually written. `sessionRunner` is a different problem — characterizing
`executeTestOnSession` (219 lines, the largest function left in the repo) means standing up
believable fakes for a device runtime, a driver, the goal executor and a terminal renderer, none of
which is injectable today.

**The constitution's Test Integrity principle forbids adding a DI seam to make it testable** — that
is reshaping implementation to suit test infrastructure, and #156 rejected exactly that move for
`cloud-core`. So the honest possibilities for `sessionRunner` are: fakes are achievable at
proportionate cost, or they are not, and it needs its own change with a deliberate, argued seam.

**This intake covers both, ordered so the tractable half lands first**, with an explicit stopping
rule (What Changes §4). That is deliberate: if the second half has to stop, it stops at a coherent
boundary with 7 of 11 warnings cleared and a fully-tested `reportWriter`, rather than mid-way through
fakes that do not actually pin behaviour.

## Why

**Problem.** These two files are 1,792 lines of completely unverified code on the CLI's primary path
— every local test run writes its report through `reportWriter` and runs through `sessionRunner`.
They carry 11 of the 54 remaining source warnings, including the repo's two largest functions
(`executeTestOnSession` 219 lines, `writeRunInputs` 156).

**Consequence if not fixed.** They are structurally frozen: no change since #154 has been able to
touch them, because restructuring unverified code is what this initiative has refused to do. They
are also the last thing standing between the current state and a `cli` package that can be batched
like the other two. And the rules cannot be promoted from `warn` to `error` while they stand.

**Why characterization specifically.** The goal is not to specify what these functions *should* do —
it is to **pin what they currently do** so a later refactor provably preserves it. Note the contract
is the inverse of a bug fix's: these tests must **pass before and after**. #158's regression tests
had to fail first; conflating the two is the easiest way to write a worthless suite.

## What Changes

### 1. Characterize `reportWriter.ts` — tests FIRST, green against unmodified source

New `packages/cli/src/test/reportWriter.test.ts`. Use real `fs.mkdtempSync` workspaces and assert on
what is actually written — no stubbing of `fs`. This is the `cloud-core` pattern and it fits here
because the runtime dependency surface is only `fs`/`fsp`/`path`/`YAML`.

Behaviours worth pinning (read the file and cover what matters; this is not exhaustive):
- `writeRunInputs` (156 lines): which files land, their paths, and their contents — especially any
  redaction. **If secrets or env bindings are filtered before being written, that is a
  security-relevant contract and MUST be pinned**, as the equivalent was in `cloud-core`.
- `writeTestRecord` / `writeTestFailureRecord`: record shape on success and failure paths.
- `finalize`: the run manifest's final state, and what it emits when a run was aborted.
- `_buildRunManifest` / `_toRunManifestTest`: manifest shape, including which fields are omitted
  versus present-and-undefined — an added `undefined` key changes emitted JSON.
- Artifact/log copying behaviour, including the missing-source path.

### 2. Refactor `reportWriter.ts` — only once §1 is green

Six functions: `writeRunInputs`:156 (156L + complexity), `writeTestRecord`:318 (73L),
`finalize`:400 (63L), `writeTestFailureRecord`:466 (86L), `_buildRunManifest`:558 (68L),
`_toRunManifestTest`:627 (complexity).

Apply the recorded Design Decisions: every extracted helper itself ≤60 lines and ≤12 complexity;
per-call local context for accumulating state; `finally` scope follows each acquisition (this writes
files — if a partial artifact is created before a throw, its cleanup must be scoped to the
acquisition); phase-outcome variants per-orchestrator. **Look for a shared shape across the four
`write*`/`finalize` functions before extracting per-function helpers** — they are a plausible sibling
family, and #159/#160 showed that is where DRY actually lives.

### 3. Characterize `sessionRunner.ts` — the harder half

New `packages/cli/src/test/sessionRunner.test.ts` covering `prepareTestSession`:138 (134L +
complexity) and `executeTestOnSession`:286 (219L + complexity).

There is no injection seam. Construct fakes for the collaborators actually used — `DeviceNode`,
`CliFilePathUtil`, `TerminalRenderer`, and the goal-executor result shape — passing them through the
existing parameters and constructors. **Do NOT add a dependency-injection seam to `sessionRunner.ts`
to make this easier.** If the only way to reach a behaviour is to change the source's shape, that
behaviour stays unpinned and is recorded as a gap, exactly as `cloud-core`'s `ora` spinner strings
were.

### 4. Stopping rule — this is the part that makes the scope safe

If, after a genuine attempt, characterizing `executeTestOnSession` requires either (a) a DI seam in
the source, or (b) fakes so elaborate that they encode assumptions rather than observe behaviour,
then **STOP after §2**. Ship `reportWriter` characterized and refactored (7 of 11 warnings), record
precisely what blocked `sessionRunner` and what a seam-introducing change would need to argue, and
leave §3/§5 to that change.

A characterization suite that passes because the fakes were built to match the refactor is worse than
no suite: it certifies nothing while looking like proof. Stopping at a coherent boundary is the
correct outcome, not a failure — say so plainly rather than forcing it.

### 5. Refactor `sessionRunner.ts` — only if §3 succeeded

Same constraints as §2.

### Constraints (binding, from the recorded DDs)

- **Characterization tests MUST pass against the unmodified source** — verify explicitly and report
  it. This is the inverse of a regression test.
- **Verify the tests are load-bearing** by mutation: corrupt one pinned behaviour at a time and
  confirm exactly the test that pins it fails. A suite green on both sides by construction produces
  the same signal as one that constrains nothing.
- **No existing test file may be edited.** New files only.
- Every extracted helper ≤60 lines and ≤12 complexity; net warning count MUST fall.
- **`max-depth` and `no-unused-vars` MUST stay at ZERO** tree-wide.
- Refactor incrementally, running `npm run test --workspace=@finalrun/finalrun-agent` after each
  function.

### Out of scope

- The other 43 source warnings (`runDetailController.ts` 6, `Hierarchy.ts` 4, and the rest).
- The seven queued follow-ups (the `_trimmed` guard, the emulator output cap, #159's two dead
  constructs, `GrounderResponseConverter` characterization, `report-web` backfill, Dependabot, the
  `ci` memory-domain split).
- Promoting rules from `warn` to `error`.
- **Adding a DI seam to either file.**

## Affected Memory

Verify, do not assume. `docs/memory/cli/report-writer.md` **exists and documents `reportWriter`** —
this is the first change in a while where a memory file covers a refactored subject directly, so a
required update is likely. Hydrate MUST check every claim in it against the refactored source, and
`docs/memory/device-node/log-capture.md` also references `reportWriter`'s log-artifact handling.

If `sessionRunner` is stopped at §4, the recorded reason may itself be durable: the conditions under
which characterization is not achievable without a design change, and what such a change must argue.

## Impact

- **Added**: `packages/cli/src/test/reportWriter.test.ts`, and `sessionRunner.test.ts` if §3 succeeds.
- **Modified**: `packages/cli/src/reportWriter.ts`, and `sessionRunner.ts` if §5 is reached; likely
  `docs/memory/cli/report-writer.md`.
- **Risk**: high, and asymmetric. `reportWriter` is well-understood work on a file-I/O surface.
  `sessionRunner` may not be completable under the no-seam rule — §4 exists precisely so that
  discovering this is a clean outcome rather than a half-finished change.
- **Expected outcome**: warnings **89 → 82** if §4 stops after `reportWriter`, or **89 → 78** if both
  land. Tests **368 → 368 + N** (this change ADDS tests; the count must rise). `max-depth` and
  `no-unused-vars` still zero; no existing test edited.

## Open Questions

- How many characterization tests are enough? (No number — coverage of the §1 behaviours is the bar,
  judged at review; see Assumptions #6.)
- If `sessionRunner` stops, should the seam question be answered in the follow-up intake or deferred
  further? (Assumed: recorded in the follow-up's origin, decided there.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Take the characterization route, not batching | Both files are untested; batching relied on a safety net that does not exist here. #156 proved this route | S:90 R:85 A:95 D:95 |
| 2 | Certain | Order `reportWriter` first | It is tractable (pure file I/O, temp dirs suffice) and self-contained; `sessionRunner` is the uncertain half, so the uncertain work must come second | S:90 R:85 A:90 D:90 |
| 3 | Certain | Characterization tests must PASS pre-refactor — the inverse of a regression test | They prove equivalence, not a bug; conflating the two produces a worthless suite | S:90 R:85 A:95 D:95 |
| 4 | Certain | Do NOT add a DI seam to either file | The constitution's Test Integrity principle forbids reshaping implementation for test infrastructure; #156 rejected the same move | S:90 R:80 A:95 D:95 |
| 5 | Confident | Stop after `reportWriter` if `sessionRunner` needs a seam or contrived fakes | A suite whose fakes encode the refactor certifies nothing while looking like proof; 7 of 11 warnings at a coherent boundary beats 11 on a false net | S:75 R:75 A:85 D:75 |
| 6 | Confident | No fixed test count; the bar is the §1 behaviour list, judged at review | A number invites padding with assertions that pin nothing | S:70 R:80 A:85 D:75 |
| 7 | Certain | Mutation-verify that the tests are load-bearing | A characterization suite is green on both sides by construction, so "still green" is also what a suite constraining nothing produces — mutation is what separates them | S:85 R:85 A:90 D:90 |
| 8 | Confident | Look for a shared shape across `writeRunInputs`/`writeTestRecord`/`writeTestFailureRecord`/`finalize` before per-function extraction | Plausible sibling family; #159 and #160 both found real duplication only by reading a family together | S:70 R:75 A:80 D:70 |
| 9 | Certain | Pin any redaction in `writeRunInputs` | If secrets or env bindings are filtered before being written, that is a security-relevant contract — the same reasoning that made it mandatory in `cloud-core` | S:85 R:75 A:90 D:90 |
| 10 | Confident | A memory update is likely required, unlike recent changes | `docs/memory/cli/report-writer.md` documents a refactored subject directly, and `device-node/log-capture.md` references its log-artifact handling | S:80 R:85 A:85 D:85 |

10 assumptions (7 certain, 3 confident, 0 tentative, 0 unresolved).
