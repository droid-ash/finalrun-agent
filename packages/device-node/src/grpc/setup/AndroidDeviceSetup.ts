import {
  DeviceInfo,
  Logger,
  type FilePathUtil,
} from '@finalrun/common';
import { waitForDriverCaptureReadiness } from '../../capture/ScreenshotCaptureCoordinator.js';
import {
  ANDROID_DRIVER_APP_PACKAGE_NAME,
  ANDROID_DRIVER_TEST_PACKAGE_NAME,
  type AdbClient,
} from '../../infra/android/AdbClient.js';
import type { GrpcDriverClient } from '../GrpcDriverClient.js';

export interface AndroidDriverProcessHandle {
  pid?: number;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

interface AndroidDriverStartupState {
  setupComplete: boolean;
  failureMessage: string | null;
  recentLogs: string[];
  processEnded: boolean;
  exitDescription: string | null;
  pid?: number;
}

/**
 * Thrown when the gRPC server is reachable but UiAutomation never finished
 * binding within the capture-readiness window. Separate from generic errors
 * so `prepare` can retry once before rolling back.
 */
class CaptureReadinessError extends Error {
  readonly isCaptureReadinessFailure = true;
  constructor(message: string) {
    super(message);
    this.name = 'CaptureReadinessError';
  }
}

export class AndroidDeviceSetup {
  private _adbClient: AdbClient;
  private _filePathUtil: FilePathUtil;
  private _connectWithPolling: (
    grpcClient: GrpcDriverClient,
    host: string,
    port: number,
    options?: {
      getStartupFailureMessage?: () => string | null;
      getWaitStatusMessage?: () => string | null;
      getTimeoutMessage?: () => string | null;
    },
  ) => Promise<boolean>;
  private _startAndroidDriverFn: (
    adbPath: string,
    deviceSerial: string,
    port: number,
  ) => AndroidDriverProcessHandle;
  private _captureReadinessTimeoutMs: number;
  private _captureReadinessDelayMs: number;

  constructor(params: {
    adbClient: AdbClient;
    filePathUtil: FilePathUtil;
    connectWithPolling: (
      grpcClient: GrpcDriverClient,
      host: string,
      port: number,
      options?: {
        getStartupFailureMessage?: () => string | null;
        getWaitStatusMessage?: () => string | null;
        getTimeoutMessage?: () => string | null;
      },
    ) => Promise<boolean>;
    startAndroidDriverFn: (
      adbPath: string,
      deviceSerial: string,
      port: number,
    ) => AndroidDriverProcessHandle;
    captureReadinessTimeoutMs: number;
    captureReadinessDelayMs: number;
  }) {
    this._adbClient = params.adbClient;
    this._filePathUtil = params.filePathUtil;
    this._connectWithPolling = params.connectWithPolling;
    this._startAndroidDriverFn = params.startAndroidDriverFn;
    this._captureReadinessTimeoutMs = params.captureReadinessTimeoutMs;
    this._captureReadinessDelayMs = params.captureReadinessDelayMs;
  }

