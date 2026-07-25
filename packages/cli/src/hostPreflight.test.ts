import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceNodeResponse, PLATFORM_ANDROID, PLATFORM_IOS } from '@finalrun/common';
import {
  formatHostPreflightReport,
  hasBlockingPreflightFailures,
  runHostPreflight,
  shouldBlockLocalRunPreflight,
  type HostPreflightDependencies,
  type HostPreflightFilePathUtil,
} from './hostPreflight.js';

function createFilePathUtil(params?: Partial<HostPreflightFilePathUtil>): HostPreflightFilePathUtil {
  return {
    async getADBPath() {
      return params?.getADBPath ? await params.getADBPath() : null;
    },
    async getDriverAppPath() {
      return params?.getDriverAppPath ? await params.getDriverAppPath() : null;
    },
    async getDriverTestAppPath() {
      return params?.getDriverTestAppPath ? await params.getDriverTestAppPath() : null;
    },
    getResourceDir() {
      return params?.getResourceDir ? params.getResourceDir() : '/tmp/finalrun-resources';
    },
  };
}

function createDependencies(params?: {
  filePathUtil?: HostPreflightFilePathUtil;
  commandPaths?: Record<string, string | null>;
  failingCommands?: Set<string>;
  existingPaths?: Set<string>;
  platform?: NodeJS.Platform;
  androidRecordingResponse?: DeviceNodeResponse;
  iosRecordingResponse?: DeviceNodeResponse;
}): HostPreflightDependencies {
  return {
    createFilePathUtil: () => params?.filePathUtil ?? createFilePathUtil(),
    async execFile(file, args) {
      const key = `${file} ${args.join(' ')}`.trim();
      if (params?.failingCommands?.has(key)) {
        throw new Error(`mock failure for ${key}`);
      }
      return { stdout: 'ok', stderr: '' };
    },
    async resolveCommand(command) {
      if (params?.commandPaths && command in params.commandPaths) {
        return params.commandPaths[command] ?? null;
      }
      return `/mock/${command}`;
    },
    async pathExists(candidatePath) {
      return params?.existingPaths?.has(candidatePath) ?? false;
    },
    getPlatform: () => params?.platform ?? 'darwin',
    async checkAndroidRecordingAvailability() {
      return params?.androidRecordingResponse ?? new DeviceNodeResponse({
        success: true,
        message: 'scrcpy ready',
      });
    },
    async checkIOSRecordingAvailability() {
      return params?.iosRecordingResponse ?? new DeviceNodeResponse({
        success: true,
        message: 'xcrun simctl ready',
      });
    },
  };
}

test('runHostPreflight marks a command as blocking when it exists but the smoke check fails', async () => {
  const dependencies = createDependencies({
    filePathUtil: createFilePathUtil({
      async getADBPath() {
        return '/mock/adb';
      },
      async getDriverAppPath() {
        return '/mock/resources/android/app-debug.apk';
      },
      async getDriverTestAppPath() {
        return '/mock/resources/android/app-debug-androidTest.apk';
      },
      getResourceDir() {
        return '/mock/resources';
      },
    }),
    failingCommands: new Set(['/mock/emulator -list-avds']),
  });

  const result = await runHostPreflight({
    requestedPlatforms: [PLATFORM_ANDROID],
  }, dependencies);

  const emulatorCheck = result.checks.find((check) => check.id === 'emulator');
  assert.ok(emulatorCheck);
  assert.equal(emulatorCheck.status, 'error');
  assert.equal(hasBlockingPreflightFailures(result), true);
  assert.equal(shouldBlockLocalRunPreflight(result), true);
});

test('runHostPreflight reports missing resource files as blocking failures', async () => {
  const resourceDir = '/mock/resources';
  const dependencies = createDependencies({
    filePathUtil: createFilePathUtil({
      getResourceDir() {
        return resourceDir;
      },
    }),
    existingPaths: new Set([
      '/bin/bash',
      `${resourceDir}/ios/finalrun-ios-test-Runner.zip`,
    ]),
  });

  const result = await runHostPreflight({
    requestedPlatforms: [PLATFORM_IOS],
  }, dependencies);

  const archiveCheck = result.checks.find((check) => check.id === 'ios-driver-archive');
  assert.ok(archiveCheck);
  assert.equal(archiveCheck.status, 'error');
  assert.match(archiveCheck.detail ?? '', /finalrun-ios\.zip/);
  assert.equal(hasBlockingPreflightFailures(result), true);
});

test('warning-only results do not block a local run', async () => {
  const resourceDir = '/mock/resources';
  const dependencies = createDependencies({
    filePathUtil: createFilePathUtil({
      getResourceDir() {
        return resourceDir;
      },
    }),
    commandPaths: {
      ffmpeg: null,
      applesimutils: null,
      lsof: null,
      ps: null,
      kill: null,
    },
    existingPaths: new Set([
      '/bin/bash',
      `${resourceDir}/ios/finalrun-ios.zip`,
      `${resourceDir}/ios/finalrun-ios-test-Runner.zip`,
    ]),
  });

  const result = await runHostPreflight({
    requestedPlatforms: [PLATFORM_IOS],
  }, dependencies);

  assert.equal(hasBlockingPreflightFailures(result), false);
  assert.equal(shouldBlockLocalRunPreflight(result), false);
  const report = formatHostPreflightReport(result, 'doctor');
  // The doctor report is a flat ✓/✗/⚠ list — warnings are marked inline
  // rather than grouped under a "Warnings" heading.
  assert.match(report, /⚠ ffmpeg — Used to compress iOS recordings after capture\./);
  assert.doesNotMatch(report, /✗ /);
});

test('runHostPreflight only evaluates the requested platform scope', async () => {
  const result = await runHostPreflight({
    requestedPlatforms: [PLATFORM_ANDROID],
  }, createDependencies({
    filePathUtil: createFilePathUtil({
      async getADBPath() {
        return '/mock/adb';
      },
      async getDriverAppPath() {
        return '/mock/resources/android/app-debug.apk';
      },
      async getDriverTestAppPath() {
        return '/mock/resources/android/app-debug-androidTest.apk';
      },
      getResourceDir() {
        return '/mock/resources';
      },
    }),
    platform: 'linux',
  }));

  assert.equal(result.checks.some((check) => check.platform === PLATFORM_IOS), false);
});
