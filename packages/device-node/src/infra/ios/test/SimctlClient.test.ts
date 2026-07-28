import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceAppInfo } from '@finalrun/common';
import { SimctlClient } from '../SimctlClient.js';

test('SimctlClient.listInstalledApps parses app metadata from simctl listapps', async () => {
  const simctlClient = new SimctlClient({
    execFileFn: async () => ({
      stdout: JSON.stringify({
        'org.wikipedia': {
          CFBundleDisplayName: 'Wikipedia',
          CFBundleVersion: '7.7.1',
        },
        'com.apple.mobilesafari': {
          CFBundleName: 'Safari',
        },
      }),
      stderr: '',
    }),
  });

  const apps = await simctlClient.listInstalledApps('SIM-1');

  assert.deepEqual(
    apps.map((app) => app.toJson()),
    [
      new DeviceAppInfo({
        packageName: 'com.apple.mobilesafari',
        name: 'Safari',
        version: null,
      }).toJson(),
      new DeviceAppInfo({
        packageName: 'org.wikipedia',
        name: 'Wikipedia',
        version: '7.7.1',
      }).toJson(),
    ],
  );
});

test('SimctlClient.listInstalledApps tolerates a non-string plist value without failing the listing', async () => {
  // Regression test for the unsafe cast formerly inside _trimmed: a malformed
  // Info.plist can carry CFBundleVersion as a number, which used to throw
  // `TypeError: value?.trim is not a function` inside metadata parsing and
  // abort enumeration of the ENTIRE app list. A non-string field must degrade
  // only that field (version: null) and leave every other app enumerated.
  const simctlClient = new SimctlClient({
    execFileFn: async () => ({
      stdout: JSON.stringify({
        'org.wikipedia': {
          CFBundleDisplayName: 'Wikipedia',
          CFBundleVersion: 771,
        },
        'com.example.other': {
          CFBundleDisplayName: 'Other',
          CFBundleVersion: '1.0',
        },
      }),
      stderr: '',
    }),
  });

  const apps = await simctlClient.listInstalledApps('SIM-1');

  assert.deepEqual(
    apps.map((app) => app.toJson()),
    [
      new DeviceAppInfo({
        packageName: 'com.example.other',
        name: 'Other',
        version: '1.0',
      }).toJson(),
      new DeviceAppInfo({
        packageName: 'org.wikipedia',
        name: 'Wikipedia',
        version: null,
      }).toJson(),
    ],
  );
});

test('SimctlClient.isAppInstalled returns success when bundle id is in listapps output', async () => {
  const simctlClient = new SimctlClient({
    execFileFn: async () => ({
      stdout: JSON.stringify({
        'org.wikipedia': { CFBundleDisplayName: 'Wikipedia' },
      }),
      stderr: '',
    }),
  });

  const present = await simctlClient.isAppInstalled('SIM-1', 'org.wikipedia');
  assert.equal(present.success, true);
  assert.deepEqual(present.data, { bundleId: 'org.wikipedia', installed: true });

  const absent = await simctlClient.isAppInstalled(
    'SIM-1',
    'org.wikimedia.wikipedia',
  );
  assert.equal(absent.success, false);
  assert.match(absent.message ?? '', /not installed: org\.wikimedia\.wikipedia/i);
  assert.deepEqual(absent.data, {
    bundleId: 'org.wikimedia.wikipedia',
    installed: false,
  });
});

test('SimctlClient.isAppInstalled flags query failures distinctly from absent apps', async () => {
  const simctlClient = new SimctlClient({
    execFileFn: async () => {
      throw new Error('simctl listapps unavailable');
    },
  });

  const result = await simctlClient.isAppInstalled('SIM-1', 'org.wikipedia');
  assert.equal(result.success, false);
  assert.match(result.message ?? '', /simctl listapps unavailable|Failed to query installed apps/i);
  assert.equal(result.data?.['checkFailed'], true);
  assert.equal(result.data?.['installed'], false);
  assert.equal(result.data?.['bundleId'], 'org.wikipedia');
});

test('SimctlClient.installApp uses simctl install for app overrides', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const simctlClient = new SimctlClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  const installed = await simctlClient.installApp('SIM-1', '/tmp/My.app');

  assert.equal(installed, true);
  assert.deepEqual(execCalls, [
    {
      file: 'xcrun',
      args: ['simctl', 'install', 'SIM-1', '/tmp/My.app'],
    },
  ]);
});

