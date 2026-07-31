import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcess } from 'child_process';
import { Logger, type LoggerSink } from '@finalrun/common';
import { AndroidLogcatProvider } from '../AndroidLogcatProvider.js';
import { IOSLogProvider } from '../IOSLogProvider.js';
import { LogWriteStreamRegistry } from '../logWriteStream.js';
import type { LogCaptureProvider } from '../LogCaptureProvider.js';

/**
 * How the fake child reacts to `kill('SIGINT')`:
 * - `exits` — the signal lands and the child exits (the success path).
 * - `signal-undelivered` — `kill` returns `false` and the child keeps running,
 *   so its `exitCode` stays `null`: the provider's early-return path.
 * - `exit-errors` — the signal lands but the child emits `error` instead of
 *   `exit`, so `_waitForExit`'s `once(process, 'exit')` rejects: the provider's
 *   outer catch path.
 */
type FakeChildBehaviour = 'exits' | 'signal-undelivered' | 'exit-errors';

class FakeChildProcess extends EventEmitter {
  pid: number | undefined = 4321;
  exitCode: number | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killSignals: Array<NodeJS.Signals | number | undefined> = [];

  constructor(private readonly _behaviour: FakeChildBehaviour = 'exits') {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);

    if (this._behaviour === 'signal-undelivered') {
      return false;
    }
    if (this._behaviour === 'exit-errors') {
      queueMicrotask(() => {
        this.emit('error', new Error('child process error'));
      });
      return true;
    }

    this.exitCode = 0;
    queueMicrotask(() => {
      this.emit('exit', 0, signal ?? null);
    });
    return true;
  }
}

/**
 * The write-stream registry and its map of live streams are both private, and a
 * leaked entry has no public observable — the process-wide `LogCaptureManager`
 * drops its handle on the child whatever the stop returned, so nothing can reach
 * the stream again. These read the private state structurally rather than
 * widening the provider's API for the test's benefit.
 */
function providerRegistry(provider: LogCaptureProvider): LogWriteStreamRegistry {
  return (provider as unknown as { _logStreams: LogWriteStreamRegistry })._logStreams;
}

function liveStreamCount(registry: LogWriteStreamRegistry): number {
  return (registry as unknown as { _streams: Map<string, unknown> })._streams.size;
}

// Larger than both the PassThrough (16 KiB) and fs.WriteStream (64 KiB) high
// water marks, so the transfer provably spans several ticks. That is the
// condition under which a stop that only unpipes loses data: it detaches the
// pipe mid-transfer and never ends the destination, so the `finish` event that
// would flush the remainder never fires.
const LOG_PAYLOAD = `${'logcat line\n'.repeat(50_000)}`;

async function startCapture(
  provider: LogCaptureProvider,
  childProcess: FakeChildProcess,
  outputFilePath: string,
): Promise<void> {
  const started = await provider.startLogCapture({
    deviceId: 'DEVICE-1',
    outputFilePath,
  });
  assert.equal(started.response.success, true);
  assert.equal(started.process, childProcess as unknown as ChildProcess);
}

function spawnStub(childProcess: FakeChildProcess): typeof import('child_process').spawn {
  return ((() =>
    childProcess as unknown as ReturnType<
      typeof import('child_process').spawn
    >) as unknown) as typeof import('child_process').spawn;
}

async function execFileStub(): Promise<{ stdout: string; stderr: string }> {
  return { stdout: '', stderr: '' };
}

async function createOutputFilePath(): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'finalrun-log-capture-'));
  return path.join(tempDir, 'run_case.log');
}

/**
 * A path whose parent directory does not exist, so `fs.createWriteStream` fails
 * its asynchronous `open(2)` with ENOENT — the cheapest reproduction of the whole
 * class of failures that arrive after `open()` has already returned the stream
 * (EACCES, EMFILE, a missing `finalrun-logs` directory).
 */
