# Plan: Commit Lockfile and Switch to Reproducible `npm ci` Installs

**Change**: 260725-358i-lockfile-reproducible-installs
**Intake**: `intake.md`

## Requirements

### ci: Committed lockfile

#### R1: Root `package-lock.json` is committed and tracked
The `package-lock.json` entry MUST be removed from `.gitignore` (currently line 4), and a root `package-lock.json` MUST be committed that freezes the dependency tree **as it currently resolves** (the tree verified green at the end of `260724-gl51`). The single root lockfile covers all 7 npm workspaces. No dependency version in any `package.json` may change.

- **GIVEN** the repo at branch `260725-358i-lockfile-reproducible-installs`
- **WHEN** `git check-ignore package-lock.json` runs
- **THEN** it matches nothing (exit 1), **AND** `git status` shows `package-lock.json` as a tracked/added file

#### R2: Lockfile is installable by CI's npm 10 (Node 20.19)
The committed lockfile MUST declare `lockfileVersion: 3` and MUST NOT require an npm newer than the npm 10 bundled with Node 20.19 (the repo's `engines.node >= 20.19.0` floor and CI's pinned version). The local generator is npm 11 / Node 24; npm 11 still emits lockfileVersion 3, but this MUST be verified, not assumed.

- **GIVEN** the generated `package-lock.json`
- **WHEN** its `lockfileVersion` field is inspected
- **THEN** it equals `3`

### ci: Workflows use `npm ci`

#### R3: `ci.yml` installs with `npm ci` and enables the npm cache
`.github/workflows/ci.yml` MUST replace `npm install` with `npm ci`, MUST remove the now-false explanatory comments (no-lockfile rationale on the setup-node step and the install step), and SHOULD enable `cache: 'npm'` on `actions/setup-node@v4` (now valid — the lockfile is the cache key).

- **GIVEN** a PR triggering the CI workflow
- **WHEN** the install step runs
- **THEN** it runs `npm ci` against the committed lockfile, failing loudly if `package.json` and the lockfile disagree
- **AND** setup-node keys its npm cache on `package-lock.json`

#### R4: `release.yml` installs with `npm ci` and enables the npm cache
`.github/workflows/release.yml` MUST make the same substitution at its install site (the `build` job, currently lines 91–98): `npm ci` instead of `npm install`, stale no-lockfile comments removed, `cache: 'npm'` enabled. The `smoke-windows` and `release` jobs have no npm install site and MUST remain untouched.

- **GIVEN** a manually-triggered release run
- **WHEN** the build job installs dependencies
- **THEN** it installs exactly the locked tree via `npm ci`, so a re-run of the same tag ships the same dependency tree that was tested

### docs: Contributor docs and memory

#### R5: `CONTRIBUTING.md` setup instruction is correct
`CONTRIBUTING.md` line 10 (`npm ci`) becomes correct for the first time since `e328e78` and MUST be verified against the committed lockfile (the clean-tree proof in R7 is that verification). A short note MAY be added stating that dependency changes must include the updated lockfile.

- **GIVEN** a fresh clone following `CONTRIBUTING.md`'s Development Setup
- **WHEN** the contributor runs `npm ci`
- **THEN** the install succeeds against the committed lockfile

#### R6: `docs/memory/ci/pr-quality-gate.md` states the inverted contract
The memory file's "Requirement: No committed lockfile — install, never `npm ci`" MUST be **replaced** (not amended) with its inverse: committed lockfile, `npm ci` in both workflows, `cache: 'npm'` enabled. The `npm install` reference inside the "PR CI gate stages" requirement MUST be corrected to `npm ci`, and the `description:` frontmatter (which encodes the no-lockfile contract only implicitly today) MUST stay accurate — one line, ≤500 chars, change-id-free, matching the file's existing FKF style. Hydrate refines later; this apply-time edit removes the directly-contradicted MUST.

- **GIVEN** the updated memory file
- **WHEN** a future change reads the ci domain
- **THEN** no requirement instructs `npm install`/no-lockfile, and the stated contract matches `.github/workflows/ci.yml` and `release.yml` as modified by this change

### ci: Reproducibility proof

#### R7: Clean-tree `npm ci` install is proven green
The lockfile MUST be proven complete by a clean-tree exercise: remove `node_modules` (root and any `packages/*/node_modules`), then `npm ci` (exit 0), `npm run build --workspaces --if-present` (exit 0), `npm run test:workspaces` (exit 0, ~348 tests: 75 common, 91 device-node, 67 goal-executor, 115 cli, plus 2 "no tests yet" notices), and `npm run lint` (exit 0; warnings allowed, 0 errors). Building against a pre-existing `node_modules` does NOT satisfy this requirement.

