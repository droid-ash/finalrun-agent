import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'child_process';
import { RecordingRequest } from '@finalrun/common';
import { IOSRecordingProvider } from '../IOSRecordingProvider.js';

class FakeChildProcess extends EventEmitter {
  pid: number | undefined = 1234;
  exitCode: number | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.exitCode = 0;
    queueMicrotask(() => {
      this.emit('exit', 0, signal ?? null);
    });
    return true;
  }
}

test('IOSRecordingProvider starts xcrun simctl recording with the simulator UDID and host file path', async () => {
  const process = new FakeChildProcess();
  const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
  const provider = new IOSRecordingProvider({
    spawnFn: (((command: string, args?: readonly string[]) => {
      spawnCalls.push({ command, args: args ?? [] });
      return process as unknown as ReturnType<typeof import('child_process').spawn>;
    }) as unknown) as typeof import('child_process').spawn,
  });

  const response = await provider.startRecordingProcess({
    deviceId: 'SIM-1',
    filePath: '/tmp/run_case.mov',
    recordingRequest: new RecordingRequest({
      runId: 'run',
      testId: 'case',
      apiKey: 'key',
    }),
  });

  assert.equal(response.response.success, true);
  assert.deepEqual(spawnCalls, [
    {
      command: 'xcrun',
      args: ['simctl', 'io', 'SIM-1', 'recordVideo', '/tmp/run_case.mov'],
    },
  ]);
});

test('IOSRecordingProvider stops with SIGINT and succeeds even when ffmpeg is unavailable', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'finalrun-ios-recording-'));
  const recordingPath = path.join(tempDir, 'run_case.mov');
  await writeFile(recordingPath, 'fake-recording');

  const process = new FakeChildProcess();
  const provider = new IOSRecordingProvider({
    execFileFn: async () => {
      throw new Error('command not available');
    },
  });

  const response = await provider.stopRecordingProcess({
    process: process as unknown as ChildProcess,
    deviceId: 'SIM-1',
    fileName: 'run_case',
    filePath: recordingPath,
  });

  assert.equal(response.success, true);
  assert.deepEqual(process.killSignals, ['SIGINT']);
});

test('IOSRecordingProvider availability reports simctl support and optional ffmpeg compression', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const provider = new IOSRecordingProvider({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      if (file === 'which' && args[0] === 'ffmpeg') {
        throw new Error('ffmpeg missing');
      }
      return { stdout: '/usr/bin/mock', stderr: '' };
    },
  });

  const response = await provider.checkAvailability();

  assert.equal(response.success, true);
  assert.match(
    response.message ?? '',
    /Video compression disabled \(ffmpeg not found\)\./,
  );
  assert.deepEqual(execCalls, [
    { file: 'which', args: ['xcrun'] },
    { file: 'xcrun', args: ['simctl', 'help'] },
    { file: 'which', args: ['ffmpeg'] },
  ]);
});

test('IOSRecordingProvider keeps the original recording when the compressed rename fails', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'finalrun-ios-recording-'));
  const recordingPath = path.join(tempDir, 'run_case.mov');
  await writeFile(recordingPath, 'original-recording');

  // A directory at the compressed path passes the provider's access() check and
  // then makes rename() fail — the shape that used to destroy the recording,
  // because the original was deleted before the rename was attempted.
  const compressedPath = path.join(tempDir, 'run_case-small.mov');
  await mkdir(compressedPath);

  const process = new FakeChildProcess();
  const provider = new IOSRecordingProvider({
    execFileFn: async () => ({ stdout: '/usr/bin/mock', stderr: '' }),
  });

  const response = await provider.stopRecordingProcess({
    process: process as unknown as ChildProcess,
    deviceId: 'SIM-1',
    fileName: 'run_case',
    filePath: recordingPath,
  });

  assert.equal(response.success, true);
  assert.equal(
    await readFile(recordingPath, 'utf8'),
    'original-recording',
    'a failed rename must leave the original recording in place',
  );
});

test('IOSRecordingProvider replaces the original with the compressed recording on success', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'finalrun-ios-recording-'));
  const recordingPath = path.join(tempDir, 'run_case.mov');
  const compressedPath = path.join(tempDir, 'run_case-small.mov');
  await writeFile(recordingPath, 'original-recording');

  const process = new FakeChildProcess();
  const provider = new IOSRecordingProvider({
    execFileFn: async (file, args) => {
      if (file === 'ffmpeg') {
        assert.deepEqual(args, [
          '-y',
          '-i',
          recordingPath,
          '-c:v',
          'libx264',
          '-crf',
          '40',
          compressedPath,
        ]);
        await writeFile(compressedPath, 'compressed');
      }
      return { stdout: '/usr/bin/mock', stderr: '' };
    },
  });

  const response = await provider.stopRecordingProcess({
    process: process as unknown as ChildProcess,
    deviceId: 'SIM-1',
    fileName: 'run_case',
    filePath: recordingPath,
  });

  assert.equal(response.success, true);
  assert.equal(await readFile(recordingPath, 'utf8'), 'compressed');
  await assert.rejects(() => stat(compressedPath), /ENOENT/);
});
