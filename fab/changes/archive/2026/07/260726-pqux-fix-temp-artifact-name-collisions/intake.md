# Intake: Make Temp Artifact Names Collision-Resistant

**Change**: 260726-pqux-fix-temp-artifact-name-collisions
**Created**: 2026-07-26

## Origin

Eighth change in the code-quality initiative, and a direct follow-up to
`260726-rpx7-fix-submit-appzip-cleanup-leak` (PR #157, merged `c39f8fc`), which recorded this as its
first follow-up.

The bug was found **empirically, not by inspection**: while instrumenting `fs.unlinkSync` to verify
PR #157's leak fix across seven exit paths, the review stage **hit a real same-millisecond
collision** — one run's temp zip clobbered an identically-named leftover and then unlinked it. CodeRabbit
independently raised the same concern on PR #157, asking for a collision-resistant name or
concurrency coverage. It was deferred there because it is a distinct latent bug that predates that
change, and closing it would have widened a scoped leak fix into a second one.

> User direction: "merged, rebase and start next".

## Why

**Problem.** Both temp artifacts in the cloud-submit path are named from a millisecond timestamp with
no random component:

| Site | Name |
|------|------|
| `packages/cloud-core/src/appBundle.ts:88` (`zipAppBundle`) | `finalrun-app-${Date.now()}.zip` |
| `packages/cloud-core/src/submit.ts:225` (`writeSpecZip`) | `finalrun-cloud-${Date.now()}.zip` |

Both are written into the shared `os.tmpdir()`. Two submissions whose zip-write lands in the same
millisecond therefore resolve to the **same path**, and the consequences compound:

1. **The second write silently overwrites the first.** `zip.writeZip(zipPath)` truncates an existing
   file, so submission A's archive is replaced by B's contents while A still holds the path and is
   about to upload it — A uploads B's payload.
2. **Then the first `finally` to run deletes the shared file** out from under the other run
   mid-upload. #157 made cleanup reliable, which makes this *more* reachable: cleanup is now
   guaranteed to fire on every exit path, so the deletion is guaranteed too.

**Why this is worse than the leak #157 fixed.** A leak wastes disk and is recoverable. A collision
**corrupts a live submission**: the user is told their tests were uploaded, and the server received a
different run's specs or app binary. There is no error, no warning, and nothing in the output that
would let a user diagnose it.

**How reachable is it?** Zipping a small spec set takes well under a millisecond, so the window is
not vanishingly narrow — it is the *normal* duration of the operation. Any two overlapping
`finalrun cloud test` invocations on one machine can hit it: two terminals, a CI runner executing
jobs in parallel, or a script fanning out submissions. It is not a theoretical race; it was observed
once already on a single developer machine during ordinary instrumentation.

**Why it has no coverage.** The existing suite's tmpdir-diff helper deliberately keys on the *stable
prefix* (`/^finalrun-(cloud|app)-.*\.zip$/`) and never on per-run uniqueness — a design choice
recorded in memory. Nothing exercises two concurrent submissions.

## What Changes

### 1. Add a random component to both temp names

Keep the existing prefixes and the `.zip` suffix; insert randomness before the extension. Using
`randomUUID` from the built-in `node:crypto` (no new dependency):

```ts
// packages/cloud-core/src/appBundle.ts
const zipPath = path.join(os.tmpdir(), `finalrun-app-${Date.now()}-${randomUUID()}.zip`);

// packages/cloud-core/src/submit.ts
const zipPath = path.join(os.tmpdir(), `finalrun-cloud-${Date.now()}-${randomUUID()}.zip`);
```

A shorter slug (e.g. `randomBytes(6).toString('hex')`) is equally acceptable — 48 bits is ample. The
timestamp is retained because it keeps temp files sortable and human-diagnosable when one is left
behind; the random part is what provides uniqueness.

**The prefix MUST be preserved.** `submit.test.ts`'s `tempZipArtifacts()` helper filters
`/^finalrun-(cloud|app)-.*\.zip$/`. Because the pattern's `.*` sits between prefix and extension, a
suffix insertion keeps all four existing cleanup assertions working unchanged. Renaming or
restructuring the prefix would break them — do not.

### 2. Deliberately NOT using `fs.mkdtempSync`

`mkdtempSync` is the theoretically stronger option: it creates a directory atomically and therefore
makes collision *impossible* rather than merely astronomically unlikely. It is rejected here because
cleanup would have to become a recursive directory removal instead of `fs.unlinkSync(path)` — which
means reworking the exact `try`/`finally` cleanup scopes that PR #157 just restructured and that
review verified across seven exit paths by instrumenting `unlinkSync`. Re-opening that code to gain
certainty over a ~2⁻¹²⁸ residual risk is a bad trade. Record the reasoning rather than leaving the
choice looking accidental.

### 3. Regression test — make the collision deterministic

Add to `packages/cloud-core/src/test/submit.test.ts`. The naming sites are module-private, so drive
them through `submitRun` and observe the artifacts while they exist (inside the `fetch` stub, before
cleanup runs).

**Stub `Date.now` to a fixed value** so both submissions receive an identical timestamp. This makes
the collision **certain** rather than probable — without it the test is a race that usually
reproduces (sub-millisecond zip writes) but could pass spuriously if the clock ticks between calls, a
flake in the worst direction: green on broken code. `Date.now` is a process global, so stubbing it
(restored in a `finally`) is consistent with the recorded convention of stubbing only genuinely
crossed globals.

Shape:
- Stub `Date.now` → constant; stub `fetch` to capture `tempZipArtifacts()` *while in flight*.
- Run two `submitRun` calls concurrently (`Promise.all`), each with a distinct spec fixture.
- Assert **two distinct** `finalrun-cloud-*` names are present simultaneously.
- Do the same for the app zip: two concurrent `.app`-directory submissions → two distinct
  `finalrun-app-*` names.
- Assert cleanup still removes both afterwards (so the fix does not reintroduce a leak).

**This test MUST fail against the current code and pass after the fix.** Verify that ordering
explicitly and report the observed failure — it is the proof, as in #155 and #157.

### Behaviour that MUST NOT change

- Cleanup semantics from #157: nested `try`/`finally`, each scoped to its own acquisition; both
  `unlinkSync` calls keep their `try {} catch {}`; spec zip unlinked before app zip; the original
  error still propagates.
- `PreparedApp`'s shape and `isTempZip` semantics; a user-supplied `.apk`/`.app.zip` is still never
  copied, renamed, or deleted.
- `filename` reported to the server. Note this is **already independent** of the temp path —
  `zipAppBundle` returns `filename: \`${basename}.zip\`` (e.g. `MyApp.app.zip`), not the temp
  basename — so the uploaded name is unaffected. Confirm rather than assume; an existing test pins
  `appFilename`.
- All existing `submit.test.ts` tests pass **unmodified**.

### Out of scope

- The **131 warnings** (83 `max-lines-per-function` + 48 `complexity`), including
  `cloud-core/src/upload.ts` `uploadApp`, `sessionRunner.ts`, `reportWriter.ts`.
- The acquisition-side orphan noted in #157 (spec zip if `writeZip` throws mid-write; app zip if
  `statSync` throws right after) — a separate follow-up.
