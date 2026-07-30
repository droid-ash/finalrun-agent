---
type: memory
description: "submit.ts + upload.ts + appBundle.ts — the millisecond-timeout env contract, stated once in the shared `timeoutEnv.ts` parser both submit and upload call (a positive integer *value*, so `1e3` and `0x10` are accepted and `1.5` is rejected, with no string-format regex) and the temp-zip lifecycle: adm-zip's `writeZip` is not atomic, so `zipAppBundle`'s cleanup scope opens before the call, and the success path hands ownership to the caller under the `isTempZip` contract"
---
# Submit Pipeline (cloud-core)

**Domain**: cloud-core

## Overview

`packages/cloud-core` submits a run to the cloud: `submit.ts` reads the environment contract, zips the spec files and uploads, `upload.ts` uploads a prepared app on its own, and `appBundle.ts` resolves the user's `--app` path into something uploadable, zipping a `.app` directory into `os.tmpdir()` when one is given. Both create temp artifacts, and each artifact's release is scoped to the acquisition that created it.

## Requirements

### Requirement: The millisecond-timeout env contract is defined once, for every variable that uses it

`parseTimeoutMsFromEnv(envVar, defaultMs)` in `packages/cloud-core/src/timeoutEnv.ts` is the **single**
definition of this contract, and every millisecond-timeout override MUST go through it — today
`FINALRUN_SUBMIT_TIMEOUT_MS` in `submit.ts` and `FINALRUN_UPLOAD_TIMEOUT_MS` in `upload.ts`, neither
of which keeps a local copy. The module is internal: it is absent from the package barrel.

The parser MUST accept only a parsed value that is both integral and positive
(`!Number.isInteger(parsed) || parsed <= 0` throws
`Invalid <VAR>=<json>: must be a positive integer (milliseconds).`), so the guard and the message
state one rule. The check tests the parsed **value**, never the literal's spelling: `'1e3'` and
`'0x10'` are accepted as `1000` and `16`, and `'1.5'` is rejected. A string-format regex MUST NOT be
introduced — it would reject integral spellings the message never promises to reject.
`Number.isInteger` subsumes the finiteness test (`NaN` and `±Infinity` are not integers), so there is
no redundant clause. An unset or empty variable falls back to the caller's default. Both directions
are pinned by tests, for both variables: the rejection of the fractional value and the acceptance of
the exponent and hex spellings.

#### Scenario: an integral value written in exponent notation

- **GIVEN** `FINALRUN_SUBMIT_TIMEOUT_MS='1e3'`
- **WHEN** the module is loaded
- **THEN** the submit timeout is 1000 ms and nothing is thrown

#### Scenario: a fractional value

- **GIVEN** `FINALRUN_SUBMIT_TIMEOUT_MS='1.5'`
- **WHEN** the module is loaded
- **THEN** loading throws `Invalid FINALRUN_SUBMIT_TIMEOUT_MS…`

#### Scenario: the upload variable answers identically

- **GIVEN** `FINALRUN_UPLOAD_TIMEOUT_MS='1.5'`, then `'1e3'`
- **WHEN** `upload.js` is loaded in each case
- **THEN** the first throws `Invalid FINALRUN_UPLOAD_TIMEOUT_MS="1.5": must be a positive integer (milliseconds).` and the second yields a 1000 ms timeout — the same rule, because it is the same function

### Requirement: The temp zip's cleanup scope encloses `writeZip`, which is not atomic

`zipAppBundle`'s cleanup scope MUST open **before** `zip.writeZip(zipPath)`, not after it. adm-zip's `writeFileTo` runs `openSync(path, 'w')` → `writeSync` → `closeSync` → `chmodSync`, so the file exists from the `openSync` onward and a throw at any later step leaves a created file that a scope opening after the call could never see. Everything between the acquisition and the `return` — the `fs.statSync` size read and the elapsed-time `Logger.i`, both fallible — sits inside that scope. On a throw the handler `unlinkSync`s the path, swallows any cleanup error, and rethrows the original. On the success path it MUST NOT unlink: the returned `uploadPath` carries `isTempZip: true` and the caller owns release from that point. Unlinking a path that was never created is already swallowed, which is what makes the wider scope free. This is the `finally`-scope rule of [/ci/pr-quality-gate.md](/ci/pr-quality-gate.md) at an acquisition that happens inside a call rather than at a statement boundary.

#### Scenario: the size read fails after the zip is written

- **GIVEN** a `.app` directory input and an `fs.statSync` that throws
- **WHEN** `prepareAppForUpload` runs
- **THEN** the original error propagates and no `finalrun-app-*.zip` remains in `os.tmpdir()`

#### Scenario: adm-zip's final write step fails

