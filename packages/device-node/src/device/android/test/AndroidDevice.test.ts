import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppUpload,
  DeeplinkAction,
  DeviceAppInfo,
  LaunchAppAction,
  PressKeyAction,
  ScrollAbsAction,
  SetLocationAction,
} from '@finalrun/common';
import type { GrpcDriverClient } from '../../../grpc/GrpcDriverClient.js';
import { CommonDriverActions } from '../../shared/CommonDriverActions.js';
import { AndroidDevice } from '../AndroidDevice.js';

test('AndroidDevice routes scroll through adb instead of gRPC swipe', async () => {
  const swipeCalls: Array<Record<string, number>> = [];
  let grpcSwipeCalls = 0;
  const grpcClient = {
    isConnected: true,
    async swipe() {
      grpcSwipeCalls += 1;
      return { success: true };
    },
    close() {},
  };

  const runtime = new AndroidDevice({
    commonDriverActions: new CommonDriverActions({
      grpcClient: grpcClient as unknown as GrpcDriverClient,
    }),
    adbClient: {
      async swipe(
        _adbPath: string,
        _deviceSerial: string,
        params: Record<string, number>,
      ) {
        swipeCalls.push(params);
        return { success: true, message: 'scrolled via adb' };
      },
      async removePortForward() {},
    } as never,
    adbPath: '/usr/bin/adb',
    deviceSerial: 'emulator-5554',
  });

  const response = await runtime.scrollAbs(
    new ScrollAbsAction({
      startX: 10,
      startY: 20,
      endX: 30,
      endY: 40,
      durationMs: 500,
    }),
  );

  assert.equal(response.success, true);
  assert.equal(response.message, 'scrolled via adb');
  assert.equal(grpcSwipeCalls, 0);
  assert.deepEqual(swipeCalls, [
    { startX: 10, startY: 20, endX: 30, endY: 40, durationMs: 500 },
  ]);
});

test('AndroidDevice opens deep links through adb', async () => {
  const openedLinks: string[] = [];
  const runtime = new AndroidDevice({
    commonDriverActions: new CommonDriverActions({
      grpcClient: {
        isConnected: true,
        close() {},
      } as unknown as GrpcDriverClient,
    }),
    adbClient: {
      async openDeepLink(
        _adbPath: string,
        _deviceSerial: string,
        deeplink: string,
      ) {
        openedLinks.push(deeplink);
        return true;
      },
      async removePortForward() {},
    } as never,
    adbPath: '/usr/bin/adb',
    deviceSerial: 'emulator-5554',
  });

  const response = await runtime.openDeepLink(
    new DeeplinkAction({
      deeplink: 'wikipedia://settings',
    }),
  );

  assert.equal(response.success, true);
  assert.equal(response.message, 'Successfully opened deep link: wikipedia://settings');
  assert.deepEqual(openedLinks, ['wikipedia://settings']);
});

test('AndroidDevice keeps installed-app listing on driver gRPC and removes port forwarding on close', async () => {
  const calls: string[] = [];
  const runtime = new AndroidDevice({
    commonDriverActions: new CommonDriverActions({
      grpcClient: {
        isConnected: true,
        async getAppList() {
          return {
            success: true,
            apps: [
              new DeviceAppInfo({
                packageName: 'org.wikipedia',
                name: 'Wikipedia',
                version: '7.7.1',
              }),
            ],
          };
        },
        close() {
          calls.push('close');
        },
      } as unknown as GrpcDriverClient,
    }),
    adbClient: {
      async removePortForward() {
        calls.push('removePortForward');
      },
    } as never,
    adbPath: '/usr/bin/adb',
    deviceSerial: 'emulator-5554',
  });

  const appListResponse = await runtime.getInstalledAppsResponse();
  await runtime.close();

  assert.equal(appListResponse.success, true);
  assert.deepEqual(appListResponse.data, {
    apps: [
      {
        packageName: 'org.wikipedia',
        name: 'Wikipedia',
        version: '7.7.1',
      },
    ],
  });
  assert.deepEqual(calls, ['removePortForward', 'close']);
});

