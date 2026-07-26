import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  DeviceActionRequest,
  DeviceInfo,
  ScrollAbsAction,
} from '@finalrun/common';
import type { FilePathUtil } from '@finalrun/common';
import type { AdbClient } from '../../infra/android/AdbClient.js';
import type { IOSDriverProcessHandle, SimctlClient } from '../../infra/ios/SimctlClient.js';
import type { GrpcDriverClient, GrpcScreenshotResponse } from '../GrpcDriverClient.js';
import { GrpcDriverSetup } from '../GrpcDriverSetup.js';
import { GrpcPortAllocator } from '../GrpcPortAllocator.js';

/**
 * Allocator used by iOS-path tests. Mirrors the default range
 * (50151 + 100 slots) but skips the kernel bindability probe so tests are
 * deterministic regardless of what's listening on the host.
 */
function stubIOSPortAllocator(): GrpcPortAllocator {
  return new GrpcPortAllocator({
    rangeStart: 50151,
    rangeEnd: 50251,
    isPortBindable: async () => true,
  });
}

class FakeGrpcClient {
  channelCreations: Array<{ host: string; port: number }> = [];
  pingResponses: boolean[];
  captureResponses: Array<GrpcScreenshotResponse | Error>;
  updateAppIdsResponses: Array<{ success: boolean; message?: string }>;
  captureCalls = 0;
  updateAppIdsCalls: string[][] = [];

  constructor(params?: {
    pingResponses?: boolean[];
    captureResponses?: Array<GrpcScreenshotResponse | Error>;
    updateAppIdsResponses?: Array<{ success: boolean; message?: string }>;
  }) {
    this.pingResponses = params?.pingResponses ?? [true];
    this.captureResponses = params?.captureResponses ?? [];
    this.updateAppIdsResponses = params?.updateAppIdsResponses ?? [{ success: true }];
  }

  get isConnected(): boolean {
    return true;
  }

  createChannel(host: string, port: number): void {
    this.channelCreations.push({ host, port });
  }

  async ping(): Promise<boolean> {
    return this.pingResponses.shift() ?? false;
  }

  async getScreenshotAndHierarchy(): Promise<GrpcScreenshotResponse> {
    this.captureCalls += 1;
    const next =
      this.captureResponses.shift() ??
      new Error('No screenshot response configured');
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  async updateAppIds(appIds: string[]): Promise<{ success: boolean; message?: string }> {
    this.updateAppIdsCalls.push(appIds);
    return this.updateAppIdsResponses.shift() ?? { success: true };
  }

  close(): void {}
}

class FakeIOSDriverProcess extends EventEmitter implements IOSDriverProcessHandle {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4321;

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

class FakeAndroidDriverProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 9876;
  killed = false;

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }

  emitError(error: Error): void {
    this.emit('error', error);
  }
}

function createFilePathUtil(overrides?: Partial<FilePathUtil>): FilePathUtil {
  return {
    getADBPath: async () => '/usr/bin/adb',
    getDriverAppPath: async () => '/tmp/app-debug.apk',
    getDriverTestAppPath: async () => '/tmp/app-debug-androidTest.apk',
    getIOSDriverAppPath: async () => '/tmp/finalrun-ios-test-Runner.app',
    getAppFilePath: async (appFileName: string) => appFileName,
    ensureIOSAppsAvailable: async () => undefined,
    ...overrides,
  };
}

// Android driver setup touches several AdbClient methods during cleanup,
// install, forward, and rollback. Tests that don't care about those calls can
// use this default fake and override just the methods they assert on.
function createAndroidAdbClientFake(
  overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {},
): AdbClient {
  return {
    async installApp() {
      return true;
    },
    async installDriverApp(
      adbPath: string,
      deviceSerial: string,
      apkPath: string,
      _packageName: string,
    ) {
      return await (this as unknown as AdbClient).installApp(
        adbPath,
        deviceSerial,
        apkPath,
      );
    },
    async removePortForward() {},
    async forwardPort() {
      return 50051;
    },
    async forceStop() {
      return { success: true };
    },
    async clearAppData() {
      return { success: true };
    },
    async isProcessRunning() {
      return false;
    },
    ...overrides,
  } as unknown as AdbClient;
}

