import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AppUpload,
  DeviceAppInfo,
  LaunchAppAction,
  PressKeyAction,
  ScrollAbsAction,
  SetLocationAction,
} from '@finalrun/common';
import type { GrpcDriverClient } from '../../../grpc/GrpcDriverClient.js';
import type { IOSDriverProcessHandle } from '../../../infra/ios/SimctlClient.js';
import { CommonDriverActions } from '../../shared/CommonDriverActions.js';
import { IOSSimulator } from '../IOSSimulator.js';

/** Stub process handle that always reports alive (exitCode null, not killed). */
function stubDriverProcess(): IOSDriverProcessHandle {
  return {
    pid: 1234,
    exitCode: null,
    killed: false,
    stdout: null,
    stderr: null,
    on() { return this; },
  } as unknown as IOSDriverProcessHandle;
}

/** Default recovery-related params for tests that don't exercise driver restart. */
function stubRecoveryParams() {
  return {
    driverProcess: stubDriverProcess(),
    restartDriver: async () => stubDriverProcess(),
  };
}

test('IOSSimulator refreshes app IDs before launchApp', async () => {
  const calls: string[] = [];
  const grpcClient = {
    isConnected: true,
    async updateAppIds(appIds: string[]) {
      calls.push(`update:${appIds.join(',')}`);
      return { success: true };
    },
    async launchApp() {
      calls.push('launch');
      return { success: true, message: 'launched' };
    },
    close() {},
  };

  const runtime = new IOSSimulator({
    commonDriverActions: new CommonDriverActions({
      grpcClient: grpcClient as unknown as GrpcDriverClient,
    }),
    simctlClient: {
      async isAppInstalled(_deviceId: string, bundleId: string) {
        calls.push(`isAppInstalled:${bundleId}`);
        return { success: true, data: { bundleId, installed: true } };
      },
      async listInstalledAppIds() {
        calls.push('listAppIds');
        return ['app.finalrun.iosUITests.xctrunner', 'org.wikipedia'];
      },
      async terminateApp() {},
      async listInstalledApps() {
        return [];
      },
      async openUrl() {
        return true;
      },
    } as never,
    deviceId: 'SIM-1',
    ...stubRecoveryParams(),
  });

  const response = await runtime.launchApp(
    new LaunchAppAction({
      appUpload: new AppUpload({
        id: '',
        platform: 'ios',
        packageName: 'org.wikipedia',
      }),
      allowAllPermissions: false,
    }),
  );

  assert.equal(response.success, true);
  assert.equal(response.message, 'launched');
  assert.deepEqual(calls, [
    'isAppInstalled:org.wikipedia',
    'listAppIds',
    'update:app.finalrun.iosUITests.xctrunner,org.wikipedia',
    'launch',
  ]);
});

test('IOSSimulator returns explicit failure when launching an app that is not installed', async () => {
  const calls: string[] = [];
  const grpcClient = {
    isConnected: true,
    async updateAppIds() {
      calls.push('grpc:updateAppIds');
      return { success: true };
    },
    async launchApp() {
      calls.push('grpc:launch');
      return { success: true, message: 'launched' };
    },
    close() {},
  };

  const runtime = new IOSSimulator({
    commonDriverActions: new CommonDriverActions({
      grpcClient: grpcClient as unknown as GrpcDriverClient,
    }),
    simctlClient: {
      async isAppInstalled(_deviceId: string, bundleId: string) {
        calls.push(`isAppInstalled:${bundleId}`);
        return {
          success: false,
          message: `App not installed: ${bundleId}`,
          data: { bundleId, installed: false },
        };
      },
      async listInstalledAppIds() {
        calls.push('listAppIds');
        return [];
      },
      async terminateApp() {},
      async listInstalledApps() {
        return [];
      },
      async openUrl() {
        return true;
      },
    } as never,
    deviceId: 'SIM-1',
    ...stubRecoveryParams(),
  });

  const response = await runtime.launchApp(
    new LaunchAppAction({
      appUpload: new AppUpload({
        id: '',
        platform: 'ios',
        packageName: 'org.wikimedia.wikipedia',
      }),
      allowAllPermissions: false,
    }),
  );

  assert.equal(response.success, false);
  assert.match(response.message ?? '', /not installed: org\.wikimedia\.wikipedia/i);
  assert.deepEqual(calls, ['isAppInstalled:org.wikimedia.wikipedia']);
});