async function createUnopenableFilePath(): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'finalrun-log-capture-'));
  return path.join(tempDir, 'directory-that-does-not-exist', 'run_case.log');
}

for (const platform of ['Android', 'iOS'] as const) {
  const createProvider = (childProcess: FakeChildProcess): LogCaptureProvider =>
    platform === 'Android'
      ? new AndroidLogcatProvider({
          execFileFn: execFileStub,
          spawnFn: spawnStub(childProcess),
        })
      : new IOSLogProvider({
          execFileFn: execFileStub,
          spawnFn: spawnStub(childProcess),
        });

  test(`${platform} log capture writes every byte the child produced before stop resolves`, async () => {
    const outputFilePath = await createOutputFilePath();
    const childProcess = new FakeChildProcess();
    const provider = createProvider(childProcess);

    await startCapture(provider, childProcess, outputFilePath);

    childProcess.stdout.write(LOG_PAYLOAD);
    childProcess.stdout.end();

    const stopped = await provider.stopLogCapture({
      process: childProcess as unknown as ChildProcess,
      outputFilePath,
    });

    assert.equal(stopped.success, true);
    assert.deepEqual(childProcess.killSignals, ['SIGINT']);
    const written = await readFile(outputFilePath, 'utf8');
    assert.equal(
      written.length,
      LOG_PAYLOAD.length,
      'the log file must be complete when stopLogCapture resolves',
    );
    assert.equal(written, LOG_PAYLOAD);
    assert.equal(liveStreamCount(providerRegistry(provider)), 0);
  });

  test(`${platform} log capture tolerates a second stop for the same file`, async () => {
    const outputFilePath = await createOutputFilePath();
    const childProcess = new FakeChildProcess();
    const provider = createProvider(childProcess);

    await startCapture(provider, childProcess, outputFilePath);
    childProcess.stdout.end();

    const first = await provider.stopLogCapture({
      process: childProcess as unknown as ChildProcess,
      outputFilePath,
    });
    const second = await provider.stopLogCapture({
      process: childProcess as unknown as ChildProcess,
      outputFilePath,
    });

    assert.equal(first.success, true);
    assert.equal(second.success, true);
  });

  test(`${platform} log capture finalizes the write stream when the stop signal is not delivered`, async () => {
    const outputFilePath = await createOutputFilePath();
    const childProcess = new FakeChildProcess('signal-undelivered');
    const provider = createProvider(childProcess);

    await startCapture(provider, childProcess, outputFilePath);
    childProcess.stdout.write(LOG_PAYLOAD);
    childProcess.stdout.end();

    const stopped = await provider.stopLogCapture({
      process: childProcess as unknown as ChildProcess,
      outputFilePath,
    });

    // The stop is reported as a failure, but it still owes the caller a closed
    // stream: the manager drops its handle on this child either way, so a stream
    // left open here leaks its fd and its registry entry for the lifetime of the
    // process, and the log file stays truncated at whatever happened to be
    // flushed.
    assert.equal(stopped.success, false);
    assert.match(stopped.message ?? '', /Failed to send SIGINT/);
    assert.equal(await readFile(outputFilePath, 'utf8'), LOG_PAYLOAD);
    assert.equal(liveStreamCount(providerRegistry(provider)), 0);
  });

  test(`${platform} log capture finalizes the write stream when waiting for the child throws`, async () => {
    const outputFilePath = await createOutputFilePath();
    const childProcess = new FakeChildProcess('exit-errors');
    const provider = createProvider(childProcess);

    await startCapture(provider, childProcess, outputFilePath);
    childProcess.stdout.write(LOG_PAYLOAD);
    childProcess.stdout.end();

    const stopped = await provider.stopLogCapture({
      process: childProcess as unknown as ChildProcess,
      outputFilePath,
    });

    assert.equal(stopped.success, false);
    assert.match(stopped.message ?? '', /child process error/);
    assert.equal(await readFile(outputFilePath, 'utf8'), LOG_PAYLOAD);
    assert.equal(liveStreamCount(providerRegistry(provider)), 0);
  });
}

