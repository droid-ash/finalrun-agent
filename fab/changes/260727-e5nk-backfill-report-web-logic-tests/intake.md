# Intake: Close the Last Zero-Coverage Package — `report-web` Logic Tests

**Change**: 260727-e5nk-backfill-report-web-logic-tests
**Created**: 2026-07-27

## Origin

Twelfth change in the code-quality initiative. After eleven changes, `report-web` is the **only
package in the repo with zero tests** — 25 source files, none covered — and it is the last
outstanding piece of the initiative's original goal of "supporting proper TDD".

Every other package has been closed out: `cloud-core` went 0 → 18 tests in #156, `cli`'s two untested
giants were characterized in #161, and `device-node`/`goal-executor` were batched against existing
coverage in #159/#160. `report-web` kept being deprioritised because it is a UI package and the
others offered a better warnings-per-change return.

> User direction: offered four options — `report-web` backfill, draining the deferred queue, a
> long-tail warning sweep, or promoting rules to `error` — the user chose the backfill: "yes, start".

## A correction to the stated value of this change

**I told the user this backfill would "unlock report-web's 14 warnings". That was wrong**, and the
measurement is unambiguous:

| Warning site | Warnings | DOM-dependent? |
|--------------|----------|----------------|
| `ui/client/runDetailController.ts` | 6 | **yes** — 70 DOM references |
| `ui/pages/RunIndexView.tsx` | 2 | yes (React component) |
| `ui/pages/RunDetailView.tsx` | 2 | yes |
| `ui/components/TestDetailSection.tsx` | 2 | yes |
| `ui/components/VideoPanel.tsx` | 1 | yes |
| `ui/components/DeviceLogPanel.tsx` | 1 | yes |

**All 14 are behind a DOM barrier.** The DOM-free logic modules this change can test carry **zero**
warnings. So this change clears **no warnings** — 78 before, 78 after.

What it does deliver is the thing the original goal actually asked for: the last package with no
tests gets tests, and graduates from the tolerant test runner to the strict one, so "zero test files"
becomes a hard error there as it already is everywhere else.

Unlocking the 14 requires a DOM test environment (`jsdom` or `happy-dom`) and probably a React
testing library — **new runtime dependencies and a testing-infrastructure decision**, which deserves
its own change with its own argument. Recorded as the follow-up (see Out of Scope).

## Why

**Problem.** `report-web` renders every local test report a user reads. Its view-model layer decides
what a run's status is, which failure surfaces first, how durations and log lines are formatted, and
which artifacts resolve — and none of it is verified. `viewModel.ts` alone is 289 lines of pure
decision logic with no test.

**Consequence if not fixed.** A regression here misreports results: a user sees a run marked passed
that failed, or a failure attributed to the wrong step. That is worse than a crash, because it is
silent and believed. The package is also the last one where the CI gate's promise is hollow — its
tolerant runner exits 0 on "no test files", so the gate cannot fail on `report-web` no matter what
changes.

**Why the pure-logic subset is the right first cut.** It needs no new dependencies, it covers the
layer where a silent misreport would originate, and it is a coherent, shippable boundary. The DOM
half is a genuinely different problem — dependency choice, environment setup, component-testing
conventions — and mixing it in would make both halves harder to review.

## What Changes

### 1. Test the seven DOM-free modules (542 lines, zero DOM references — verified)

| Module | Lines | Notes |
|--------|-------|-------|
| `ui/viewModel.ts` | 289 | the substance — run/test status derivation, failure selection, summary shaping |
| `ui/logs.ts` | 73 | log-line parsing/normalisation |
| `ui/format.ts` | 53 | duration/date/label formatting |
| `artifacts.ts` | 46 | artifact path resolution |
| `ui/icons.ts` | 42 | icon selection by status/action |
| `fetchers.ts` | 24 | data-fetch helpers |
| `ui/routes.ts` | 15 | route construction |

New test files under `packages/report-web/src/**/test/`, per the repo's layout requirement (a
`test/` directory beside the code it covers — so `ui/test/viewModel.test.ts`, `test/artifacts.test.ts`,
and so on).

**Use `node --test` via the existing tsx runner — add no test dependency.** The package already has
`tsx` as a devDependency and the runner already invokes `node --import tsx --test`.

**These are characterization tests**: they pin what the code currently does, so they must pass
against the unmodified source. There is no refactor in this change, so unlike #156/#161 there is no
"before and after" — but the same quality bar applies: **mutation-verify** that each pin is
load-bearing, because a suite that asserts nothing looks identical to one that does.

**Prioritise by consequence, not by line count.** `viewModel.ts` decides what a user is told about
their run; a wrong status or a wrong first-failure attribution is the failure mode that matters. Pin
that behaviour first and most thoroughly. `routes.ts` at 15 lines needs proportionally little.

### 2. Graduate `report-web` to the strict shared runner

Once real tests exist, "zero test files" should be a hard error here as it is everywhere else.

- `packages/report-web/package.json`: `"test": "node ./scripts/runTests.mjs"` →
  `"test": "node ../../scripts/run-node-tests.mjs"`.
- **Check the strict runner works for this package before switching.** The shared runner discovers
  compiled `dist/**/*.test.js`; `report-web`'s tolerant runner instead runs `src/**/*.test.ts`
  through tsx. `report-web`'s build is `tsup` + `vite`, not plain `tsc`, so **verify what its build
  actually emits and whether test files reach `dist/` at all.** If they do not, the correct outcome
  is to keep a package-local runner (updated so zero files exits 1) rather than force the shared one
  — say so and explain, rather than making the switch fit.
- Delete `packages/report-web/scripts/runTests.mjs` only if it is genuinely superseded.