test('IOSSimulator routes scroll through gRPC swipe and installed-app listing through simctl', async () => {
  const grpcSwipeCalls: Array<Record<string, number>> = [];
  const grpcClient = {
    isConnected: true,
    async swipe(params: Record<string, number>) {
      grpcSwipeCalls.push(params);
      return { success: true, message: 'scrolled via grpc' };
    },
    close() {},
  };
  const runtime = new IOSSimulator({
    commonDriverActions: new CommonDriverActions({
      grpcClient: grpcClient as unknown as GrpcDriverClient,
    }),
    simctlClient: {
      async listInstalledApps() {
        return [
          new DeviceAppInfo({
            packageName: 'org.wikipedia',
            name: 'Wikipedia',
            version: '7.7.1',
          }),
        ];
      },
      async listInstalledAppIds() {
        return [];
      },
      async terminateApp() {},
      async openUrl() {
        return true;
      },
    } as never,
    deviceId: 'SIM-1',
    ...stubRecoveryParams(),
  });

  const scrollResponse = await runtime.scrollAbs(
    new ScrollAbsAction({
      startX: 50,
      startY: 60,
      endX: 70,
      endY: 80,
      durationMs: 600,
    }),
  );
  const appListResponse = await runtime.getInstalledAppsResponse();

  assert.equal(scrollResponse.success, true);
  assert.equal(scrollResponse.message, 'scrolled via grpc');
  assert.deepEqual(grpcSwipeCalls, [
    { startX: 50, startY: 60, endX: 70, endY: 80, durationMs: 600 },
  ]);
  assert.deepEqual(appListResponse.data, {
    apps: [
      {
        packageName: 'org.wikipedia',
        name: 'Wikipedia',
        version: '7.7.1',
      },
    ],
  });
});

test('IOSSimulator terminates the runner before closing gRPC', async () => {
  const calls: string[] = [];
  const grpcClient = {
    isConnected: true,
    close() {
      calls.push('close');
    },
  };
  const runtime = new IOSSimulator({
    commonDriverActions: new CommonDriverActions({
      grpcClient: grpcClient as unknown as GrpcDriverClient,
    }),
    simctlClient: {
      async terminateApp() {
        calls.push('terminate');
      },
      async listInstalledAppIds() {
        return [];
      },
      async listInstalledApps() {
        return [];
      },
      async openUrl() {
        return true;
      },
    } as never,
    deviceId: 'SIM-1',
    ...stubRecoveryParams(),
  });

  await runtime.close();

  assert.deepEqual(calls, ['terminate', 'close']);
});

test('IOSSimulator routes home and physical button keys through simctl', async () => {
  const calls: string[] = [];
  const grpcClient = {
    isConnected: true,
    async pressKey(key: string) {
      calls.push(`grpc:${key}`);
      return { success: true, message: 'pressed via grpc' };
    },
    close() {},
  };
  const runtime = new IOSSimulator({
    commonDriverActions: new CommonDriverActions({
      grpcClient: grpcClient as unknown as GrpcDriverClient,
    }),
    simctlClient: {
      async pressButton(_deviceId: string, button: string) {
        calls.push(`simctl:${button}`);
        return { success: true, message: `pressed ${button}` };
      },
      async terminateApp() {},
      async terminateAppResult() {
        return { success: true };
      },
      async listInstalledAppIds() {
        return [];
      },
      async listInstalledApps() {
        return [];
      },
      async openUrl() {
        return true;
      },
    } as never,
    deviceId: 'SIM-1',
    ...stubRecoveryParams(),
  });

  const homeResponse = await runtime.home({} as never);
  const powerResponse = await runtime.pressKey(
    new PressKeyAction({
      key: 'power',
    }),
  );
  const enterResponse = await runtime.pressKey(
    new PressKeyAction({
      key: 'enter',
    }),
  );

  assert.equal(homeResponse.message, 'pressed home');
  assert.equal(powerResponse.message, 'pressed lock');
  assert.equal(enterResponse.message, 'pressed via grpc');
  assert.deepEqual(calls, ['simctl:home', 'simctl:lock', 'grpc:enter']);
});

