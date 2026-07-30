import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import type { ChildProcess } from 'child_process';
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