**Widen discovery to `.test.tsx`.** The tolerant runner matches only `.test.ts`
(`scripts/runTests.mjs:37`), a gap flagged in #151's review. Whatever runner ends up in place must
also discover `.test.tsx`, so the future component-test change does not silently find nothing.

### 3. Required memory update

`docs/memory/ci/pr-quality-gate.md` records `report-web` as **the one package with zero test files**
and as the sole tolerant-runner case, with a scenario keyed on it. This change falsifies that. The
strict/tolerant requirement and its scenario must be updated — and if no tolerant runner remains
anywhere, that shape should be described as retired rather than left as a live option.

### Out of scope

- **The 14 DOM-dependent warnings** and the DOM test environment that would unlock them. That is the
  follow-up: choose `jsdom` or `happy-dom`, decide whether a React testing library is warranted, and
  set the convention for component tests. It is a dependency decision, not a backfill.
- Any refactor of `report-web` source. This change adds tests only; nothing in `src/` changes except
  the `package.json` test script.
- The other 30 source warnings outside `report-web`.
- The nine queued follow-ups (the `_trimmed` guard, emulator output cap, `getPlatform()` swap,
  `adbPath!` guard, #159's two dead constructs, `GrounderResponseConverter`, Dependabot's 4 CVEs, the
  `ci` memory-domain split).
- Promoting lint rules from `warn` to `error`.

## Affected Memory

- `ci/pr-quality-gate`: **(modify — required)** the "Tests run through explicit-discovery runner
  scripts" requirement names `report-web` as the sole zero-test/tolerant package and bases a scenario
  on it. Both become false. Update to the post-change truth, including whether any tolerant runner
  survives.
- `report-web/renderers`: (verify) a `report-web` memory domain exists. Check whether it describes
  behaviour these tests now pin, and whether anything it claims is contradicted by what the tests
  find — a characterization pass is exactly when latent doc drift surfaces.

## Impact

- **Added**: test files under `packages/report-web/src/**/test/`.
- **Modified**: `packages/report-web/package.json` (test script), `docs/memory/ci/pr-quality-gate.md`,
  possibly `docs/memory/report-web/renderers.md`.
- **Possibly deleted**: `packages/report-web/scripts/runTests.mjs`, if genuinely superseded.
- **No `packages/report-web/src` source change.**
- **Risk**: low. Tests-only, no refactor, no new dependency. The real risks are (a) writing tests
  that assert nothing — addressed by the mutation requirement — and (b) forcing the strict-runner
  switch when this package's non-`tsc` build makes it inappropriate, addressed by §2's check-first
  instruction.
- **Expected outcome**: tests **401 → 401 + N**; warnings **78, unchanged** (stated plainly so a
  reader is not surprised); `max-depth` and `no-unused-vars` still zero; `report-web` no longer prints
  a "no tests yet" notice.

## Open Questions

- Does `report-web`'s `tsup`/`vite` build emit test files to `dist/`? (Decides §2 — must be checked,
  not assumed.)
- How many tests are enough? (No number; the bar is that `viewModel.ts`'s status and failure-selection
  decisions are pinned and mutation-verified — see Assumptions #5.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope to the 7 DOM-free modules; exclude the DOM half | Verified: `runDetailController.ts` has 70 DOM references and the 14 `.tsx` files are React components. Testing them needs new dependencies and an infra decision | S:90 R:85 A:95 D:95 |
| 2 | Certain | This change clears ZERO warnings, and that is stated up front | All 14 `report-web` warnings are DOM-dependent; the modules under test carry none. The earlier claim that this "unlocks 14 warnings" was wrong and is corrected here | S:95 R:90 A:95 D:95 |
| 3 | Certain | Add no test dependency — use `node --test` through the existing tsx runner | `tsx` is already a devDependency and the runner already uses it; a DOM library is the follow-up's decision to make, not this change's | S:90 R:80 A:95 D:90 |
| 4 | Confident | Prioritise `viewModel.ts` by consequence, not line count | It decides what the user is told about a run; a wrong status or misattributed failure is silent and believed, which is worse than a crash | S:80 R:80 A:85 D:80 |
| 5 | Confident | No fixed test count; the bar is that status and failure-selection decisions are pinned and mutation-verified | A number invites padding; #156 and #161 both showed mutation is what separates a real suite from a decorative one | S:75 R:80 A:85 D:75 |
| 6 | Certain | Verify the strict runner actually works here before switching | `report-web` builds with `tsup`/`vite`, not plain `tsc`; the shared runner discovers compiled `dist/**/*.test.js`. If tests do not reach `dist/`, keep a package-local runner corrected to exit 1 on zero files | S:85 R:80 A:90 D:85 |
| 7 | Certain | Whatever runner remains must discover `.test.tsx`, not just `.test.ts` | The current tolerant runner matches only `.test.ts` — a gap flagged in #151's review. Left unfixed, the future component-test change silently finds nothing | S:90 R:85 A:95 D:90 |
| 8 | Certain | The memory update is REQUIRED | `pr-quality-gate.md` names `report-web` as the sole zero-test/tolerant package and keys a scenario on it; both become false | S:90 R:85 A:95 D:95 |
| 9 | Confident | Check `docs/memory/report-web/renderers.md` against what the tests find | A characterization pass is exactly when latent documentation drift surfaces; #161 found three drifted claims this way | S:75 R:85 A:85 D:80 |
| 10 | Certain | No `report-web` source file changes | Tests-only change; the sole non-test edit is the `package.json` test script | S:90 R:85 A:95 D:95 |

10 assumptions (7 certain, 3 confident, 0 tentative, 0 unresolved).
