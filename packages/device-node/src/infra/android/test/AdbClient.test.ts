import assert from 'node:assert/strict';
import test from 'node:test';
import { AdbClient, isUndeclaredPermissionGrantFailure } from '../AdbClient.js';

function adbExecError(stderr: string): Error & { code: number; stderr: string; stdout: string } {
  const err = new Error('Command failed') as Error & {
    code: number;
    stderr: string;
    stdout: string;
  };
  err.code = 255;
  err.stderr = stderr;
  err.stdout = '';
  return err;
}

test('isUndeclaredPermissionGrantFailure matches pm grant SecurityException stderr', () => {
  assert.equal(
    isUndeclaredPermissionGrantFailure(
      "java.lang.SecurityException: Package org.wikipedia.dev has not requested permission android.permission.CAMERA",
    ),
    true,
  );
  assert.equal(isUndeclaredPermissionGrantFailure('device offline'), false);
});

test('AdbClient.togglePermissions treats undeclared permission grant as success', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      throw adbExecError(
        "\nException occurred while executing 'grant':\njava.lang.SecurityException: Package com.example.app has not requested permission android.permission.CAMERA\n",
      );
    },
  });

  const result = await adbClient.togglePermissions(
    '/platform-tools/adb',
    'emulator-5554',
    'com.example.app',
    { camera: 'allow' },
  );

  assert.equal(result.success, true);
  assert.match(execCalls[0]?.args.join(' '), /pm grant com\.example\.app android\.permission\.CAMERA/);
});

test('AdbClient.togglePermissions fails when pm grant fails for reasons other than undeclared', async () => {
  const adbClient = new AdbClient({
    execFileFn: async (_file, args) => {
      if (args.includes('android.permission.CAMERA')) {
        throw adbExecError(
          "\nException occurred while executing 'grant':\njava.lang.SecurityException: Package com.example.app has not requested permission android.permission.CAMERA\n",
        );
      }
      throw adbExecError('Error: device offline');
    },
  });

  const result = await adbClient.togglePermissions(
    '/platform-tools/adb',
    'emulator-5554',
    'com.example.app',
    { camera: 'allow', microphone: 'allow' },
  );

  assert.equal(result.success, false);
  assert.match(result.message ?? '', /RECORD_AUDIO|microphone|offline|Failed to update/i);
});

test('AdbClient.allowAllPermissions succeeds when every pm grant is undeclared', async () => {
  const adbClient = new AdbClient({
    execFileFn: async (_file, args) => {
      if (args.includes('appops')) {
        return { stdout: '', stderr: '' };
      }
      throw adbExecError(
        "java.lang.SecurityException: Package com.minimal.app has not requested permission android.permission.CAMERA",
      );
    },
  });

  const result = await adbClient.allowAllPermissions(
    '/platform-tools/adb',
    'emulator-5554',
    'com.minimal.app',
  );

  assert.equal(result.success, true);
});

test('AdbClient.installApp uses reinstall and grant flags for app overrides', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  const installed = await adbClient.installApp(
    '/platform-tools/adb',
    'emulator-5554',
    '/tmp/app.apk',
  );

  assert.equal(installed, true);
  assert.deepEqual(execCalls, [
    {
      file: '/platform-tools/adb',
      args: ['-s', 'emulator-5554', 'install', '-r', '-g', '/tmp/app.apk'],
    },
  ]);
});

test('AdbClient.installDriverApp returns true on first install without checking package', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  const installed = await adbClient.installDriverApp(
    '/platform-tools/adb',
    'emulator-5554',
    '/tmp/app.apk',
    'app.finalrun.android',
  );

  assert.equal(installed, true);
  assert.deepEqual(execCalls, [
    {
      file: '/platform-tools/adb',
      args: ['-s', 'emulator-5554', 'install', '-r', '-g', '/tmp/app.apk'],
    },
  ]);
});

