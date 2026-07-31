---
type: memory
description: "Per-test device log capture (manager, providers, Device integration) and the write-stream finalization contract: every exit from start/stop ends and flushes the log file's write stream through one shared `LogWriteStreamRegistry`, held per provider instance and keyed on the capture's output file path, so the file the CLI copies next is complete. `open()` records the first stream `error` and never throws; `finalize` decides the stop from the stream's terminal `'close'` state."
---
# Log Capture (device-node)

**Domain**: device-node

## Overview

Per-test device log capture for Android (logcat) and iOS (simctl log stream), mirroring the recording pipeline architecture. The non-obvious part is stopping: the file must be complete when the stop resolves, because the CLI copies it immediately afterwards.

## Architecture

The log capture system mirrors RecordingManager/RecordingProvider exactly:

- **`LogCaptureProvider`** (`src/device/LogCaptureProvider.ts`) -- interface with `startLogCapture`, `stopLogCapture`, `checkAvailability`, `cleanupPlatformResources`, plus `fileExtension` and `platformName` readonly properties.
- **`AndroidLogcatProvider`** (`src/device/AndroidLogcatProvider.ts`) -- clears ring buffer with `adb -s <serial> logcat -c` before capture, then spawns `adb -s <serial> logcat -v threadtime` piping stdout to a write stream. Uses injected `execFileFn` and `spawnFn` for testability.
- **`IOSLogProvider`** (`src/device/IOSLogProvider.ts`) -- spawns `xcrun simctl spawn <udid> log stream --style compact` piping stdout to a write stream. Same injected function pattern.
- **`LogCaptureManager`** (`src/device/LogCaptureManager.ts`) -- state-tracking controller. Implements `DeviceLogCaptureController` interface. Exposes `startLogCapture`, `stopLogCapture`, `abortLogCapture`, `cleanupDevice`.
- **`LogInfo`** (`src/device/LogInfo.ts`) -- state object tracking deviceId, filePath, runId, testId, platform, startTime, endTime.

## Key Patterns

- **Map key**: `{runId}###{testId}` (same delimiter as RecordingManager).
- **Three maps**: `_logProcessMap` (ChildProcess), `_logInfoMap` (LogInfo), `_deviceToLogKeysMap` (deviceId to keys).
- **Stopped set**: `_stoppedTestCases` Set prevents double-stop.
- **Output path**: `<os.tmpdir()>/finalrun-logs/{sanitizedRunId}_{sanitizedTestId}.log`. Never writes directly to the report directory — the CLI copies the finished file in and redacts it there ([/cli/report-writer.md](/cli/report-writer.md)).
- **Process stop**: SIGINT + `_waitForExit` (listens for `exit` event via `once`), then `LogWriteStreamRegistry.finalize(outputFilePath, stdout)` — drain `stdout` to EOF, end the write stream, await its terminal `'close'`. Both providers use this pattern, and both finalize on every other exit too (see the finalization requirement below).
- **Write-stream registry**: `LogWriteStreamRegistry` (`src/device/logWriteStream.ts`) is a **per-provider-instance** field (`private readonly _logStreams`), not a module-level singleton, and is keyed on `outputFilePath` — which `LogCaptureManager` derives from the same `(runId, testId)` pair as its own `mapKey`, so the key is that capture's identity. It is not re-exported from the package barrel.
- **Provider selection**: Constructor accepts optional providers map; defaults to `PLATFORM_ANDROID -> AndroidLogcatProvider`, `PLATFORM_IOS -> IOSLogProvider`.
- **Default instance**: `defaultLogCaptureManager` exported as a singleton.

## Device Integration

`Device` class (`src/device/Device.ts`) exposes four parallel methods to recording:
- `startLogCapture(request)` -- delegates to `DeviceLogCaptureController`
- `stopLogCapture(runId, testId)` -- delegates with platform from `this._platform`
- `abortLogCapture(runId, keepOutput)` -- delegates with deviceId and platform
- `logCaptureCleanUp()` -- called from `closeConnection()` after `recordingCleanUp()`

