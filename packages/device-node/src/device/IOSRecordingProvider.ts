import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { DeviceNodeResponse, Logger, PLATFORM_IOS, type RecordingRequest } from '@finalrun/common';
import type { RecordingProvider, RecordingProviderResult } from './RecordingProvider.js';

const execFileAsync = promisify(execFile);

type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/**
 * x264 Constant Rate Factor used when re-encoding a finished recording.
 * 40 is far above the visually-lossless range (~18-23): a run's video is a
 * diagnostic artifact uploaded per test, so file size dominates fidelity.
 */
const COMPRESSION_CRF = '40';

/**
 * iOS screen recording via `xcrun simctl io <udid> recordVideo`.
 * Mirrors the studio-flutter implementation for booted simulators.
 */
export class IOSRecordingProvider implements RecordingProvider {
  static readonly RECORDING_FOLDER = 'fr_ios_screen_recording';

  private readonly _execFileFn: ExecFileFn;
  private readonly _spawnFn: typeof spawn;

  constructor(params?: { execFileFn?: ExecFileFn; spawnFn?: typeof spawn }) {
    this._execFileFn = params?.execFileFn ?? execFileAsync;
    this._spawnFn = params?.spawnFn ?? spawn;
  }

  get recordingFolder(): string {
    return IOSRecordingProvider.RECORDING_FOLDER;
  }

  get platformName(): string {
    return PLATFORM_IOS;
  }

  get fileExtension(): string {
    return 'mov';
  }

