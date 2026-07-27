// Port of device_node/lib/device/GrpcDriverSetup.dart
// Handles driver app installation and gRPC connection setup.
// MATCHES Dart logic: install -> port forward -> start driver (background) -> poll with ping

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { DeviceInfo, Logger } from '@finalrun/common';
import type { FilePathUtil } from '@finalrun/common';
import { AndroidDevice } from '../device/android/AndroidDevice.js';
import { Device } from '../device/Device.js';
import { LogCaptureManager } from '../device/LogCaptureManager.js';
import { IOSSimulator } from '../device/ios/IOSSimulator.js';
import { CommonDriverActions } from '../device/shared/CommonDriverActions.js';
import type { DeviceRuntime } from '../device/shared/DeviceRuntime.js';
import { AdbClient } from '../infra/android/AdbClient.js';
import { SimctlClient } from '../infra/ios/SimctlClient.js';
import { GrpcDriverClient } from './GrpcDriverClient.js';
import { GrpcPortAllocator } from './GrpcPortAllocator.js';
import {
  AndroidDeviceSetup,
  type AndroidDriverProcessHandle,
} from './setup/AndroidDeviceSetup.js';
import { IOSSimulatorSetup } from './setup/IOSSimulatorSetup.js';

// iOS port pool. Lives above the AdbClient pool (DEFAULT_GRPC_PORT_START
// + 100 slots) so an Android emulator and an iOS simulator running on the
// same host can never both try to bind the same loopback port. Without this
// they both used to land on DEFAULT_GRPC_PORT_START, the iOS gRPC client
// would connect to the Android instrumentation driver, and launchApp came
// back with Android's "Cannot launch: <pkg>, maybe the app is not present"
// — see PR notes for the failing PROD run.
const IOS_GRPC_PORT_RANGE_START = 50151;
const IOS_GRPC_PORT_RANGE_END = IOS_GRPC_PORT_RANGE_START + 100;

const execFileAsync = promisify(execFile);

/**
 * Sets up the gRPC connection to a device's driver app.
 * Flow: install driver -> connect gRPC -> return a wrapped platform runtime.
 *
 * Dart equivalent: GrpcDriverSetup in device_node/lib/device/GrpcDriverSetup.dart
 */
export class GrpcDriverSetup {
  private _adbClient: AdbClient;
  private _simctlClient: SimctlClient;
  private _filePathUtil: FilePathUtil;
  private _grpcClientFactory: () => GrpcDriverClient;
  private _delayFn: (ms: number) => Promise<void>;
  private _captureReadinessTimeoutMs: number;
  private _captureReadinessDelayMs: number;
  private _killStaleHostProcessesOnPortFn: (port: number) => Promise<void>;
  private _startAndroidDriverFn: (
    adbPath: string,
    deviceSerial: string,
    port: number,
  ) => AndroidDriverProcessHandle;
  private _androidDeviceSetup: AndroidDeviceSetup;
  private _iosSimulatorSetup: IOSSimulatorSetup;
  private _iosPortAllocator: GrpcPortAllocator;

  constructor(params: {
    adbClient: AdbClient;
    simctlClient: SimctlClient;
    filePathUtil: FilePathUtil;
    grpcClientFactory?: () => GrpcDriverClient;
    delayFn?: (ms: number) => Promise<void>;
    captureReadinessTimeoutMs?: number;
    captureReadinessDelayMs?: number;
    killStaleHostProcessesOnPortFn?: (port: number) => Promise<void>;
    startAndroidDriverFn?: (
      adbPath: string,
      deviceSerial: string,
      port: number,
    ) => AndroidDriverProcessHandle;
    iosPortAllocator?: GrpcPortAllocator;
  }) {
    this._adbClient = params.adbClient;
    this._simctlClient = params.simctlClient;
    this._filePathUtil = params.filePathUtil;
    this._grpcClientFactory = params.grpcClientFactory ?? (() => new GrpcDriverClient());
    this._delayFn = params.delayFn ?? ((ms) => this._delay(ms));
    this._captureReadinessTimeoutMs = params.captureReadinessTimeoutMs ?? 15000;
    this._captureReadinessDelayMs = params.captureReadinessDelayMs ?? 500;
    this._killStaleHostProcessesOnPortFn =
      params.killStaleHostProcessesOnPortFn ??
      ((port) => this._killStaleHostProcessesOnPort(port));
    this._startAndroidDriverFn =
      params.startAndroidDriverFn ??
      ((adbPath, deviceSerial, port) =>
        this._startAndroidDriver(adbPath, deviceSerial, port));
    this._iosPortAllocator =
      params.iosPortAllocator ??
      new GrpcPortAllocator({
        rangeStart: IOS_GRPC_PORT_RANGE_START,
        rangeEnd: IOS_GRPC_PORT_RANGE_END,
      });

    this._androidDeviceSetup = new AndroidDeviceSetup({
      adbClient: this._adbClient,
      filePathUtil: this._filePathUtil,
      connectWithPolling: async (grpcClient, host, port, options) =>
        await this._connectWithPolling(grpcClient, host, port, options),
      startAndroidDriverFn: this._startAndroidDriverFn,
      captureReadinessTimeoutMs: this._captureReadinessTimeoutMs,
      captureReadinessDelayMs: this._captureReadinessDelayMs,
    });
    this._iosSimulatorSetup = new IOSSimulatorSetup({
      simctlClient: this._simctlClient,
      filePathUtil: this._filePathUtil,
      connectWithPolling: async (grpcClient, host, port, options) =>
        await this._connectWithPolling(grpcClient, host, port, options),
      captureReadinessTimeoutMs: this._captureReadinessTimeoutMs,
      captureReadinessDelayMs: this._captureReadinessDelayMs,
      killStaleHostProcessesOnPortFn: this._killStaleHostProcessesOnPortFn,
      portAllocator: this._iosPortAllocator,
    });
  }