/**
 * The write stream the registry tracks for `outputFilePath`, read structurally
 * for the same reason as `providerRegistry` above. The provider owns the stream
 * privately, and the failing-stop tests below must await its asynchronous
 * `error` event deterministically before stopping — anything sleep-based races
 * the fd open on a slow box.
 */
function trackedStream(registry: LogWriteStreamRegistry, outputFilePath: string): EventEmitter {
  const entry = (
    registry as unknown as { _streams: Map<string, { stream: EventEmitter }> }
  )._streams.get(outputFilePath);
  assert.ok(entry, `no tracked write stream for ${outputFilePath}`);
  return entry.stream;
}

for (const platform of ['Android', 'iOS'] as const) {
  const createProvider = (childProcess: FakeChildProcess): LogCaptureProvider =>
    platform === 'Android'
      ? new AndroidLogcatProvider({
          execFileFn: execFileStub,
          spawnFn: spawnStub(childProcess),
        })
      : new IOSLogProvider({
          execFileFn: execFileStub,
          spawnFn: spawnStub(childProcess),
        });

  test(`${platform} log capture stop reports failure over a write stream that never opened`, async () => {
    const outputFilePath = await createUnopenableFilePath();
    const childProcess = new FakeChildProcess();
    const provider = createProvider(childProcess);

    // The start still succeeds: `fs.createWriteStream` opens its fd
    // asynchronously, so the ENOENT arrives as an `error` event only after
    // `startLogCapture` has returned.
    await startCapture(provider, childProcess, outputFilePath);

    const [openError] = await once(
      trackedStream(providerRegistry(provider), outputFilePath),
      'error',
    );
    assert.match(String(openError), /ENOENT/);

    // No payload: the defect this pins is about the error, not the bytes — the
    // errored stream auto-destroyed and the pipe detached itself, so nothing
    // written here could reach the file anyway. Ending stdout lets the stop's
    // drain reach EOF instead of its 5 s timeout.
    childProcess.stdout.end();

    const stopped = await provider.stopLogCapture({
      process: childProcess as unknown as ChildProcess,
      outputFilePath,
    });

    // The caller-visible half of the fix the registry tests above cannot see:
    // the success path calls `finalize` — not `finalizeQuietly` — so the
    // recorded open error reaches the stop response as a failure. Mutating
    // that one call to the quiet variant restores the original defect (a
    // successful stop over a log file that was never written) while every
    // registry-level test stays green; these assertions are what kill it.
    assert.equal(stopped.success, false);
    assert.match(stopped.message ?? '', /ENOENT/);
    assert.equal(liveStreamCount(providerRegistry(provider)), 0);
  });

  test(`${platform} log capture quiet-first stop path reports failure over an errored stream`, async () => {
    const outputFilePath = await createUnopenableFilePath();
    const childProcess = new FakeChildProcess('signal-undelivered');
    const provider = createProvider(childProcess);

    await startCapture(provider, childProcess, outputFilePath);

    const [openError] = await once(
      trackedStream(providerRegistry(provider), outputFilePath),
      'error',
    );
    assert.match(String(openError), /ENOENT/);

    childProcess.stdout.end();

    const stopped = await provider.stopLogCapture({
      process: childProcess as unknown as ChildProcess,
      outputFilePath,
    });

    // The undelivered SIGINT makes this a quiet-first path: `finalizeQuietly`
    // consumes the recorded ENOENT silently (it drops the registry entry), so a
    // later `finalize` for the same path would find nothing — safe only because
    // the path is already reporting a failure of its own. That invariant, every
    // quiet-first path returning `success: false` by itself, is what makes the
    // documented quiet-before-loud ordering hazard in `logWriteStream.ts` safe.
    // Pinned deliberately WITHOUT asserting what a later stop over the swallowed
    // error returns: the swallow-then-resolve sequence is an accepted, documented
    // accident, not a contract.
    assert.equal(stopped.success, false);
    assert.match(stopped.message ?? '', /Failed to send SIGINT/);
    assert.equal(liveStreamCount(providerRegistry(provider)), 0);
  });
}