- The `FINALRUN_SUBMIT_TIMEOUT_MS` message/parser mismatch.
- Promoting lint rules to `error`; `report-web` backfill; Dependabot; splitting the oversized `ci`
  memory domain.

## Affected Memory

**Required.** `docs/memory/ci/pr-quality-gate.md` § Design Decisions ("Characterize around the absent
seam…") currently documents the collision as **present behaviour**:

> …temp-artifact uniqueness — `submit.ts` and `appBundle.ts` name their temp files
> `finalrun-cloud-${Date.now()}.zip` and `finalrun-app-${Date.now()}.zip`, millisecond resolution
> with no random component, so two submissions landing in the same millisecond share one path and
> either can unlink the other's in-flight upload.

This change makes that false. It must be updated to describe the collision-resistant naming and the
fact that uniqueness is now covered by a test — and the surrounding claim that uniqueness is an
"unreachable gap" no longer holds, since this change reaches it. Keep the `tempZipArtifacts()`
prefix-keying note, which stays accurate.

## Impact

- **Modified**: `packages/cloud-core/src/appBundle.ts`, `packages/cloud-core/src/submit.ts`
  (one line each, plus a `node:crypto` import), `packages/cloud-core/src/test/submit.test.ts`
  (new tests), `docs/memory/ci/pr-quality-gate.md`.
- **Expected diff**: small — two naming lines, one import, two tests, one memory edit.
- **Risk**: low. The change is additive to a filename. The real risk is a **weak test**: a
  concurrency test that passes for timing reasons rather than because the fix works. Stubbing
  `Date.now` is what removes that risk, and the fail-before-fix check is what proves it.
- **Expected outcome**: tests **366 → 368** (cloud-core 16 → 18); lint **131 warnings / 0 errors**
  unchanged; `max-depth` and `no-unused-vars` still zero.

## Open Questions

- `randomUUID()` (36 chars) vs a shorter `randomBytes(6).toString('hex')` (12 chars)? (Assumed
  `randomUUID` for zero-thought correctness; a shorter slug is fine — see Assumptions #3.)
- Keep the timestamp at all, now that randomness supplies uniqueness? (Assumed yes — it makes an
  orphaned temp file diagnosable; see Assumptions #4.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Fix both naming sites now, as their own change | Recorded as #157's first follow-up; the user asked for the next change; CodeRabbit raised it independently | S:95 R:85 A:90 D:95 |
| 2 | Certain | The bug is real and observed, not theoretical | Review hit an actual same-millisecond collision while instrumenting #157 on one machine | S:90 R:80 A:95 D:95 |
| 3 | Confident | Add a random component to the filename; keep prefix and `.zip` | Minimal, preserves the `tempZipArtifacts()` regex and all four existing cleanup assertions; `randomUUID` needs no new dependency | S:80 R:85 A:90 D:80 |
| 4 | Confident | Retain the timestamp alongside the random component | Keeps temp files sortable and diagnosable if one is ever orphaned; costs nothing | S:70 R:90 A:85 D:75 |
| 5 | Certain | Do NOT switch to `fs.mkdtempSync` | It would force cleanup from `unlinkSync` to recursive directory removal, reworking the exact `try`/`finally` scopes #157 restructured and review verified by instrumenting `unlinkSync` — a bad trade for a ~2⁻¹²⁸ residual | S:85 R:70 A:90 D:85 |
| 6 | Certain | Stub `Date.now` in the regression test | Makes the collision deterministic; without it the test usually reproduces but can pass spuriously — green on broken code, the worst flake direction | S:90 R:85 A:95 D:90 |
| 7 | Certain | The test MUST fail pre-fix | Same proof obligation as #155 and #157; a concurrency test that passes on broken code is worse than none | S:90 R:85 A:95 D:95 |
| 8 | Certain | Preserve #157's cleanup structure exactly | It was verified across seven exit paths by instrumenting `unlinkSync`; this change must not disturb it | S:90 R:75 A:95 D:90 |
| 9 | Confident | The uploaded `filename` is unaffected | `zipAppBundle` returns a `filename` of `${basename}.zip`, derived from the bundle name, not the temp path — but confirm against the existing `appFilename` assertion rather than assuming | S:80 R:85 A:85 D:85 |
| 10 | Certain | The memory update is REQUIRED | `pr-quality-gate.md` documents the collision as present behaviour and calls uniqueness an unreachable gap; this change falsifies both | S:90 R:85 A:95 D:95 |

10 assumptions (7 certain, 3 confident, 0 tentative, 0 unresolved).