  async prepare(
    deviceInfo: DeviceInfo,
    grpcClient: GrpcDriverClient,
  ): Promise<{ adbPath: string; deviceSerial: string }> {
    const deviceSerial = deviceInfo.id;
    if (!deviceSerial) {
      throw new Error('Android device serial is required for driver setup.');
    }

    const adbPath = await this._filePathUtil.getADBPath();
    if (!adbPath) {
      throw new Error('ADB not found. Please install Android SDK platform-tools.');
    }

    await this._cleanupStaleDriverProcesses(adbPath, deviceSerial);

    let driverInstalled = false;
    let testRunnerInstalled = false;
    let localPort: number | null = null;
    let driverProcess: AndroidDriverProcessHandle | null = null;

    try {
      const driverPath = await this._filePathUtil.getDriverAppPath();
      if (!driverPath) {
        throw new Error(
          'Driver app APK not found. Configure FINALRUN_ASSET_DIR, FINALRUN_ASSET_MANIFEST_PATH, or FINALRUN_ASSET_MANIFEST_URL.',
        );
      }

      Logger.i(`Installing driver app on ${deviceSerial}...`);
      const installed = await this._adbClient.installDriverApp(
        adbPath,
        deviceSerial,
        driverPath,
        ANDROID_DRIVER_APP_PACKAGE_NAME,
      );
      if (!installed) {
        throw new Error('Failed to install driver app APK');
      }
      driverInstalled = true;

      const testAppPath = await this._filePathUtil.getDriverTestAppPath();
      if (testAppPath) {
        Logger.i(`Installing test runner APK on ${deviceSerial}...`);
        const testInstalled = await this._adbClient.installDriverApp(
          adbPath,
          deviceSerial,
          testAppPath,
          ANDROID_DRIVER_TEST_PACKAGE_NAME,
        );
        if (!testInstalled) {
          throw new Error('Failed to install test runner APK');
        }
        testRunnerInstalled = true;
      } else {
        Logger.w('Test runner APK not found - instrumentation may fail');
      }

      await this._adbClient.removePortForward(adbPath, deviceSerial);
      // forwardPort allocates a port from the AdbClient's pool and uses
      // the same value on both sides of the forward. The driver app gets
      // launched with `-e port localPort` so all references line up.
      localPort = await this._adbClient.forwardPort(adbPath, deviceSerial);

      let spawned = await this._spawnDriverAndAwaitGrpc(
        adbPath,
        deviceSerial,
        localPort,
        grpcClient,
      );
      driverProcess = spawned.driverProcess;

      try {
        await this._awaitCaptureReadiness(spawned.startupState, grpcClient);
      } catch (err) {
        if (!(err instanceof CaptureReadinessError)) {
          throw err;
        }
        Logger.w(
          `Driver reached gRPC but UiAutomation never bound on ${deviceSerial} (${err.message}); retrying once after deep cleanup`,
        );
        const priorProcessGone = await this._tearDownDriverAttempt(
          adbPath,
          deviceSerial,
          spawned.driverProcess,
        );
        driverProcess = null;
        if (!priorProcessGone) {
          // The prior instrumentation host is still alive after the cleanup
          // cap, so its UiAutomation binding is likely still held. Starting a
          // second `am instrument` now would race the same stale binding the
          // retry is meant to escape — bail and surface the original readiness
          // error instead of masking it with a second failure.
          throw err;
        }

        spawned = await this._spawnDriverAndAwaitGrpc(
          adbPath,
          deviceSerial,
          localPort,
          grpcClient,
        );
        driverProcess = spawned.driverProcess;

        await this._awaitCaptureReadiness(spawned.startupState, grpcClient);
      }

      spawned.startupState.setupComplete = true;
      Logger.i('gRPC connection established successfully');
      return { adbPath, deviceSerial };
    } catch (error) {
      await this._rollbackFailedSetup({
        adbPath,
        deviceSerial,
        localPort,
        driverProcess,
        driverInstalled,
        testRunnerInstalled,
      });
      throw error;
    }
  }

  private _trackAndroidDriverProcess(
    deviceSerial: string,
    driverProcess: AndroidDriverProcessHandle,
  ): AndroidDriverStartupState {
    const state: AndroidDriverStartupState = {
      setupComplete: false,
      failureMessage: null,
      recentLogs: [],
      processEnded: false,
      exitDescription: null,
      pid: driverProcess.pid,
    };

    const appendLog = (source: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = chunk.toString().trim();
      if (!text) {
        return;
      }

      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        Logger.d(`Android driver ${source}: ${trimmed}`);
        state.recentLogs.push(`${source}: ${trimmed}`);
        if (state.recentLogs.length > 20) {
          state.recentLogs.shift();
        }
      }
    };

    driverProcess.stdout?.on('data', (chunk: Buffer | string) => appendLog('stdout', chunk));
    driverProcess.stderr?.on('data', (chunk: Buffer | string) => appendLog('stderr', chunk));

    driverProcess.on('error', (error: Error) => {
      state.processEnded = true;
      state.exitDescription = `error: ${error.message}`;
      state.failureMessage = `Android driver process error for ${deviceSerial}: ${error.message}`;
      Logger.e(state.failureMessage);
    });

    driverProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      state.processEnded = true;
      state.exitDescription =
        code !== null ? `code ${code}` : signal ? `signal ${signal}` : 'unknown status';
      const logSuffix =
        state.recentLogs.length > 0 ? ` Logs: ${state.recentLogs.join(' | ')}` : '';