test('IOSSimulator uses simctl for setLocation', async () => {
  const calls: string[] = [];
  const grpcClient = {
    isConnected: true,
    close() {},
  };
  const runtime = new IOSSimulator({
    commonDriverActions: new CommonDriverActions({
      grpcClient: grpcClient as unknown as GrpcDriverClient,
    }),
    simctlClient: {
      async setLocation(_deviceId: string, lat: string, long: string) {
        calls.push(`${lat},${long}`);
        return { success: true, message: 'location set via simctl' };
      },
      async terminateApp() {},
      async terminateAppResult() {
        return { success: true };
      },
      async listInstalledAppIds() {
        return [];
      },
      async listInstalledApps() {
        return [];
      },
      async openUrl() {
        return true;
      },
    } as never,
    deviceId: 'SIM-1',
    ...stubRecoveryParams(),
  });

  const response = await runtime.setLocation(
    new SetLocationAction({
      lat: '37.7749',
      long: '-122.4194',
    }),
  );

  assert.equal(response.success, true);
  assert.equal(response.message, 'location set via simctl');
  assert.deepEqual(calls, ['37.7749,-122.4194']);
});

test('IOSSimulator fails explicitly when clearState is requested without reinstall context', async () => {
  const calls: string[] = [];
  const grpcClient = {
    isConnected: true,
    async updateAppIds() {
      return { success: true };
    },
    async launchApp() {
      calls.push('grpc:launch');
      return { success: true, message: 'launched' };
    },
    close() {},
  };
  const runtime = new IOSSimulator({
    commonDriverActions: new CommonDriverActions({
      grpcClient: grpcClient as unknown as GrpcDriverClient,
    }),
    simctlClient: {
      async isAppInstalled(_deviceId: string, bundleId: string) {
        return { success: true, data: { bundleId, installed: true } };
      },
      async listInstalledAppIds() {
        return ['org.wikipedia'];
      },
      async terminateApp() {},
      async terminateAppResult() {
        calls.push('simctl:terminate');
        return { success: true };
      },
      async listInstalledApps() {
        return [];
      },
      async openUrl() {
        return true;
      },
    } as never,
    deviceId: 'SIM-1',
    ...stubRecoveryParams(),
  });

  const response = await runtime.launchApp(
    new LaunchAppAction({
      appUpload: new AppUpload({
        id: '',
        platform: 'ios',
        packageName: 'org.wikipedia',
      }),
      clearState: true,
      stopAppBeforeLaunch: true,
      allowAllPermissions: false,
    }),
  );

  assert.equal(response.success, false);
  assert.match(
    response.message ?? '',
    /clearState is not supported in finalrun-ts/i,
  );
  assert.deepEqual(calls, ['simctl:terminate']);
});