test('GrpcDriverSetup waits for screenshot capture readiness after ping succeeds', async () => {
  const grpcClient = new FakeGrpcClient({
    pingResponses: [true],
    captureResponses: [
      { success: false, message: 'UiAutomation not connected', screenWidth: 0, screenHeight: 0 },
      { success: false, message: 'UiAutomation not connected', screenWidth: 0, screenHeight: 0 },
      {
        success: true,
        screenshot: 'image',
        hierarchy: '[]',
        screenWidth: 1080,
        screenHeight: 2400,
      },
    ],
  });
  const driverProcess = new FakeAndroidDriverProcess();

  const setup = new GrpcDriverSetup({
    adbClient: createAndroidAdbClientFake(),
    simctlClient: {} as SimctlClient,
    filePathUtil: createFilePathUtil({
      getIOSDriverAppPath: async () => null,
    }),
    grpcClientFactory: () => grpcClient as unknown as GrpcDriverClient,
    delayFn: async () => undefined,
    startAndroidDriverFn: () => driverProcess,
    captureReadinessTimeoutMs: 1000,
    captureReadinessDelayMs: 0,
  });

  const device = await setup.setUp(
    new DeviceInfo({
      id: 'emulator-5554',
      deviceUUID: 'device-1',
      isAndroid: true,
      sdkVersion: 34,
      name: 'Android Emulator',
    }),
  );

  assert.equal(device.getDeviceInfo().id, 'emulator-5554');
  assert.equal(grpcClient.channelCreations.length, 1);
  assert.equal(grpcClient.captureCalls, 3);
});

test('GrpcDriverSetup fails when Android UiAutomation never becomes capture-ready after a retry', async () => {
  // prepare() now retries the driver start phase once when UiAutomation
  // never binds, so the final-failure path needs to survive both attempts.
  const transientCaptureResponse: GrpcScreenshotResponse = {
    success: false,
    message: 'UiAutomation not connected',
    screenWidth: 0,
    screenHeight: 0,
  };
  const grpcClient = new FakeGrpcClient({
    pingResponses: [true, true],
    captureResponses: Array.from({ length: 40 }, () => ({
      ...transientCaptureResponse,
    })),
  });
  const driverProcesses = [new FakeAndroidDriverProcess(), new FakeAndroidDriverProcess()];
  let spawnCount = 0;

  const setup = new GrpcDriverSetup({
    adbClient: createAndroidAdbClientFake(),
    simctlClient: {} as SimctlClient,
    filePathUtil: createFilePathUtil({
      getIOSDriverAppPath: async () => null,
    }),
    grpcClientFactory: () => grpcClient as unknown as GrpcDriverClient,
    delayFn: async () => undefined,
    startAndroidDriverFn: () => {
      const next = driverProcesses[spawnCount] ?? new FakeAndroidDriverProcess();
      spawnCount += 1;
      return next;
    },
    captureReadinessTimeoutMs: 20,
    captureReadinessDelayMs: 5,
  });

  await assert.rejects(
    () =>
      setup.setUp(
        new DeviceInfo({
          id: 'emulator-5554',
          deviceUUID: 'device-1',
          isAndroid: true,
          sdkVersion: 34,
          name: 'Android Emulator',
        }),
      ),
    /UiAutomation never became ready/,
  );
  assert.equal(spawnCount, 2, 'expected one retry after capture-readiness failure');
  assert.equal(driverProcesses[0]!.killed, true, 'first driver should be killed before retry');
});

