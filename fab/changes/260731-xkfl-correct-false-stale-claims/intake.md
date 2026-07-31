# Intake: Correct False and Stale Factual Claims

**Change**: 260731-xkfl-correct-false-stale-claims
**Created**: 2026-07-31

## Origin

One-shot `/fab-new` invocation with a fully-specified item list. The items come from an
independent adversarial review of PRs #168–#175, re-verified by the requester against main at
`91b2683`. The requester explicitly warned that **line numbers rot** — every location below must
be re-derived at apply time, never trusted from the numbers given. Raw input (abridged only where
it repeats these instructions):

> Correct false and stale factual claims across comments, docs and policy. This change is
> documentation and comment content only: do NOT change any runtime behaviour, do not rename
> anything, do not refactor. It is also the change that fixes errors THIS pipeline introduced, so
> accuracy matters more than speed. [Items 1–8 plus nice-to-haves — reproduced in full under
> "What Changes" below.] Finally, do NOT commit or git add fab/backlog.md — it is intentionally
> untracked reference scratch; note the git-pr expected-area guard would otherwise stage untracked
> files under fab/.

## Why

1. **Problem**: eight clusters of factual claims in comments, docs, and fab policy files are
   false or stale — some were false when written (fabricated/mislabelled measurements, citations
   of rules that say the opposite, used-by headers naming symbols that never existed in this
   repo), others rotted when later PRs moved the ground under them (line-number citations, a
   "planned" sweep that already shipped, a bookkeeping record for a merged change stuck at
   `review-pr: active`).
2. **Consequence if unfixed**: these files are the project's stated source of truth — policy
   files feed every future apply/review pass, and memory docs are declared authoritative
   (`docs/memory/index.md`). False claims propagate: an agent reading `code-quality.md` would cite
   a fabricated 67/18 ratio as precedent; one reading `code-review.md` might re-run a sweep that
   already merged as PR #171; the stuck `.status.yaml` makes a completed change look in-flight.
   Several of these errors were introduced by this very pipeline, so leaving them standing
   compounds the credibility cost.
3. **Approach**: a single docs/comments-only truth pass. Every correction is re-verified against
   the current tree before editing (measure counts, grep for symbols, read the code the citation
   points at). No runtime behaviour changes, no renames, no refactors. Accuracy over speed.

## What Changes

### Item 1 — `fab/project/code-quality.md` (§ Comments, CI-and-workflow paragraph, ~line 38)

The paragraph presents `.github/workflows/drivers.yml` as the canonical fully-compliant example
and cites "67 comment lines against 18 functional lines". **The figure is false and was never
true of the file**: measured, the file is 103 comment / 44 functional lines, identical at the
commit that wrote the claim. The 67/18 came from a mid-flight snapshot of an in-progress diff
(which had reached 69/17 by merge) — a diff measurement mislabelled as a property of the file.
The paragraph also self-contradicts: it states there is *no comment-to-code ratio cap because
density is not the test*, then offers a ratio as proof of compliance.

**Fix**: remove the numeric ratio entirely and let the deletion test carry the argument (the
requester's preferred option). If any figure is kept, it must state exactly what it measures and
be re-verified against the current file. Preserve the rest of the paragraph's content (ruleset
`14531661` / `build.gradle.kts:104` citations, the drivers.yml-vs-ci.yml paths-filter rationale).

### Item 2 — `fab/project/code-review.md` (§ Project-Specific Review Rules, ~line 60)

The sweep-scope bullet calls the restatement-comment sweep (~146 audit findings) "planned" and
"executed as a separate later change". That sweep **already shipped as PR #171**
(`260731-vxq1-comment-content-sweep`, merged commit `7b38afc`). **Fix**: rewrite to past tense
and reference the merged change/PR so nobody re-runs it. The scope rules themselves (rationale
claims out of scope, mixed-block handling) remain valid and stay.

### Item 3 — `packages/common/src/env.ts` (~line 9, re-export shim comment)

The comment claims the constitution's Test Integrity rule *forbids* editing the test to chase a
new import path. `fab/project/constitution.md` line 14 says the opposite on both halves: it
explicitly **permits** updating tests to match the spec, and it prohibits modifying
*implementation* code solely to accommodate test infrastructure — which is arguably what
retaining the re-export shim does. PR #172 also edited that very test file (added 5 tests),
disproving the comment's premise. **Fix**: correct the citation so the comment states the real
reason the shim is retained — consumer compatibility, *if verification confirms that is the
reason* (check actual importers of `env.ts` before writing it). Do not misattribute it to the
constitution. The shim itself stays (removing it would be a runtime change — out of scope).

### Item 4 — citation rot: `logger.ts:103-105` → current location

Two places cite `packages/common/src/logger.ts:103-105` for the unguarded sink loop:

- `packages/device-node/src/device/logWriteStream.ts` (~line 89) — note the request's path typo;
  this is the correct path, verified to exist
- `docs/memory/device-node/log-capture.md` (~line 167)

The loop is now at `logger.ts:99` (PR #171 deleted four one-line comments above it). The
substantive claim — the loop is unguarded — is **still true**; only the line reference rotted.
**Fix**: repoint both citations, and prefer a line-number-free anchor (e.g., function/method name
in `logger.ts`) since this exact citation has now rotted twice. Verify the loop's current
location and its unguardedness before rewriting.

### Item 5 — false used-by attributions naming symbols that do not exist

Five headers name consumers that exist nowhere in the codebase (they are Dart predecessor names —
`AIAgent.ts` line 1 says it replaces `FinalRunAgent.dart`):

| File | ~Loc | False symbol(s) |
|------|------|-----------------|
| `packages/common/src/constants.ts` | line 11 | `FinalRunAgent` |
| `packages/common/src/constants.ts` | line 153 | `HeadlessGoalExecutor` |
| `packages/common/src/models/Hierarchy.ts` | lines 2–3 | `FinalRunAgent`, `HeadlessActionExecutor` |
| `drivers/android/app/src/androidTest/java/app/finalrun/android/grpc/DriverServiceImpl.kt` | ~line 39 | "replaces `ActionProcessor`" |
| `drivers/android/app/src/androidTest/java/app/finalrun/android/grpc/GrpcDriverServer.kt` | ~line 13 | `WebSocketServerImpl` |

Path corrections verified: `DriverServiceImpl.kt` (not `.ts`), and **both** Kotlin files live
under `androidTest/` (the request said `grpc/GrpcDriverServer.kt` without a tree prefix;
`git ls-files` confirms `androidTest`). PR #170 deleted a fourth identical false header citing
exactly this falseness; PR #171 then edited both TS files and left these standing.

**Fix**: replace each false name with the real consumers, verified by grep at apply time.
Candidates named by the requester: goal-executor `AIAgent.ts`, `ai/schemas.ts`,
`ActionExecutor.ts`, `TestExecutor.ts` — verify, do not copy blindly. For the Kotlin files,
verify against actual referencing code (or drop the "replaces X" claim if no real predecessor
exists in-repo).

### Item 6 — `docs/memory/drivers/grpc-contract.md` (~lines 128–130, fps default)

The doc claims an omitted `fps` defaults to **1** and that the proto-documented **24** "is not
adopted". Per the requester (verify before rewriting): the gRPC `StartStreaming` path actually
defaults to **24** — see `GrpcDriverServer.swift` and `proto/finalrun/driver.proto` — and the
**1** belongs to the legacy WebSocket path. The doc contradicts both the code and the code's own
comment. **Fix**: rewrite the passage to attribute each default to its correct path, after
reading the Swift implementation and the proto.

### Item 7 — `docs/codebase-walkthrough.md` (pre-existing, five false claims)

Never touched by the recent work; carries:

1. "5 packages" when there are 7 (omits `cloud-core` and `local-runtime`)
2. A wrong `runTestCommand` line range
3. "18 action types" when there are 22
4. A table headed `packages/cli/src` listing six files that actually live in
   `packages/common/src`, with two functions miscredited
5. A path `packages/cli/src/checkRunner.ts` that does not exist (file is under
   `packages/common/src`)

**Fix**: correct all five, each re-verified with `find`/`git ls-files`/direct reads — counts
counted, line ranges re-derived, table paths and function attributions checked against the
actual files.

### Item 8 — pipeline bookkeeping: `fab/changes/260731-3vhw-delete-dead-code-audit-targets/.status.yaml`

Records `review-pr` as `active` with no `completed_at`, though the change merged as PR #170 (its
finishing commit was made locally after merge and never pushed). **Fix**: complete the record so
it reflects a finished pipeline. Prefer fab tooling with the change-name override
(e.g., `fab status finish 3vhw review-pr` — verify the exact stage state first with
`fab preflight 3vhw` / `fab status`); fall back to a careful direct YAML edit only if the tooling
refuses from this worktree.

### Nice-to-haves (do if cheap and verifiable, else skip)

- `packages/common/src/constants.ts` line 1: "only the subset used by CLI plus goal-executor plus
  device-node" — marginally overstated since PR #172 removed `env.ts`'s import of
  `REASONING_LEVELS`. Reword if the verified consumer set makes it easy.
- `packages/common/src/models/Hierarchy.ts` line 2: claims the Dart file is ~108KB — unverifiable
  (no Dart sources in this repo or its history). Drop the figure or mark it unverifiable.

### Constraints (apply to every item)