`GrpcDriverSetup.setUp()` (`src/grpc/GrpcDriverSetup.ts`) instantiates and injects `LogCaptureManager` into Device alongside RecordingManager. The per-test caller that drives start/stop/abort across one goal execution is [/cli/session-runner.md](/cli/session-runner.md).

## Error Handling

- Start failures return `DeviceNodeResponse { success: false }` and clean up map entries.
- Stop failures still finalize state (delete from maps, add to stopped set) to prevent leaks.
- File deletion on `keepOutput: false` uses `force: true` and logs warnings on failure.
- A write stream's own `error` is handled by the listener `open()` attaches, recorded on the registry
  entry, and reported by `finalize`'s terminal-state decision — never left to Node's
  unhandled-`error` throw (see the listener requirement below).

## Requirements

### Requirement: Every exit from a capture's lifecycle finalizes its write stream

A provider MUST end and flush the log file's write stream on **every** path out of
`startLogCapture` and `stopLogCapture`, not only the success path. `Readable.unpipe()` detaches a
pipe **without** ending the destination: anything still buffered is dropped, `finish` never fires,
and the file is silently truncated — so detaching alone is never a stop. Finalization happens
through `LogWriteStreamRegistry`, which drains the child's `stdout` to EOF (the pipe writes
everything the child produced), ends the write stream, and waits for its terminal `'close'`.

Two entry points express the difference in how a failure is reported:

- **`finalize(outputFilePath, source?)`** throws. It is the success path's call
  (`AndroidLogcatProvider.stopLogCapture`, `IOSLogProvider.stopLogCapture`): a log that could not be
  flushed is a failed stop, because the file is not known to be complete. Which streams that covers
  is settled by the stream's terminal state — whether it finished and closed un-errored — not by
  whether an `error` event was ever seen (see the terminal-state requirement below).
- **`finalizeQuietly(outputFilePath, source?)`** logs and swallows. It is the call on every path
  that is already returning a failure — a start that threw, a stop whose SIGINT was never delivered
  (an early return), and each provider's outer `catch` when `_waitForExit` throws. Those paths still
  MUST end the stream and drop its registry entry, but a finalization error there must not mask the
  failure being reported.

`finalize` is idempotent and cheap on repeat: an untracked path (a capture that never opened a
stream, or one an earlier stop already finalized) returns at once, a stream that has already ended
or been destroyed is not ended again, and the terminal-state wait is skipped once `stream.closed`
is true — which is what lets an error path call it without knowing whether the success path already
did.
Untracking and ending run in a `finally`, so a rejecting drain cannot strand a stream that nothing
else holds a handle on, and that rejection keeps precedence over the terminal-state decision after
it. A stream destroyed *by an error* still reaches `'close'`, so it is untracked and ended like any
other and then fails on the decision (below).

**Which of the two entry points the success path calls is only observable from outside a provider, so
it is pinned there.** A stop over a write stream whose asynchronous `open(2)` failed returns
`DeviceNodeResponse { success: false }` with a message naming the error and leaves no tracked entry
behind — the caller-visible half of the contract. Registry-level tests cannot reach it: they call
`finalize` themselves, so replacing the success path's `finalize` with `finalizeQuietly` in
`AndroidLogcatProvider.stopLogCapture` and `IOSLogProvider.stopLogCapture` — which restores a
successful stop over a log file that was never written — leaves every one of them green. The two
platform-parameterized failing-stream tests in
`packages/device-node/src/device/test/logCaptureProviders.test.ts` are what fail on that swap, and
are mutation-verified against exactly it. They assert the response, not registry internals: a real
unopenable path (its parent directory absent), the stream's `error` event awaited deterministically
rather than slept on, and `liveStreamCount` back to zero.

#### Scenario: buffered output is still complete on disk after the stop

- **GIVEN** a log capture whose child process has written data that is still buffered
- **WHEN** `stopLogCapture` resolves
- **THEN** the output file contains every byte the child produced

#### Scenario: the stop's signal is never delivered

- **GIVEN** a stop whose SIGINT delivery fails, so the provider returns a failure response early
- **WHEN** that early return runs
- **THEN** the write stream is ended, flushed and untracked first, and the failure response is what the caller receives