test('GrpcDriverSetup recovers when a stale UiAutomation binding clears after the one-shot retry', async () => {
  // Simulates the back-to-back-run failure: the first instrumentation attempt
  // connects over gRPC but never finishes binding UiAutomation. After the
  // inter-attempt teardown (force-stop + pm clear + pidof wait) the second
  // attempt succeeds. This is the core scenario the retry guard protects.
  const driverProcesses = [new FakeAndroidDriverProcess(), new FakeAndroidDriverProcess()];
  let spawnCount = 0;
  const adbCalls: string[] = [];

  // State-driven fake: the first spawned driver always replies "UiAutomation
  // not connected" (exhausting the readiness window), and the retry's driver
  // returns a successful capture on its first poll. This keeps the response
  // boundary tied to *attempt*, not to how many polls fit in a 20ms window.
  const grpcClient = {
    channelCreations: [] as Array<{ host: string; port: number }>,
    captureCalls: 0,
    get isConnected(): boolean {
      return true;
    },
    createChannel(host: string, port: number): void {
      this.channelCreations.push({ host, port });
    },
    async ping(): Promise<boolean> {
      return true;
    },
    async getScreenshotAndHierarchy(): Promise<GrpcScreenshotResponse> {
      this.captureCalls += 1;
      if (spawnCount <= 1) {
        return {
          success: false,
          message: 'UiAutomation not connected',
          screenWidth: 0,
          screenHeight: 0,
        };
      }
      return {
        success: true,
        screenshot: 'image',
        hierarchy: '[]',
        screenWidth: 1080,
        screenHeight: 2400,
      };
    },
    async updateAppIds(): Promise<{ success: boolean; message?: string }> {
      return { success: true };
    },
    close(): void {},
  };

  const setup = new GrpcDriverSetup({
    adbClient: createAndroidAdbClientFake({
      async forceStop(...args: unknown[]) {
        const [, , packageName] = args as [string, string, string];
        adbCalls.push(`forceStop:${packageName}`);
        return { success: true };
      },
      async clearAppData(...args: unknown[]) {
        const [, , packageName] = args as [string, string, string];
        adbCalls.push(`clearAppData:${packageName}`);
        return { success: true };
      },
      async isProcessRunning(...args: unknown[]) {
        const [, , packageName] = args as [string, string, string];
        adbCalls.push(`isProcessRunning:${packageName}`);
        return false;
      },
    }),
    simctlClient: {} as SimctlClient,
    filePathUtil: createFilePathUtil({
      getIOSDriverAppPath: async () => null,
    }),
    grpcClientFactory: () => grpcClient as unknown as GrpcDriverClient,
    delayFn: async () => undefined,
    startAndroidDriverFn: () => {
      const next = driverProcesses[spawnCount] ?? new FakeAndroidDriverProcess();
      spawnCount += 1;
      return next;
    },
    captureReadinessTimeoutMs: 20,
    captureReadinessDelayMs: 5,
  });

  const device = await setup.setUp(
    new DeviceInfo({
      id: 'emulator-5554',
      deviceUUID: 'device-1',
      isAndroid: true,
      sdkVersion: 34,
      name: 'Android Emulator',
    }),
  );

  assert.equal(device.getDeviceInfo().id, 'emulator-5554');
  assert.equal(spawnCount, 2, 'expected exactly one retry');
  assert.equal(driverProcesses[0]!.killed, true, 'first driver should be SIGKILLed between attempts');
  assert.equal(driverProcesses[1]!.killed, false, 'second driver should remain alive after success');
  // The same force-stop + pm clear + pidof sequence must run twice — once for
  // pre-run cleanup, once between attempts — so a stale UiAutomation binding
  // from the first attempt is genuinely released before the retry spawns.
  assert.deepEqual(adbCalls, [
    'forceStop:app.finalrun.android.test',
    'forceStop:app.finalrun.android',
    'clearAppData:app.finalrun.android.test',
    'isProcessRunning:app.finalrun.android.test',
    'forceStop:app.finalrun.android.test',
    'forceStop:app.finalrun.android',
    'clearAppData:app.finalrun.android.test',
    'isProcessRunning:app.finalrun.android.test',
  ]);
});