test('SimctlClient.openUrl uses simctl openurl', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const simctlClient = new SimctlClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  const opened = await simctlClient.openUrl('SIM-1', 'wikipedia://settings');

  assert.equal(opened, true);
  assert.deepEqual(execCalls, [
    {
      file: 'xcrun',
      args: ['simctl', 'openurl', 'SIM-1', 'wikipedia://settings'],
    },
  ]);
});

test('SimctlClient.setLocation uses simctl location set', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const simctlClient = new SimctlClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  const result = await simctlClient.setLocation('SIM-1', '37.7749', '-122.4194');

  assert.equal(result.success, true);
  assert.deepEqual(execCalls, [
    {
      file: 'xcrun',
      args: ['simctl', 'location', 'SIM-1', 'set', '37.7749,-122.4194'],
    },
  ]);
});

test('SimctlClient.pressButton uses simctl io ui for physical buttons', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const simctlClient = new SimctlClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  const result = await simctlClient.pressButton('SIM-1', 'home');

  assert.equal(result.success, true);
  assert.deepEqual(execCalls, [
    {
      file: 'xcrun',
      args: ['simctl', 'io', 'SIM-1', 'ui', 'home'],
    },
  ]);
});

test('SimctlClient.togglePermissions uses simctl privacy for location and applesimutils for others', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const simctlClient = new SimctlClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      if (file === 'which') {
        return { stdout: '/usr/local/bin/applesimutils\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });

  const result = await simctlClient.togglePermissions('SIM-1', 'org.wikipedia', {
    location: 'allow',
    calendar: 'deny',
    camera: 'deny',
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    appliedPermissions: ['location', 'calendar', 'camera'],
  });
  assert.deepEqual(execCalls, [
    {
      file: 'xcrun',
      args: ['simctl', 'privacy', 'SIM-1', 'grant', 'location-always', 'org.wikipedia'],
    },
    {
      file: 'xcrun',
      args: ['simctl', 'privacy', 'SIM-1', 'revoke', 'calendar', 'org.wikipedia'],
    },
    {
      file: 'which',
      args: ['applesimutils'],
    },
    {
      file: 'applesimutils',
      args: [
        '--byId',
        'SIM-1',
        '--bundle',
        'org.wikipedia',
        '--setPermissions',
        'camera=NO',
      ],
    },
  ]);
});

test('SimctlClient.togglePermissions uses simctl privacy only for supported custom permissions', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const simctlClient = new SimctlClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  const result = await simctlClient.togglePermissions('SIM-1', 'org.wikipedia', {
    calendar: 'allow',
    photos: 'deny',
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    appliedPermissions: ['calendar', 'photos'],
  });
  assert.deepEqual(execCalls, [
    {
      file: 'xcrun',
      args: ['simctl', 'privacy', 'SIM-1', 'grant', 'calendar', 'org.wikipedia'],
    },
    {
      file: 'xcrun',
      args: ['simctl', 'privacy', 'SIM-1', 'revoke', 'photos', 'org.wikipedia'],
    },
  ]);
});

test('SimctlClient.allowAllPermissions continues when applesimutils is missing', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const simctlClient = new SimctlClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      if (file === 'which') {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });

  const result = await simctlClient.allowAllPermissions('SIM-1', 'org.wikipedia');

  assert.equal(result.success, true);
  assert.match(result.message ?? '', /applesimutils is not installed/i);
  assert.deepEqual(result.data, {
    appliedPermissions: [
      'calendar',
      'contacts',
      'location',
      'medialibrary',
      'microphone',
      'motion',
      'photos',
      'reminders',
      'siri',
    ],
    skippedPermissions: [
      'camera',
      'homeKit',
      'notifications',
      'speech',
      'userTracking',
    ],
    permissionWarning:
      'Skipped pre-granting iOS permissions because applesimutils is not installed: camera, homeKit, notifications, speech, userTracking',
  });
  assert.deepEqual(execCalls, [
    {
      file: 'xcrun',
      args: ['simctl', 'privacy', 'SIM-1', 'grant', 'all', 'org.wikipedia'],
    },
    {
      file: 'which',
      args: ['applesimutils'],
    },
  ]);
});