#### Scenario: finalizing twice, or finalizing a capture that never started

- **GIVEN** a path that was never opened, or one an earlier stop already finalized
- **WHEN** finalization runs
- **THEN** it resolves without throwing and without hanging

#### Scenario: the stop's write stream never opened

- **GIVEN** a capture started against an output path whose parent directory does not exist, so the
  stream's asynchronous `open(2)` fails with `ENOENT` after the start has already returned success
- **WHEN** `stopLogCapture` runs and its drain reaches EOF
- **THEN** the provider's response is `success: false` with a message naming the `ENOENT`, and the
  registry tracks no stream for that path

### Requirement: The stop's outcome is decided from the stream's terminal state

`finalize` MUST NOT decide success or failure until the tracked stream has reached its terminal
`'close'` state, and MUST then resolve iff `stream.writableFinished && stream.errored === null`.
`fs.WriteStream` always emits `'close'` (`emitClose` defaults true) — after `end()` → `finish` →
auto-destroy on the clean path, after `destroy(err)` on the failing one — so the wait terminates on
every tracked path, including a stream that already finished or was already destroyed; only an
already-`closed` stream skips it. The wait itself MUST NOT throw: the failure already lives in the
recorded entry error and `stream.errored`, and the decision is what reports it.

The wait is load-bearing because auto-destroy runs `close(2)` **after** `finish`: a stream can flush
completely and still fail on close (`EIO`), an error that arrives with `writableFinished` already
true. Deciding before it lands makes the outcome depend on which tick won — and the losing side is a
*successful* stop over a file whose durability the OS just refused to confirm, which the CLI then
copies. Waiting for `'close'` first is what makes the outcome a property of the stream's state rather
than of event timing.

On a stream that finished and closed cleanly, a recorded `entry.error` is stale: that state is
reachable only through a bare non-destroying `stream.emit('error', …)`, since every real fs error
either destroys the stream (`autoDestroy: true`) or arrives at close time and sets `errored`. Such a
stop succeeds, with a guarded warning naming the output file and the stale error — the contract keys
failure to the file not being known complete, and this file *is* complete. Every other terminal state
rejects with `entry.error ?? stream.errored`: the first recorded error ahead of whatever destroyed
the stream, with a synthesized error only for the in-principle-unreachable state where both are null.

#### Scenario: a close-time error arrives after a clean finish

- **GIVEN** a stream that emitted `finish` cleanly and then fails its close teardown with an `EIO`
- **WHEN** `finalize` — entered before that error landed — decides
- **THEN** it rejects with the close-time error deterministically, even though `writableFinished` is
  true and the flush itself completed

#### Scenario: a flushed log carries a stale non-destroying error

- **GIVEN** a stream that recorded a bare `error` event and then wrote, ended and closed cleanly
- **WHEN** `finalize` decides
- **THEN** the stop succeeds, the file on disk holds every byte written, and a warning names the
  output file and the stale error

#### Scenario: the stream was already destroyed and closed

- **GIVEN** a stream a failed asynchronous `open(2)` already destroyed and closed
- **WHEN** `finalize` runs
- **THEN** the terminal-state wait is skipped and the decision rejects at once with the recorded error

#### Scenario: the drain rejects before the decision runs

- **GIVEN** a stop whose drain rejects because the child's `stdout` emitted `error`
- **WHEN** `finalize` runs
- **THEN** the stream is still ended, closed and untracked, and the rejection carries the drain error
  rather than a redundant one

### Requirement: The drain wait is bounded, and its timeout degrades to a truncated log

Waiting for a stopped capture's `stdout` to reach EOF MUST be bounded — `LOG_DRAIN_TIMEOUT_MS`,
5000 ms. By the time a provider finalizes it has already awaited the child's `exit`, so the pipe is
draining a closed descriptor and reaches EOF in a few ticks; the bound exists for a child that
somehow outlives its own exit event. On timeout the source is `unpipe`d from the destination
**before** the stream is ended — a chunk arriving after `end()` raises
`ERR_STREAM_WRITE_AFTER_END`, which `pipe` re-emits as an unhandled `error` — a warning naming the
file is logged, and the stop still completes. **The accepted degradation is a possibly incomplete
log, never a stop that does not return**: an unbounded wait would hang the CLI, which is strictly
worse than a truncated diagnostic artifact.