test('GrpcDriverSetup does not retry when capture-readiness reports a non-transient failure', async () => {
  // "device offline" is not in TRANSIENT_CAPTURE_PATTERNS, so
  // waitForCaptureReadiness early-bails with {ready: false, transient: false}.
  // The retry is meant for the stale-UiAutomation (transient-but-window-expired)
  // case only — a non-transient failure must surface immediately without
  // burning an extra teardown + re-spawn cycle.
  const grpcClient = new FakeGrpcClient({
    pingResponses: [true],
    captureResponses: [
      { success: false, message: 'device offline', screenWidth: 0, screenHeight: 0 },
    ],
  });
  let spawnCount = 0;

  const setup = new GrpcDriverSetup({
    adbClient: createAndroidAdbClientFake(),
    simctlClient: {} as SimctlClient,
    filePathUtil: createFilePathUtil({
      getIOSDriverAppPath: async () => null,
    }),
    grpcClientFactory: () => grpcClient as unknown as GrpcDriverClient,
    delayFn: async () => undefined,
    startAndroidDriverFn: () => {
      spawnCount += 1;
      return new FakeAndroidDriverProcess();
    },
    captureReadinessTimeoutMs: 1000,
    captureReadinessDelayMs: 0,
  });

  await assert.rejects(
    () =>
      setup.setUp(
        new DeviceInfo({
          id: 'emulator-5554',
          deviceUUID: 'device-1',
          isAndroid: true,
          sdkVersion: 34,
          name: 'Android Emulator',
        }),
      ),
    /non-transient failure.*device offline/,
  );
  assert.equal(spawnCount, 1, 'non-transient failure must not trigger the one-shot retry');
});

test('GrpcDriverSetup aborts retry when the prior test-package process never disappears', async () => {
  // Inter-attempt teardown polls `pidof` to confirm the instrumentation host
  // is gone before spawning a second `am instrument`. If the poll times out,
  // the stale UiAutomation binding is likely still held — retrying would race
  // the exact condition the retry is meant to escape. The retry must bail and
  // surface the original capture-readiness error instead.
  const transientCaptureResponse: GrpcScreenshotResponse = {
    success: false,
    message: 'UiAutomation not connected',
    screenWidth: 0,
    screenHeight: 0,
  };
  const grpcClient = new FakeGrpcClient({
    pingResponses: [true],
    captureResponses: Array.from({ length: 20 }, () => ({
      ...transientCaptureResponse,
    })),
  });
  let spawnCount = 0;
  const isProcessRunningCalls: string[] = [];

  const setup = new GrpcDriverSetup({
    adbClient: createAndroidAdbClientFake({
      async isProcessRunning(...args: unknown[]) {
        const [, , packageName] = args as [string, string, string];
        isProcessRunningCalls.push(packageName);
        // The pre-run cleanup call (first invocation) sees a clean device.
        // Every subsequent call — the inter-attempt teardown poll — keeps
        // reporting the instrumentation host as alive, simulating a binding
        // that never releases within the cap.
        return isProcessRunningCalls.length > 1;
      },
    }),
    simctlClient: {} as SimctlClient,
    filePathUtil: createFilePathUtil({
      getIOSDriverAppPath: async () => null,
    }),
    grpcClientFactory: () => grpcClient as unknown as GrpcDriverClient,
    delayFn: async () => undefined,
    startAndroidDriverFn: () => {
      spawnCount += 1;
      return new FakeAndroidDriverProcess();
    },
    captureReadinessTimeoutMs: 20,
    captureReadinessDelayMs: 5,
  });

  await assert.rejects(
    () =>
      setup.setUp(
        new DeviceInfo({
          id: 'emulator-5554',
          deviceUUID: 'device-1',
          isAndroid: true,
          sdkVersion: 34,
          name: 'Android Emulator',
        }),
      ),
    /UiAutomation never became ready/,
  );
  assert.equal(spawnCount, 1, 'retry must not spawn a second driver when the prior one is still alive');
});