test('LogWriteStreamRegistry ends and untracks the stream when the source errors', async () => {
  const outputFilePath = await createOutputFilePath();
  const registry = new LogWriteStreamRegistry();
  const stream = registry.open(outputFilePath);
  const source = new PassThrough();
  source.pipe(stream);
  source.write('one logcat line\n');
  queueMicrotask(() => {
    source.destroy(new Error('stdout exploded'));
  });

  // The drain rejects — `finished(source)` rejects on a `stdout` error and
  // `Promise.race` propagates it — and that must not skip the finalisation: the
  // registry entry is the only handle on the stream, so a bail-out here strands
  // it open and untracked forever.
  await assert.rejects(registry.finalize(outputFilePath, source), /stdout exploded/);

  assert.equal(stream.writableFinished, true, 'the write stream must still be ended and flushed');
  assert.equal(liveStreamCount(registry), 0);
});

test('LogWriteStreamRegistry attaches the error listener before it hands out the stream', async () => {
  const outputFilePath = await createOutputFilePath();
  const registry = new LogWriteStreamRegistry();
  const stream = registry.open(outputFilePath);

  // Synchronously on return, before either provider can pipe into it. `pipe()`
  // does not forward a destination's errors to the source, so a stream handed out
  // with no listener turns its first `error` into an unhandled one — which Node
  // throws, taking the CLI down in the middle of a run.
  assert.ok(
    stream.listenerCount('error') > 0,
    'open() must attach the error listener before returning the stream',
  );

  await registry.finalize(outputFilePath);
  assert.equal(liveStreamCount(registry), 0);
});

test('LogWriteStreamRegistry finalize rejects with the error a failed open recorded', async () => {
  const outputFilePath = await createUnopenableFilePath();
  const registry = new LogWriteStreamRegistry();
  const stream = registry.open(outputFilePath);

  // The fd is opened asynchronously, so ENOENT arrives well after open() returned.
  // The `once` below attaches a handler of its own before that can happen, so the
  // event is handled here with or without the persistent listener — reaching these
  // assertions therefore proves nothing about unhandled errors, and this test does
  // not claim it does. What it pins is the RECORD: against the pre-fix source
  // `finalize` resolves and this fails on `assert.rejects`. Attachment is guarded
  // structurally by the sibling test above, which reads
  // `stream.listenerCount('error') > 0` synchronously on return, before any other
  // listener exists; the escape case a listener can still produce — a throwing
  // `Logger` sink — has its own test below.
  const [openError] = await once(stream, 'error');
  assert.match(String(openError), /ENOENT/);

  // The ENOENT destroyed the stream, so the terminal-state decision would reject
  // via `stream.errored` even with no record. What the record adds — and what
  // this pins — is precedence: the rejection carries the FIRST error the stream
  // emitted, not whichever one happened to destroy it.
  await assert.rejects(registry.finalize(outputFilePath), /ENOENT/);
  assert.equal(liveStreamCount(registry), 0);
});

test('LogWriteStreamRegistry finalizeQuietly resolves for a stream whose open failed', async () => {
  const outputFilePath = await createUnopenableFilePath();
  const registry = new LogWriteStreamRegistry();
  const stream = registry.open(outputFilePath);

  await once(stream, 'error');

  // The quiet variant is what a caller already returning a failure calls, so a
  // recorded write error must be logged rather than thrown there — the same split
  // the rest of the registry's contract already draws.
  await registry.finalizeQuietly(outputFilePath);
  assert.equal(liveStreamCount(registry), 0);
});