test('IOSSimulator continues launch when allowAllPermissions warns about missing applesimutils', async () => {
  const calls: string[] = [];
  const grpcClient = {
    isConnected: true,
    async updateAppIds() {
      calls.push('grpc:updateAppIds');
      return { success: true };
    },
    async launchApp() {
      calls.push('grpc:launch');
      return {
        success: true,
        message: 'launched',
        data: { packageName: 'org.wikipedia' },
      };
    },
    close() {},
  };
  const runtime = new IOSSimulator({
    commonDriverActions: new CommonDriverActions({
      grpcClient: grpcClient as unknown as GrpcDriverClient,
    }),
    simctlClient: {
      async isAppInstalled(_deviceId: string, bundleId: string) {
        return { success: true, data: { bundleId, installed: true } };
      },
      async listInstalledAppIds() {
        calls.push('simctl:listAppIds');
        return ['org.wikipedia'];
      },
      async allowAllPermissions() {
        calls.push('simctl:allowAllPermissions');
        return {
          success: true,
          message:
            'Skipped pre-granting iOS permissions because applesimutils is not installed: camera',
          data: {
            skippedPermissions: ['camera'],
            permissionWarning:
              'Skipped pre-granting iOS permissions because applesimutils is not installed: camera',
          },
        };
      },
      async terminateApp() {},
      async terminateAppResult() {
        return { success: true };
      },
      async listInstalledApps() {
        return [];
      },
      async openUrl() {
        return true;
      },
    } as never,
    deviceId: 'SIM-1',
    ...stubRecoveryParams(),
  });

  const response = await runtime.launchApp(
    new LaunchAppAction({
      appUpload: new AppUpload({
        id: '',
        platform: 'ios',
        packageName: 'org.wikipedia',
      }),
    }),
  );

  assert.equal(response.success, true);
  assert.equal(
    response.message,
    'launched Skipped pre-granting iOS permissions because applesimutils is not installed: camera',
  );
  assert.deepEqual(response.data, {
    packageName: 'org.wikipedia',
    skippedPermissions: ['camera'],
    permissionWarning:
      'Skipped pre-granting iOS permissions because applesimutils is not installed: camera',
  });
  assert.deepEqual(calls, [
    'simctl:listAppIds',
    'grpc:updateAppIds',
    'simctl:allowAllPermissions',
    'grpc:launch',
  ]);
});

test('IOSSimulator applies supported custom permissions through simctl before launch', async () => {
  const calls: string[] = [];
  const grpcClient = {
    isConnected: true,
    async updateAppIds() {
      calls.push('grpc:updateAppIds');
      return { success: true };
    },
    async launchApp() {
      calls.push('grpc:launch');
      return {
        success: true,
        message: 'launched',
      };
    },
    close() {},
  };
  const runtime = new IOSSimulator({
    commonDriverActions: new CommonDriverActions({
      grpcClient: grpcClient as unknown as GrpcDriverClient,
    }),
    simctlClient: {
      async isAppInstalled(_deviceId: string, bundleId: string) {
        return { success: true, data: { bundleId, installed: true } };
      },
      async listInstalledAppIds() {
        calls.push('simctl:listAppIds');
        return ['org.wikipedia'];
      },
      async togglePermissions() {
        calls.push('simctl:togglePermissions');
        return {
          success: true,
          data: {
            appliedPermissions: ['calendar'],
          },
        };
      },
      async terminateApp() {},
      async terminateAppResult() {
        return { success: true };
      },
      async listInstalledApps() {
        return [];
      },
      async openUrl() {
        return true;
      },
    } as never,
    deviceId: 'SIM-1',
    ...stubRecoveryParams(),
  });

  const response = await runtime.launchApp(
    new LaunchAppAction({
      appUpload: new AppUpload({
        id: '',
        platform: 'ios',
        packageName: 'org.wikipedia',
      }),
      allowAllPermissions: false,
      permissions: {
        calendar: 'allow',
      },
    }),
  );

  assert.equal(response.success, true);
  assert.equal(response.message, 'launched');
  assert.deepEqual(response.data, {
    packageName: 'org.wikipedia',
    appliedPermissions: ['calendar'],
  });
  assert.deepEqual(calls, [
    'simctl:listAppIds',
    'grpc:updateAppIds',
    'simctl:togglePermissions',
    'grpc:launch',
  ]);
});
