# Intake: Fix Deferred Error-Path Defects

**Change**: 260728-o3me-fix-deferred-error-path-defects
**Created**: 2026-07-28

## Origin

> merged, start next

This change is the next step in the 13-PR code-quality initiative that began with the user's
request: *"suppose we want to support proper TDD and improve the code. where to start what to
follow, what to cover? end goal is test should run at PR opening and code should improve:- 1.
code readability - less number of lines( suggest) 2. DRY 3. YAGNI 4. Function should be just
50-60 lines and max depth should be less than or equal to 4."*

Across changes #155–#163, every refactor held a strict **zero-behaviour-change** contract. When a
refactor surfaced a latent defect, fixing it inside that refactor would have broken the contract
and destroyed the equivalence proof, so each was deliberately deferred to its own change with its
own test. Six such deferrals accumulated. This change drains that queue.

The deferrals were not vague notes — several are recorded in-code. `SimctlClient._trimmed` carries
a doc comment stating the cast semantics were preserved verbatim through the refactor; and
`submit.test.ts` carries an explicit characterization test whose comment reads *"reconciling
message and parser is a behaviour change, recorded as follow-up in this change's plan.md."*
This change is that follow-up.

### Scope corrections made during intake

Three findings changed the scope from the six items as originally queued. They are recorded here
because each contradicts the queue's own wording and apply must not re-derive the wrong version:

1. **The "emulator output cap" item is two sites, not one.** A sweep of every `on('data')`
   accumulator in `device-node` found two unbounded buffers, not one — and two more that are
   already correct (see Non-Goals). The queue named only one.
2. **The `getPlatform()` item is behaviour-preserving.** `PLATFORM_IOS` is literally `'ios'`
   (`packages/common/src/constants.ts:8`), so the local expression and `getPlatform()` are exactly
   equivalent. It therefore takes a **characterization** test (must pass before *and* after), not
   a regression test. The queue's blanket "every fix needs a test that fails before it" is wrong
   for this one item.
3. **The timeout mismatch is narrower than stated.** The queue said the parser wrongly accepts
   `1.5`, `1e3` and `0x10`. Only `1.5` is a genuine mismatch: `Number('1e3')` is `1000` and
   `Number('0x10')` is `16` — both *are* positive integers, so the message's promise is already
   satisfied for them. The fix must reject fractional values only, and must NOT reject `1e3`.

## Why

**The problem.** Seven defects sit on error paths in shipped code. Error paths are the least
exercised and least observed part of any system, which is exactly why these survived: each fires
only when something else has already gone wrong, so the symptom is attributed to the original
fault rather than to the handler. Two of them (`_trimmed`, `adbPath!`) convert a recoverable
condition into a crash or a confusing downstream failure; two are unbounded-memory growth; one is
a documented contract lie; one leaks a temp file; one is duplicated logic that will drift.

**What happens if we don't.** They stay invisible until a user hits them in the field, where the
diagnostic context is worst. Concretely: a malformed `Info.plist` with a numeric `CFBundleVersion`
currently throws `value?.trim is not a function` out of iOS app enumeration — a TypeError whose
text names an internal expression and tells the user nothing about their app. A long recording
session grows two arrays for its entire lifetime that **nothing ever reads after startup**. And
the `FINALRUN_SUBMIT_TIMEOUT_MS` error message actively lies to whoever reads it.

**Why now, and why batched.** The Batching Design Decision recorded in
`docs/memory/ci/pr-quality-gate.md` established that per-change ceremony cost is fixed, so the
unit of work should be a coherent family rather than one item. These seven share one shape —
*deferred error-path defect, needs a test* — and cluster two-to-three per package. Batching also
lets one reviewer hold the class in mind, which is how the mirror sweep above found the second
unbounded buffer that per-item work would have missed.

**Why not just leave them.** Each was deferred with an explicit promise of a follow-up, two of
them written into the source and test files. Leaving them turns a deliberate, documented deferral
into an undocumented defect — the worst of both.

## What Changes

Seven fixes. Each gets a test. The test *kind* differs per fix and is stated explicitly, because
conflating the two kinds produces a worthless suite: a **regression** test must fail before the
fix and pass after (it proves a bug existed); a **characterization** test must pass before *and*
after (it proves equivalence).