test('LogWriteStreamRegistry records only the first error a stream emits', async () => {
  const outputFilePath = await createOutputFilePath();
  const registry = new LogWriteStreamRegistry();
  const stream = registry.open(outputFilePath);

  // `??=` is what makes this hold: the first error is the one that explains the
  // failure and everything after it is fallout on an already-doomed stream.
  // Emitted directly rather than provoked, because two real failures on one
  // stream cannot be ordered deterministically. The destroy is what makes the
  // stream genuinely failing — `finish` can no longer fire, so `finalize` must
  // reject — and it carries a THIRD error so the assertion also pins precedence:
  // the recorded first error outranks `stream.errored` (the destroy reason,
  // which is fallout) in the rejection.
  stream.emit('error', new Error('first failure'));
  stream.emit('error', new Error('second failure'));
  stream.destroy(new Error('destroy fallout'));

  await assert.rejects(registry.finalize(outputFilePath), /first failure/);
  assert.equal(liveStreamCount(registry), 0);
});

test('LogWriteStreamRegistry finalize resolves and untracks a stream that wrote cleanly', async () => {
  const outputFilePath = await createOutputFilePath();
  const registry = new LogWriteStreamRegistry();
  const stream = registry.open(outputFilePath);
  stream.write('one logcat line\n');

  // The happy path, guarding against the recorded-error check turning every stop
  // into a rejection.
  await registry.finalize(outputFilePath);

  assert.equal(stream.writableFinished, true);
  assert.equal(await readFile(outputFilePath, 'utf8'), 'one logcat line\n');
  assert.equal(liveStreamCount(registry), 0);
});

test('LogWriteStreamRegistry finalize resolves a stream that flushed cleanly despite a stale non-destroying error', async () => {
  const outputFilePath = await createOutputFilePath();
  const registry = new LogWriteStreamRegistry();
  const stream = registry.open(outputFilePath);
  stream.write('one logcat line\n');

  // A bare emit is the only construction that reaches this state: every real fs
  // error either destroys the stream (`autoDestroy: true`) or arrives at close
  // time, setting `stream.errored`. The stream itself is untouched, so the
  // flush below completes and the file on disk is genuinely whole — the state
  // in which the old unconditional rejection contradicted the file's own
  // contract (a log that could not be flushed is a failed stop; this one was
  // flushed).
  stream.emit('error', new Error('stale failure'));

  const warnings: string[] = [];
  const capturingSink: LoggerSink = (entry) => {
    warnings.push(entry.message);
  };
  Logger.addSink(capturingSink);
  try {
    await registry.finalize(outputFilePath);
  } finally {
    Logger.removeSink(capturingSink);
  }

  assert.equal(stream.writableFinished, true);
  assert.equal(await readFile(outputFilePath, 'utf8'), 'one logcat line\n');
  assert.equal(liveStreamCount(registry), 0);
  // The stale record is not silently swallowed: the warning names the file and
  // the error it is overriding.
  assert.ok(
    warnings.some((m) => m.includes(outputFilePath) && m.includes('stale failure')),
    `expected a warning naming ${outputFilePath} and the stale error, got: ${JSON.stringify(warnings)}`,
  );
});

test('LogWriteStreamRegistry finalize rejects deterministically on a close-time error after a clean finish', async () => {
  const outputFilePath = await createOutputFilePath();
  const registry = new LogWriteStreamRegistry();
  const stream = registry.open(outputFilePath);

  // Forces the failure auto-destroy's `close(2)` would report. `_destroy` is
  // the documented Writable teardown seam: the real teardown still runs (the fd
  // is actually closed) and the callback is then handed the EIO the OS would
  // have returned, which Node surfaces as `error` → `errored` → `close`.
  // `stream.destroy(err)` after `finish` cannot pin this — it races
  // auto-destroy's own `destroy()` call and loses nondeterministically.
  const realDestroy = stream._destroy.bind(stream);
  stream._destroy = (error, callback) => {
    realDestroy(error, () => {
      callback(error ?? new Error('EIO: i/o error, close'));
    });
  };

  stream.write('one logcat line\n');
  stream.end();
  await once(stream, 'finish');

  // `finalize` starts with `writableFinished` already true and the close-time
  // error not yet delivered — exactly the window the pre-fix code raced: its
  // `_endAndFlush` early-returned on a finished stream and the recorded-error
  // check then resolved or rejected by whether the close callback had run yet.
  // Awaiting the terminal 'close' makes this rejection deterministic.
  await assert.rejects(registry.finalize(outputFilePath), /EIO/);

  assert.equal(stream.writableFinished, true, 'the flush itself completed cleanly');
  assert.equal(liveStreamCount(registry), 0);
});

