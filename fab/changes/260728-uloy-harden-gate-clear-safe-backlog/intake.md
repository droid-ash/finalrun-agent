# Intake: Harden the CI Gate and Clear the Zero-Risk Backlog

**Change**: 260728-uloy-harden-gate-clear-safe-backlog
**Created**: 2026-07-28

## Origin

Thirteenth change in the code-quality initiative, and the first aimed at the **initiative's own
infrastructure** rather than at warnings.

Two things prompted it. First, #162 established empirically that **the gate this initiative built
does not typecheck**: an excess-property type error injected into a `report-web` test fixture passed
`npm run build`, `npm test` *and* `npm run lint`; only `tsc -p packages/report-web/tsconfig.json`
caught it, and nothing invokes that. Second, the deferred-follow-up queue has grown every change for
five consecutive changes — a triage found **16 open items**, not the ten previously reported.

> User direction: asked which of four options to take next, the user chose "1 and 2" — the typecheck
> stage and draining the deferred queue — and asked for them planned together via `/fab-new`.

**Scope was narrowed by agreement.** The queue is not one coherent unit: it spans infra gaps,
pure deletions, additive test assertions, six behaviour-changing error-path fixes, and four separate
decisions (Dependabot, the `ci` memory split, a DOM test environment, `GrounderResponseConverter`
characterization). Presented with that triage, the user chose **gate hardening plus the
zero-behaviour-change backlog**, leaving the six error-path fixes and the four decisions as
follow-ups. Every item below is therefore either infrastructure or provably non-behavioural, so one
review can certify the whole change.