  async setUp(deviceInfo: DeviceInfo): Promise<Device> {
    const grpcClient = this._grpcClientFactory();

    try {
      const { runtime, adbPath } = await this._createRuntime(deviceInfo, grpcClient);
      return new Device({
        deviceInfo,
        runtime,
        logCaptureController: new LogCaptureManager({ adbPath }),
      });
    } catch (error) {
      grpcClient.close();
      throw error;
    }
  }

  private async _createRuntime(
    deviceInfo: DeviceInfo,
    grpcClient: GrpcDriverClient,
  ): Promise<{ runtime: DeviceRuntime; adbPath?: string }> {
    const commonDriverActions = new CommonDriverActions({ grpcClient });

    if (deviceInfo.isAndroid) {
      const prepared = await this._androidDeviceSetup.prepare(deviceInfo, grpcClient);
      return {
        runtime: new AndroidDevice({
          commonDriverActions,
          adbClient: this._adbClient,
          adbPath: prepared.adbPath,
          deviceSerial: prepared.deviceSerial,
        }),
        adbPath: prepared.adbPath,
      };
    }

    const prepared = await this._iosSimulatorSetup.prepare(deviceInfo, grpcClient);
    return {
      runtime: new IOSSimulator({
        commonDriverActions,
        simctlClient: this._simctlClient,
        deviceId: prepared.deviceId,
        driverProcess: prepared.driverProcess,
        restartDriver: prepared.restartDriver,
      }),
    };
  }

  /**
   * Connects to the gRPC server with polling.
   * Matches Dart: creates channel once, then polls with ping().
   * 240 attempts x 500ms = 120 seconds total timeout.
   */
  private async _connectWithPolling(
    grpcClient: GrpcDriverClient,
    host: string,
    port: number,
    options?: {
      getStartupFailureMessage?: () => string | null;
      getWaitStatusMessage?: () => string | null;
      getTimeoutMessage?: () => string | null;
    },
  ): Promise<boolean> {
    const maxAttempts = 240;
    const delayMs = 500;

    Logger.d(`GrpcDriverSetup: Creating channel to ${host}:${port}`);
    grpcClient.createChannel(host, port);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      this._throwIfStartupFailed(options);
      this._logWaitProgress(attempt, options);

      try {
        const connected = await grpcClient.ping();
        if (connected) {
          Logger.i(
            `Connected after ${attempt + 1} attempts (${((attempt + 1) * 500) / 1000}s)`,
          );
          return true;
        }
      } catch {
        // Ping failures are expected while the driver is still starting.
      }

      this._throwIfStartupFailed(options);

      await this._delayFn(delayMs);
    }

    const timeoutMessage = options?.getTimeoutMessage?.();
    if (timeoutMessage) {
      throw new Error(timeoutMessage);
    }

    Logger.e('Failed to connect after 120s (driver did not start)');
    return false;
  }

  /** Throw when the platform setup has recorded a fatal driver-startup failure. */
  private _throwIfStartupFailed(options?: {
    getStartupFailureMessage?: () => string | null;
  }): void {
    const startupFailure = options?.getStartupFailureMessage?.();
    if (startupFailure) {
      throw new Error(startupFailure);
    }
  }

  /** Every 20 polls, log that the driver is still being waited on (with any status detail). */
  private _logWaitProgress(
    attempt: number,
    options?: { getWaitStatusMessage?: () => string | null },
  ): void {
    if (attempt > 0 && attempt % 20 === 0) {
      const waitStatus = options?.getWaitStatusMessage?.();
      Logger.i(
        waitStatus
          ? `Still waiting for driver... (${(attempt * 500) / 1000}s) ${waitStatus}`
          : `Still waiting for driver... (${(attempt * 500) / 1000}s)`,
      );
    }
  }

  private _startAndroidDriver(
    adbPath: string,
    deviceSerial: string,
    port: number,
  ): AndroidDriverProcessHandle {
    const args = [
      '-s',
      deviceSerial,
      'shell',
      'am',
      'instrument',
      '-w',
      '-e',
      'port',
      String(port),
      '-e',
      'app_perfect_device_id',
      deviceSerial,
      '-e',
      'class',
      'app.finalrun.android.FinalRunTest#testDriver',
      'app.finalrun.android.test/androidx.test.runner.AndroidJUnitRunner',
    ];

    Logger.d(`Starting driver: ${adbPath} ${args.join(' ')}`);

    const child = spawn(adbPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    return child as AndroidDriverProcessHandle;
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async _killStaleHostProcessesOnPort(port: number): Promise<void> {
    try {
      const { stdout } = await execFileAsync('lsof', ['-ti', `:${port}`]);
      const pids = stdout
        .toString()
        .split('\n')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

      for (const pid of pids) {
        const { stdout: processStdout } = await execFileAsync('ps', ['-p', pid, '-o', 'comm=']);
        const processName = processStdout.toString().trim();
        if (
          processName.includes('xcodebuild') ||
          processName.includes('XCTest') ||
          processName.includes('xctrunner') ||
          processName.includes('iosUITests')
        ) {
          Logger.i(`Killing stale process ${pid} (${processName}) on port ${port}`);
          await execFileAsync('kill', ['-9', pid]);
        }
      }
    } catch {
      // Port cleanup is best-effort for simulator startup.
    }
  }
}