- **Docs and comment content only** — no runtime behaviour changes, no renames, no refactors.
- **Re-derive every location** — line numbers in this intake are hints, not addresses.
- **Verify before writing** — every replacement claim must be checked against the current tree;
  this change exists because unverified claims were written before.
- **Never commit or `git add` `fab/backlog.md`** — intentionally untracked reference scratch.
  (It does not currently exist in this worktree, but the git-pr expected-area guard stages
  untracked files under `fab/`, so the ship stage must exclude it explicitly if it appears.)

## Affected Memory

- `device-node/log-capture`: (modify) repoint the rotted `logger.ts:103-105` citation (Item 4) —
  content correction within the memory file itself
- `drivers/grpc-contract`: (modify) correct the fps-default attribution (gRPC StartStreaming = 24
  from proto; legacy WebSocket path = 1) per Item 6

No other memory files change: the remaining edits are source comments, fab policy files,
`docs/codebase-walkthrough.md`, and one `.status.yaml` — none alter spec-level behavior.

## Impact

- **fab policy**: `fab/project/code-quality.md`, `fab/project/code-review.md` — feed every future
  apply/review pass
- **Source comments** (content only): `packages/common/src/env.ts`, `constants.ts`,
  `models/Hierarchy.ts`; `packages/device-node/src/device/logWriteStream.ts`;
  `drivers/android/.../androidTest/.../grpc/DriverServiceImpl.kt`, `GrpcDriverServer.kt`
- **Docs**: `docs/memory/device-node/log-capture.md`, `docs/memory/drivers/grpc-contract.md`,
  `docs/codebase-walkthrough.md`
- **Pipeline state**: `fab/changes/260731-3vhw-.../.status.yaml`
- **Zero runtime impact**: no executable line changes; tests unaffected. Verification work reads
  `logger.ts`, `AIAgent.ts`, `ai/schemas.ts`, `ActionExecutor.ts`, `TestExecutor.ts`,
  `GrpcDriverServer.swift`, `proto/finalrun/driver.proto`, and the package tree, but does not
  modify them (except where an item explicitly targets them).

## Open Questions

- None — the request is fully specified, prescribes fix strategies per item, and grants
  discretion explicitly where wanted (nice-to-haves "if cheap and verifiable"; Item 4's durable
  anchor "consider").

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Item 1: remove the drivers.yml numeric ratio entirely rather than correcting it to 103/44 | Requester prescribed this as the preferred fix ("remove the numeric ratio entirely and let the deletion test carry the argument"); keeping a figure is allowed only with verified provenance | S:95 R:90 A:95 D:90 |
| 2 | Confident | Item 3: the shim-retention reason to write is consumer compatibility, contingent on verifying actual importers of `env.ts` at apply time | Requester hedged ("if that is the reason"); agent can resolve it mechanically by grepping importers before writing | S:80 R:85 A:80 D:70 |
| 3 | Confident | Item 4: switch both citations to a line-number-free anchor (function-level reference) instead of just repointing to `logger.ts:99` | Requester said "consider whether a line-number-free reference would be more durable, since this exact citation has now rotted twice" — strong signal toward durability; trivially reversible | S:75 R:90 A:85 D:75 |
| 4 | Certain | Item 5: both Kotlin files (`DriverServiceImpl.kt`, `GrpcDriverServer.kt`) live under `androidTest/`, and the `.ts`→`.kt` extension correction applies | Verified via `git ls-files` during intake; request's own path hints were partially wrong | S:90 R:95 A:100 D:95 |
| 5 | Confident | Item 5: replacement used-by names come from apply-time grep, using the requester's candidates (AIAgent.ts, ai/schemas.ts, ActionExecutor.ts, TestExecutor.ts) as hypotheses only | Requester: "which you must verify yourself"; grep is deterministic | S:85 R:85 A:90 D:80 |
| 6 | Certain | Item 8: use fab tooling (change-name override) to complete 3vhw's record; hand-edit `.status.yaml` only as fallback | Requester prescribed exactly this preference order | S:95 R:80 A:90 D:90 |
| 7 | Confident | Do both nice-to-haves (constants.ts line 1 wording, Hierarchy.ts 108KB figure) since both are one-line comment edits verifiable at apply time | "If cheap and verifiable" — both are; Hierarchy.ts figure handled by dropping or marking unverifiable per the stated options | S:80 R:90 A:85 D:75 |
| 8 | Certain | Ship stage must never stage `fab/backlog.md`; it is absent in this worktree today but the guard binds if it appears | Explicit user constraint; absence verified during intake | S:95 R:85 A:95 D:95 |
| 9 | Certain | Change type is `docs` (comment/doc content only, plus one bookkeeping YAML), despite "fix" wording in the description | The change alters no runtime behaviour by explicit constraint | S:90 R:90 A:95 D:90 |

9 assumptions (5 certain, 4 confident, 0 tentative, 0 unresolved).