Also corrected during triage: three items previously listed as open are already done — the app-zip
cleanup window (fixed in #157), the temp-filename collision (#158), and `artifacts.ts`'s half-pin
(fixed inside #162's own review response).

## Why

**Problem 1 — the gate has two coverage holes.** It runs `npm ci` → build → test → lint. Neither
step typechecks in the one package where building does not imply typechecking, and both the build and
test steps use `--if-present`, so a workspace with no `test` script is skipped in silence.

**Problem 2 — the backlog is compounding.** Each deferral was individually correct, and three became
proper fixes with regression tests. But nothing is scheduled to absorb them, and the safe ones —
dead code and missing assertions — are cheap now and only get more confusing later. Dead code in
particular contradicts principle 3 (YAGNI), which this initiative reports as complete at zero
`no-unused-vars` violations; that metric does not catch a dead *parameter* or an unreachable
*branch*.

**Consequence if not fixed.** A type error in `report-web` reaches `main` with a green gate — the
package has 57 tests and none of them typecheck. And the "YAGNI: done" claim is slightly false while
four provably-dead constructs sit in the tree.

## What Changes

### 1. Add a typecheck stage to the gate

No `typecheck` script exists anywhere today. Add one and wire it into `.github/workflows/ci.yml`
after build.

**The design constraint that matters.** Only `report-web` sets `noEmit: true`; the other five
packages typecheck as a *side effect* of building with `tsc` over `include: ["src/**/*"]`. So the
minimum fix is `report-web` alone — but prefer typechecking **all** packages explicitly, because the
current coverage is accidental: any package that later switches to `tsup`/`vite`/`esbuild` would
silently lose typechecking exactly as `report-web` did, with nothing to notice.

**Do NOT wire it with `npm run typecheck --workspaces --if-present`** — that reintroduces the very
silent-skip gap §2 closes. Use an explicit invocation that fails loudly when a package is missing
its script or its tsconfig.

**Expect this to surface pre-existing type errors.** `report-web`'s `tsconfig.json` reportedly passes
clean, but no package's *test* files have ever been typechecked under a `--noEmit` pass. If errors
appear, fix them — but if a fix would be a behaviour change rather than a type correction, stop and
record it instead; this change is non-behavioural by construction.

### 2. Close the `--if-present` silent-skip gap

`test:workspaces` (and the build step) skip a workspace with no `test` script without comment.
`packages/local-runtime` — a tarball-packaging workspace with no `src/` — is the standing instance,
and a package that *lost* its `test` script would be indistinguishable from it.

Make the skip **explicit rather than silent**: an intentional no-test workspace should be named
somewhere the gate can check, so an unintentional one is reported. The mechanism is open — an
allow-list checked by a small script is one option; another is giving `local-runtime` a `test` script
that states plainly it has nothing to test and exits 0. Prefer whichever is simplest to read and
hardest to drift. **Do not use a blanket `|| true`.**

### 3. Remove four provably-dead constructs

Each was found by a review mutation surviving — i.e. corrupting it changed nothing observable.

| Site | What is dead | Found in |
|------|--------------|----------|
| `goal-executor/src/ActionExecutor.ts:771,775` | `_runSingleDeviceAction`'s `failureMessage` parameter — `_executeDeviceAction` already substitutes `'Action failed'`, so `result.error` is never nullish and none of the ten per-action fallback strings can be emitted | #159 |
| `goal-executor/src/ai/AIAgent.ts:312` | `throw lastError ?? new Error(exhaustedMessage)` — the attempt loop always returns or throws on the last attempt (`MAX_LLM_ATTEMPTS = 2`), so `lastError` and the `exhaustedMessage` parameter are dead | #159 |
| `report-web/src/ui/viewModel.ts:240` | the `Math.max(0, …)` clamp in `formatRelativeTime` — unreachable | #162 |
| `report-web/src/ui/logs.ts:56` | the `if (!logText) return [];` guard in `parseDeviceLogLines` — unreachable | #162 |

**Verify each is dead before deleting it** — do not take the prior finding on trust. TypeScript still
needs a terminal throw at `AIAgent.ts:312`, so that one is a simplification of the expression, not a
deletion of the statement. Note `viewModel.ts` has several other `Math.max(0, …)` uses (`:254`, and
more in `runDetailController.ts`) that are **not** flagged — touch only `:240`.

### 4. Add the two missing test pins

- **Unlink order** (`cloud-core/src/test/submit.test.ts`): spec-zip-before-app-zip is guaranteed by
  JS `finally` semantics and was confirmed empirically in #157, but all four tmpdir-snapshot
  assertions compare final *sets*, not sequence. Pin the order so nobody later assumes it is tested.
- **Four boundary values** (`report-web`): `formatLongDuration`'s round-up (`Math.round`→`Math.floor`
  survives, because 1400 and 499 behave alike — needs e.g. 1600→`'2s'`); `formatVideoTimestamp`
  truncation (1499 rounds the same either way); `formatRelativeTime`'s 24h→day boundary (24→12
  survives); `resolveStepReasoning`'s `think`-before-`plan` precedence.

**Each new assertion MUST be mutation-verified** — corrupt the behaviour, confirm exactly that
assertion fails, revert. An assertion that cannot fail is worse than none, and these four exist
precisely because the originals could not.

### Out of scope

- **The six error-path behaviour fixes**: `SimctlClient._trimmed` type-safety guard; the
  `_spawnEmulatorWithCapture` output cap; `sessionRunner`'s `getPlatform()` swap and `adbPath!`
  guard; the `FINALRUN_SUBMIT_TIMEOUT_MS` message/parser mismatch; the acquisition-side orphan in
  `writeZip`/`statSync`. Each changes behaviour and needs its own test.
