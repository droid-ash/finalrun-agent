# Intake: Fix the Temp App-Zip Cleanup Leak in `submitRun`

**Change**: 260726-rpx7-fix-submit-appzip-cleanup-leak
**Created**: 2026-07-26

## Origin

Direct follow-up to `260726-pvf3-characterize-refactor-cloud-submit` (PR #156, merged `a1199a7`),
where this bug was found and **deliberately deferred with a written fix spec**.

CodeRabbit raised it during #156's review. Investigation confirmed it was real but **pre-existing**:
on the pre-refactor `origin/main`, `prepareAppForUpload` was called at `submit.ts:83` while the `try`
whose `finally` deleted the temp zip only opened at `:151` — the same window, 68 lines wide. The
pipeline's own review stage independently reached the same conclusion. It was deferred because #156's
refactor was warranted as behaviour-preserving, and its 15 characterization tests existed precisely
to demonstrate that; changing error-path cleanup semantics inside it would have destroyed the
property those tests were written to prove.

This is the second instance of the same pattern: PR #154 surfaced a latent leak in `runTests`, #155
fixed it in its own change with a regression test. That worked, so this follows the same route.

> User direction: "merged, rebase and start next".

**Notable:** the Design Decision that names this exact failure mode — *`finally` scope follows the
acquisition, not the phase split* — already exists in `docs/memory/ci/pr-quality-gate.md`, written
during #155. It did not prevent this leak because the code predates it. The comment sitting on the
offending `try` today even asserts the invariant it violates (see What Changes §1).

## Why

**Problem.** In `submitRun`:

```ts
const appMode = resolveAppMode(input);          // may acquire a temp .app.zip
const filesToZip = collectFilesToZip(input);    // can throw
Logger.i(`Zipping ${filesToZip.length} file(s)...`);
const zipPath = writeSpecZip(filesToZip);       // can throw (AdmZip.addLocalFile)

try {
  … build form, upload, submit …
} finally {
  fs.unlinkSync(zipPath);                       // spec zip
  if (appMode.type === 'file' && appMode.prepared.isTempZip) {
    fs.unlinkSync(appMode.prepared.uploadPath); // app zip — only reachable from here
  }
}
```

When `input.appPath` is a `.app` **directory** (an iOS simulator build), `resolveAppMode` →
`prepareAppForUpload` zips it into a temp `.app.zip` and marks `isTempZip: true`. That file is
deleted **only** by the `finally` above. If `collectFilesToZip` or `writeSpecZip` throws — the latter
does so whenever a spec file is missing, since `AdmZip.addLocalFile` throws on a nonexistent path —
the `try` is never entered and the app zip is orphaned on disk.

**Consequence.** A leaked `.app.zip` is not a small artifact: it is a compressed iOS app bundle, tens
to hundreds of megabytes, left in the system temp directory. The trigger is an ordinary user error
(a spec path that no longer resolves) combined with an ordinary flag (`--app` pointing at a `.app`
directory). Repeat the mistake a few times and the leak is measured in gigabytes, with nothing in
the failure output telling the user a file was left behind.

**Why it survived.** The path has **no coverage**. #156's 15 characterization tests pin cleanup on
the success path and on the *request-failure* path (both of which enter the `try`), but nothing
exercises a throw *between* app resolution and entering the `try`. That gap is the reason this change
must add a test, not merely move a brace.

## What Changes

### 1. Give each acquisition its own `finally` (`packages/cloud-core/src/submit.ts`)

The principled shape — and the one the existing Design Decision prescribes — is nested scopes, each
opening immediately after the acquisition it releases:

```ts
const appMode = resolveAppMode(input);
try {
  const filesToZip = collectFilesToZip(input);
  Logger.i(`Zipping ${filesToZip.length} file(s)...`);
  const zipPath = writeSpecZip(filesToZip);
  try {
    … build form, upload, submit …
  } finally {
    // spec zip: acquired just above, released here
  }
} finally {
  // temp app zip: acquired by resolveAppMode, released here
}
```

A single `try` opened right after `resolveAppMode` with a `let zipPath: string | undefined` and an
`if (zipPath)` guard in the `finally` is an acceptable alternative. Nesting is preferred because it
makes each scope's correspondence to its acquisition structural rather than conditional.

**Cleanup ordering MUST be preserved.** Today the spec zip is unlinked before the app zip. Nesting
preserves that naturally (inner `finally` runs first) — confirm it rather than assume it.

**Also fix the misleading comment.** The comment currently above the `try` reads:

> The temp files (the spec zip above, and any temp .app.zip prepared during app resolution) are
> acquired before the request, so this finally encloses everything after acquisition — its scope
> follows the acquisition, not the phase split.

That is true of the spec zip and **false of the app zip**, which is acquired earlier and left
outside. Replace it with a comment that describes the new structure accurately; do not leave a
comment asserting an invariant the code breaks.

### 2. Add the missing regression test (`packages/cloud-core/src/test/submit.test.ts`)

One test for **a throw between app resolution and the cleanup `try`**, asserting the temp app zip is
released. A concrete recipe that uses only existing helpers:

- `appPath` → a real temp `.app` **directory** (so `prepareAppForUpload` produces a temp
  `.app.zip` with `isTempZip: true`). The existing `.app`-mode test already builds one.
- `checked.tests[0].sourcePath` → a path that does **not** exist, so `writeSpecZip`'s
  `AdmZip.addLocalFile` throws.
- Assert `submitRun` rejects, **and** that no `finalrun-app-*.zip` survives in `os.tmpdir()` — the
  same tmpdir-snapshot technique the existing cleanup tests use (`/^finalrun-(cloud|app)-.*\.zip$/`).

**This test MUST fail against the current code and pass after the fix.** Verify that ordering
explicitly — it is the whole proof, exactly as in #155. A test that passes before the fix is not a
regression test. Note this is the **inverse** of #156's characterization tests, which had to pass on
both sides.

### Behaviour that MUST NOT change

- The rejection surfaced to the caller: the error from `writeSpecZip`/`collectFilesToZip` must
  propagate unchanged. Cleanup must not swallow or replace it.
- Cleanup errors stay swallowed. Both `unlinkSync` calls are wrapped in `try {} catch {}` today
  precisely because they run in a `finally` and would otherwise mask the in-flight error. Keep that.
- Spec-zip-before-app-zip unlink order.
- All 15 existing `submit.test.ts` tests must pass **unmodified**. If one needs editing, that is
  evidence the fix changed more than intended.

### Out of scope

- The remaining **131 warnings** (83 `max-lines-per-function` + 48 `complexity`), including
  `cloud-core/src/upload.ts` `uploadApp` and the untested `sessionRunner.ts` / `reportWriter.ts`.
- The `FINALRUN_SUBMIT_TIMEOUT_MS` message/parser mismatch (the guard accepts `1.5` while the message
  promises a positive integer) — also deferred from #156, its own change.
- Promoting lint rules from `warn` to `error`; `report-web` test backfill; Dependabot.
- Any change to `prepareAppForUpload` itself, or to when a temp zip is created.

## Affected Memory

Likely none, but hydrate MUST verify rather than assume — this touches a resource-lifecycle contract,
and the relevant Design Decision already exists.

- `ci/pr-quality-gate` § Design Decisions already contains *"`finally` scope follows the acquisition,
  not the phase split"* (from #155). This change is a second application of that rule, not a new
  one — so the likely correct outcome is **no memory change**. Hydrate should check whether the DD
  merits a note that it applies to *every* acquisition in a function, not just the last one, since
  that is precisely the reading this leak violated.
- Grep `docs/memory/**` for `submitRun`, `resolveAppMode`, `prepareAppForUpload`, temp-zip and
  cleanup lifecycle before concluding.

## Impact

- **Modified**: `packages/cloud-core/src/submit.ts` (brace/scope move + comment),
  `packages/cloud-core/src/test/submit.test.ts` (one new test).
- **Expected diff**: small — a restructured `try` boundary, a corrected comment, one test.
- **Risk**: low. The change is a few lines in a function that now has 15 characterization tests
  guarding it, and the new test proves the specific behaviour being fixed. It is a **deliberate
  behaviour change on an error path** — cleanup now runs where it previously did not — so the
  no-behaviour-change rule from #156 explicitly does not apply here.
- **Expected outcome**: tests **365 → 366** (cloud-core 15 → 16); lint **131 warnings / 0 errors**
  unchanged; `max-depth` and `no-unused-vars` still zero. Note the added nesting must not push
  `submitRun` past `max-depth 4` — check.

## Open Questions

- Nested `try` blocks vs a single `try` with `let zipPath: string | undefined`? (Assumed nested — see
  Assumptions #3.)
- Should the leak also be reported to the user (a warning naming the orphaned file) rather than
  silently cleaned? (Assumed no — out of scope; silent cleanup matches the existing contract.)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Fix this now as its own change | Deferred from #156 with a written four-step spec, and the user asked for the next change | S:95 R:85 A:90 D:95 |
| 2 | Certain | The bug is real and pre-existing, not introduced by #156 | Verified against pre-refactor `origin/main`: acquisition at `:83`, cleanup `try` at `:151` — same window; both CodeRabbit and the pipeline review agreed | S:90 R:85 A:95 D:95 |
| 3 | Confident | Nested `try`/`finally`, each opening immediately after its acquisition | Makes the scope-follows-acquisition rule structural rather than conditional; a single `try` with an `undefined`-guarded `zipPath` is an acceptable alternative | S:75 R:80 A:85 D:75 |
| 4 | Certain | This change INTENTIONALLY changes behaviour on an error path | It is a bug fix; cleanup now runs where it did not. #156's no-behaviour-change contract does not carry over | S:90 R:70 A:90 D:90 |
| 5 | Certain | A regression test is mandatory and MUST fail pre-fix | Absence of coverage on this path is why the leak survived two reviews; verifying fail-then-pass is the proof, as in #155 | S:90 R:85 A:95 D:95 |
| 6 | Confident | Force the throw via a nonexistent spec `sourcePath` (so `AdmZip.addLocalFile` throws) plus a real `.app` directory | Uses only existing test helpers, and models a genuine user error rather than an artificial stub | S:75 R:85 A:85 D:80 |
| 7 | Certain | Preserve error propagation, swallowed cleanup errors, and unlink order | The `catch {}` wrappers exist so cleanup cannot mask the in-flight error; order is observable via the tmpdir-snapshot tests | S:90 R:80 A:95 D:90 |
| 8 | Certain | Fix the comment that claims the invariant the code violates | It currently asserts the `finally` "encloses everything after acquisition", which is false for the app zip — a misleading comment is worse than none | S:90 R:90 A:90 D:90 |
| 9 | Confident | Test count must rise (365 → 366); all 15 existing tests pass unmodified | A flat count means the regression test was not added; an edited existing test means the fix changed more than intended | S:80 R:85 A:85 D:85 |
| 10 | Confident | Verify the added nesting does not breach `max-depth 4` | The repo holds `max-depth` at zero violations tree-wide; a new one would be a regression introduced by this fix | S:75 R:90 A:85 D:80 |

10 assumptions (7 certain, 3 confident, 0 tentative, 0 unresolved).
