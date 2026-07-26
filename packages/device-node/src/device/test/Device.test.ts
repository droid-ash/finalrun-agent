import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppUpload,
  EraseTextAction,
  DeviceActionRequest,
  DeviceInfo,
  DeviceNodeResponse,
  GetHierarchyAction,
  GetScreenshotAction,
  LaunchAppAction,
  PointPercent,
  RecordingRequest,
  RotateAction,
  TapPercentAction,
} from '@finalrun/common';
import { Device } from '../Device.js';
import type {
  DeviceRuntime,
  DeviceScreenshotAndHierarchy,
} from '../shared/DeviceRuntime.js';

function createRuntime(overrides?: Partial<DeviceRuntime>): DeviceRuntime {
  return {
    setShouldEnsureStability() {},
    isConnected() {
      return true;
    },
    async tap() {
      return new DeviceNodeResponse({ success: true });
    },
    async tapPercent() {
      return new DeviceNodeResponse({ success: true });
    },
    async longPress() {
      return new DeviceNodeResponse({ success: true });
    },
    async enterText() {
      return new DeviceNodeResponse({ success: true });
    },
    async eraseText() {
      return new DeviceNodeResponse({ success: true });
    },
    async scrollAbs() {
      return new DeviceNodeResponse({ success: true });
    },
    async back() {
      return new DeviceNodeResponse({ success: true });
    },
    async home() {
      return new DeviceNodeResponse({ success: true });
    },
    async rotate() {
      return new DeviceNodeResponse({ success: true });
    },
    async hideKeyboard() {
      return new DeviceNodeResponse({ success: true });
    },
    async pressKey() {
      return new DeviceNodeResponse({ success: true });
    },
    async launchApp() {
      return new DeviceNodeResponse({ success: true });
    },
    async killApp() {
      return new DeviceNodeResponse({ success: true });
    },
    async openDeepLink() {
      return new DeviceNodeResponse({ success: true });
    },
    async setLocation() {
      return new DeviceNodeResponse({ success: true });
    },
    async switchToPrimaryApp() {
      return new DeviceNodeResponse({ success: true });
    },
    async checkAppInForeground() {
      return new DeviceNodeResponse({ success: true });
    },
    async captureState() {
      return new DeviceNodeResponse({ success: true });
    },
    async getInstalledAppsResponse() {
      return new DeviceNodeResponse({ success: true, data: { apps: [] } });
    },
    async getInstalledApps() {
      return [];
    },
    async getScreenshot() {
      return new DeviceNodeResponse({ success: true, data: { screenshot: 'image' } });
    },
    async getHierarchy() {
      return new DeviceNodeResponse({ success: true, data: { hierarchy: '[]' } });
    },
    async getScreenshotAndHierarchy(): Promise<DeviceScreenshotAndHierarchy> {
      return {
        screenshot: 'image',
        hierarchy: '[]',
        screenWidth: 100,
        screenHeight: 200,
      };
    },
    async close() {},
    killDriver() {},
    ...overrides,
  };
}

function createIOSDeviceInfo(): DeviceInfo {
  return new DeviceInfo({
    id: 'SIM-1',
    deviceUUID: 'SIM-1',
    isAndroid: false,
    sdkVersion: 17,
    name: 'iPhone 15 Pro',
  });
}

test('Device delegates launchApp and stability preference to the runtime', async () => {
  const calls: Array<string | boolean | undefined> = [];
  const runtime = createRuntime({
    setShouldEnsureStability(shouldEnsureStability) {
      calls.push(shouldEnsureStability);
    },
    async launchApp() {
      calls.push('launch');
      return new DeviceNodeResponse({ success: true, message: 'launched' });
    },
  });

  const device = new Device({
    deviceInfo: createIOSDeviceInfo(),
    runtime,
  });

  const response = await device.executeAction(
    new DeviceActionRequest({
      requestId: 'req-1',
      shouldEnsureStability: false,
      action: new LaunchAppAction({
        appUpload: new AppUpload({
          id: '',
          platform: 'ios',
          packageName: 'org.wikipedia',
        }),
      }),
    }),
  );

  assert.equal(response.success, true);
  assert.equal(response.message, 'launched');
  assert.deepEqual(calls, [false, 'launch']);
});