#### Scenario: a child outlives its exit event

- **GIVEN** a stopped capture whose `stdout` has not reached EOF after 5 s
- **WHEN** the drain wait times out
- **THEN** the source is detached, a warning names the output file as possibly incomplete, the stream is ended and flushed, and the stop resolves

### Requirement: The write stream's `error` listener is attached at `open()`, records the first error, and never throws

`LogWriteStreamRegistry.open()` MUST attach the stream's `error` listener **before it returns** —
before anything can pipe into the stream — and the listener MUST stay attached for the stream's whole
life. `fs.createWriteStream` opens its fd asynchronously, so an `EACCES`, a missing `finalrun-logs`
directory or an `EMFILE` arrives as an `error` event well after `open()` has returned, and every
later write can fail the same way (`ENOSPC`). `Readable.pipe()` does **not** forward a destination's
errors to the source, so an `error` event with no listener is one Node throws: an
`uncaughtException` that takes the CLI down mid-run. The registry therefore tracks a per-path entry
(`{ readonly stream; error? }`) rather than the bare stream — module-private, like the registry
itself.

**The first error is recorded, not merely logged, and a later one MUST NOT overwrite it** — a second
event is fallout on an already-destroyed stream, while the first is what explains the failure.
Recording is what makes that first error outlive the event carrying it: `stream.errored` holds only
the error that *destroyed* the stream, so on a stream that failed twice it names the fallout rather
than the cause. The record is therefore what `finalize`'s rejection prefers ahead of
`stream.errored`, and on the one flushed-cleanly state a stale record survives into, it is what the
warning names. That decision MUST run **after** `finalize`'s `try`/`finally` and after the terminal
`'close'` (see the terminal-state requirement above): a drain rejection or a flush error is already
the failure being reported and keeps precedence, so nothing is masked by a redundant one.

**The listener MUST NOT throw.** It is the listener of last resort, so its `Logger.e` call is guarded,
and `finalizeQuietly`'s own `Logger.e` is guarded for the same reason: `finalize`'s rejection with a
recorded error is what makes that `catch` reachable on the very failure the guard exists for, and
`finalizeQuietly` MUST resolve for callers that are already returning a failure. The reason is
`Logger.e`'s **independent** fallibility: `Logger._emit`'s sink
loop (`packages/common/src/logger.ts`) runs every sink with no `try`/`catch`, and the CLI
installs `ReportWriter.createLoggerSink()` (`packages/cli/src/reportWriter.ts`), a bare
synchronous `fs.appendFileSync`, so a full disk, a permissions change or a removed artifacts
directory makes the log call throw on its own schedule. The two failures can also be one, but only
conditionally: the device log lives at `<os.tmpdir()>/finalrun-logs/…` and the runner log at
`<runDir>/runner.log` — **different directories**, so the `ENOSPC`-hits-both correlation holds only
where tmpdir and the artifacts directory share a filesystem. The guard does not rest on that
correlation. A throw from the listener escapes `emit('error')`, which Node calls on a tick with no
enclosing `try`, and becomes exactly the `uncaughtException` the listener exists to prevent; a lost
log line is the cheaper outcome, and the record is taken first so nothing the stop depends on is at
stake.

#### Scenario: a stream is handed out before it can fail

- **GIVEN** a stream just returned from `open()`
- **WHEN** its `error` listener count is read synchronously, before anything pipes into it
- **THEN** it is greater than zero, so no `error` event on that stream can ever be unhandled

#### Scenario: the asynchronous open fails

- **GIVEN** an output path inside a directory that does not exist
- **WHEN** the stream emits `error`
- **THEN** the error is recorded on the entry and logged, no uncaught exception is raised, and the
  subsequent `finalize` rejects with it — the stream never finished, so the file is not known to be
  complete