      if (!state.setupComplete) {
        state.failureMessage =
          `Android driver process exited before setup completed (${state.exitDescription}) for ${deviceSerial}.${logSuffix}`;
        Logger.e(state.failureMessage);
      } else {
        Logger.i(
          `Android driver process ended for ${deviceSerial} (${state.exitDescription})`,
        );
      }
    });

    return state;
  }

  private _formatWaitStatus(state: AndroidDriverStartupState): string {
    const processState = state.processEnded
      ? `process exited (${state.exitDescription ?? 'unknown status'})`
      : `process alive${state.pid ? ` pid=${state.pid}` : ''}`;
    const lastLog = state.recentLogs.at(-1);
    return lastLog
      ? `${processState}; last log: ${lastLog}`
      : `${processState}; no driver output yet`;
  }

  private _buildTimeoutMessage(
    deviceSerial: string,
    localPort: number,
    state: AndroidDriverStartupState,
  ): string {
    const processState = state.processEnded
      ? `exited (${state.exitDescription ?? 'unknown status'})`
      : `alive${state.pid ? ` pid=${state.pid}` : ''}`;
    const logSummary =
      state.recentLogs.length > 0 ? state.recentLogs.join(' | ') : 'none';
    return (
      `Android device ${deviceSerial} was ready, but the driver never became reachable over ` +
      `gRPC at 127.0.0.1:${localPort} after 120s. Process state: ${processState}. ` +
      `Recent logs: ${logSummary}.`
    );
  }

  private async _cleanupStaleDriverProcesses(
    adbPath: string,
    deviceSerial: string,
  ): Promise<void> {
    Logger.d(`Cleaning up stale driver processes on ${deviceSerial}...`);
    await this._adbClient.forceStop(
      adbPath,
      deviceSerial,
      ANDROID_DRIVER_TEST_PACKAGE_NAME,
      { suppressErrorLog: true },
    );
    await this._adbClient.forceStop(
      adbPath,
      deviceSerial,
      ANDROID_DRIVER_APP_PACKAGE_NAME,
      { suppressErrorLog: true },
    );
    // `pm clear` on the instrumentation test package evicts its process and
    // drops any AccessibilityManagerService binding held against its UID —
    // the root cause of second-run UiAutomation bind-with-id=-1 failures.
    // The test APK holds no user data, and the driver APK (which keeps the
    // runtime permissions granted via `adb install -g`) is deliberately not
    // cleared.
    await this._adbClient.clearAppData(
      adbPath,
      deviceSerial,
      ANDROID_DRIVER_TEST_PACKAGE_NAME,
    );
    await this._waitForProcessGone(
      adbPath,
      deviceSerial,
      ANDROID_DRIVER_TEST_PACKAGE_NAME,
    );
  }

  /**
   * Poll `pidof <package>` until the process disappears or the cap elapses.
   * Returns true if the process is confirmed gone, false on cap timeout.
   * Callers decide whether a timeout is fatal: pre-run cleanup treats it as
   * best-effort (subsequent phases will surface real problems), but the
   * inter-attempt retry path must NOT proceed on a timeout — the stale
   * UiAutomation binding we were waiting to release is the exact race the
   * retry is meant to avoid.
   */
  private async _waitForProcessGone(
    adbPath: string,
    deviceSerial: string,
    packageName: string,
    capMs = 5000,
  ): Promise<boolean> {
    const pollMs = 250;
    const startedAt = Date.now();
    while (Date.now() - startedAt < capMs) {
      const running = await this._adbClient.isProcessRunning(
        adbPath,
        deviceSerial,
        packageName,
      );
      if (!running) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    Logger.w(
      `Timed out waiting for ${packageName} on ${deviceSerial} to exit after ${capMs}ms`,
    );
    return false;
  }

  /**
   * Install APKs already done; port forward already set up. This brings up a
   * single instrumentation attempt: spawn the driver, track its process, and
   * poll the gRPC port. On failure it cleans up the spawned process before
   * re-throwing so the caller doesn't leak a pid.
   */
  private async _spawnDriverAndAwaitGrpc(
    adbPath: string,
    deviceSerial: string,
    localPort: number,
    grpcClient: GrpcDriverClient,
  ): Promise<{
    driverProcess: AndroidDriverProcessHandle;
    startupState: AndroidDriverStartupState;
  }> {
    Logger.i('Starting Android driver instrumentation...');
    const driverProcess = this._startAndroidDriverFn(adbPath, deviceSerial, localPort);
    const startupState = this._trackAndroidDriverProcess(deviceSerial, driverProcess);

    try {
      Logger.i(`Waiting for Android driver gRPC at 127.0.0.1:${localPort}...`);
      const connected = await this._connectWithPolling(
        grpcClient,
        '127.0.0.1',
        localPort,
        {
          getStartupFailureMessage: () => startupState.failureMessage,
          getWaitStatusMessage: () => this._formatWaitStatus(startupState),
          getTimeoutMessage: () =>
            this._buildTimeoutMessage(deviceSerial, localPort, startupState),
        },
      );
      if (!connected) {
        throw new Error(
          'Failed to connect to device via gRPC after 120s - driver did not start',
        );
      }
      return { driverProcess, startupState };
    } catch (err) {
      if (!driverProcess.killed) {
        try {
          driverProcess.kill('SIGKILL');
        } catch (killErr) {
          Logger.w(
            `Failed to kill Android driver process after gRPC connect failure for ${deviceSerial}:`,
            killErr,
          );
        }
      }
      throw err;
    }
  }

  /**
   * Poll `getScreenshotAndHierarchy` until UiAutomation is bound or the
   * capture-readiness window expires. Only the transient window-expired case
   * throws `CaptureReadinessError` so `prepare` retries once; a non-transient
   * failure (e.g. "device offline", permission denied) throws a plain Error
   * and falls straight to rollback. A process-death failure also surfaces
   * directly via `startupState.failureMessage` — no retry.
   */
  private async _awaitCaptureReadiness(
    startupState: AndroidDriverStartupState,
    grpcClient: GrpcDriverClient,
  ): Promise<void> {
    const captureReady = await waitForDriverCaptureReadiness(grpcClient, {
      timeoutMs: this._captureReadinessTimeoutMs,
      delayMs: this._captureReadinessDelayMs,
    });
    if (!captureReady.ready) {
      if (startupState.failureMessage) {
        throw new Error(startupState.failureMessage);
      }
      const reason = captureReady.message ?? 'unknown capture readiness error';
      if (!captureReady.transient) {
        throw new Error(
          `Driver started and gRPC connected, but capture-readiness reported a non-transient failure: ${reason}`,
        );
      }
      throw new CaptureReadinessError(
        `Driver started and gRPC connected, but UiAutomation never became ready for screenshot capture after ${this._captureReadinessTimeoutMs / 1000}s: ${reason}`,
      );
    }
    if (startupState.failureMessage) {
      throw new Error(startupState.failureMessage);
    }
  }

  /**
   * Inter-attempt teardown used when the first driver start succeeded at the
   * gRPC level but failed the UiAutomation readiness gate. Kills the prior
   * process, force-stops both packages, clears the test package's state, and
   * waits for its process to exit before the next attempt starts.
   * Returns true if the prior instrumentation host is confirmed gone — the
   * retry should only proceed in that case.
   */
  private async _tearDownDriverAttempt(
    adbPath: string,
    deviceSerial: string,
    driverProcess: AndroidDriverProcessHandle,
  ): Promise<boolean> {
    if (!driverProcess.killed) {
      try {
        driverProcess.kill('SIGKILL');
      } catch (error) {
        Logger.w(
          `Failed to kill previous Android driver process for ${deviceSerial}:`,
          error,
        );
      }
    }
    await this._adbClient.forceStop(
      adbPath,
      deviceSerial,
      ANDROID_DRIVER_TEST_PACKAGE_NAME,
      { suppressErrorLog: true },
    );
    await this._adbClient.forceStop(
      adbPath,
      deviceSerial,
      ANDROID_DRIVER_APP_PACKAGE_NAME,
      { suppressErrorLog: true },
    );
    await this._adbClient.clearAppData(
      adbPath,
      deviceSerial,
      ANDROID_DRIVER_TEST_PACKAGE_NAME,
    );
    return await this._waitForProcessGone(
      adbPath,
      deviceSerial,
      ANDROID_DRIVER_TEST_PACKAGE_NAME,
    );
  }

  private async _rollbackFailedSetup(params: {
    adbPath: string;
    deviceSerial: string;
    localPort: number | null;
    driverProcess: AndroidDriverProcessHandle | null;
    driverInstalled: boolean;
    testRunnerInstalled: boolean;
  }): Promise<void> {
    if (params.driverProcess && !params.driverProcess.killed) {
      try {
        const killed = params.driverProcess.kill('SIGKILL');
        Logger.i(
          `Killed Android driver host process for ${params.deviceSerial}: ${killed}`,
        );
      } catch (error) {
        Logger.w(
          `Failed to kill Android driver host process for ${params.deviceSerial}:`,
          error,
        );
      }
    }

    if (params.localPort !== null) {
      try {
        await this._adbClient.removePortForward(params.adbPath, params.deviceSerial);
      } catch (error) {
        Logger.w(
          `Failed to remove Android port forward for ${params.deviceSerial}:`,
          error,
        );
      }
    }

    if (params.driverInstalled) {
      await this._adbClient.forceStop(
        params.adbPath,
        params.deviceSerial,
        ANDROID_DRIVER_APP_PACKAGE_NAME,
        { suppressErrorLog: true },
      );
    }
    if (params.testRunnerInstalled) {
      await this._adbClient.forceStop(
        params.adbPath,
        params.deviceSerial,
        ANDROID_DRIVER_TEST_PACKAGE_NAME,
        { suppressErrorLog: true },
      );
      // Ensure the instrumentation host is gone before returning control.
      // Otherwise the next `prepare()` can race a still-running `am instrument`
      // that still holds the old UiAutomation binding, reproducing the very
      // second-run failure this rollback is meant to clean up after.
      await this._waitForProcessGone(
        params.adbPath,
        params.deviceSerial,
        ANDROID_DRIVER_TEST_PACKAGE_NAME,
      );
    }
  }
}