  async startRecordingProcess(params: {
    deviceId: string;
    filePath: string;
    recordingRequest: RecordingRequest;
    sdkVersion?: string;
  }): Promise<RecordingProviderResult> {
    try {
      const args = ['simctl', 'io', params.deviceId, 'recordVideo', params.filePath];
      Logger.i(
        `IOSRecordingProvider: Starting recording for device ${params.deviceId} with command: xcrun ${args.join(' ')}`,
      );

      const process = this._spawnFn('xcrun', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ChildProcess;

      process.stdout?.on('data', (data: Buffer | string) => {
        Logger.i(`xcrun simctl stdout: ${String(data)}`);
      });
      process.stderr?.on('data', (data: Buffer | string) => {
        Logger.w(`xcrun simctl stderr: ${String(data)}`);
      });

      await this._awaitSpawn(process);

      return {
        process,
        response: new DeviceNodeResponse({
          success: true,
          message: `iOS recording started successfully for device: ${params.deviceId}, file: ${params.filePath}`,
        }),
        platformMetadata: {
          tool: 'xcrun simctl',
          deviceType: 'simulator',
          command: 'recordVideo',
        },
      };
    } catch (error) {
      Logger.e(
        `IOSRecordingProvider: Failed to start recording for device ${params.deviceId}:`,
        error,
      );
      throw new Error(
        `Failed to start iOS recording for device ${params.deviceId}: ${this._formatError(error)}`,
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
      Logger.i(`IOSRecordingProvider: Sent SIGINT to xcrun simctl process: ${killSent}`);

      if (!killSent) {
        Logger.e(
          `IOSRecordingProvider: Failed to deliver SIGINT for device: ${params.deviceId}, file: ${params.fileName}`,
        );
        return new DeviceNodeResponse({
          success: false,
          message: 'Failed to send SIGINT to xcrun simctl process.',
        });
      }

      const exitCode = await this._waitForExit(params.process);
      Logger.i(
        `IOSRecordingProvider: xcrun simctl process exited with code ${exitCode} for device: ${params.deviceId}, file: ${params.fileName}`,
      );

      const compressionResult = await this._compressVideo(params.filePath);
      if (!compressionResult.success) {
        Logger.w(
          `IOSRecordingProvider: Video compression failed for ${params.filePath}: ${compressionResult.message}`,
        );
      }

      return new DeviceNodeResponse({
        success: true,
        message: `iOS recording stopped successfully for device: ${params.deviceId}, file: ${params.fileName}`,
      });
    } catch (error) {
      Logger.e(
        `IOSRecordingProvider: Error stopping recording for device: ${params.deviceId}, file: ${params.fileName}`,
        error,
      );
      return new DeviceNodeResponse({
        success: false,
        message: `Error stopping iOS recording: ${this._formatError(error)}`,
      });
    }
  }

  async checkAvailability(): Promise<DeviceNodeResponse> {
    try {
      const xcrunAvailable = await this._commandExists('xcrun');
      if (!xcrunAvailable) {
        return new DeviceNodeResponse({
          success: false,
          message: 'xcrun not found. Please ensure Xcode command line tools are installed.',
        });
      }

      Logger.i('IOSRecordingProvider: xcrun found in PATH');
      await this._execFileFn('xcrun', ['simctl', 'help']);
      Logger.i('IOSRecordingProvider: simctl is available');

      const ffmpegAvailable = await this._checkFfmpegAvailability();
      if (!ffmpegAvailable) {
        Logger.w('IOSRecordingProvider: ffmpeg not found - video compression will be disabled');
      }

      return new DeviceNodeResponse({
        success: true,
        message:
          'iOS recording tools (xcrun simctl) are available and recordVideo is supported. ' +
          (ffmpegAvailable
            ? 'Video compression enabled.'
            : 'Video compression disabled (ffmpeg not found).'),
      });
    } catch (error) {
      Logger.e('IOSRecordingProvider: Error checking iOS recording availability', error);
      return new DeviceNodeResponse({
        success: false,
        message: `Error checking iOS recording tools: ${this._formatError(error)}`,
      });
    }
  }

  async cleanupPlatformResources(deviceId: string): Promise<void> {
    Logger.i(`IOSRecordingProvider: Cleaning up resources for device: ${deviceId}`);
  }

  private async _commandExists(command: string): Promise<boolean> {
    try {
      await this._execFileFn('which', [command]);
      return true;
    } catch {
      return false;
    }
  }

  private async _checkFfmpegAvailability(): Promise<boolean> {
    return await this._commandExists('ffmpeg');
  }

  private async _compressVideo(originalFilePath: string): Promise<DeviceNodeResponse> {
    try {
      if (!(await this._checkFfmpegAvailability())) {
        return new DeviceNodeResponse({
          success: false,
          message: 'ffmpeg not available for video compression',
        });
      }

      await fsp.access(originalFilePath);

      const parsedPath = path.parse(originalFilePath);
      const compressedFilePath = path.join(
        parsedPath.dir,
        `${parsedPath.name}-small${parsedPath.ext}`,
      );

      Logger.i(`IOSRecordingProvider: Starting video compression for ${originalFilePath}`);

      await this._execFileFn('ffmpeg', [
        '-y',
        '-i',
        originalFilePath,
        '-c:v',
        'libx264',
        '-crf',
        COMPRESSION_CRF,
        compressedFilePath,
      ]);

      await fsp.access(compressedFilePath);
      // Rename straight over the original. Both paths are in the same
      // directory, where POSIX rename() replaces the destination atomically, so
      // deleting the original first buys nothing — and if the rename then fails,
      // the recording is gone with no copy left anywhere.
      await fsp.rename(compressedFilePath, originalFilePath);

      const finalFileStats = await fsp.stat(originalFilePath);
      Logger.i(
        `IOSRecordingProvider: Video compression completed. Final file size: ${(finalFileStats.size / 1024 / 1024).toFixed(2)} MB`,
      );

      return new DeviceNodeResponse({
        success: true,
        message: 'Video compressed successfully',
      });
    } catch (error) {
      Logger.e('IOSRecordingProvider: Error during video compression', error);
      return new DeviceNodeResponse({
        success: false,
        message: `Video compression error: ${this._formatError(error)}`,
      });
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

  private async _waitForExit(process: ChildProcess): Promise<number | null> {
    if (process.exitCode !== null) {
      return process.exitCode;
    }

    const [code] = await once(process, 'exit');
    return (code as number | null) ?? null;
  }

  private _formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
