// Port of mobile_cli/lib/cli_file_path_util.dart
// Resolves paths to ADB, driver APKs, and iOS apps.

import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { FilePathUtil } from '@finalrun/common';
import { RuntimeAssetStore } from './runtimeAssets.js';

const execFileAsync = promisify(execFile);
type ExecFileFn = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

interface CliFilePathUtilOptions {
  downloadAssets?: boolean;
}

/**
 * CLI-specific file path resolver.
 * Locates ADB, driver app binaries, and user app files.
 *
 * Dart equivalent: CliFilePathUtil in mobile_cli/lib/cli_file_path_util.dart
 */
export class CliFilePathUtil implements FilePathUtil {
  private _assetStore: RuntimeAssetStore;
  private _execFileFn: ExecFileFn;

  constructor(
    resourceDir?: string,
    execFileFn?: ExecFileFn,
    options?: CliFilePathUtilOptions,
  ) {
    this._assetStore = new RuntimeAssetStore(resourceDir, {
      downloadAssets: options?.downloadAssets,
    });
    this._execFileFn = execFileFn ?? execFileAsync;
  }

  /**
   * Find ADB path: check ANDROID_HOME, then try `which adb`.
   * Dart: Future<String?> getADBPath()
   */
  async getADBPath(): Promise<string | null> {
    const androidHome = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
    if (androidHome) {
      const adbPath = path.join(androidHome, 'platform-tools', 'adb');
      if (fs.existsSync(adbPath)) {
        return adbPath;
      }
    }

    try {
      const { stdout } = await execFileAsync('which', ['adb']);
      const resolved = stdout.trim();
      if (resolved && fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // adb not in PATH
    }

    return null;
  }

  /**
   * Get path to the Android driver app APK (the main app).
   * File: resources/android/app-debug.apk
   */
  async getDriverAppPath(): Promise<string | null> {
    return await this._assetStore.resolveAssetPath('android-driver-apk');
  }

  /**
   * Get path to the Android test runner APK (instrumentation test APK).
   * File: resources/android/app-debug-androidTest.apk
   */
  async getDriverTestAppPath(): Promise<string | null> {
    return await this._assetStore.resolveAssetPath('android-driver-test-apk');
  }

  getResourceDir(): string {
    return this._assetStore.getResourceDir();
  }

  /**
   * Get path to the extracted iOS runner app.
   * Files are extracted from resources/ios/finalrun-ios.zip and
   * resources/ios/finalrun-ios-test-Runner.zip into Debug-iphonesimulator/.
   */
  async getIOSDriverAppPath(): Promise<string | null> {
    await this.ensureIOSAppsAvailable();

    const { runnerAppPath } = this._resolveIOSExtractedAppPaths();
    if (!fs.existsSync(runnerAppPath)) {
      throw new Error(`Extracted iOS runner app not found: ${runnerAppPath}`);
    }

    return runnerAppPath;
  }

  /**
   * Get the path to a user's app file (APK/IPA specified by name).
   */
  async getAppFilePath(appFileName: string): Promise<string> {
    if (path.isAbsolute(appFileName) && fs.existsSync(appFileName)) {
      return appFileName;
    }

    const cwdPath = path.resolve(process.cwd(), appFileName);
    if (fs.existsSync(cwdPath)) {
      return cwdPath;
    }

    throw new Error(`App file not found: ${appFileName}`);
  }

  /**
   * Ensure iOS apps are available (extract from .zip if needed).
   */
  async ensureIOSAppsAvailable(): Promise<void> {
    const { appPath, runnerAppPath, targetDir } = this._resolveIOSExtractedAppPaths();
    if (fs.existsSync(appPath) && fs.existsSync(runnerAppPath)) {
      return;
    }

    const appZipPath = await this._assetStore.resolveAssetPath('ios-driver-archive');
    const runnerZipPath = await this._assetStore.resolveAssetPath('ios-driver-runner-archive');
    const iosDir = path.join(this.getResourceDir(), 'ios');

    if (!appZipPath || !fs.existsSync(appZipPath)) {
      throw new Error(
        `Missing iOS driver archive in ${iosDir}. Configure FINALRUN_ASSET_DIR, FINALRUN_ASSET_MANIFEST_PATH, or FINALRUN_ASSET_MANIFEST_URL.`,
      );
    }
    if (!runnerZipPath || !fs.existsSync(runnerZipPath)) {
      throw new Error(
        `Missing iOS test runner archive in ${iosDir}. Configure FINALRUN_ASSET_DIR, FINALRUN_ASSET_MANIFEST_PATH, or FINALRUN_ASSET_MANIFEST_URL.`,
      );
    }

    fs.mkdirSync(targetDir, { recursive: true });

    for (const zipPath of [appZipPath, runnerZipPath]) {
      try {
        await this._execFileFn('unzip', ['-o', zipPath, '-d', targetDir]);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);
        throw new Error(`Failed to unzip iOS driver archive ${zipPath}: ${message}`);
      }
    }

    if (!fs.existsSync(runnerAppPath)) {
      throw new Error(`Extracted iOS runner app not found: ${runnerAppPath}`);
    }
  }

  private _resolveIOSExtractedAppPaths(): {
    targetDir: string;
    appPath: string;
    runnerAppPath: string;
  } {
    const targetDir = path.join(this.getResourceDir(), 'ios', 'Debug-iphonesimulator');
    return {
      targetDir,
      appPath: path.join(targetDir, 'finalrun-ios.app'),
      runnerAppPath: path.join(targetDir, 'finalrun-ios-test-Runner.app'),
    };
  }
}
