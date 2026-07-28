# Plan: Harden the CI Gate and Clear the Zero-Risk Backlog

**Change**: 260728-uloy-harden-gate-clear-safe-backlog
**Intake**: `intake.md`

## Requirements

### CI Gate: Typecheck stage

#### R1: The gate typechecks every workspace explicitly
`.github/workflows/ci.yml` MUST gain a typecheck stage after the build step. Every TypeScript workspace (`common`, `cloud-core`, `device-node`, `goal-executor`, `report-web`, `cli`) MUST carry a `typecheck` script running `tsc --noEmit -p tsconfig.json`, and the root `typecheck` script MUST invoke them via `npm run typecheck --workspaces` — deliberately **without** `--if-present`, so a workspace missing its `typecheck` script fails the run with a "Missing script" error, and `-p tsconfig.json` fails loudly (TS5058) if a tsconfig is deleted. The stage runs after build because dependent packages resolve `@finalrun/*` types from built `dist/` declarations.

- **GIVEN** an excess-property type error in a `report-web` test fixture (the exact #162 scenario)
- **WHEN** `npm run typecheck` runs
- **THEN** it exits non-zero reporting the error (build, test, and lint would all still pass)

- **GIVEN** all six packages in their current state
- **WHEN** `npm run typecheck` runs after a build
- **THEN** it exits 0

#### R2: Silent workspace skips are closed by explicit no-op scripts
The `--if-present` flag MUST be removed from the root `build` script, the root `test:workspaces` script, and the CI build step. To keep `packages/local-runtime` (tarball packaging, no `src/`) passing, it MUST gain explicit `build`, `test`, and `typecheck` scripts that print a plain statement of why there is nothing to do and exit 0. No blanket always-succeed shell fallback (`|| true`) anywhere. With `--if-present` gone, npm itself is the enforcer: a workspace that *loses* one of these scripts fails the run loudly instead of being skipped in silence.

- **GIVEN** a workspace whose `test` script has been removed (simulated)
- **WHEN** `npm run test:workspaces` runs
- **THEN** npm exits non-zero with a "Missing script" error naming the workspace

- **GIVEN** `packages/local-runtime` with its explicit no-op scripts
- **WHEN** build/test/typecheck run across workspaces
- **THEN** local-runtime prints its intentional no-op notice and exits 0

### goal-executor: dead-code removal

#### R3: `_runSingleDeviceAction`'s dead `failureMessage` parameter is removed
The `failureMessage` parameter of `_runSingleDeviceAction` (`packages/goal-executor/src/ActionExecutor.ts:771`) and the fallback-string argument at all ten call sites MUST be removed, **after** verifying deadness: `_executeDeviceAction` is the only producer of the consumed result and always substitutes `response.message ?? 'Action failed'`, so `result.error` is never nullish when `success` is false and `result.error ?? failureMessage` never evaluates its right operand.

- **GIVEN** the pre-change source with `failureMessage` replaced by a sentinel string (mutation)
- **WHEN** the goal-executor suite runs
- **THEN** all tests pass — proving no test (and no reachable path) observes the fallback strings

#### R4: `_retryLLMAttempts`' dead terminal-throw expression is simplified
In `packages/goal-executor/src/ai/AIAgent.ts`, the loop-exit `throw lastError ?? new Error(exhaustedMessage)` is unreachable (the loop always returns or throws on attempt `MAX_LLM_ATTEMPTS`, and `MAX_LLM_ATTEMPTS = 2 ≥ 1`). This is a SIMPLIFICATION, not a statement deletion: TypeScript still needs a terminal throw. The `exhaustedMessage` parameter and its two call-site literals MUST be removed, along with the now write-only `lastError` variable (a write-only variable would violate the `no-unused-vars` ZERO invariant). The terminal throw becomes `throw new Error(\`${label.name} failed after all retry attempts\`)` — byte-identical to the removed literals if the branch were ever reachable.

- **GIVEN** the pre-change source with the terminal throw replaced by a sentinel error (mutation)
- **WHEN** the goal-executor suite runs
- **THEN** all tests pass — proving the expression's identity is unobservable

### report-web: dead-code removal

#### R5: `formatRelativeTime`'s dead clamp is removed
The `Math.max(0, …)` wrapper at `packages/report-web/src/ui/viewModel.ts:240` MUST be removed after verifying deadness analytically (a negative delta floors to a negative `totalMinutes`, which is `< 1` → `'just now'`, identical to the clamped path; `Math.max(0, NaN)` is `NaN`, so the NaN path is also identical) and by mutation (removing it leaves the suite green). ONLY line 240 is touched — the `Math.max(0, …)` at `viewModel.ts:254` and the uses in `runDetailController.ts` are NOT flagged and MUST stay.

- **GIVEN** a timestamp in the future of the frozen clock
- **WHEN** `formatRelativeTime` runs without the clamp
- **THEN** it still returns `'just now'` (pinned by the existing frozen-clock test)

#### R6: `parseDeviceLogLines`' dead empty-string guard is removed
The `if (!logText) return [];` guard at `packages/report-web/src/ui/logs.ts:56` MUST be removed after verifying deadness: `logText` is typed `string`, and `''.split('\n')` yields `['']` whose single empty line the `line.length === 0` filter drops — so `''` produces `[]` with or without the guard (pinned by the existing `returns [] for empty input` test).

- **GIVEN** `parseDeviceLogLines('')`
- **WHEN** the guard is removed
- **THEN** the result is still `[]` and the existing test stays green

### Test pins

#### R7: The spec-zip-before-app-zip unlink order is pinned
`packages/cloud-core/src/test/submit.test.ts` MUST gain a test that records the *sequence* of temp-zip unlinks on a success path with a `.app` bundle (spy on `fs.unlinkSync`, delegating to the real implementation, restored in `finally`) and asserts the spec zip (`finalrun-cloud-*`) is unlinked strictly before the temp app zip (`finalrun-app-*`). The pin MUST be mutation-verified: reordering the two `finally` releases in `submit.ts` fails exactly this assertion; the four existing set-based tmpdir-snapshot assertions cannot see the swap.

- **GIVEN** `submitRun` succeeding with a `.app` bundle
- **WHEN** both temp zips are cleaned up
- **THEN** the recorded unlink sequence is `[finalrun-cloud-*, finalrun-app-*]`

#### R8: Four boundary values are pinned in report-web
Each new assertion MUST be mutation-verified (corrupt, confirm exactly that assertion fails, revert):
1. `formatLongDuration(1600)` is `'2s'` — kills `Math.round`→`Math.floor` (1400/499 behave alike under both).
2. `formatVideoTimestamp(1900)` is `'00:01'` — kills `Math.floor`→`Math.round` (1499 rounds the same either way).
3. `formatRelativeTime` at 23h is `'23h'` and at exactly 24h is `'1d'` — kills the 24→12 boundary mutation.
4. `resolveStepReasoning` returns `thought.think` when BOTH `think` and `plan` differ from the title — kills a think/plan precedence swap (the existing test's `think` equals the title, so it passes under either order).

- **GIVEN** each of the four mutations applied one at a time
- **WHEN** the report-web suite runs
- **THEN** exactly the corresponding new assertion fails, and the suite is green once reverted

### Memory

#### R9: `docs/memory/ci/pr-quality-gate.md` is updated and re-indexed
The "PR CI gate stages" requirement MUST gain the typecheck stage; the **Coverage boundary** paragraph and the *"a type error clears every stage of the gate"* scenario (both deliberately falsified by R1) MUST be replaced/inverted; the `--if-present` half of the paragraph MUST reflect R2's landed mechanism. The frontmatter description MUST stop claiming the gate "never typechecks". `fab memory-index` MUST be run and `fab memory-index --check` MUST exit 0.

- **GIVEN** the updated memory file
- **WHEN** `fab memory-index --check` runs
- **THEN** it exits 0 and no memory text still claims the gate does not typecheck or skips silently

### Non-Goals

- The six error-path behaviour fixes (`_trimmed` guard, emulator output cap, `getPlatform()`, `adbPath!`, timeout mismatch, acquisition-side orphan) — each changes behaviour and needs its own change.
- Dependabot, the `ci` memory-domain split, a DOM test environment, `GrounderResponseConverter` characterization.
- The 44 remaining source warnings; promoting lint rules to `error`.
- Any behaviour change — an item that turns out to change behaviour is dropped and recorded.

### Design Decisions

#### Explicit no-op scripts + dropped `--if-present`, not an allow-list checker
**Decision**: Close the silent-skip gap by giving `local-runtime` explicit no-op `build`/`test`/`typecheck` scripts and removing `--if-present` from every workspace-wide invocation, so npm itself fails loudly on a missing script.
**Why**: Zero new code to maintain — the enforcement mechanism is npm's own missing-script error, which cannot drift, and the intentional no-op is declared in the one place a reader looks (`local-runtime/package.json`) with a message that prints on every run. A new workspace is automatically covered: it must declare all three scripts or the gate fails.
**Rejected**: An allow-list checked by a small script — a second file to keep in sync with the workspace list, a new script to review, and the allow-list itself can drift stale; `|| true` fallbacks — banned by intake, they swallow real failures.
*Introduced by*: 260728-uloy-harden-gate-clear-safe-backlog

#### Typecheck runs `tsc --noEmit -p tsconfig.json` per package, via `--workspaces` without `--if-present`
**Decision**: Each TS package owns a `typecheck` script (`tsc --noEmit -p tsconfig.json`); the root fans out with `npm run typecheck --workspaces`.
**Why**: Explicit `-p` fails loudly (TS5058) when a tsconfig is missing; the workspace fan-out (without `--if-present`) fails loudly when a script is missing; per-package scripts keep the check runnable locally in one package. The per-package `tsconfig.json` includes test files, so the stage covers them too — newly for `report-web`, redundantly for the five `tsc`-building packages whose builds already typechecked their tests. The redundancy is deliberate: it makes the coverage explicit rather than a build-tool by-product.
**Rejected**: A root-level chain of six `tsc -p packages/…` invocations — a seventh package added later would be silently absent from the chain, recreating the accidental-coverage problem this change exists to fix; `npm run typecheck --workspaces --if-present` — reintroduces the silent-skip gap §2 closes.
*Introduced by*: 260728-uloy-harden-gate-clear-safe-backlog

## Tasks

### Phase 1: Setup

- [x] T001 Record the pre-change baseline: `npm run build --workspaces --if-present`, `npm run test:workspaces` (per-package counts), `npm run lint` (warning count), and `tsc --noEmit -p` over all six packages <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 Add `typecheck` scripts (`tsc --noEmit -p tsconfig.json`) to `packages/{common,cloud-core,device-node,goal-executor,report-web,cli}/package.json`, a root `typecheck` script (`npm run typecheck --workspaces`) in `package.json`, and a "Typecheck all workspaces" step after build in `.github/workflows/ci.yml` <!-- R1 -->
- [x] T003 Add explicit no-op `build`/`test`/`typecheck` scripts to `packages/local-runtime/package.json`; drop `--if-present` from root `build` and `test:workspaces` scripts and from the CI build step <!-- R2 -->
- [x] T004 Verify deadness (sentinel mutation + suite green), then remove the `failureMessage` parameter from `_runSingleDeviceAction` and the string argument from all ten call sites in `packages/goal-executor/src/ActionExecutor.ts` <!-- R3 -->
- [x] T005 Verify unreachability (sentinel mutation + suite green), then simplify `_retryLLMAttempts` in `packages/goal-executor/src/ai/AIAgent.ts`: remove `exhaustedMessage` param + both call-site literals + write-only `lastError`; terminal throw becomes `` new Error(`${label.name} failed after all retry attempts`) `` <!-- R4 -->
- [x] T006 [P] Verify deadness (analytic + mutation), then remove the `Math.max(0, …)` clamp at `packages/report-web/src/ui/viewModel.ts:240` only <!-- R5 -->
- [x] T007 [P] Verify deadness (analytic + mutation), then remove the `if (!logText) return [];` guard at `packages/report-web/src/ui/logs.ts:56` <!-- R6 -->

### Phase 3: Integration & Edge Cases

- [x] T008 Add the unlink-order pin to `packages/cloud-core/src/test/submit.test.ts` (fs.unlinkSync spy, sequence assertion); mutation-verify by reordering the two `finally` releases in `submit.ts`, confirm exactly the new assertion fails, revert <!-- R7 -->
- [x] T009 Add the four boundary pins (`formatLongDuration(1600)` in `packages/report-web/src/ui/test/format.test.ts`; `formatVideoTimestamp(1900)`, `formatRelativeTime` 23h/24h, and the think-before-plan precedence test in `packages/report-web/src/ui/test/viewModel.test.ts`); mutation-verify each individually <!-- R8 -->

### Phase 4: Polish

- [x] T010 Update `docs/memory/ci/pr-quality-gate.md` (frontmatter description, stage list, Coverage boundary paragraph, inverted type-error scenario, `--if-present` half); run `fab memory-index` and verify `fab memory-index --check` exits 0 <!-- R9 -->
- [x] T011 Full verification: build exit 0; `npm run typecheck` exit 0 for all workspaces; `npm run test:workspaces` exit 0 with count > 458 (per-package counts); `npm run lint` ≤ 78 warnings / 0 errors / `max-depth`+`no-unused-vars` zero; injected-type-error proof (fails, then passes after revert); lost-test-script proof (reported, not skipped); `git diff --numstat` touches no unrelated file <!-- R1 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: Six per-package `typecheck` scripts + root `typecheck` script exist; `.github/workflows/ci.yml` runs the typecheck stage after build; no `--if-present` anywhere on the typecheck path — **verified**: verified: cli/cloud-core/common/device-node/goal-executor/report-web each carry `tsc --noEmit -p tsconfig.json`; root `typecheck` = `npm run typecheck --workspaces`; ci.yml step sits between build and test
- [x] A-002 R2: `--if-present` is gone from root `build`, root `test:workspaces`, and the CI build step; `local-runtime` carries explicit no-op `build`/`test`/`typecheck` scripts; no `|| true` anywhere — **verified**: verified: no `--if-present` and no `|| true` anywhere in package.json/workflows/scripts; local-runtime no-ops print and exit 0 in all three fan-outs
- [x] A-003 R3: `_runSingleDeviceAction` has no `failureMessage` parameter and no call site passes a fallback string — **verified**: verified: all 10 call sites pass 2 args; `_runSingleDeviceAction(action, traceStep)`
- [x] A-004 R4: `_retryLLMAttempts` has no `exhaustedMessage` parameter, no `lastError` variable, and still ends in a terminal throw; both call sites dropped their message literal — **verified**: verified: terminal throw is `` new Error(`${label.name} failed after all retry attempts`) ``, byte-identical to both removed literals
- [x] A-005 R5: `viewModel.ts` `formatRelativeTime` computes `deltaMs` without a clamp; `viewModel.ts:254` and `runDetailController.ts` `Math.max(0, …)` uses are untouched — **verified**: verified: the sole surviving clamp is `viewModel.ts:256` (formatVideoTimestamp); `runDetailController.ts` has zero diff
- [x] A-006 R6: `logs.ts` `parseDeviceLogLines` has no `!logText` guard and the empty-input test still passes — **verified**: verified: the only in-repo caller (`TestDetailSection.tsx:123`) coerces with `?? ''`
- [x] A-007 R7: The unlink-order test exists and asserts sequence (`finalrun-cloud-*` strictly before `finalrun-app-*`) — **verified**: verified by reviewer mutation — see A-013
- [x] A-008 R8: All four boundary assertions exist (1600→'2s'; 1900→'00:01'; 23h→'23h' and 24h→'1d'; think-before-plan) — **verified**: verified by reviewer mutations — see A-014
- [x] A-009 R9: `pr-quality-gate.md` documents the typecheck stage, carries the inverted scenario, reflects the landed `--if-present` mechanism, and `fab memory-index --check` exits 0 — **verified**: `fab memory-index --check` exit 0 (soft-cap size warning only). One overstated rationale clause flagged should-fix (line 166)

### Behavioral Correctness

- [x] A-010 R1: Injected type error in a `report-web` test fixture makes `npm run typecheck` exit non-zero; after revert it exits 0 (both directions quoted) — **verified**: reviewer-reproduced: TS2353 at `viewModel.test.ts(348,89)`, `npm run typecheck` exit 2; exit 0 after revert. Also probed a `packages/common/src` error post-build (TS2322, exit 2) to rule out an incremental/tsbuildinfo false green
- [x] A-011 R2: Simulating a workspace losing its `test` script makes `npm run test:workspaces` fail with a "Missing script" error (reported, not skipped); reverted afterwards — **verified**: reviewer-reproduced: `npm run test:workspaces` exit 1, `Missing script: "test"` naming `@finalrun/report-web`

### Removal Verification

- [x] A-012 R3: Each of the four removals was verified dead BEFORE deletion (sentinel mutation and/or analytic proof recorded), and the full suite is green after removal with zero test-file edits for R3–R6 — **verified**: reviewer re-verified independently: nullish-`result.error` sentinel in `_runSingleDeviceAction` and a sentinel loop-exit throw in `_retryLLMAttempts` both never fired across goal-executor (67) + cli (150); analytic proofs hold (single private producer always assigns; loop throws at `attempt >= MAX_LLM_ATTEMPTS`). No test file changed for R3–R6

### Scenario Coverage

- [x] A-013 R7: Reordering the two `finally` releases in `submit.ts` fails exactly the new order assertion (mutation applied, observed, reverted) — **verified**: reviewer-reproduced: moving the app-zip release into the inner finally fails exactly `the spec zip (inner finally) is unlinked first` while `submitRun zips a .app directory ... removes both temp zips on success` stays green
- [x] A-014 R8: Each of the four mutations fails exactly its corresponding new assertion (four runs, each observed and reverted) — **verified**: reviewer-reproduced: round→floor ⇒ 1s vs 2s; floor→round ⇒ 00:02 vs 00:01; `<24`→`<12` ⇒ 0d vs 23h; `<24`→`<25` ⇒ 24h vs 1d; think/plan swap ⇒ wrong candidate

### Edge Cases & Error Handling

- [x] A-015 R1: A deleted per-package tsconfig or missing `typecheck` script fails the typecheck stage loudly (TS5058 / npm "Missing script"), never a silent skip — **verified**: reviewer-reproduced: removed tsconfig ⇒ `error TS5058: The specified path does not exist: 'tsconfig.json'`; removed `typecheck` script ⇒ npm exit 1 `Missing script: "typecheck"`

### Code Quality

- [x] A-016 Pattern consistency: New test code follows the existing suites' stub-and-restore-in-finally and frozen-clock patterns; scripts follow existing package.json conventions — **verified**: verified: stub-and-restore-in-`finally` and frozen-clock patterns match the surrounding suites
- [x] A-017 No unnecessary duplication: The unlink spy reuses the existing `tempZipArtifacts`/`installFetchStub` helpers; no new runner or checker script is introduced — **verified**: verified: reuses `makeTempDir`/`makeInput`/`installFetchStub`/`okResponse`; no new runner or checker script

## Notes

### One removal has an external-consumer caveat

`parseDeviceLogLines` (`report-web/src/ui/logs.ts`) is re-exported through the **published**
`@finalrun/report-web/ui` barrel, and this change removed its `if (!logText) return [];` guard.

In-repo the removal is provably safe: the sole caller, `TestDetailSection.tsx:123`, coerces with
`?? ''`, and `logText` is typed `string`. Under that declared contract this is not a behaviour
change, which is why it qualified for a non-behavioural change.

But an **untyped external consumer** passing `undefined` now gets a `TypeError` where it previously
got `[]`. If the `ui` barrel is treated as a stable public API, that is a semantic change at the
package boundary even though it is not one under the type contract. Recorded so the decision is
visible rather than implicit: the guard was removed because it is unreachable *given the declared
types*, not because no caller could ever pass a non-string.

If the barrel is meant to tolerate untyped callers, the guard should come back — as a deliberate
input-validation decision with a test, not as dead code.

### Deferred (unchanged from intake)

The six error-path behaviour fixes, Dependabot, the `ci` memory-domain split (now ~38KB against a
~15KB soft cap), a DOM test environment, and `GrounderResponseConverter` characterization all remain
queued.


- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Typecheck fan-out is `npm run typecheck --workspaces` (no `--if-present`) over per-package `tsc --noEmit -p tsconfig.json` scripts | Explicit `-p` fails loudly on a missing tsconfig, npm fails loudly on a missing script, and a future workspace is auto-covered — satisfies the intake's "explicit invocation that fails loudly" without a checker script | S:85 R:90 A:90 D:85 |
| 2 | Confident | §2 mechanism: explicit no-op scripts in `local-runtime` + drop `--if-present` everywhere, npm as enforcer | Intake left the mechanism open with two named options; this is the "simplest to read, hardest to drift" one — no new checker script, and the intentional skip is named in the package itself | S:70 R:85 A:85 D:70 |
| 3 | Certain | `local-runtime` also gets a no-op `typecheck` script | It has no TypeScript and no tsconfig; one uniform mechanism covers all three workspace-wide stages | S:80 R:90 A:90 D:85 |
| 4 | Certain | The simplified terminal throw message is `` `${label.name} failed after all retry attempts` `` | Byte-identical to both removed call-site literals ('Planner/Grounder failed after all retry attempts') if the unreachable branch ever fired — zero behaviour delta even in the impossible case | S:80 R:90 A:90 D:85 |
| 5 | Certain | `lastError` is removed entirely, not just the `??` | After the simplification it would be write-only, which `no-unused-vars` flags — violating the ZERO invariant the change must preserve | S:80 R:90 A:95 D:90 |
| 6 | Confident | Unlink order is observed by a delegating spy on `fs.unlinkSync` (restored in `finally`), not a seam | Observation-only wrapper of a module the suite already exercises for real; consistent with the characterize-around-the-absent-seam memory decision (no implementation reshaping) | S:70 R:85 A:80 D:70 |
| 7 | Confident | Root `build` script drops `--if-present` too (not only the CI step) | `release.yml` builds per-workspace explicitly so it is unaffected; keeping root and CI consistent avoids the gap surviving in local `npm run build`/`npm test` | S:65 R:85 A:85 D:75 |
| 8 | Certain | Boundary pin values: 1600→'2s', 1900→'00:01', 23h→'23h' + 24h→'1d', both-differ think/plan step | Each value is chosen so exactly one mutation class is killed and verified by running that mutation | S:85 R:90 A:90 D:90 |

8 assumptions (5 certain, 3 confident, 0 tentative).