test('GrpcDriverSetup wires Android runtime scroll through adb', async () => {
  const grpcClient = new FakeGrpcClient({
    pingResponses: [true],
    captureResponses: [
      {
        success: true,
        screenshot: 'image',
        hierarchy: '[]',
        screenWidth: 1080,
        screenHeight: 2400,
      },
    ],
  });
  const driverProcess = new FakeAndroidDriverProcess();
  const swipeCalls: Array<{
    adbPath: string;
    deviceSerial: string;
    params: Record<string, number>;
  }> = [];

  const setup = new GrpcDriverSetup({
    adbClient: createAndroidAdbClientFake({
      async swipe(...args: unknown[]) {
        const [adbPath, deviceSerial, params] = args as [
          string,
          string,
          Record<string, number>,
        ];
        swipeCalls.push({ adbPath, deviceSerial, params });
        return { success: true, message: 'scrolled via adb' };
      },
    }),
    simctlClient: {} as SimctlClient,
    filePathUtil: createFilePathUtil({
      getIOSDriverAppPath: async () => null,
    }),
    grpcClientFactory: () => grpcClient as unknown as GrpcDriverClient,
    delayFn: async () => undefined,
    startAndroidDriverFn: () => driverProcess,
    captureReadinessTimeoutMs: 1000,
    captureReadinessDelayMs: 0,
  });

  const device = await setup.setUp(
    new DeviceInfo({
      id: 'emulator-5554',
      deviceUUID: 'device-1',
      isAndroid: true,
      sdkVersion: 34,
      name: 'Android Emulator',
    }),
  );

  const response = await device.executeAction(
    new DeviceActionRequest({
      requestId: 'req-scroll-setup',
      action: new ScrollAbsAction({
        startX: 11,
        startY: 22,
        endX: 33,
        endY: 44,
        durationMs: 555,
      }),
    }),
  );

  assert.equal(response.success, true);
  assert.equal(response.message, 'scrolled via adb');
  assert.deepEqual(swipeCalls, [
    {
      adbPath: '/usr/bin/adb',
      deviceSerial: 'emulator-5554',
      params: {
        startX: 11,
        startY: 22,
        endX: 33,
        endY: 44,
        durationMs: 555,
      },
    },
  ]);
});

test('GrpcDriverSetup fails fast when the Android driver exits early and rolls back setup', async () => {
  const grpcClient = new FakeGrpcClient({
    pingResponses: [false, false, false],
  });
  const driverProcess = new FakeAndroidDriverProcess();
  const adbCalls: string[] = [];
  let delayCalls = 0;

  const setup = new GrpcDriverSetup({
    adbClient: createAndroidAdbClientFake({
      async installApp(...args: unknown[]) {
        const [, , apkPath] = args as [string, string, string];
        adbCalls.push(`install:${apkPath}`);
        return true;
      },
      async removePortForward() {
        adbCalls.push('removePortForward');
      },
      async forwardPort() {
        adbCalls.push('forwardPort');
        return 50051;
      },
      async forceStop(...args: unknown[]) {
        const [, , packageName] = args as [string, string, string];
        adbCalls.push(`forceStop:${packageName}`);
        return { success: true };
      },
      async clearAppData(...args: unknown[]) {
        const [, , packageName] = args as [string, string, string];
        adbCalls.push(`clearAppData:${packageName}`);
        return { success: true };
      },
      async isProcessRunning(...args: unknown[]) {
        const [, , packageName] = args as [string, string, string];
        adbCalls.push(`isProcessRunning:${packageName}`);
        return false;
      },
    }),
    simctlClient: {} as SimctlClient,
    filePathUtil: createFilePathUtil({
      getIOSDriverAppPath: async () => null,
    }),
    grpcClientFactory: () => grpcClient as unknown as GrpcDriverClient,
    delayFn: async () => {
      delayCalls += 1;
      if (delayCalls === 1) {
        driverProcess.stderr.write('instrumentation crashed\n');
        driverProcess.emitExit(1);
      }
    },
    startAndroidDriverFn: () => driverProcess,
  });

  await assert.rejects(
    () =>
      setup.setUp(
        new DeviceInfo({
          id: 'emulator-5554',
          deviceUUID: 'device-1',
          isAndroid: true,
          sdkVersion: 34,
          name: 'Android Emulator',
        }),
      ),
    /Android driver process exited before setup completed \(code 1\) for emulator-5554\..*stderr: instrumentation crashed/,
  );

  assert.equal(delayCalls, 1);
  assert.equal(driverProcess.killed, true);
  assert.deepEqual(adbCalls, [
    // _cleanupStaleDriverProcesses: force-stop both packages, clear test
    // package state, then poll `pidof` until the instrumentation host exits.
    'forceStop:app.finalrun.android.test',
    'forceStop:app.finalrun.android',
    'clearAppData:app.finalrun.android.test',
    'isProcessRunning:app.finalrun.android.test',
    'install:/tmp/app-debug.apk',
    'install:/tmp/app-debug-androidTest.apk',
    'removePortForward',
    'forwardPort',
    // _rollbackFailedSetup: tear down the port forward, stop both packages,
    // then confirm the instrumentation host is gone before the error surfaces.
    'removePortForward',
    'forceStop:app.finalrun.android',
    'forceStop:app.finalrun.android.test',
    'isProcessRunning:app.finalrun.android.test',
  ]);
});