- **GIVEN** no `node_modules` anywhere in the tree
- **WHEN** `npm ci` then build, test, and lint run in order
- **THEN** every step exits 0 and the test counts match the previously-verified green tree

### Non-Goals

- Upgrading/bumping/changing ANY dependency version — the change freezes the currently-resolving tree; version changes are their own reviewable commits
- Reverting the `AIAgent.ts` provider-options widening in `packages/goal-executor` — version-agnostic and still guards deliberate upgrades
- Adding Dependabot/Renovate — a separate policy decision the lockfile merely enables
- Touching `packages/**/src` application source

### Design Decisions

#### Reuse the existing on-disk lockfile rather than re-resolving from scratch
**Decision**: Adopt the untracked `package-lock.json` already on disk (generated 2026-07-24 alongside the currently-installed, verified-green `node_modules`), reconciled via a fresh `npm install` run, instead of deleting it and re-resolving caret ranges from the registry.
**Why**: That lockfile pins exactly the tree the previous change verified green (build 0, 348 tests, lint 0 errors, `@ai-sdk/anthropic` 3.0.101 handled by the documented widening). Re-resolving from scratch could pull newer in-range releases — precisely the drift this change exists to stop.
**Rejected**: `rm package-lock.json && npm install` — discards the verified resolution and re-floats every caret range at lock time for no benefit.
*Introduced by*: 260725-358i-lockfile-reproducible-installs

## Tasks

### Phase 1: Setup

- [x] T001 Remove the `package-lock.json` entry (line 4) from `.gitignore` <!-- R1 -->

### Phase 2: Core Implementation

- [x] T002 Reconcile and validate the root `package-lock.json`: run `npm install` (no-op against the in-sync tree), confirm `lockfileVersion` is 3 and the top-level name/version match `package.json`; confirm no `package.json` was modified <!-- R1, R2 -->
- [x] T003 [P] Edit `.github/workflows/ci.yml`: `npm install` → `npm ci`, delete the two no-lockfile comment blocks, add `cache: 'npm'` to the setup-node step <!-- R3 -->
- [x] T004 [P] Edit `.github/workflows/release.yml`: same substitution at the build job's install site (~lines 91–98), delete its no-lockfile comments, add `cache: 'npm'`; verify no other install site exists in the file <!-- R4 -->

### Phase 3: Integration & Edge Cases

- [x] T005 Clean-tree verification: `rm -rf node_modules packages/*/node_modules`, then `npm ci` (exit 0), `npm run build --workspaces --if-present` (exit 0), `npm run test:workspaces` (exit 0, ~348 tests), `npm run lint` (exit 0, 0 errors); record exact counts and exit codes <!-- R7 -->
- [x] T006 Sanity checks: `git check-ignore package-lock.json` no longer matches; `git status` shows `package-lock.json` tracked/added; `git diff` shows no `package.json` version changes <!-- R1 -->

### Phase 4: Polish

- [x] T007 [P] Verify `CONTRIBUTING.md:10` (`npm ci`) needs no change; add a one-line note that dependency changes must include the updated `package-lock.json` <!-- R5 -->
- [x] T008 [P] Update `docs/memory/ci/pr-quality-gate.md`: replace the "No committed lockfile" requirement with its inverse, fix `npm install` → `npm ci` in the "PR CI gate stages" requirement, keep the `description:` frontmatter accurate (≤500 chars, change-id-free, FKF style); re-run `fab memory-index` so the generated index row stays consistent <!-- R6 -->

## Execution Order

- T001 and T002 block T005 (the lockfile must be un-ignored and validated before the clean-tree proof)
- T003/T004/T007/T008 are file edits independent of T005 but MUST be complete before the change is considered done
- T006 runs after T005

## Acceptance

### Functional Completeness

- [x] A-001 R1: `.gitignore` no longer contains a `package-lock.json` entry and the root lockfile is a tracked/added file — verified: `.gitignore` has no package-lock entry; `git check-ignore` exits 1; lockfile tracked and clean
- [x] A-002 R3: `.github/workflows/ci.yml` runs `npm ci` (no `npm install` remains) with `cache: 'npm'` on setup-node and no stale no-lockfile comments — verified: ci.yml:31 `cache: 'npm'`, ci.yml:35 `npm ci`; no `npm install` and no no-lockfile comments remain
- [x] A-003 R4: `.github/workflows/release.yml` runs `npm ci` at its only install site with `cache: 'npm'` and no stale no-lockfile comments; smoke-windows/release jobs untouched — verified: release.yml:94 `cache: 'npm'`, :97 `npm ci`; YAML parse confirms `build` is the only job with npm steps; smoke-windows/release untouched
- [x] A-004 R5: `CONTRIBUTING.md` setup says `npm ci` and notes that dependency changes include the lockfile — verified: CONTRIBUTING.md:10 `npm ci`, :13 lockfile-with-dependency-changes note
- [x] A-005 R6: `docs/memory/ci/pr-quality-gate.md` contains no `npm install`/no-lockfile requirement; the inverse requirement (committed lockfile, `npm ci`, `cache: 'npm'`) is present and the `description:` frontmatter matches — verified: no `npm install`/no-lockfile requirement survives; inverse requirement + scenario present; `description:` frontmatter and `ci/index.md` row updated and mutually consistent

