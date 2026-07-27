---
type: memory
description: "sessionRunner.ts — prepareTestSession/executeTestOnSession/runGoal: the per-call ExecutionSessionState every phase records its acquisition into, the single finally that releases whatever is still held, the recording and device-log capture lifecycles, and the CLI's two sanctioned dependency seams (TestSessionDeps and testRunnerDependencies)"
---
# Session Runner (cli)

`packages/cli/src/sessionRunner.ts` holds the CLI's device-session lifecycle: `prepareTestSession` (pick a target, start it if needed, connect the driver, install/launch the app), `executeTestOnSession` (recording + log capture around one goal execution), and `runGoal`, which composes the two for a single goal and is re-exported from the package index (`packages/cli/src/index.ts`) as the library entry point — no internal CLI command calls it. `runGoal` owns its own `finally`, releasing the session it prepared on every exit; the guarded `session.cleanup()` inside it is the same idempotent closure `prepareTestSession` handed back.

## prepareTestSession

`prepareTestSession(config, dependencies = testSessionDeps)` returns a `TestSession` — `{ deviceNode, device, deviceInfo, platform, app?, launchSummary?, cleanup }`. Phases are module-private helpers: `detectAndChooseEntry` (detect inventory, scope to the requested platform, auto-select or prompt), `startEntryAndReselect` (start a startable entry, re-detect, re-select), `establishDeviceSession` (`setUpDevice`, optional `installAppOverride`, optional `ensureAppReady`).

- `cleanup` is a closure over a `cleanedUp` flag, so calling it twice runs `deviceNode.cleanup()` once.
- The whole body sits in a `try`/`catch` that runs `cleanup()` — itself guarded, its own failure only warns — and rethrows, so a failure at any phase after `deviceNode.init` never leaks the device.
- A `startTarget` diagnostic, an entry that never becomes runnable, and an inventory with nothing usable all surface as `DevicePreparationError`, which carries the `DeviceInventoryDiagnostic[]` for the caller to print. The no-usable-target message is scoped to the requested platform when one was given.

## executeTestOnSession

`executeTestOnSession(session, config, dependencies = testSessionDeps)` builds the AI agent and executor, then runs a fixed phase sequence, each phase a module-private helper: `createSessionExecutor` → early return on an already-aborted signal → `wireAbortSignal` → `startRecordingPhase` → `startLogCapturePhase` → `executor.executeGoal` → `stopRecordingPhase` → `stopActiveLogCapture` → `composeFinalResult`. The whole body has a single `finally` running `releaseSessionResources`.

**`ExecutionSessionState` is the release-visible ledger.** A per-call object holds `abortListener`, `activeRecording` and `activeLogCapture` (each an `ActiveCapture` of `{ runId, testId, startedAt, keepPartialOnFailure }`). Every phase records what it acquired *into that object*, and `releaseSessionResources` releases exactly what is still recorded there, in order: abort listener removed, recording aborted, log capture aborted, renderer destroyed. The two device-side aborts are each individually `try`/`catch`ed and warn on failure, so neither can skip what follows it. A phase that completes its own teardown clears its slot (`state.activeRecording = undefined`) so the `finally` does not double-release.

**Recording.** Required when `config.recording` is set and the platform is Android. A start failure fails the run with a `Recording is required for Android runs.` result on Android and only warns elsewhere. `stopRecordingPhase` returns the recording record when a file path came back; a required recording that stops without one, or fails to stop at all, produces a message that is appended to the goal result via `markGoalResultFailed` rather than replacing it. A stop failure also best-effort `abortRecording`s before returning.

**Device-log capture.** Start failures never fail the run — a `success: false` response warns and a throw is caught and warned. Stop success falls back to the capture's own `startedAt` and to `new Date()` for `completedAt` when the driver omits them. A stop that reports failure aborts the capture with `keepPartialOnFailure` and yields no record. A stop that *throws* deliberately leaves `state.activeLogCapture` set, so the `finally` aborts it — the one path where the ledger entry outliving the phase is the point. The device side of the same lifecycle is [/device-node/log-capture.md](/device-node/log-capture.md).

**Result composition.** `composeFinalResult` merges `recording` and `deviceLog` onto the executor's result only when each is present, so an absent artifact leaves no key behind.

## Design Decisions

### An acquisition is recorded in the release-visible state before anything fallible follows it
**Decision**: The statement that records an acquisition in `ExecutionSessionState` comes *before* the log line announcing it, not after. `startRecordingPhase` and `startLogCapturePhase` both set `state.activeRecording` / `state.activeLogCapture` and only then call `Logger.i`.
**Why**: `Logger.i` is fallible here. The CLI installs `ReportWriter.createLoggerSink()` on the module-level `Logger`, and that sink is an unguarded synchronous `fs.appendFileSync` — a full disk, a removed run directory or a permissions change makes the log line throw. Announcing before recording means the throw escapes with the capture started on the device but absent from the ledger the `finally` reads, so it is never stopped or aborted: an orphaned `logcat`/`simctl` process on the device while the run reports normally. Ordering the two statements the other way costs nothing and makes the window not exist. This is the ordering facet of the `finally`-scope rule in [/ci/pr-quality-gate.md](/ci/pr-quality-gate.md); a green suite does not see it, so the pinning tests drive a throwing sink and assert the stop/abort still happens.
**Rejected**: (a) wrapping the log call in its own `try`/`catch` — it fixes this one call site and leaves the next fallible statement someone inserts between acquisition and registration equally lethal; (b) making the report-writer sink swallow its own errors — a silently failing runner log is a worse default than a loud one, and it would hide disk failures from every other caller too.
*Introduced by*: 260727-18tg-characterize-refactor-cli-giants

### The CLI has exactly two sanctioned dependency seams, known by name
**Decision**: `packages/cli` carries two deliberate, pre-existing dependency-injection seams and no others: `TestSessionDeps` in `sessionRunner.ts` — a per-call `dependencies` parameter defaulting to the exported `testSessionDeps`, taken by both `prepareTestSession` and `executeTestOnSession` — and `testRunnerDependencies` in `testRunner.ts`, a module-level mutable object whose members tests reassign and restore. A change that needs to know whether a CLI function is injectable checks these two by name.
**Why**: The two seams look nothing alike at a call site, so grepping for one shape finds only that one. `goalRunner.test.ts` exercises `prepareTestSession`/`executeTestOnSession`/`runGoal` entirely through `TestSessionDeps`, yet a search for the `testRunnerDependencies` pattern in `sessionRunner.ts` returns nothing and reads as "no seam exists" — a false negative that has already produced a scoping decision (a proposal to abandon characterizing `sessionRunner`) based on a seam that was there all along. Naming both is what makes the check cheap enough to actually perform.
**Rejected**: (a) unifying the two onto one shape — a refactor of working, tested infrastructure whose only benefit is making a grep easier, and the per-call parameter and the module-level object genuinely suit different call graphs (`runTests` is a top-level entry point with no caller to thread a parameter from); (b) treating "I found no seam" as sufficient evidence — the constitution forbids *adding* a seam for tests, so a false negative silently converts a tractable change into a deferred one.
*Introduced by*: 260727-18tg-characterize-refactor-cli-giants