### 1. device-node — `SimctlClient._trimmed` type safety

`packages/device-node/src/infra/ios/SimctlClient.ts:550`

```ts
private _trimmed(value: unknown): string | undefined {
  return (value as string | undefined)?.trim();
}
```

The cast is a lie: the parameter is `unknown` and the values come from `JSON.parse` of
`simctl listapps` output. A non-string, non-nullish value reaches `.trim()` and throws
`TypeError: value?.trim is not a function`. Eight call sites feed it, including
`CFBundleVersion`, `CFBundleName` and `ApplicationType` — all fields a malformed or unusual
`Info.plist` can carry as a number or nested object.

The throw is **user-reachable**, not internal: the existing doc comment on the method records
that it is caught by `_listInstalledAppMetadata` and propagated verbatim as `message` by
`uninstallUserApps` and `isAppInstalled`.

Fix — make the runtime behaviour match the declared `unknown` parameter:

```ts
private _trimmed(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}
```

**Behaviour change**: a non-string field now yields `undefined` and falls through to the
existing fallback chain (`|| fallbackName`, `?? null`, the `com.apple.` prefix default) instead
of aborting enumeration of the entire app list. This is strictly better: one malformed field in
one app currently fails the whole listing.

**Test kind: regression.** Feed `_trimmed`'s enclosing path a record with a numeric
`CFBundleVersion`; assert it throws today and returns a record with `version: null` after. Also
update the method's doc comment — it currently explains why the unsafe cast was *preserved*, and
that rationale expires with this fix.

### 2. device-node — bound `AndroidRecordingProvider._spawnScrcpy` output

`packages/device-node/src/device/AndroidRecordingProvider.ts:232-249`

```ts
process.stdout?.on('data', (data: Buffer | string) => {
  const message = String(data);
  stdoutChunks.push(message);          // never bounded, never cleared
  Logger.i(`scrcpy stdout: ${message}`);
});
```

The **only** consumer of these arrays is `_formatStartupExit`, reachable only from
`_waitForStableStartup` — i.e. during startup. Once the recording is running, the listeners keep
pushing for the entire recording lifetime and **nothing ever reads the result**. That is
unbounded growth in service of no consumer: a YAGNI violation and a slow leak in the same
statement.

### 3. device-node — bound `DeviceDiscoveryService` emulator capture

`packages/device-node/src/discovery/DeviceDiscoveryService.ts:611-619`

```ts
capture.child.stdout?.on('data', (chunk: Buffer | string) => {
  capture.stdoutChunks.push(String(chunk));
});
```

Same defect, different shape: the emulator child is spawned `detached` and long-lived, and its
chunks are consumed only by `_emulatorTranscript` for a `CommandTranscript`.

### Fixes 2 and 3: use the idiom the repo already has

The codebase already answers "how do we bound a diagnostic buffer" — `AndroidDeviceSetup.ts:245`
and `IOSSimulatorSetup.ts` both do:

```ts
state.recentLogs.push(`${source}: ${trimmed}`);
if (state.recentLogs.length > 20) {
  state.recentLogs.shift();
}
```

Fixes 2 and 3 SHALL adopt this same bounded-ring shape (retain the most recent N, drop the
oldest) rather than inventing a policy. Keeping the *most recent* chunks is also the better
diagnostic: for a startup failure the process exits almost immediately so first and last coincide,
while for a long-running process the tail is what explains the failure.

**On sharing a helper**: the two sites have genuinely different shapes — fix 2 closes over two
local arrays and returns them; fix 3 mutates a `capture` object field. Per the mirror rule
established in change #160 (`docs/memory/device-node/android-ios-mirror.md`), share only what a
**measured** diff shows to be identical, never what is merely parallel-shaped. Apply SHALL
measure before extracting: a shared bound *constant* is very likely correct; a shared push helper
is only correct if the bodies actually converge. Do not force a helper to satisfy DRY.

**Test kind: regression.** Drive more than N chunks into a stubbed child process and assert the
retained length is capped, and that the retained content is the tail. Both providers already have
test files with spawn stubs (`AndroidRecordingProvider.test.ts`, and the discovery service's
suite), so the seam exists.

