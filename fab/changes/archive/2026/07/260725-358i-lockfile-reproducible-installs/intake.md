# Intake: Commit Lockfile and Switch to Reproducible `npm ci` Installs

**Change**: 260725-358i-lockfile-reproducible-installs
**Created**: 2026-07-25

## Origin

Follow-up to `260724-gl51-ci-gate-lint-enforcement` (merged as PR #151, squash commit `851c0da`),
which added the repo's first PR test gate. That change surfaced — and had to work around — a build
break caused by unpinned dependency resolution. This change fixes the root cause.

**What happened in the previous change.** The new CI gate went red at the build step with:

```text
src/ai/AIAgent.ts(575,9): error TS2322: Type 'AIAgentProviderOptions | undefined' is not
assignable to type 'SharedV3ProviderOptions | undefined'.
```

The cause was **not** our code. `packages/goal-executor` declares `"@ai-sdk/anthropic": "^3.0.58"`,
and with no lockfile a fresh `npm install` resolved it to `3.0.101`, whose
`AnthropicLanguageModelOptions` gained a `fallbacks[].thinking: Record<string, unknown>` field.
`unknown` is not a `JSONValue`, so the provider's own option type stopped being assignable to the
`SharedV3ProviderOptions` (`Record<string, JSONObject>`) that `generateText` requires. The symptom
appeared with **zero source changes on our side** — purely because CI resolved newer dependencies
than the developer's machine had.

That was patched at the type level (a documented widening at the single `generateText` boundary),
which is version-agnostic and remains correct. But the underlying exposure is unaddressed: **every
CI run resolves caret ranges afresh, so the next upstream release can break the build again with no
commit from us.**

> User direction: after the merge, asked to "start a new intake on a new branch for the new task",
> selecting **"Lockfile + npm ci"** from the queued follow-ups — described as fixing the root cause
> of the goal-executor build break, which will otherwise recur on any upstream semver bump.

**Key discovery during intake (changes the framing).** The lockfile exclusion was **not a
deliberate architectural decision**. `git log -S` traces it to commit `e328e78`, whose subject is
*"Fix report-web build under TypeScript 6"* — an unrelated TS6/tsup fix. Untracking the lockfile
appears there only as a one-line note in the commit body ("Untrack package-lock.json and add it to
.gitignore"), with **no stated rationale**, alongside the deletion of 6,026 lines of
`package-lock.json`. It reads as an incidental workaround to dodge a resolution problem during that
fix, not a considered policy.

Corroborating evidence that it was unintentional: **`CONTRIBUTING.md` line 10 still instructs
contributors to run `npm ci`** — a command that has been guaranteed to fail ever since the lockfile
was untracked. Nobody updated the contributor docs because nobody decided the policy.

## Why

**Problem.** Dependency resolution is non-reproducible. With `package-lock.json` gitignored, three
different installs of the same commit — a developer's machine, CI, and the release workflow — can
resolve to three different dependency trees. The `AIAgent.ts` TS2322 break is a concrete, already-
realized instance: CI failed on code that built fine locally.

**Consequence if not fixed.**
- **The build can break with no code change.** Any upstream patch release inside an existing caret
  range can turn CI red. This is not hypothetical — it already happened once and cost a debugging
  cycle inside the previous change.
- **The new PR gate is undermined.** A gate whose red/green depends on *when* it ran, rather than
  on *what changed*, erodes trust in the signal. The gate was the entire point of the previous
  change.
- **Releases are not reproducible.** `release.yml` also uses `npm install`, so a re-run of the same
  tag can ship a different dependency tree than the one that was tested.
- **Contributor onboarding is broken.** `CONTRIBUTING.md` documents `npm ci`, which cannot work.
- **CI is slower.** Without a lockfile, `setup-node`'s `cache: 'npm'` cannot be enabled (nothing to
  key on), so every run does a full cold resolution + download.

**Why this approach.** Committing the lockfile is the standard, low-risk fix and is what
`CONTRIBUTING.md` already assumes. `npm ci` then installs exactly the locked tree, deterministically
and faster, and fails loudly if `package.json` and the lockfile disagree — converting a silent drift
into an explicit, actionable error. Dependency updates become deliberate, reviewable commits
(a changed lockfile in a PR diff) instead of invisible ambient changes.

**Alternatives considered.** Pinning exact versions in every `package.json` (dropping carets) was
rejected: it only pins *direct* dependencies, leaving the transitive tree — including
`@ai-sdk/provider`, which is half of the actual TS2322 incompatibility — still floating. Only a
lockfile pins transitives.

## What Changes

### 1. Commit `package-lock.json`

Remove the `package-lock.json` entry from `.gitignore` (currently **line 4**) and commit the
generated lockfile at the repo root. This is a monorepo with 7 npm workspaces, so the single root
lockfile covers every workspace.

- Generate with a clean, complete resolution (e.g. `npm install` against the current
  `package.json` set) and commit the result.
- Expect a large added file (the previously deleted lockfile was ~6,026 lines; today's tree will be
  larger). This is normal and reviewable.
- **`lockfileVersion` must be appropriate for the toolchain.** The repo's `engines.node` floor is
  `>=20.19.0` (bundled npm 10, `lockfileVersion` 3). The lockfile MUST NOT be generated in a way
  that requires a newer npm than CI's Node 20.19 provides.

### 2. Switch CI and release workflows to `npm ci`

**`.github/workflows/ci.yml`** — replace `npm install` with `npm ci`, and remove the two comment
blocks (around the current lines 31–36) that explain the no-lockfile constraint, since it no longer
holds:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: '20.19'
          cache: 'npm'          # now valid — there is a lockfile to key on
      - run: npm ci
```

**`.github/workflows/release.yml`** — the same substitution at its install step (currently around
lines 95–98), including its equivalent explanatory comments. Release builds MUST be reproducible;
this is arguably the more important of the two.

Enabling `cache: 'npm'` on `setup-node` is included because it becomes valid and is the main speed
win, but it is an optimization — if it complicates the change, the correctness fix (`npm ci`) stands
on its own.

### 3. Fix `CONTRIBUTING.md`

Line 10 already says `npm ci`. Once the lockfile is committed this instruction becomes **correct for
the first time since `e328e78`** — verify it works end-to-end from a clean clone rather than
assuming. No text change is expected; if the setup section needs a note about the lockfile being
committed (e.g. "commit lockfile changes when you change dependencies"), add it.

### 4. Update the `ci` memory domain

`docs/memory/ci/pr-quality-gate.md` contains a requirement that this change **directly
invalidates**:

> ### Requirement: No committed lockfile — install, never `npm ci`
> `package-lock.json` is gitignored, so CI MUST use `npm install` (never `npm ci`, which requires a
> lockfile) and setup-node MUST NOT enable `cache: 'npm'` (nothing to key on). This mirrors
> `release.yml`.

This requirement must be **replaced** (not merely amended) with the inverse: a committed lockfile,
`npm ci` in both workflows, and `cache: 'npm'` enabled. The file's `description:` frontmatter also
references the no-lockfile contract and must be updated. The PR-CI-gate-stages requirement (which
names `npm install` in its ordered step list) needs the same correction.

### Out of scope

- **Upgrading or changing any dependency version.** This change locks the tree *as it currently
  resolves*; it deliberately does not bump anything. Any version change must be its own reviewable
  commit.
- **Reverting the `AIAgent.ts` type widening** from the previous change. It is version-agnostic and
  correct on both old and new SDK versions; the lockfile makes recurrence unlikely, not impossible
  (the widening still protects the deliberate-upgrade path).
- **Adding automated dependency updates** (Dependabot/Renovate). A lockfile makes such tooling
  viable and is a sensible successor, but it is a separate decision.
- The other queued follow-ups: test backfill for `report-web`/`cloud-core`, refactoring the ~18
  oversized functions, and promoting lint rules from `warn` to `error`.

## Affected Memory

- `ci/pr-quality-gate`: (modify) Replace the "No committed lockfile — install, never `npm ci`"
  requirement with its inverse (committed lockfile, `npm ci`, `cache: 'npm'` enabled); update the
  `npm install` reference inside the PR-CI-gate-stages requirement; update the `description:`
  frontmatter, which currently encodes the no-lockfile contract.

## Impact

- **Modified**: `.gitignore` (remove line 4), `.github/workflows/ci.yml`,
  `.github/workflows/release.yml`, `docs/memory/ci/pr-quality-gate.md`, possibly `CONTRIBUTING.md`.
- **Added**: `package-lock.json` (large, generated).
- **No `packages/**/src` changes** — no application source is touched.
- **Risk**: low-to-moderate, and concentrated in one place. The lockfile must capture a tree that
  actually builds and tests green. Because the current floating resolution *does* build green today
  (verified at the end of the previous change: build 0, 348 tests pass, lint 0 errors), locking the
  present tree is the safe baseline. The main failure mode is generating the lockfile from a
  partially-installed or stale `node_modules`.
- **Verification requirement**: after committing the lockfile, a **clean-tree** install must be
  proven — remove `node_modules`, run `npm ci`, then `npm run build --workspaces --if-present`,
  `npm run test:workspaces` (expect exit 0, 348 tests), and `npm run lint` (expect exit 0). Merely
  building against the existing `node_modules` does not prove `npm ci` works.
- **Follow-on benefit**: CI gets faster (npm cache becomes usable) and the `goal-executor` TS2322
  class of failure stops being able to appear spontaneously.

## Open Questions

- Should `cache: 'npm'` be enabled in the same change, or deferred to keep the diff minimal?
  (Included by default — it is a two-line addition that becomes valid with the lockfile.)
- Should a follow-up add Dependabot/Renovate now that a lockfile makes it viable? (Deliberately out
  of scope here.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Commit `package-lock.json` and remove its `.gitignore` entry (line 4) | User explicitly selected the "Lockfile + npm ci" option; it is the stated root-cause fix | S:95 R:75 A:90 D:95 |
| 2 | Certain | The lockfile exclusion was incidental, not a deliberate policy, so reversing it does not override a considered decision | Verified via `git log -S`: introduced in `e328e78` ("Fix report-web build under TypeScript 6") as an unexplained one-liner; `CONTRIBUTING.md:10` still documents `npm ci`, proving no policy was propagated | S:90 R:70 A:90 D:85 |
| 3 | Certain | Switch BOTH `ci.yml` and `release.yml` to `npm ci` | Both currently use `npm install` with matching no-lockfile comments; leaving release non-reproducible would defeat the purpose | S:90 R:80 A:95 D:90 |
| 4 | Confident | Enable `cache: 'npm'` on `setup-node` in the same change | Becomes valid once a lockfile exists and is the main CI speed win; small, easily reverted if problematic | S:70 R:90 A:85 D:75 |
| 5 | Certain | Lock the tree as it currently resolves — do NOT bump any dependency | The current resolution is verified green (build 0, 348 tests, lint 0 errors); bundling upgrades would confound the change and its risk | S:85 R:75 A:90 D:90 |
| 6 | Certain | Do NOT revert the `AIAgent.ts` provider-options widening | It is version-agnostic, correct on both SDK versions, and still guards deliberate upgrades; reverting adds risk for no benefit | S:85 R:80 A:90 D:90 |
| 7 | Certain | Verification requires a clean-tree `npm ci` (delete `node_modules` first), then build + test + lint | Building against pre-existing `node_modules` would not prove the lockfile is complete or that `npm ci` succeeds — the exact failure this change must prevent | S:90 R:85 A:95 D:90 |
| 8 | Confident | Update `docs/memory/ci/pr-quality-gate.md` by replacing the no-lockfile requirement, not amending it | The change inverts that requirement outright; a stale MUST in memory would actively misdirect future work | S:80 R:85 A:85 D:85 |
| 9 | Confident | `CONTRIBUTING.md` likely needs no text change — only verification | Line 10 already says `npm ci`; it becomes correct rather than needing rewriting | S:75 R:90 A:80 D:80 |
| 10 | Confident | Exclude Dependabot/Renovate from this change | A lockfile enables it, but automated dependency updates are a separate policy decision (YAGNI here) | S:70 R:90 A:80 D:80 |
| 11 | Confident | `lockfileVersion` must remain installable by CI's Node 20.19 / npm 10 | `engines.node >= 20.19.0`; a lockfile requiring a newer npm would break the very gate this protects | S:70 R:80 A:80 D:80 |

11 assumptions (7 certain, 4 confident, 0 tentative, 0 unresolved).