#### Scenario: a stream errors twice on its way to being destroyed

- **GIVEN** a stream that emits `error`, then a second different `error`, and is then destroyed by a
  third
- **WHEN** `finalize` runs
- **THEN** it rejects with the **first** error, ahead of the one `stream.errored` carries

#### Scenario: the logger sink fails alongside the stream

- **GIVEN** a `Logger` sink that throws — the shape the CLI's unguarded `fs.appendFileSync` sink takes
  on a full disk
- **WHEN** the stream's `error` listener runs, and later `finalizeQuietly` logs the rejection
- **THEN** neither throw escapes: no `uncaughtException` is raised, `finalizeQuietly` resolves, and
  `finalize` still rejects with the recorded error

## Design Decisions

### One shared write-stream registry serves both log providers

**Decision**: The write stream a log provider pipes `stdout` into is created and tracked by
`LogWriteStreamRegistry` in `packages/device-node/src/device/logWriteStream.ts`, and each provider
calls its `finalize`/`finalizeQuietly` in place of a bare `stdout.unpipe()`. The registry is a field
on each provider instance, and the module is absent from the package barrel.

**Why**: `stopLogCapture` receives only `{ process, outputFilePath }`, so it needs a way back to the
stream `startLogCapture` opened. Running the measured diff the mirror rule demands
([/device-node/android-ios-mirror.md](/device-node/android-ios-mirror.md)), the two providers'
versions of that bookkeeping come back identical modulo a log-prefix string — the affirmative case
that rule describes — so the shape it prescribes is a single-purpose, zero-branch-import leaf at the
two providers' common parent, kept out of the barrel. Per-instance rather than module-global because
a stream's lifetime belongs to the provider that opened it, and a process-wide map would keep
accumulating entries for captures whose provider is long gone.

**Rejected**: (a) a private `Map` in each provider — duplicates the one case the mirror rule says to
share; (b) widening `LogCaptureProvider` so the stream travels through `LogCaptureManager` — changes
a cross-package interface and puts a Node stream in the manager's vocabulary for no gain; (c)
keeping `unpipe()` and calling `end()` immediately — ends the destination before `stdout` has
drained, which truncates the file in a new way and errors on the in-flight write; (d) a
module-level singleton registry — the entry outlives the provider, so a leaked entry is unbounded
growth in a process-wide object rather than garbage collected with its owner.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### The finalization call site documents why detaching is not a flush

**Decision**: The comment at each provider's finalization call states the `unpipe()` semantics — a
detached pipe leaves the destination unended, so buffered output is dropped and the file the CLI
copies next is truncated — rather than restating the call it sits above.

**Why**: This truncation raises no error anywhere: a short log reads as a quiet device, so nothing
in a run's output distinguishes the two. The fact a future reader needs is the reason the
finalization cannot be simplified back to a detach, and that reason is not derivable from the code
in front of them. A comment restating the call carries none of it, and a comment asserting the data
is flushed while nothing ends the stream actively certifies the defect.

**Rejected**: (a) a comment restating the call (`// flush and close the stream`) — reads as a
guarantee, and nothing checks it against what the code does; (b) no comment at all — the next
reader re-derives "detaching is enough" from a pipe that visibly works.

*Introduced by*: 260730-zga4-drivers-ci-gate-audit-defects

### The stop's outcome is decided after `finalize`'s `try`/`finally`, never inside it

**Decision**: The `error` listener records the first error on the registry entry, and `finalize`
decides the stop only once its `try`/`finally` has completed without throwing. Recording is
required; logging alone is not.

**Why**: A drain rejection and a recorded write error both mean "the log is not known to be
complete", so either satisfies the "a write error fails the stop" contract — but deciding *after* the
`finally` gets precedence right for free and cannot replace an in-flight failure with a redundant
one. The recording half is what makes the rejection name the *cause*: `stream.errored` carries only
whatever destroyed the stream, which on a stream that failed twice is the fallout. It also closes the
half nothing in a run's output would reveal — an `error` event with no listener at all crashes the
CLI, and one that is logged and forgotten leaves the stop with no first error to prefer.