- **GIVEN** a `.app` directory input and an `fs.chmodSync` that throws for the output path — the last step of adm-zip's write, with the file already created and closed
- **WHEN** `prepareAppForUpload` runs
- **THEN** the original error propagates and no `finalrun-app-*.zip` remains in `os.tmpdir()`

#### Scenario: the zip is produced successfully

- **GIVEN** a `.app` directory input and a write that completes
- **WHEN** `prepareAppForUpload` returns
- **THEN** the temp zip still exists at `uploadPath`, `isTempZip` is `true`, and release is the caller's

## Design Decisions

### The temp zip is released by `catch`-and-rethrow, not by `finally`

**Decision**: The scope around `writeZip` is a `try`/`catch` that unlinks and rethrows, not a `try`/`finally`. Cleanup failures inside the handler are swallowed — the same ignore-cleanup-errors unlink idiom `submit.ts` uses — and the original error propagates unchanged.

**Why**: The success path must not unlink. `zipAppBundle` returns the path with `isTempZip: true`, and ownership transfers to the caller at that moment, so an unconditional `finally` would delete the artifact the function exists to produce. The failure path is the only one where the function still owns the file and no one else holds a reference, which is exactly what `catch` selects. Swallowing the cleanup error keeps the report pointing at the real fault: a cleanup `ENOENT` displacing the `EACCES` from `statSync` would be a strictly worse diagnosis of the same failure.

**Rejected**: (a) a `finally` consulting a success flag set just before the `return` — reconstructs at runtime what the two branches already express structurally, and the flag is one more thing to leave unset on a new exit path; (b) leaving the throw path to the caller's cleanup — the caller never receives the path on that path, so it has nothing to clean up; (c) returning a partial `PreparedApp` instead of rethrowing — hides a failed zip behind a payload that cannot be uploaded, converting a clear failure into a confusing one downstream.

*Introduced by*: 260728-o3me-fix-deferred-error-path-defects

### An environment-variable guard is defined by the parsed value, and its message is the contract

**Decision**: The `FINALRUN_SUBMIT_TIMEOUT_MS` contract is stated once, as a property of the parsed number — integral and positive — and the error message is treated as the authoritative wording of that property rather than as prose beside it. The accepted set is pinned in both directions, so neither a loosening nor an over-tightening passes unnoticed.

**Why**: The message is the only documentation a user of this variable gets, so a guard looser than its own message is a contract lie that surfaces at the worst moment — a fractional millisecond accepted and used as a timeout while the text says it cannot be. Testing the value rather than the literal keeps the narrowing minimal: `1e3` and `0x10` denote integers, so rejecting them would be a genuine regression for anyone using those spellings, introduced in the name of matching a message that never mentioned notation. Pinning acceptance as well as rejection is what makes that distinction survive: a test suite that only pins the rejection is equally satisfied by a regex that is far stricter than the contract.

**Rejected**: (a) a `/^\d+$/`-style format regex — rejects integral spellings the message accepts, re-introducing the same mismatch in the opposite direction; (b) loosening the message to match a permissive parser — the unit is milliseconds for a network timeout, and a fractional one is a caller mistake worth naming; (c) truncating or rounding a fractional value — accepts the mistake by silently changing it, so the configured value is not the one in effect and the caller never learns; (d) treating the mismatch as characterized behaviour to be preserved — pinning a contradiction makes it visible, not correct.

*Introduced by*: 260728-o3me-fix-deferred-error-path-defects

### The timeout parser is extracted for de-duplication; the tests still reach it through module load

**Decision**: `parseTimeoutMsFromEnv(envVar, defaultMs)` lives in an internal
`packages/cloud-core/src/timeoutEnv.ts`, imported by `submit.ts` and `upload.ts` and absent from the
package barrel. `submit.test.ts`'s existing module-load test is not modified and keeps reaching the
throw by dropping the require-cache entry and re-requiring `submit.js`; the `upload.js` test uses the
same seam.

**Why**: The contract above says it must be stated once, and two copies is how one of them came to be
looser than its own error message — a variable documented as accepting a positive integer while
accepting a fractional millisecond, in the module that had no tests. A single definition is what makes
the two unable to diverge again, and it is a de-duplication justified by a measured duplicate rather
than by anticipation. The module-load seam the existing test already uses is untouched by moving the
function, so that test's proof survives byte-for-byte.

**Rejected**: (a) correcting the looser guard in place — fixes one divergence and leaves the mechanism
that produced it; (b) importing the parser from the untested module into the well-tested one — makes
the more heavily tested module depend on the less tested one, and leaves a general-purpose parser in
a module about uploading; (c) exporting the parser from the barrel — it is an internal detail of two
modules, not API. The characterization rule's rejected alternative — exporting a timeout parser *so
tests can reach it* ([/ci/pr-quality-gate.md](/ci/pr-quality-gate.md)) — does not apply here: the test
path is unchanged, and the extraction is justified by the duplication rather than by test access.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects
