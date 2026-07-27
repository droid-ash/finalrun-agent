import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fsp from 'node:fs/promises';
import { once } from 'node:events';
import { promisify } from 'node:util';
import {
  DeviceNodeResponse,
  Logger,
  PLATFORM_ANDROID,
  type RecordingRequest,
} from '@finalrun/common';
import type { RecordingProvider, RecordingProviderResult } from './RecordingProvider.js';

const execFileAsync = promisify(execFile);

type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

type DelayFn = (ms: number) => Promise<void>;

export class ScrcpyStartupInterruptedError extends Error {
  readonly signal: NodeJS.Signals;

  constructor(signal: NodeJS.Signals) {
    super(`scrcpy recording startup interrupted by ${signal} before it became ready`);
    this.name = 'ScrcpyStartupInterruptedError';
    this.signal = signal;
  }
}

/**
 * Android screen recording via host-installed `scrcpy`.
 * Uses headless recording to keep parity with the existing iOS artifact flow.
 */
export class AndroidRecordingProvider implements RecordingProvider {
  static readonly RECORDING_FOLDER = 'fr_android_screen_recording';
  static readonly DEFAULT_STARTUP_SETTLE_MS = 1000;

  private readonly _execFileFn: ExecFileFn;
  private readonly _spawnFn: typeof spawn;
  private readonly _delayFn: DelayFn;
  private readonly _startupSettleMs: number;

  constructor(params?: {
    execFileFn?: ExecFileFn;
    spawnFn?: typeof spawn;
    delayFn?: DelayFn;
    startupSettleMs?: number;
  }) {
    this._execFileFn = params?.execFileFn ?? execFileAsync;
    this._spawnFn = params?.spawnFn ?? spawn;
    this._delayFn = params?.delayFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._startupSettleMs =
      params?.startupSettleMs ?? AndroidRecordingProvider.DEFAULT_STARTUP_SETTLE_MS;
  }

  get recordingFolder(): string {
    return AndroidRecordingProvider.RECORDING_FOLDER;
  }

  get platformName(): string {
    return PLATFORM_ANDROID;
  }

  get fileExtension(): string {
    return 'mp4';
  }

  async startRecordingProcess(params: {
    deviceId: string;
    filePath: string;
    recordingRequest: RecordingRequest;
    sdkVersion?: string;
  }): Promise<RecordingProviderResult> {
    try {
      const scrcpyAvailable = await this._commandExists('scrcpy');
      if (!scrcpyAvailable) {
        throw new Error('scrcpy not found in PATH');
      }

      const args = this._recordingArgs(params.deviceId, params.filePath);
      Logger.i(
        `AndroidRecordingProvider: Starting recording for device ${params.deviceId} with command: scrcpy ${args.join(' ')}`,
      );

      const { process, stdoutChunks, stderrChunks } = this._spawnScrcpy(args);

      await this._awaitSpawn(process);

      const startupState = await this._waitForStableStartup(process, {
        stdoutChunks,
        stderrChunks,
      });
      if (startupState.exited) {
        if (startupState.signal === 'SIGINT' || startupState.signal === 'SIGTERM') {
          throw new ScrcpyStartupInterruptedError(startupState.signal);
        }
        throw new Error(startupState.message);
      }

      return {
        process,
        response: new DeviceNodeResponse({
          success: true,
          message: `Android recording started successfully for device: ${params.deviceId}, file: ${params.filePath}`,
        }),
        platformMetadata: {
          tool: 'scrcpy',
          deviceType: 'adb',
          command: 'record',
          container: 'mp4',
          audio: false,
        },
      };
    } catch (error) {
      if (error instanceof ScrcpyStartupInterruptedError) {
        Logger.w(
          `AndroidRecordingProvider: scrcpy startup for device ${params.deviceId} was interrupted by ${error.signal} before it became ready`,
        );
        throw error;
      }
      Logger.e(
        `AndroidRecordingProvider: Failed to start recording for device ${params.deviceId}:`,
        error,
      );
      throw new Error(
        `Failed to start Android recording for device ${params.deviceId}: ${this._formatError(error)}`,
      );
    }
  }

  async stopRecordingProcess(params: {
    process: ChildProcess;
    deviceId: string;
    fileName: string;
    filePath: string;
  }): Promise<DeviceNodeResponse> {
    try {
      const killSent = params.process.kill('SIGINT');
      Logger.i(`AndroidRecordingProvider: Sent SIGINT to scrcpy process: ${killSent}`);

      if (!killSent) {
        Logger.e(
          `AndroidRecordingProvider: Failed to deliver SIGINT for device: ${params.deviceId}, file: ${params.fileName}`,
        );
        return new DeviceNodeResponse({
          success: false,
          message: 'Failed to send SIGINT to scrcpy process.',
        });
      }

      const { code: exitCode, signal } = await this._waitForExit(params.process);
      Logger.i(
        `AndroidRecordingProvider: scrcpy process exited with code=${exitCode ?? 'unknown'} signal=${signal ?? 'none'} for device: ${params.deviceId}, file: ${params.fileName}`,
      );

      await fsp.access(params.filePath);
      const stats = await fsp.stat(params.filePath);
      if (stats.size <= 0) {
        return new DeviceNodeResponse({
          success: false,
          message: `Android recording file is empty: ${params.filePath}`,
        });
      }

      return new DeviceNodeResponse({
        success: true,
        message: `Android recording stopped successfully for device: ${params.deviceId}, file: ${params.fileName}`,
      });
    } catch (error) {
      Logger.e(
        `AndroidRecordingProvider: Error stopping recording for device: ${params.deviceId}, file: ${params.fileName}`,
        error,
      );
      return new DeviceNodeResponse({
        success: false,
        message: `Error stopping Android recording: ${this._formatError(error)}`,
      });
    }
  }

  async checkAvailability(): Promise<DeviceNodeResponse> {
    try {
      const scrcpyAvailable = await this._commandExists('scrcpy');
      if (!scrcpyAvailable) {
        return new DeviceNodeResponse({
          success: false,
          message: 'scrcpy not found. Please ensure scrcpy is installed and available on PATH.',
        });
      }

      await this._execFileFn('scrcpy', ['--version']);
      return new DeviceNodeResponse({
        success: true,
        message: 'Android recording tools (scrcpy) are available.',
      });
    } catch (error) {
      Logger.e('AndroidRecordingProvider: Error checking Android recording availability', error);
      return new DeviceNodeResponse({
        success: false,
        message: `Error checking Android recording tools: ${this._formatError(error)}`,
      });
    }
  }

  async cleanupPlatformResources(deviceId: string): Promise<void> {
    Logger.i(`AndroidRecordingProvider: Cleaning up resources for device: ${deviceId}`);
  }

  private _recordingArgs(deviceId: string, filePath: string): string[] {
    return [
      '--serial',
      deviceId,
      '--no-window',
      '--no-playback',
      '--no-control',
      '--no-audio',
      '--record',
      filePath,
      '--record-format',
      'mp4',
    ];
  }

  /** Spawn scrcpy, mirroring its output into the logger and per-call chunk buffers. */
  private _spawnScrcpy(args: string[]): {
    process: ChildProcess;
    stdoutChunks: string[];
    stderrChunks: string[];
  } {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const process = this._spawnFn('scrcpy', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcess;

    process.stdout?.on('data', (data: Buffer | string) => {
      const message = String(data);
      stdoutChunks.push(message);
      Logger.i(`scrcpy stdout: ${message}`);
    });
    process.stderr?.on('data', (data: Buffer | string) => {
      const message = String(data);
      stderrChunks.push(message);
      Logger.w(`scrcpy stderr: ${message}`);
    });

    return { process, stdoutChunks, stderrChunks };
  }

  private async _commandExists(command: string): Promise<boolean> {
    try {
      await this._execFileFn('which', [command]);
      return true;
    } catch {
      return false;
    }
  }

  private async _awaitSpawn(process: ChildProcess): Promise<void> {
    if (process.pid !== undefined) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const handleSpawn = (): void => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const cleanup = (): void => {
        process.off('spawn', handleSpawn);
        process.off('error', handleError);
      };

      process.once('spawn', handleSpawn);
      process.once('error', handleError);
    });
  }

  private async _waitForStableStartup(
    process: ChildProcess,
    logs: {
      stdoutChunks: string[];
      stderrChunks: string[];
    },
  ): Promise<{
    exited: boolean;
    message?: string;
    signal?: NodeJS.Signals | null;
  }> {
    if (process.exitCode !== null || process.signalCode !== null) {
      return {
        exited: true,
        message: this._formatStartupExit(process.exitCode, process.signalCode, logs),
        signal: process.signalCode,
      };
    }

    const timeoutResult = this._delayFn(this._startupSettleMs).then(
      () => ({ exited: false }) as const,
    );
    const exitResult = this._waitForExit(process).then(({ code, signal }) => ({
      exited: true as const,
      message: this._formatStartupExit(code, signal, logs),
      signal,
    }));

    return await Promise.race([timeoutResult, exitResult]);
  }

  private _formatStartupExit(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    logs: {
      stdoutChunks: string[];
      stderrChunks: string[];
    },
  ): string {
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      return `scrcpy recording startup interrupted by ${signal} before it became ready`;
    }

    const cause =
      signal !== null
        ? `signal=${signal}`
        : `code=${exitCode === null ? 'unknown' : String(exitCode)}`;
    const stderr = logs.stderrChunks.join('').trim();
    const stdout = logs.stdoutChunks.join('').trim();
    const detail = stderr || stdout;
    return detail
      ? `scrcpy exited before recording became ready (${cause}): ${detail}`
      : `scrcpy exited before recording became ready (${cause})`;
  }

  private async _waitForExit(process: ChildProcess): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    if (process.exitCode !== null || process.signalCode !== null) {
      return {
        code: process.exitCode,
        signal: process.signalCode,
      };
    }

    const [code, signal] = await once(process, 'exit');
    return {
      code: (code as number | null) ?? null,
      signal: (signal as NodeJS.Signals | null) ?? null,
    };
  }

  private _formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