test('AdbClient.installDriverApp returns false without retry when package is absent', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      if (args.includes('install')) {
        throw adbExecError('adb: failed to install /tmp/app.apk: storage full');
      }
      if (args.includes('packages')) {
        return { stdout: 'package:com.other.app\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });

  const installed = await adbClient.installDriverApp(
    '/platform-tools/adb',
    'emulator-5554',
    '/tmp/app.apk',
    'app.finalrun.android',
  );

  assert.equal(installed, false);
  // install (fails) + pm list packages (returns no match). No uninstall, no retry.
  assert.equal(execCalls.length, 2);
  assert.equal(execCalls[0]?.args.includes('install'), true);
  assert.equal(execCalls[1]?.args.includes('packages'), true);
  assert.equal(
    execCalls.some((call) => call.args.includes('uninstall')),
    false,
  );
});

test('AdbClient.installDriverApp uninstalls and retries when package already exists', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  let installAttempts = 0;
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      if (args.includes('install')) {
        installAttempts += 1;
        if (installAttempts === 1) {
          throw adbExecError('adb: failed to install /tmp/app.apk: INSTALL_FAILED_UPDATE_INCOMPATIBLE');
        }
        return { stdout: 'Success', stderr: '' };
      }
      if (args.includes('packages')) {
        return { stdout: 'package:app.finalrun.android\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });

  const installed = await adbClient.installDriverApp(
    '/platform-tools/adb',
    'emulator-5554',
    '/tmp/app.apk',
    'app.finalrun.android',
  );

  assert.equal(installed, true);
  assert.equal(installAttempts, 2);
  const verbs = execCalls.map((call) =>
    call.args.find((arg) => ['install', 'uninstall', 'shell'].includes(arg)),
  );
  // install (fails) -> shell pm list packages -> uninstall -> install (succeeds)
  assert.deepEqual(verbs, ['install', 'shell', 'uninstall', 'install']);
});

test('AdbClient.installDriverApp returns false when retry install also fails', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      if (args.includes('install')) {
        throw adbExecError('adb: failed to install /tmp/app.apk: INSTALL_FAILED_UPDATE_INCOMPATIBLE');
      }
      if (args.includes('uninstall')) {
        throw adbExecError('Failure [DELETE_FAILED_INTERNAL_ERROR]');
      }
      if (args.includes('packages')) {
        return { stdout: 'package:app.finalrun.android\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });

  const installed = await adbClient.installDriverApp(
    '/platform-tools/adb',
    'emulator-5554',
    '/tmp/app.apk',
    'app.finalrun.android',
  );

  assert.equal(installed, false);
  const verbs = execCalls.map((call) =>
    call.args.find((arg) => ['install', 'uninstall', 'shell'].includes(arg)),
  );
  assert.deepEqual(verbs, ['install', 'shell', 'uninstall', 'install']);
});

test('AdbClient.openDeepLink uses adb am start with the deeplink URL', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  const opened = await adbClient.openDeepLink(
    '/platform-tools/adb',
    'emulator-5554',
    'wikipedia://settings',
  );

  assert.equal(opened, true);
  assert.deepEqual(execCalls, [
    {
      file: '/platform-tools/adb',
      args: [
        '-s',
        'emulator-5554',
        'shell',
        'am',
        'start',
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'wikipedia://settings',
      ],
    },
  ]);
});

test('AdbClient.swipe uses adb input swipe with absolute coordinates', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  const result = await adbClient.swipe('/platform-tools/adb', 'emulator-5554', {
    startX: 10,
    startY: 20,
    endX: 30,
    endY: 40,
    durationMs: 700,
  });

  assert.equal(result.success, true);
  assert.deepEqual(execCalls, [
    {
      file: '/platform-tools/adb',
      args: [
        '-s',
        'emulator-5554',
        'shell',
        'input',
        'swipe',
        '10',
        '20',
        '30',
        '40',
        '700',
      ],
    },
  ]);
});

test('AdbClient.performKeyPress maps logical keys to adb key events', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  const result = await adbClient.performKeyPress(
    '/platform-tools/adb',
    'emulator-5554',
    'enter',
  );

  assert.equal(result.success, true);
  assert.deepEqual(execCalls, [
    {
      file: '/platform-tools/adb',
      args: [
        '-s',
        'emulator-5554',
        'shell',
        'input',
        'keyevent',
        'KEYCODE_ENTER',
      ],
    },
  ]);
});

test('AdbClient.hideKeyboard presses back only when the keyboard is visible', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      if (args.includes('dumpsys')) {
        return { stdout: 'mInputShown=true', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });

  const result = await adbClient.hideKeyboard('/platform-tools/adb', 'emulator-5554');

  assert.equal(result.success, true);
  assert.deepEqual(execCalls, [
    {
      file: '/platform-tools/adb',
      args: ['-s', 'emulator-5554', 'shell', 'dumpsys', 'input_method'],
    },
    {
      file: '/platform-tools/adb',
      args: [
        '-s',
        'emulator-5554',
        'shell',
        'input',
        'keyevent',
        'KEYCODE_BACK',
      ],
    },
  ]);
});

test('AdbClient.launchAppCli resolves the launcher activity before launching', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      if (args.includes('resolve-activity')) {
        return {
          stdout: 'com.example.app/.MainActivity\n',
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    },
  });

  const result = await adbClient.launchAppCli(
    '/platform-tools/adb',
    'emulator-5554',
    'com.example.app',
    {
      foo: {
        key: 'foo',
        type: 'arg',
        value: 'bar',
      },
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(execCalls, [
    {
      file: '/platform-tools/adb',
      args: [
        '-s',
        'emulator-5554',
        'shell',
        'cmd',
        'package',
        'resolve-activity',
        '--brief',
        'com.example.app',
        '-c',
        'android.intent.category.LAUNCHER',
      ],
    },
    {
      file: '/platform-tools/adb',
      args: [
        '-s',
        'emulator-5554',
        'shell',
        'am',
        'start',
        '-W',
        '-n',
        'com.example.app/.MainActivity',
        '-e',
        'foo',
        'bar',
      ],
    },
  ]);
});

test('AdbClient.togglePermissions uses pm grant and appops for Android permission helpers', async () => {
  const execCalls: Array<{ file: string; args: readonly string[] }> = [];
  const adbClient = new AdbClient({
    execFileFn: async (file, args) => {
      execCalls.push({ file, args });
      return { stdout: '', stderr: '' };
    },
  });

  const result = await adbClient.togglePermissions(
    '/platform-tools/adb',
    'emulator-5554',
    'com.example.app',
    {
      camera: 'allow',
      overlay: 'deny',
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(execCalls, [
    {
      file: '/platform-tools/adb',
      args: [
        '-s',
        'emulator-5554',
        'shell',
        'pm',
        'grant',
        'com.example.app',
        'android.permission.CAMERA',
      ],
    },
    {
      file: '/platform-tools/adb',
      args: [
        '-s',
        'emulator-5554',
        'shell',
        'appops',
        'set',
        'com.example.app',
        'SYSTEM_ALERT_WINDOW',
        'deny',
      ],
    },
  ]);
});
