import { execFile, spawn, type ChildProcess } from 'child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { DeviceNodeResponse, Logger, PLATFORM_ANDROID } from '@finalrun/common';
import { LogWriteStreamRegistry } from './logWriteStream.js';
import type { LogCaptureProvider } from './LogCaptureProvider.js';

const execFileAsync = promisify(execFile);

type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/**
 * Android device log capture via `adb logcat`.
 * Clears the ring buffer before capture, then streams in threadtime format.
 */
export class AndroidLogcatProvider implements LogCaptureProvider {
  private readonly _execFileFn: ExecFileFn;
  private readonly _spawnFn: typeof spawn;
  private readonly _adbPath: string;
  private readonly _logStreams = new LogWriteStreamRegistry();

  constructor(params?: {
    execFileFn?: ExecFileFn;
    spawnFn?: typeof spawn;
    adbPath?: string;
  }) {
    this._execFileFn = params?.execFileFn ?? execFileAsync;
    this._spawnFn = params?.spawnFn ?? spawn;
    this._adbPath = params?.adbPath ?? 'adb';
  }

  get fileExtension(): string {
    return 'log';
  }

  get platformName(): string {
    return PLATFORM_ANDROID;
  }

  async startLogCapture(params: {
    deviceId: string;
    outputFilePath: string;
    appIdentifier?: string;
  }): Promise<{ process: ChildProcess; response: DeviceNodeResponse }> {
    try {
      await this._execFileFn(this._adbPath, ['-s', params.deviceId, 'logcat', '-c']);
      Logger.i(
        `AndroidLogcatProvider: Cleared logcat ring buffer for device ${params.deviceId}`,
      );

      const writeStream = this._logStreams.open(params.outputFilePath);
      const args = ['-s', params.deviceId, 'logcat', '-v', 'threadtime'];

      if (params.appIdentifier) {
        try {
          const { stdout } = await this._execFileFn(this._adbPath, [
            '-s', params.deviceId, 'shell', 'pidof', params.appIdentifier,
          ]);
          const pids = String(stdout).trim().split(/\s+/).filter(Boolean);
          for (const pid of pids) {
            args.push('--pid', pid);
          }
          if (pids.length > 0) {
            Logger.i(
              `AndroidLogcatProvider: Filtering by PID(s) ${pids.join(', ')} for package ${params.appIdentifier}`,
            );
          } else {
            Logger.w(
              `AndroidLogcatProvider: pidof returned no PIDs for ${params.appIdentifier}, capturing all logs`,
            );
          }
        } catch {
          Logger.w(
            `AndroidLogcatProvider: Failed to resolve PID for ${params.appIdentifier}, capturing all logs`,
          );
        }
      }

      Logger.i(
        `AndroidLogcatProvider: Starting log capture for device ${params.deviceId} with command: adb ${args.join(' ')}`,
      );

      const childProcess = this._spawnFn(this._adbPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      }) as ChildProcess;

      childProcess.stdout?.pipe(writeStream);
      childProcess.stderr?.on('data', (data: Buffer | string) => {
        Logger.w(`adb logcat stderr: ${String(data)}`);
      });

      return {
        process: childProcess,
        response: new DeviceNodeResponse({
          success: true,
          message: `Android log capture started for device: ${params.deviceId}, file: ${params.outputFilePath}`,
        }),
      };
    } catch (error) {
      Logger.e(
        `AndroidLogcatProvider: Failed to start log capture for device ${params.deviceId}:`,
        error,
      );
      // The write stream may already be open — the caller never receives a
      // handle on this path, so closing it here is the only chance to.
      await this._logStreams.finalizeQuietly(params.outputFilePath);
      throw new Error(
        `Failed to start Android log capture for device ${params.deviceId}: ${this._formatError(error)}`,
      );
    }
  }

  async stopLogCapture(params: {
    process: ChildProcess;
    outputFilePath: string;
  }): Promise<DeviceNodeResponse> {
    try {
      const killSent = params.process.kill('SIGINT');
      Logger.i(`AndroidLogcatProvider: Sent SIGINT to adb logcat process: ${killSent}`);

      if (!killSent) {
        if (params.process.exitCode !== null) {
          Logger.i(
            `AndroidLogcatProvider: adb logcat process already exited (code ${params.process.exitCode}) for file: ${params.outputFilePath}`,
          );
        } else {
          Logger.e(
            `AndroidLogcatProvider: Failed to deliver SIGINT for log capture file: ${params.outputFilePath}`,
          );
          // The capture is over for this caller either way, so finalize before
          // returning: leaving the stream open leaks its fd, leaves the log file
          // truncated at whatever was buffered, and leaves the registry entry
          // behind for the lifetime of the process-wide capture manager — which
          // drops its handle on this process regardless of the response below,
          // so nothing could ever reach the stream again.
          await this._logStreams.finalizeQuietly(params.outputFilePath, params.process.stdout);
          return new DeviceNodeResponse({
            success: false,
            message: 'Failed to send SIGINT to adb logcat process.',
          });
        }
      }

      const exitCode = await this._waitForExit(params.process);
      Logger.i(
        `AndroidLogcatProvider: adb logcat process exited with code ${exitCode} for file: ${params.outputFilePath}`,
      );

      // Drain stdout to EOF, then end the log file's write stream and wait for
      // its flush. `stdout.unpipe()` on its own — which is all this used to do
      // — detaches the pipe without ending the destination, so buffered logcat
      // output was dropped and the file the CLI copies next was truncated. A
      // failure here fails the stop: the file is not known to be complete.
      await this._logStreams.finalize(params.outputFilePath, params.process.stdout);

      return new DeviceNodeResponse({
        success: true,
        message: `Android log capture stopped successfully for file: ${params.outputFilePath}`,
      });
    } catch (error) {
      Logger.e(
        `AndroidLogcatProvider: Error stopping log capture for file: ${params.outputFilePath}`,
        error,
      );
      // `_waitForExit` threw (or the finalize above did) — finalize again so no
      // path out of `stopLogCapture` leaves the stream open or tracked. Cheap
      // and idempotent: an already-finalized path is untracked and returns at
      // once.
      await this._logStreams.finalizeQuietly(params.outputFilePath, params.process.stdout);
      return new DeviceNodeResponse({
        success: false,
        message: `Error stopping Android log capture: ${this._formatError(error)}`,
      });
    }
  }

  async checkAvailability(): Promise<DeviceNodeResponse> {
    try {
      await this._execFileFn('which', [this._adbPath]);
      return new DeviceNodeResponse({
        success: true,
        message: 'Android log capture tools (adb) are available.',
      });
    } catch (error) {
      Logger.e('AndroidLogcatProvider: Error checking adb availability', error);
      return new DeviceNodeResponse({
        success: false,
        message: `adb not found. Please ensure Android SDK platform-tools are installed: ${this._formatError(error)}`,
      });
    }
  }

  async cleanupPlatformResources(deviceId: string): Promise<void> {
    Logger.i(`AndroidLogcatProvider: Cleaning up resources for device: ${deviceId}`);
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
