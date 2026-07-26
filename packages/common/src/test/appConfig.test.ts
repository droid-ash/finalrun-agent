import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  resolveAppOverrideIdentifier,
  resolveAppConfig,
} from '../appConfig.js';

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  callback: () => Promise<T>,
): Promise<T> {
  const previousValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previousValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('resolveAppConfig rejects conflicting requested and inferred platforms', () => {
  assert.throws(
    () =>
      resolveAppConfig({
        workspaceApp: {
          packageName: 'org.wikipedia.android',
          bundleId: 'org.wikipedia.ios',
        },
        envName: 'none',
        requestedPlatform: 'ios',
        appOverride: {
          appPath: '/tmp/wikipedia.apk',
          inferredPlatform: 'android',
        },
      }),
    /App override platform is "android", but the selected platform is "ios"\./,
  );
});

test('resolveAppConfig infers android from the override platform when both identifiers are configured', () => {
  const resolved = resolveAppConfig({
    workspaceApp: {
      packageName: 'org.wikipedia.android',
      bundleId: 'org.wikipedia.ios',
    },
    envName: 'none',
    appOverride: {
      appPath: '/tmp/wikipedia.apk',
      inferredPlatform: 'android',
    },
  });

  assert.deepEqual(resolved, {
    platform: 'android',
    identifier: 'org.wikipedia.android',
    identifierKind: 'packageName',
    name: undefined,
    sourceEnvName: undefined,
  });
});

test('resolveAppConfig treats env app config as a full replacement', () => {
  const resolved = resolveAppConfig({
    workspaceApp: {
      name: 'Wikipedia',
      packageName: 'org.wikipedia.android',
      bundleId: 'org.wikipedia.ios',
    },
    environmentApp: {
      packageName: 'org.wikipedia.beta',
    },
    envName: 'staging',
  });

  assert.deepEqual(resolved, {
    platform: 'android',
    identifier: 'org.wikipedia.beta',
    identifierKind: 'packageName',
    name: undefined,
    sourceEnvName: 'staging',
  });
});

test('resolveAppOverrideIdentifier falls back to ANDROID_SDK_ROOT when ANDROID_HOME has no tools', async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'finalrun-app-config-'));
  const staleSdkRoot = path.join(tempDir, 'stale-sdk');
  const validSdkRoot = path.join(tempDir, 'valid-sdk');
  const buildToolsDir = path.join(validSdkRoot, 'build-tools', '35.0.0');
  const fakeAaptPath = path.join(buildToolsDir, 'aapt');
  const appPath = path.join(tempDir, 'Wikipedia.apk');

  try {
    await fsp.mkdir(staleSdkRoot, { recursive: true });
    await fsp.mkdir(buildToolsDir, { recursive: true });
    await fsp.writeFile(
      fakeAaptPath,
      ['#!/bin/sh', 'printf "package: name=\'org.wikipedia.beta\'\\n"'].join('\n'),
      'utf-8',
    );
    await fsp.chmod(fakeAaptPath, 0o755);
    await fsp.writeFile(appPath, '', 'utf-8');

    const packageName = await withEnv(
      {
        ANDROID_HOME: staleSdkRoot,
        ANDROID_SDK_ROOT: validSdkRoot,
        PATH: '',
      },
      async () =>
        await resolveAppOverrideIdentifier({
          appPath,
          inferredPlatform: 'android',
        }),
    );

    assert.equal(packageName, 'org.wikipedia.beta');
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