test('LogWriteStreamRegistry finalizeQuietly resolves when the logger sink throws too', async () => {
  const outputFilePath = await createUnopenableFilePath();
  const registry = new LogWriteStreamRegistry();
  const stream = registry.open(outputFilePath);

  // Awaited BEFORE the sink is installed, so the listener's own (already guarded)
  // log call is out of the picture and this case pins `finalizeQuietly`'s guard
  // alone.
  const [openError] = await once(stream, 'error');
  assert.match(String(openError), /ENOENT/);

  const throwingSink: LoggerSink = (entry) => {
    if (entry.message.includes('Failed to finalize log write stream')) {
      throw new Error('ENOSPC: runner.log sink failed');
    }
  };
  Logger.addSink(throwingSink);
  try {
    // `finalize` now re-throws a recorded error where it used to resolve, which is
    // what first makes `finalizeQuietly`'s own `Logger.e` reachable — and its
    // documented contract is to log that failure, not to add one. Unguarded, the
    // sink's throw propagates out of the catch and this rejects.
    await registry.finalizeQuietly(outputFilePath);
  } finally {
    Logger.removeSink(throwingSink);
  }

  assert.equal(liveStreamCount(registry), 0);
});

// Deliberately LAST in the file. Against an unguarded log call this test does not
// merely fail an assertion: the sink's throw escapes `emit('error')` as an uncaught
// exception, so the awaited event never resolves, the test's own `finally` never
// runs, and the throwing sink stays installed on the module-level `Logger` for
// whatever runs next. Placing it last keeps that failure mode from cascading into
// unrelated cases and misattributing the cause.
test('LogWriteStreamRegistry survives a logger sink that throws while recording a stream error', async () => {
  const outputFilePath = await createUnopenableFilePath();
  const registry = new LogWriteStreamRegistry();

  // The runner-log sink the CLI installs (`ReportWriter.createLoggerSink`) is an
  // unguarded synchronous `fs.appendFileSync`, and `Logger._emit`'s sink loop does
  // not guard it either — so `Logger.e` can throw independently of why the stream
  // failed (a full disk, a permissions change, a removed artifacts directory), and
  // where `os.tmpdir()` and the run directory share a filesystem one ENOSPC fails
  // both at once. The log call inside the listener is therefore guarded: a throw
  // from it would escape `emit('error')` on a tick with no enclosing try and become
  // the uncaughtException the listener exists to prevent.
  const throwingSink: LoggerSink = (entry) => {
    if (entry.message.includes('log write stream failed')) {
      throw new Error('ENOSPC: runner.log sink failed');
    }
  };
  Logger.addSink(throwingSink);
  try {
    const stream = registry.open(outputFilePath);

    // The registry's listener runs first in emit order, so unguarded its throw
    // reaches `emit` before this `once` handler ever runs — the awaited event never
    // resolves and the throw surfaces as an uncaught exception instead.
    const [openError] = await once(stream, 'error');
    assert.match(String(openError), /ENOENT/);

    // Recording happens before the fallible log call, so a failed log costs a log
    // line and nothing else — the stop still fails on the recorded error.
    await assert.rejects(registry.finalize(outputFilePath), /ENOENT/);
    assert.equal(liveStreamCount(registry), 0);
  } finally {
    Logger.removeSink(throwingSink);
  }
});
