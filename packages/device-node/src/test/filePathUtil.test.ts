import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliFilePathUtil } from '../filePathUtil.js';

type ExecResult = { stdout: string; stderr: string };

function createTempResourceDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-cli-'));
  fs.mkdirSync(path.join(root, 'ios'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ios', 'finalrun-ios.zip'), 'zip');
  fs.writeFileSync(path.join(root, 'ios', 'finalrun-ios-test-Runner.zip'), 'zip');
  return root;
}

test('CliFilePathUtil extracts both iOS driver archives into Debug-iphonesimulator', async () => {
  const resourceDir = createTempResourceDir();
  const unzipCalls: Array<readonly string[]> = [];

  try {
    const filePathUtil = new CliFilePathUtil(
      resourceDir,
      (async (_file: string, args: readonly string[]): Promise<ExecResult> => {
        unzipCalls.push(args);
        const zipPath = args[1] as string;
        const targetDir = args[3] as string;

        if (zipPath.endsWith('finalrun-ios-test-Runner.zip')) {
          fs.mkdirSync(path.join(targetDir, 'finalrun-ios-test-Runner.app'), {
            recursive: true,
          });
        } else if (zipPath.endsWith('finalrun-ios.zip')) {
          fs.mkdirSync(path.join(targetDir, 'finalrun-ios.app'), {
            recursive: true,
          });
        }

        return { stdout: '', stderr: '' };
      }),
    );

    const runnerPath = await filePathUtil.getIOSDriverAppPath();

    assert.equal(
      runnerPath,
      path.join(
        resourceDir,
        'ios',
        'Debug-iphonesimulator',
        'finalrun-ios-test-Runner.app',
      ),
    );
    assert.equal(unzipCalls.length, 2);
    assert.deepEqual(
      unzipCalls.map((args) => path.basename(args[1] as string)),
      ['finalrun-ios.zip', 'finalrun-ios-test-Runner.zip'],
    );
  } finally {
    fs.rmSync(resourceDir, { recursive: true, force: true });
  }
});

test('CliFilePathUtil fails clearly when an iOS archive cannot be unzipped', async () => {
  const resourceDir = createTempResourceDir();

  try {
    const filePathUtil = new CliFilePathUtil(
      resourceDir,
      (async (_file: string, args: readonly string[]): Promise<ExecResult> => {
        throw new Error(`unzip failed for ${path.basename(args[1] as string)}`);
      }),
    );

    await assert.rejects(
      () => filePathUtil.ensureIOSAppsAvailable(),
      /Failed to unzip iOS driver archive/,
    );
  } finally {
    fs.rmSync(resourceDir, { recursive: true, force: true });
  }
});

test('CliFilePathUtil reuses pre-extracted iOS driver apps without unzipping again', async () => {
  const resourceDir = createTempResourceDir();
  const targetDir = path.join(resourceDir, 'ios', 'Debug-iphonesimulator');
  fs.mkdirSync(path.join(targetDir, 'finalrun-ios.app'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'finalrun-ios-test-Runner.app'), { recursive: true });
  let unzipCalled = false;

  try {
    const filePathUtil = new CliFilePathUtil(
      resourceDir,
      (async (): Promise<ExecResult> => {
        unzipCalled = true;
        return { stdout: '', stderr: '' };
      }),
    );

    const runnerPath = await filePathUtil.getIOSDriverAppPath();

    assert.equal(
      runnerPath,
      path.join(
        resourceDir,
        'ios',
        'Debug-iphonesimulator',
        'finalrun-ios-test-Runner.app',
      ),
    );
    assert.equal(unzipCalled, false);
  } finally {
    fs.rmSync(resourceDir, { recursive: true, force: true });
  }
});

test('CliFilePathUtil downloads the Android driver asset from the manifest into the cache dir', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-assets-cache-'));
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-assets-source-'));
  const previousManifestPath = process.env['FINALRUN_ASSET_MANIFEST_PATH'];

  try {
    const assetContents = Buffer.from('apk-binary');
    const assetPath = path.join(sourceDir, 'app-debug.apk');
    fs.writeFileSync(assetPath, assetContents);

    const manifestPath = path.join(sourceDir, 'assets-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: '0.1.1',
        assets: [
          {
            kind: 'android-driver-apk',
            platform: 'android',
            filename: 'app-debug.apk',
            url: `file://${assetPath}`,
            sha256: createHash('sha256').update(assetContents).digest('hex'),
            size: assetContents.length,
          },
        ],
      }),
      'utf-8',
    );
    process.env['FINALRUN_ASSET_MANIFEST_PATH'] = manifestPath;

    const filePathUtil = new CliFilePathUtil(
      cacheDir,
      undefined,
      { downloadAssets: true },
    );

    const resolvedAssetPath = await filePathUtil.getDriverAppPath();

    assert.equal(resolvedAssetPath, path.join(cacheDir, 'android', 'app-debug.apk'));
    assert.equal(fs.readFileSync(resolvedAssetPath!, 'utf-8'), 'apk-binary');
  } finally {
    if (previousManifestPath === undefined) {
      delete process.env['FINALRUN_ASSET_MANIFEST_PATH'];
    } else {
      process.env['FINALRUN_ASSET_MANIFEST_PATH'] = previousManifestPath;
    }
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});