test('GrpcDriverSetup includes Android process status in gRPC timeout failures', async () => {
  const grpcClient = new FakeGrpcClient({
    pingResponses: [],
  });
  const driverProcess = new FakeAndroidDriverProcess();
  let wroteLog = false;

  const setup = new GrpcDriverSetup({
    adbClient: createAndroidAdbClientFake(),
    simctlClient: {} as SimctlClient,
    filePathUtil: createFilePathUtil({
      getIOSDriverAppPath: async () => null,
    }),
    grpcClientFactory: () => grpcClient as unknown as GrpcDriverClient,
    delayFn: async () => {
      if (!wroteLog) {
        wroteLog = true;
        driverProcess.stdout.write('waiting for instrumentation\n');
      }
    },
    startAndroidDriverFn: () => driverProcess,
  });

  await assert.rejects(
    () =>
      setup.setUp(
        new DeviceInfo({
          id: 'emulator-5554',
          deviceUUID: 'device-1',
          isAndroid: true,
          sdkVersion: 34,
          name: 'Android Emulator',
        }),
      ),
    /driver never became reachable over gRPC at 127\.0\.0\.1:50051 after 120s\. Process state: alive pid=9876\. Recent logs: stdout: waiting for instrumentation\./,
  );
});

test('GrpcDriverSetup installs, starts, and initializes the iOS simulator driver', async () => {
  const grpcClient = new FakeGrpcClient({
    pingResponses: [false, true],
    captureResponses: [
      {
        success: true,
        screenshot: 'image',
        hierarchy: '[]',
        screenWidth: 1179,
        screenHeight: 2556,
      },
    ],
  });
  const driverProcess = new FakeIOSDriverProcess();
  const calls: string[] = [];

  const setup = new GrpcDriverSetup({
    adbClient: {} as AdbClient,
    simctlClient: {
      async installApp(deviceId: string, appPath: string) {
        calls.push(`install:${deviceId}:${appPath}`);
        return true;
      },
      async terminateApp(deviceId: string, bundleId: string) {
        calls.push(`terminate:${deviceId}:${bundleId}`);
      },
      startDriver(deviceId: string, port: number) {
        calls.push(`start:${deviceId}:${port}`);
        return driverProcess;
      },
      async listInstalledAppIds(deviceId: string) {
        calls.push(`appIds:${deviceId}`);
        return ['app.finalrun.iosUITests.xctrunner', 'org.wikipedia'];
      },
    } as unknown as SimctlClient,
    filePathUtil: createFilePathUtil({
      ensureIOSAppsAvailable: async () => {
        calls.push('ensureIOS');
      },
    }),
    grpcClientFactory: () => grpcClient as unknown as GrpcDriverClient,
    delayFn: async () => undefined,
    killStaleHostProcessesOnPortFn: async (port: number) => {
      calls.push(`cleanup:${port}`);
    },
    captureReadinessTimeoutMs: 1000,
    captureReadinessDelayMs: 0,
    iosPortAllocator: stubIOSPortAllocator(),
  });

  const device = await setup.setUp(
    new DeviceInfo({
      id: 'SIM-1',
      deviceUUID: 'SIM-1',
      isAndroid: false,
      sdkVersion: 17,
      name: 'iPhone 15 Pro',
    }),
  );

  assert.equal(device.getDeviceInfo().id, 'SIM-1');
  assert.deepEqual(calls, [
    'ensureIOS',
    'install:SIM-1:/tmp/finalrun-ios-test-Runner.app',
    'cleanup:50151',
    'terminate:SIM-1:app.finalrun.iosUITests.xctrunner',
    'start:SIM-1:50151',
    'appIds:SIM-1',
  ]);
  assert.equal(grpcClient.channelCreations.length, 1);
  assert.equal(grpcClient.captureCalls, 1);
  assert.deepEqual(grpcClient.updateAppIdsCalls, [
    ['app.finalrun.iosUITests.xctrunner', 'org.wikipedia'],
  ]);
});