### 4. cli — use `DeviceInfo.getPlatform()` instead of re-deriving it

`packages/cli/src/sessionRunner.ts:202`

```ts
const platform = deviceInfo.isAndroid ? PLATFORM_ANDROID : 'ios';
```

`DeviceInfo` already exposes exactly this (`packages/common/src/models/DeviceInfo.ts:42`):

```ts
getPlatform(): string {
  return this.isAndroid ? PLATFORM_ANDROID : PLATFORM_IOS;
}
```

Two defects in one line: the logic is duplicated, and the duplicate hardcodes the bare string
`'ios'` where the model uses the `PLATFORM_IOS` constant. If the constant ever changes, this line
silently diverges. Fix: `const platform = deviceInfo.getPlatform();`

**This is behaviour-preserving.** `PLATFORM_IOS === 'ios'` (`packages/common/src/constants.ts:8`),
so the two expressions are exactly equivalent today — which is precisely why the duplication is
safe to remove now and dangerous to leave.

**Test kind: characterization.** Assert both branches (`isAndroid` true and false) produce
`'android'` / `'ios'`, and confirm the test passes on `origin/main` *before* the edit. A test that
only passes afterwards would prove nothing here.

### 5. cli — guard `adbPath` instead of asserting it away

`packages/cli/src/sessionRunner.ts:332`

```ts
const installed = await params.deviceNode.installAndroidApp(
  params.adbPath!,   // <- non-null assertion
  params.deviceInfo.id,
  params.appOverridePath,
);
```

`AdbPath` is `Awaited<ReturnType<CliFilePathUtil['getADBPath']>>` and is nullable — every other
use in the file passes it unasserted to `detectInventory`, which accepts the nullable type. The
`!` exists solely because `installAndroidApp` requires non-null, and it silences a reachable case
rather than handling it.

Note the immediately preceding lines already guard the *sibling* precondition:

```ts
if (!params.deviceInfo.id) {
  throw new Error('Android device serial is required to install an app override.');
}
```

Fix: add the matching guard for `adbPath` in the same shape and voice, then drop the `!`.

**Test kind: regression.** Invoke the app-override install path with `adbPath: null`; assert a
descriptive `Error` today's code does not produce. Fails before, passes after.

### 6. cloud-core — make the timeout parser match its own error message

`packages/cloud-core/src/submit.ts:59-68`. The message promises *"must be a positive integer
(milliseconds)"* but the guard only rejects non-finite and non-positive values, so `1.5` is
accepted. Fix: additionally require `Number.isInteger(parsed)`.

**Precisely scoped** (per Origin correction 3): this rejects fractional values only. `1e3` and
`0x10` denote the integers `1000` and `16` and MUST continue to be accepted — `Number.isInteger`
tests the resulting *value*, not the literal's spelling. Apply MUST NOT add a string-format regex.

**Test kind: regression, by converting an existing characterization test.**
`packages/cloud-core/src/test/submit.test.ts:582-588` currently pins the mismatch:

```ts
// Characterization, not endorsement: ... a fractional value is ACCEPTED even though
// the error text promises "a positive integer". Pinned here so the mismatch is visible
// and cannot change unnoticed; reconciling message and parser is a behaviour change,
// recorded as follow-up in this change's plan.md.
process.env['FINALRUN_SUBMIT_TIMEOUT_MS'] = '1.5';
assert.doesNotThrow(reload, 'fractional values are accepted by the current parser');
```

This assertion MUST be **converted** to `assert.throws(reload, /Invalid FINALRUN_SUBMIT_TIMEOUT_MS/)`
and its comment rewritten — not deleted. Deleting it would silently drop the coverage. Apply
SHALL also add `1e3` to the accepted set so the narrowing is pinned in both directions.

### 7. cloud-core — close the acquisition-side temp-zip orphan

`packages/cloud-core/src/appBundle.ts:92-94`

```ts
zip.writeZip(zipPath);              // <- acquisition
const size = fs.statSync(zipPath).size;   // <- fallible, outside any cleanup scope
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
Logger.i(`Zipped ${basename} in ${elapsed}s`);
return { uploadPath: zipPath, ... };
```