**Rejected**: (a) throwing inside the `finally` — masks a drain rejection with a redundant error;
(b) logging the error without recording it — the rejection then carries whichever error destroyed the
stream instead of the one that explains the failure; (c) attaching the listener in each provider — the
two versions would diff empty modulo a log prefix (the case the mirror rule says to share), and the
registry already owns this bookkeeping; (d) observing the error only through `await finished(stream)`
inside the finalization path — that listener does not exist until the stop runs, so an error emitted
earlier is still unhandled, and a rejecting wait would throw from the very path whose job is to end,
untrack and then *report* the failure.

*Introduced by*: 260730-eyvt-ci-cost-guards-carried-defects

### A listener of last resort guards its own log call, because not throwing is its contract

**Decision**: The `Logger.e` call inside the stream's `error` listener sits in its own `try`/`catch`
with an empty handler, after the error has been recorded; `finalizeQuietly`'s `Logger.e` is guarded
the same way. Nothing else in the listener can throw.

**Why**: A listener whose entire purpose is to keep an `error` event from becoming an
`uncaughtException` cannot itself be a source of one. `Logger.e` is fallible on its own schedule — an
unguarded sink loop reaching an unguarded `fs.appendFileSync` — so an unguarded log call there
converts the failure being handled into the failure being prevented, on a tick Node runs with no
enclosing `try`. Recording before logging is what makes swallowing the log line free: the record is
already in place for `finalize`'s decision to report, so only a diagnostic line is lost. This is
**not** the shape rejected in
[/cli/session-runner.md](/cli/session-runner.md): that rejection is scoped to the
acquisition-ordering problem, where two statements can be reordered and a local catch would patch
one call site while the next inserted statement stays lethal. Here there is nothing to reorder.

**Rejected**: (a) leaving `Logger.e` unguarded on the reading that a log call is not "fallible
enough" — the CLI's own sink makes it fallible, and the correlated `ENOSPC` case is the exact trigger
the listener was added for; (b) making the report-writer sink swallow its own errors instead — a
silently failing runner log is a worse default for every other caller (the same trade
[/cli/session-runner.md](/cli/session-runner.md) records); (c) guarding `finalize` too so a recorded
error is logged rather than thrown — that is `finalizeQuietly`, and collapsing the two loses the
distinction between a stop that failed and a path already reporting a failure.

*Introduced by*: 260730-eyvt-ci-cost-guards-carried-defects

### The stop succeeds iff the stream finished and closed un-errored, decided after the terminal `'close'`

**Decision**: `finalize` awaits the tracked stream's terminal `'close'` on every path — a plain,
never-rejecting listener, skipped only when `stream.closed` is already true — and then resolves iff
`stream.writableFinished && stream.errored === null`. A stale recorded error in that state is warned
about and the stop still succeeds; every other terminal state rejects with
`entry.error ?? stream.errored`.

**Why**: Deciding from error *history* — whether an error was ever recorded, read at whatever moment
the `finally` completes — is wrong in two directions from one root cause. It fails a log that was
flushed completely whenever a stale non-destroying record survives, contradicting this file's own
contract: that contract keys failure to the file not being known complete, and a stream that finished
and closed cleanly IS known complete. And it sees a close-time `EIO` (from the `close(2)` auto-destroy
performs after `finish`) only when that error happens to land before the read — a timing dependence
whose losing side reports success over a file whose durability the OS just refused to confirm, which
the CLI then copies. That is the data-integrity face, and it is why the wait comes first: with the
terminal state settled, the predicate can key on what the contract cares about. The wait runs even on
an already-finished or already-destroyed stream, because skipping it there is exactly where the
close-time window opens. Two independent reviewers converged on this reading: an operator-side
adversarial review rated it should-fix, and CodeRabbit rated the same `finalize` check MAJOR under
data integrity on PR #173, asking for the terminal-state wait and a regression test by name.