- **The four separate decisions**: Dependabot (4 frozen CVEs), the `ci` memory-domain split (~35KB
  against a ~15KB soft cap), a DOM test environment (would unlock `report-web`'s 14 warnings),
  `GrounderResponseConverter` characterization (2 warnings).
- The 44 remaining source warnings, and promoting rules from `warn` to `error`.
- **Any behaviour change.** If an item turns out to change behaviour, drop it and record why.

## Affected Memory

**Required.** `docs/memory/ci/pr-quality-gate.md` § "PR CI gate stages" carries a **Coverage
boundary** paragraph and a scenario (*"a type error clears every stage of the gate"*) written in
#162. This change falsifies both — deliberately, since closing that hole is the point. The
requirement must gain the typecheck stage, the scenario must be replaced or inverted, and the
`--if-present` half of the same paragraph must reflect whatever §2 lands.

Hydrate should also check whether the dead-code removals touch anything documented in
`docs/memory/report-web/renderers.md` or the `goal-executor`-related entries.

## Impact

- **Modified**: `.github/workflows/ci.yml`, root and/or per-package `package.json` (a `typecheck`
  script), `packages/goal-executor/src/{ActionExecutor,ai/AIAgent}.ts`,
  `packages/report-web/src/ui/{viewModel,logs}.ts`, `packages/cloud-core/src/test/submit.test.ts`,
  `packages/report-web/src/ui/test/*.test.ts`, `docs/memory/ci/pr-quality-gate.md`.
- **Risk**: low by construction — every item is infra or provably non-behavioural. The two real risks
  are (a) the typecheck stage surfacing pre-existing errors whose fix would be a behaviour change
  (handle by recording, not forcing), and (b) deleting something only *believed* dead, addressed by
  §3's verify-before-deleting rule.
- **Expected outcome**: tests **458 → 458 + ~5**; warnings **78 or fewer** (the dead-code removals may
  clear a line or two but none of these functions is currently flagged, so expect **78 unchanged**);
  `max-depth`/`no-unused-vars` still zero; a new CI stage that fails on a type error.

## Open Questions

- Typecheck all six packages or only `report-web`? (Assumed all — see Assumptions #2.)
- Which mechanism for the `--if-present` gap? (Deliberately left open — see Assumptions #4.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is gate hardening + the zero-behaviour-change backlog only | User chose this from a four-way triage; the six error-path fixes and four decisions stay queued | S:95 R:85 A:90 D:95 |
| 2 | Confident | Typecheck all packages explicitly, not just `report-web` | The other five typecheck only as a build side-effect; a future switch to `tsup`/`vite` would silently lose it exactly as `report-web` did | S:75 R:85 A:85 D:80 |
| 3 | Certain | Do NOT wire typecheck via `--workspaces --if-present` | That reintroduces the exact silent-skip gap §2 exists to close | S:90 R:85 A:95 D:95 |
| 4 | Confident | The `--if-present` mechanism is left to apply, with constraints | Several reasonable shapes (allow-list, explicit no-op script); the binding requirements are that an unintentional skip is reported and that no blanket always-succeed shell fallback is used | S:65 R:85 A:80 D:65 |
| 5 | Certain | Verify each dead construct is dead before removing it | All four come from prior reviews' surviving mutations; re-confirm rather than trust, since a wrong deletion is a behaviour change | S:90 R:75 A:90 D:90 |
| 6 | Certain | `AIAgent.ts:312` is a simplification, not a statement deletion | TypeScript needs a terminal throw there; only `lastError ??` and the `exhaustedMessage` parameter are dead | S:85 R:85 A:95 D:90 |
| 7 | Certain | Touch only `viewModel.ts:240`'s `Math.max(0, …)` | Several other `Math.max(0, …)` uses exist in `viewModel.ts` and `runDetailController.ts` and are NOT flagged as dead | S:90 R:85 A:95 D:95 |
| 8 | Certain | Every new assertion must be mutation-verified | These four exist precisely because the originals could not fail; an assertion that cannot fail is worse than none | S:90 R:85 A:95 D:95 |
| 9 | Confident | Expect the typecheck stage to surface pre-existing errors; fix type errors, record behaviour changes | No package's test files have been typechecked under `--noEmit`. A fix that changes behaviour violates this change's premise | S:70 R:75 A:85 D:75 |
| 10 | Certain | The memory update is REQUIRED | `pr-quality-gate.md`'s Coverage-boundary paragraph and its type-error scenario are deliberately falsified by §1 | S:90 R:85 A:95 D:95 |

10 assumptions (7 certain, 3 confident, 0 tentative, 0 unresolved).