test('Device routes parity primitives to the runtime', async () => {
  const calls: string[] = [];
  const runtime = createRuntime({
    async tapPercent() {
      calls.push('tapPercent');
      return new DeviceNodeResponse({ success: true });
    },
    async eraseText() {
      calls.push('eraseText');
      return new DeviceNodeResponse({ success: true });
    },
    async rotate() {
      calls.push('rotate');
      return new DeviceNodeResponse({ success: true });
    },
    async getScreenshot() {
      calls.push('getScreenshot');
      return new DeviceNodeResponse({ success: true });
    },
    async getHierarchy() {
      calls.push('getHierarchy');
      return new DeviceNodeResponse({ success: true });
    },
  });
  const device = new Device({
    deviceInfo: createIOSDeviceInfo(),
    runtime,
  });

  await device.executeAction(
    new DeviceActionRequest({
      requestId: 'req-1',
      action: new TapPercentAction({
        point: new PointPercent({ xPercent: 0.5, yPercent: 0.5 }),
      }),
    }),
  );
  await device.executeAction(
    new DeviceActionRequest({
      requestId: 'req-2',
      action: new EraseTextAction(),
    }),
  );
  await device.executeAction(
    new DeviceActionRequest({
      requestId: 'req-3',
      action: new RotateAction(),
    }),
  );
  await device.executeAction(
    new DeviceActionRequest({
      requestId: 'req-4',
      action: new GetScreenshotAction(),
    }),
  );
  await device.executeAction(
    new DeviceActionRequest({
      requestId: 'req-5',
      action: new GetHierarchyAction(),
    }),
  );

  assert.deepEqual(calls, [
    'tapPercent',
    'eraseText',
    'rotate',
    'getScreenshot',
    'getHierarchy',
  ]);
});

test('Device exposes runtime screenshot and installed app helpers', async () => {
  const runtime = createRuntime({
    async getInstalledApps() {
      return [
        {
          packageName: 'org.wikipedia',
          name: 'Wikipedia',
          version: '7.7.1',
          toJson() {
            return {
              packageName: 'org.wikipedia',
              name: 'Wikipedia',
              version: '7.7.1',
            };
          },
        },
      ] as never;
    },
    async getScreenshotAndHierarchy() {
      return {
        screenshot: 'base64',
        hierarchy: '[]',
        screenWidth: 1179,
        screenHeight: 2556,
      };
    },
  });

  const device = new Device({
    deviceInfo: createIOSDeviceInfo(),
    runtime,
  });

  const apps = await device.getInstalledApps();
  const screenshot = await device.getScreenshotAndHierarchy();

  assert.equal(apps.length, 1);
  assert.equal(apps[0]?.packageName, 'org.wikipedia');
  assert.deepEqual(screenshot, {
    screenshot: 'base64',
    hierarchy: '[]',
    screenWidth: 1179,
    screenHeight: 2556,
  });
});

test('Device delegates startRecording through the recording controller with the device platform', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const device = new Device({
    deviceInfo: createIOSDeviceInfo(),
    runtime: createRuntime(),
    recordingController: {
      async startRecording(params) {
        calls.push(params as unknown as Record<string, unknown>);
        return new DeviceNodeResponse({ success: true, message: 'started' });
      },
      async stopRecording() {
        return new DeviceNodeResponse({ success: true });
      },
      async cleanupDevice() {},
      async abortRecording() {},
    },
  });

  const response = await device.startRecording(
    new RecordingRequest({
      runId: 'run',
      testId: 'case',
      apiKey: 'key',
    }),
  );

  assert.equal(response.success, true);
  assert.deepEqual(calls, [
    {
      deviceId: 'SIM-1',
      platform: 'ios',
      sdkVersion: '17',
      recordingRequest: new RecordingRequest({
        runId: 'run',
        testId: 'case',
        apiKey: 'key',
      }),
    },
  ]);
});

test('Device.closeConnection cleans up active recordings before closing the runtime', async () => {
  const calls: string[] = [];
  const device = new Device({
    deviceInfo: createIOSDeviceInfo(),
    runtime: createRuntime({
      async close() {
        calls.push('close');
      },
    }),
    recordingController: {
      async startRecording() {
        return new DeviceNodeResponse({ success: true });
      },
      async stopRecording() {
        return new DeviceNodeResponse({ success: true });
      },
      async cleanupDevice() {
        calls.push('cleanup');
      },
      async abortRecording() {},
    },
  });

  await device.closeConnection();

  assert.deepEqual(calls, ['cleanup', 'close']);
});