`writeZip` creates the file; the caller can only clean it up once `createAppBundle` **returns**
the path. If `statSync` throws (EACCES, ENOENT on a vanished file) or `Logger.i` throws, the
function exits without returning and the zip is orphaned in `os.tmpdir()` with no reference.

This is the `finally`-scope rule from `docs/memory/ci/pr-quality-gate.md` applied consistently:
*every acquisition independently needs a `finally` whose `try` opens immediately after it.* The
sibling case — spec zipping failing after the app zip is acquired — was already fixed in #157/#158
and is pinned by `submit.test.ts:407`. This is the same defect one frame earlier, and it is the
last uncovered window.

Fix: open the cleanup scope immediately after `writeZip`, so any throw between acquisition and
return unlinks the file and rethrows.

> **Corrected during review — this paragraph is wrong as written, kept for traceability.** It
> treats `writeZip` as atomic. It is not: adm-zip's `writeFileTo` does `openSync(path,'w')` →
> `writeSync` → `closeSync` → `chmodSync`, so the file exists from the `openSync` onward and a
> throw from any later step leaves it behind — where a scope opening *after* the call can never
> see it. The scope must open **before** `writeZip`. The rule's real content is that the scope
> must enclose the **acquisition point**, and the acquisition point is not always the call
> boundary. See `plan.md` R8 and the refined rule in `docs/memory/ci/pr-quality-gate.md`.

**Test kind: regression.** Stub `fs.statSync` to throw via `mock.method(fs, 'statSync', ...)` —
`appBundle.ts` calls it through the `fs` namespace, so the seam works — then assert
`tempZipArtifacts()` is unchanged. The helper already exists at `submit.test.ts:103`.

### Non-Goals

Recorded so review does not re-litigate them; each was checked, not assumed:

- **`AndroidDeviceSetup` / `IOSSimulatorSetup` `appendLog`** — already bounded (`recentLogs`,
  cap 20, `shift()`). No change. These are the source of the idiom fixes 2 and 3 adopt.
- **`IOSRecordingProvider`** — its `on('data')` handlers log without accumulating
  (`IOSRecordingProvider.ts:59-63`). This asymmetry with Android is **correct**, not an
  oversight: iOS has no scrcpy-equivalent startup-diagnostic buffer to bound. Do not "fix" it.
- **`AndroidLogcatProvider` / `IOSLogProvider` `stderr` handlers** — out of scope for this change;
  they belong to the log-capture lifecycle, not the deferred queue.
- **No refactoring.** Function-length, depth and complexity work is finished for these files.
  Touch only what each fix requires.
- **The `ci` memory-domain split** (~38KB against a ~15KB soft cap) stays queued as a separate
  `/docs-reorg-memory` job. This change does not migrate existing content — but see fix 7's memory
  target: new cloud-core facts go to a new domain rather than making the overload worse.

## Affected Memory

- `device-node/android-ios-mirror.md`: (modify) `_trimmed` now type-safe rather than a preserved
  unsafe cast; the two diagnostic buffers bounded via the existing `recentLogs` ring idiom; and
  the verified-correct asymmetry — `IOSRecordingProvider` accumulates nothing because it has no
  startup-diagnostic consumer, while `AndroidDeviceSetup`/`IOSSimulatorSetup` were already bounded
- `cli/session-runner.md`: (modify) platform derivation now delegates to `DeviceInfo.getPlatform()`
  rather than re-deriving it; `adbPath` guarded in the same shape as the adjacent device-serial
  guard instead of asserted away
- `cloud-core/submit-pipeline.md`: (new) new domain — the `FINALRUN_SUBMIT_TIMEOUT_MS` contract
  (message and parser now agree; integral *values* accepted regardless of literal spelling) and
  the complete temp-zip lifecycle including the acquisition-side scope

## Impact

**Six source files** (1 cli with two sites, 3 device-node, 2 cloud-core) plus their test files.
Every edit is local — no signature changes on exported APIs, no new dependencies, no config
changes. (Apply added a seventh: `packages/device-node/src/diagnosticBuffer.ts`, the shared bound
constant for fixes 2 and 3.)