test('GrpcDriverSetup surfaces an early iOS driver process exit during setup', async () => {
  const grpcClient = new FakeGrpcClient({
    pingResponses: [false, false, false],
  });
  const driverProcess = new FakeIOSDriverProcess();
  let delayCalls = 0;
  let terminateCalls = 0;

  const setup = new GrpcDriverSetup({
    adbClient: {} as AdbClient,
    simctlClient: {
      async installApp() {
        return true;
      },
      async terminateApp() {
        terminateCalls += 1;
      },
      startDriver() {
        return driverProcess;
      },
      async listInstalledAppIds() {
        return [];
      },
    } as unknown as SimctlClient,
    filePathUtil: createFilePathUtil(),
    grpcClientFactory: () => grpcClient as unknown as GrpcDriverClient,
    delayFn: async () => {
      delayCalls += 1;
      if (delayCalls === 1) {
        driverProcess.stderr.write('driver crashed\n');
        driverProcess.emitExit(1);
      }
    },
    killStaleHostProcessesOnPortFn: async () => undefined,
    iosPortAllocator: stubIOSPortAllocator(),
  });

  await assert.rejects(
    () =>
      setup.setUp(
        new DeviceInfo({
          id: 'SIM-3',
          deviceUUID: 'SIM-3',
          isAndroid: false,
          sdkVersion: 17,
          name: 'iPhone 15 Pro Max',
        }),
      ),
    /iOS driver process exited before setup completed/,
  );
  assert.equal(terminateCalls, 2);
});

test('GrpcDriverSetup fails when iOS screenshot capture never becomes ready after ping', async () => {
  const grpcClient = new FakeGrpcClient({
    pingResponses: [true],
    captureResponses: [
      { success: false, message: 'UiAutomation not connected', screenWidth: 0, screenHeight: 0 },
      { success: false, message: 'UiAutomation not connected', screenWidth: 0, screenHeight: 0 },
      { success: false, message: 'UiAutomation not connected', screenWidth: 0, screenHeight: 0 },
    ],
  });
  const driverProcess = new FakeIOSDriverProcess();

  const setup = new GrpcDriverSetup({
    adbClient: {} as AdbClient,
    simctlClient: {
      async installApp() {
        return true;
      },
      async terminateApp() {},
      startDriver() {
        return driverProcess;
      },
      async listInstalledAppIds() {
        return ['org.wikipedia'];
      },
    } as unknown as SimctlClient,
    filePathUtil: createFilePathUtil(),
    grpcClientFactory: () => grpcClient as unknown as GrpcDriverClient,
    delayFn: async () => undefined,
    killStaleHostProcessesOnPortFn: async () => undefined,
    captureReadinessTimeoutMs: 20,
    captureReadinessDelayMs: 5,
    iosPortAllocator: stubIOSPortAllocator(),
  });

  await assert.rejects(
    () =>
      setup.setUp(
        new DeviceInfo({
          id: 'SIM-4',
          deviceUUID: 'SIM-4',
          isAndroid: false,
          sdkVersion: 17,
          name: 'iPhone 14',
        }),
      ),
    /screenshot capture never became ready/,
  );
});