### Behavioral Correctness

- [x] A-006 R2: `package-lock.json` declares `lockfileVersion: 3` (installable by npm 10 / Node 20.19) — verified: `lockfileVersion: 3`; zero locked packages incompatible with Node 20.19.0 (semver-checked); only v3 fields present
- [x] A-007 R1: No `package.json` (root or workspace) has any version change — the diff adds the lockfile and edits only `.gitignore`, the two workflows, `CONTRIBUTING.md`, and the memory file/index — verified: `git diff origin/main...HEAD -- package.json 'packages/*/package.json'` is empty; packages/, drivers/, scripts/ untouched

### Scenario Coverage

- [x] A-008 R7: Clean-tree proof recorded: `rm -rf node_modules packages/*/node_modules` → `npm ci` exit 0 → build exit 0 → `test:workspaces` exit 0 with ~348 tests (75 common, 91 device-node, 67 goal-executor, 115 cli) + 2 "no tests yet" notices → lint exit 0 with 0 errors — verified independently at review: clean-tree `npm ci` exit 0 (359 added / 367 audited), build exit 0, `test:workspaces` exit 0 with 348 tests (75 common + 91 device-node + 67 goal-executor + 115 cli) plus the 2 tolerant-runner packages, lint exit 0 with 156 warnings / 0 errors

### Edge Cases & Error Handling

- [x] A-009 R1: `git check-ignore package-lock.json` exits non-zero (no ignore rule matches, including inherited/global rules) — verified: `git check-ignore -v package-lock.json` exits 1

### Code Quality

- [x] A-010 Pattern consistency: workflow edits keep the files' existing comment style; the memory edit matches the file's FKF present-truth style (requirement replaced, not narrated) — verified: workflow comments keep the existing style; memory edit replaces the requirement in FKF present-truth form
- [x] A-011 No unnecessary duplication: no new scripts or helpers introduced; the existing `bootstrap: npm ci` root script is left as-is (already correct) — verified: no new scripts or helpers; root `bootstrap: npm ci` unchanged

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Adopt the existing untracked on-disk lockfile (generated 2026-07-24 with the verified-green `node_modules`, `@ai-sdk/anthropic` 3.0.101) reconciled via `npm install`, rather than deleting and re-resolving | It pins exactly the tree verified green in `260724-gl51`; re-resolving would re-float caret ranges — the drift this change eliminates. Intake mandates "lock the tree as it currently resolves" | S:90 R:85 A:95 D:90 |
| 2 | Certain | lockfileVersion 3 from local npm 11 is acceptable — verify the field, don't regenerate under npm 10 | npm 11 emits lockfileVersion 3, the same format npm 10 reads/writes; verified on the actual file, and the clean-tree `npm ci` plus CI itself re-prove it | S:85 R:85 A:90 D:90 |
| 3 | Confident | Add the optional one-line lockfile note to `CONTRIBUTING.md` | Intake marks it optional ("if the setup section needs a note … add it"); one sentence prevents the most likely contributor error (`npm ci` failing after a dep change without a lockfile commit) and is trivially reversible | S:70 R:95 A:85 D:80 |
| 4 | Confident | Run `fab memory-index` after editing the memory file's frontmatter, even though hydrate owns memory | The index header says "re-run after any memory write"; leaving a generated index row stale would contradict the edited description. Hydrate re-runs it anyway — idempotent | S:65 R:95 A:85 D:80 |
| 5 | Certain | Only one install site exists in `release.yml` (build job, ~line 98); smoke-windows and release jobs need no change | Verified by reading the full file — the other jobs only download artifacts and run `gh`/`git`/pwsh | S:90 R:90 A:95 D:95 |
| 6 | Confident | Keep `cache: 'npm'` in this change (not deferred) | Intake includes it by default (Assumption 4 there); two-line addition, valid once the lockfile exists, easily reverted | S:75 R:90 A:85 D:80 |

6 assumptions (3 certain, 3 confident, 0 tentative).