| Package | Source | Tests |
|---|---|---|
| device-node | `infra/ios/SimctlClient.ts`, `device/AndroidRecordingProvider.ts`, `discovery/DeviceDiscoveryService.ts` | existing suites for all three |
| cli | `sessionRunner.ts` (two sites) | `src/test/sessionRunner.test.ts` |
| cloud-core | `submit.ts`, `appBundle.ts` | `src/test/submit.test.ts` |

**Blast radius.** Four fixes change observable behaviour on error paths (1, 5, 6, 7); one changes
memory retention only (2, 3); one changes nothing observable (4). No happy path changes in any of
the seven.

**Gate.** The five-stage CI gate (`npm ci` → build → typecheck → test → lint) must stay green, and
the change must add **zero** new lint warnings. Current baseline: **460 tests / 0 failures**,
**78 warnings / 0 errors**. Two principles must stay at zero, as they have for nine consecutive
changes: `max-depth` and `no-unused-vars`.

## Open Questions

None blocking. The one genuine judgement call — the retention bound N for fixes 2 and 3 — is
recorded as a graded assumption below rather than a question, because the repo supplies a
precedent (20) and the value is trivially reversible.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Batch all seven fixes in one change rather than splitting per package | The Batching Design Decision in `ci/pr-quality-gate.md` settles this: ceremony cost is fixed per change, and a shared class is the right unit. Batching is what surfaced the second unbounded buffer | S:75 R:85 A:85 D:75 |
| 2 | Certain | Fix 4 takes a characterization test, not a regression test | Verified `PLATFORM_IOS === 'ios'` in `common/src/constants.ts:8`, so the change is provably behaviour-preserving. A fails-before test is impossible and demanding one would force a fake | S:90 R:90 A:95 D:90 |
| 3 | Certain | Fix 6 rejects fractional values only; `1e3` and `0x10` keep working | `Number.isInteger` tests the parsed value, and both denote integers. The queue's wording was wrong; a format regex would be a real regression for anyone using exponent notation | S:85 R:85 A:80 D:80 |
| 4 | Certain | Leave `appendLog` and `IOSRecordingProvider` alone | Both were read, not assumed: the first is already capped at 20 with `shift()`, the second accumulates nothing because it has no consumer to serve. Changing either would be churn | S:80 R:90 A:95 D:90 |
| 5 | Confident | Bound fixes 2 and 3 with the in-repo ring idiom (retain most recent, drop oldest) | Reusing the established `recentLogs` shape is the DRY answer and avoids inventing policy. The tail is also the better diagnostic for a long-running process | S:60 R:80 A:80 D:65 |
| 6 | Confident | Use one shared bound constant, and extract a shared push helper only if a measured diff justifies it | Per the #160 mirror rule: share on measured identity, never on parallel shape. The two sites differ structurally, so a forced helper would be worse than duplication | S:55 R:85 A:85 D:70 |
| 7 | Confident | `_trimmed` returns `undefined` for non-strings rather than throwing a clearer error | The eight call sites all have working fallbacks, so falling through degrades one field instead of failing the whole app listing. Matches the declared `unknown` parameter | S:75 R:80 A:80 D:70 |
| 8 | Confident | Fix 5 throws a descriptive error rather than skipping the install silently | Mirrors the device-serial guard three lines above in shape and voice. A silent skip would report success for an install that never happened | S:70 R:85 A:80 D:75 |
| 9 | Confident | Fix 7 is worth doing despite a narrow trigger window | It is the last uncovered window in a lifecycle whose other two windows already have regression tests, and it applies the recorded `finally`-scope rule consistently rather than selectively | S:70 R:85 A:75 D:75 |
| 10 | Confident | cloud-core facts go to a new `cloud-core` memory domain, not into `ci/pr-quality-gate.md` | That file is already ~38KB against a ~15KB cap. Adding there worsens a known overload; a new domain is where these facts belong anyway and does not pre-empt the queued split | S:55 R:75 A:85 D:80 |

10 assumptions (4 certain, 6 confident, 0 tentative, 0 unresolved).