test('AndroidDevice routes back, home, hideKeyboard, and rotate through adb', async () => {
  const calls: string[] = [];
  let grpcBackCalls = 0;
  const runtime = new AndroidDevice({
    commonDriverActions: new CommonDriverActions({
      grpcClient: {
        isConnected: true,
        async back() {
          grpcBackCalls += 1;
          return { success: true };
        },
        close() {},
      } as unknown as GrpcDriverClient,
    }),
    adbClient: {
      async back() {
        calls.push('back');
        return { success: true, message: 'back via adb' };
      },
      async home() {
        calls.push('home');
        return { success: true, message: 'home via adb' };
      },
      async hideKeyboard() {
        calls.push('hideKeyboard');
        return { success: true, message: 'keyboard hidden' };
      },
      async rotate() {
        calls.push('rotate');
        return {
          success: true,
          message: 'rotated',
          data: { orientation: 'landscape' },
        };
      },
      async removePortForward() {},
    } as never,
    adbPath: '/usr/bin/adb',
    deviceSerial: 'emulator-5554',
  });

  const backResponse = await runtime.back({} as never);
  const homeResponse = await runtime.home({} as never);
  const hideKeyboardResponse = await runtime.hideKeyboard({} as never);
  const rotateResponse = await runtime.rotate({} as never);

  assert.equal(backResponse.message, 'back via adb');
  assert.equal(homeResponse.message, 'home via adb');
  assert.equal(hideKeyboardResponse.message, 'keyboard hidden');
  assert.equal(rotateResponse.data?.orientation, 'landscape');
  assert.equal(grpcBackCalls, 0);
  assert.deepEqual(calls, ['back', 'home', 'hideKeyboard', 'rotate']);
});

test('AndroidDevice falls back to gRPC for unmapped key presses', async () => {
  const calls: string[] = [];
  const runtime = new AndroidDevice({
    commonDriverActions: new CommonDriverActions({
      grpcClient: {
        isConnected: true,
        async pressKey(key: string) {
          calls.push(`grpc:${key}`);
          return { success: true, message: 'pressed via grpc' };
        },
        close() {},
      } as unknown as GrpcDriverClient,
    }),
    adbClient: {
      async performKeyPress() {
        calls.push('adb');
        return {
          success: false,
          message: 'Android key is not mapped for adb: customKey',
          data: { handled: false },
        };
      },
      async removePortForward() {},
    } as never,
    adbPath: '/usr/bin/adb',
    deviceSerial: 'emulator-5554',
  });

  const response = await runtime.pressKey(
    new PressKeyAction({
      key: 'customKey',
    }),
  );

  assert.equal(response.success, true);
  assert.equal(response.message, 'pressed via grpc');
  assert.deepEqual(calls, ['adb', 'grpc:customKey']);
});

test('AndroidDevice applies adb prelaunch steps before the driver launch path', async () => {
  const calls: string[] = [];
  const runtime = new AndroidDevice({
    commonDriverActions: new CommonDriverActions({
      grpcClient: {
        isConnected: true,
        async launchApp() {
          calls.push('grpc:launch');
          return { success: true, message: 'launched' };
        },
        close() {},
      } as unknown as GrpcDriverClient,
    }),
    adbClient: {
      async isPackageInstalled() {
        calls.push('adb:isPackageInstalled');
        return { success: true, data: { installed: true } };
      },
      async forceStop() {
        calls.push('adb:forceStop');
        return { success: true };
      },
      async clearAppData() {
        calls.push('adb:clearAppData');
        return { success: true };
      },
      async allowAllPermissions() {
        calls.push('adb:allowAllPermissions');
        return { success: true };
      },
      async removePortForward() {},
    } as never,
    adbPath: '/usr/bin/adb',
    deviceSerial: 'emulator-5554',
  });

  const response = await runtime.launchApp(
    new LaunchAppAction({
      appUpload: new AppUpload({
        id: '',
        platform: 'android',
        packageName: 'org.wikipedia',
      }),
      clearState: true,
      stopAppBeforeLaunch: true,
      allowAllPermissions: true,
    }),
  );

  assert.equal(response.success, true);
  assert.equal(response.message, 'launched');
  assert.deepEqual(calls, [
    'adb:isPackageInstalled',
    'adb:forceStop',
    'adb:clearAppData',
    'adb:allowAllPermissions',
    'grpc:launch',
  ]);
});

test('AndroidDevice enables mock location before delegating coordinates to gRPC', async () => {
  const calls: string[] = [];
  const runtime = new AndroidDevice({
    commonDriverActions: new CommonDriverActions({
      grpcClient: {
        isConnected: true,
        async setLocation() {
          calls.push('grpc:setLocation');
          return { success: true, message: 'location set' };
        },
        close() {},
      } as unknown as GrpcDriverClient,
    }),
    adbClient: {
      async performMockLocation() {
        calls.push('adb:mockLocation');
        return { success: true };
      },
      async removePortForward() {},
    } as never,
    adbPath: '/usr/bin/adb',
    deviceSerial: 'emulator-5554',
  });

  const response = await runtime.setLocation(
    new SetLocationAction({
      lat: '37.7749',
      long: '-122.4194',
    }),
  );

  assert.equal(response.success, true);
  assert.equal(response.message, 'location set');
  assert.deepEqual(calls, ['adb:mockLocation', 'grpc:setLocation']);
});