**Rejected**: (a) a bare `writableFinished` guard on the rejection — fixes only the stale-record face
and makes the other unconditional, since a close-time error is recorded *with* `writableFinished`
true, so the guard drops precisely the error that matters most; (b) unconditional rejection on any
recorded error — contradicts the flushed-log contract and leaves close-time observation racy, because
nothing waits for the error to arrive; (c) clearing `entry.error` once the flush resolves — the same
silent drop of close-time errors by another route; (d) `finished(stream)` or
`events.once(stream, 'close')` as the wait primitive — both reject when the stream errors while
waiting, and the wait must never throw: the failure already lives in the record and `stream.errored`,
and the decision is what reports it.

*Introduced by*: 260731-vojm-log-finalize-terminal-state

### The close-time failure is forced through the write stream's `_destroy` teardown seam

**Decision**: The test pinning deterministic close-time rejection overrides the tracked stream's
`_destroy` to run the real teardown and then hand its callback an `EIO`-shaped error, writes, `end()`s
and awaits `finish`, and only then calls `finalize`.

**Why**: A real `close(2)` failure cannot be provoked on a healthy fd, and the shape being pinned is
specific — `finish` first, error at close, `stream.errored` set while `writableFinished` is true.
`_destroy` is the documented `Writable` customization seam for exactly that teardown step, so the
test reproduces the production sequence instead of approximating it, and the fd is still really
closed.

**Rejected**: (a) `stream.destroy(err)` after `finish` — races auto-destroy's own `destroy()` call, so
it pins the window nondeterministically or not at all; (b) timing the error with a sleep — flaky by
construction, the shape this suite avoids everywhere else (its stream errors are awaited as events,
never slept on).

*Introduced by*: 260731-vojm-log-finalize-terminal-state

### The recorded error is consumed by the first finalization, and call ordering is documented rather than enforced

**Decision**: A recorded error survives only until the first finalization consumes it — `finalize`
drops the entry in its `finally` — so a `finalizeQuietly` running *before* a `finalize` for the same
path swallows the error and leaves the later `finalize` to find an untracked path and resolve. The
required ordering (`finalize` before any `finalizeQuietly` for the same path) is stated on
`finalizeQuietly`'s doc comment; `logWriteStream.ts` enforces nothing.

**Why**: What upholds the ordering lives outside the registry, which is exactly why a comment is the
right carrier — a reader of `finalizeQuietly` cannot recover it from the code in front of them. Both
providers' `stopLogCapture` run the loud call on the success path before any quiet catch-path call,
and every quiet-first path (a start that threw, a stop whose SIGINT was never delivered, a provider's
outer `catch` when `_waitForExit` throws) returns a failure response on its own, so no success is ever
reported over a swallowed error. **That invariant — not the swallow — is what makes the hazard safe,
and it is pinned on both platforms**: a capture over an unopenable path (recorded `ENOENT`) whose
stop's SIGINT is never delivered answers `success: false` naming the SIGINT failure, with
`liveStreamCount` back to zero. The one remaining sequence that could reach quiet-then-loud is a
second stop for the same capture, which `LogCaptureManager`'s `_stoppedTestCases` set covers
**sequentially only**: the `has()` early-return and the `add()` inside
`_finalizeStoppedLogCapture` straddle the awaited `provider.stopLogCapture(…)`, so overlapping
stop/abort calls for one `(runId, testId)` are a check-then-act race the set does not close — an
accepted, documented hazard. Enforcing the invariant inside the registry costs more than the hazard:
an errored entry kept as a tombstone is a leak, and the registry is a per-provider instance precisely
so entries are collected with their owner.

**Rejected**: (a) tombstoning errored entries so a later `finalize` still observes the error —
reintroduces the unbounded growth the per-instance registry design rejects; (b) making
`finalizeQuietly` preserve the entry — breaks its "end the stream and drop its entry" contract, which
is what every already-failing path calls it for; (c) a test pinning the second-stop-over-a-failed-
stream success — cements an accident as a contract, which is worse than an accepted, documented
hazard, so the quiet-first tests stop at the failure response and assert nothing about a later
`finalize` for the same path.

*Introduced by*: 260731-cjx8-provider-log-stop-test-coverage
