import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { PLATFORM_ANDROID, PLATFORM_IOS } from '@finalrun/common';
import { runDoctorCommand } from '../doctorRunner.js';
import { resolveWorkspace } from '@finalrun/common';

const CLI_TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-cli-home-'));

function createTempWorkspace(params?: {
  envFiles?: Record<string, string>;
  includeEnvDir?: boolean;
  includeSuitesDir?: boolean;
  configYaml?: string | null;
  testLines?: string[];
  testFiles?: Record<string, string>;
  suites?: Record<string, string>;
}): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-cli-bin-'));
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  const suitesDir = path.join(rootDir, '.finalrun', 'suites');
  fs.mkdirSync(testsDir, { recursive: true });
  if (params?.includeEnvDir !== false) {
    fs.mkdirSync(envDir, { recursive: true });
  }
  const suites = params?.suites ?? {};
  if ((params?.includeSuitesDir ?? Object.keys(suites).length > 0) === true) {
    fs.mkdirSync(suitesDir, { recursive: true });
  }

  const configYaml = buildWorkspaceConfigYaml(params?.configYaml);
  if (configYaml !== undefined) {
    fs.writeFileSync(path.join(rootDir, '.finalrun', 'config.yaml'), configYaml, 'utf-8');
  }

  const testFiles = params?.testFiles ?? {
    'login.yaml': (
      params?.testLines ?? ['name: login', 'steps:', '  - Open the login screen.']
    ).join('\n'),
  };
  for (const [relativePath, contents] of Object.entries(testFiles)) {
    const targetPath = path.join(testsDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, contents, 'utf-8');
  }

  for (const [relativePath, contents] of Object.entries(suites)) {
    const targetPath = path.join(suitesDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, contents, 'utf-8');
  }

  if (params?.includeEnvDir !== false) {
    for (const [fileName, contents] of Object.entries(params?.envFiles ?? { 'dev.yaml': '{}\n' })) {
      fs.writeFileSync(path.join(envDir, fileName), contents, 'utf-8');
    }
  }

  return rootDir;
}

function buildWorkspaceConfigYaml(configYaml?: string | null): string | undefined {
  if (configYaml === null) {
    return undefined;
  }

  const defaultAppConfig = ['app:', '  packageName: org.wikipedia'].join('\n');
  if (configYaml === undefined) {
    return `${defaultAppConfig}\n`;
  }
  if (/^app:/m.test(configYaml)) {
    return configYaml;
  }
  const trimmedConfig = configYaml.trimEnd();
  return `${trimmedConfig}\n${defaultAppConfig}\n`;
}

function runCli(args: string[], cwd: string, envOverrides?: NodeJS.ProcessEnv) {
  const compiledBinPath = path.resolve(__dirname, '../../bin/finalrun.js');
  const sourceBinPath = path.resolve(__dirname, '../../bin/finalrun.ts');
  const tsxCliPath = path.resolve(__dirname, '../../../../node_modules/tsx/dist/cli.mjs');
  const tsconfigPath = path.resolve(__dirname, '../../../../tsconfig.dev.json');
  const commandArgs = fs.existsSync(compiledBinPath)
    ? [compiledBinPath, ...args]
    : fs.existsSync(tsconfigPath)
      ? [tsxCliPath, '--tsconfig', tsconfigPath, sourceBinPath, ...args]
      : [tsxCliPath, sourceBinPath, ...args];
  return spawnSync(process.execPath, commandArgs, {
    cwd,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      ...envOverrides,
    },
    encoding: 'utf-8',
  });
}

async function resolveWorkspaceForHome(cwd: string, homeDir: string) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return await resolveWorkspace(cwd);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

const EMPTY_PROVIDER_ENV_VARS = {
  OPENAI_API_KEY: '',
  GOOGLE_API_KEY: '',
  ANTHROPIC_API_KEY: '',
};

async function assertNoRunArtifacts(cwd: string): Promise<void> {
  const workspace = await resolveWorkspaceForHome(cwd, CLI_TEST_HOME);
  const artifactEntries = await fsp.readdir(workspace.artifactsDir).catch(() => []);
  const runEntries = artifactEntries.filter((e) => e !== '.server.json');
  assert.deepEqual(runEntries, []);
  await assert.rejects(() => fsp.stat(path.join(workspace.artifactsDir, 'runs.json')));
}

function assertNoRunOutput(result: ReturnType<typeof runCli>): void {
  assert.doesNotMatch(result.stdout, /All tests passed/);
  assert.doesNotMatch(result.stdout, /test\(s\) failed/);
  assert.doesNotMatch(result.stdout, /Run directory:/);
  assert.doesNotMatch(result.stdout, /Run report available at/);
}

function createDoctorDependencies(params: {
  requestedPlatforms?: Array<typeof PLATFORM_ANDROID | typeof PLATFORM_IOS>;
  reportChecks: Array<{
    platform: 'android' | 'ios' | 'common';
    status: 'ok' | 'error' | 'warning';
    id: string;
    title: string;
    summary: string;
    detail?: string;
    blocking: boolean;
  }>;
  hostPlatform?: NodeJS.Platform;
}) {
  return {
    hostPreflightDependencies: {
      getPlatform: () => params.hostPlatform ?? 'darwin',
    },
    async runHostPreflight(options: {
      requestedPlatforms: Array<typeof PLATFORM_ANDROID | typeof PLATFORM_IOS>;
    }) {
      return {
        requestedPlatforms: params.requestedPlatforms ?? options.requestedPlatforms,
        checks: params.reportChecks,
      };
    },
  };
}

async function findAvailablePort(): Promise<number> {
  const net = await import('node:net');
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('No ephemeral port allocated.')));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

test('finalrun check works without --env when dev.yaml exists', async () => {
  const rootDir = createTempWorkspace({
    envFiles: {
      'dev.yaml': ['variables:', '  locale: en-US'].join('\n'),
    },
  });

  try {
    const result = runCli(['check'], rootDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Using Android package: org\.wikipedia/);
    assert.match(result.stdout, /using env dev\./);
    assert.equal(result.stderr, '');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun check uses .finalrun/config.yaml env when --env is omitted', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'env: staging\n',
    envFiles: {
      'dev.yaml': ['variables:', '  locale: en-US'].join('\n'),
      'staging.yaml': ['variables:', '  locale: de-DE'].join('\n'),
    },
  });

  try {
    const result = runCli(['check'], rootDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /using env staging\./);
    assert.equal(result.stderr, '');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun check prefers --env over .finalrun/config.yaml env', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'env: staging\n',
    envFiles: {
      'dev.yaml': ['variables:', '  locale: en-US'].join('\n'),
      'staging.yaml': ['variables:', '  locale: de-DE'].join('\n'),
    },
  });

  try {
    const result = runCli(['check', '--env', 'dev'], rootDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /using env dev\./);
    assert.equal(result.stderr, '');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun check ignores config model values', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'model: bedrock/claude\n',
  });

  try {
    const result = runCli(['check'], rootDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /using env dev\./);
    assert.equal(result.stderr, '');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runDoctorCommand reports missing Android blockers', async () => {
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk) => {
    printed += chunk.toString();
  });

  const result = await runDoctorCommand(
    {
      platform: 'android',
      output,
    },
    createDoctorDependencies({
      reportChecks: [
        {
          platform: PLATFORM_ANDROID,
          status: 'error',
          id: 'adb',
          title: 'adb',
          summary: 'Required to communicate with Android devices.',
          detail: 'ADB was not found in ANDROID_HOME, ANDROID_SDK_ROOT, or PATH.',
          blocking: true,
        },
      ],
    }),
  );

  assert.equal(result.success, false);
  assert.match(printed, /✗ adb/);
  assert.match(printed, /Required to communicate with Android devices\./);
});

test('runDoctorCommand reports missing iOS blockers', async () => {
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk) => {
    printed += chunk.toString();
  });

  const result = await runDoctorCommand(
    {
      platform: 'ios',
      output,
    },
    createDoctorDependencies({
      reportChecks: [
        {
          platform: PLATFORM_IOS,
          status: 'error',
          id: 'xcrun',
          title: 'xcrun',
          summary: 'Required to access iOS simulator tooling.',
          detail: 'xcrun was not found in PATH.',
          blocking: true,
        },
      ],
    }),
  );

  assert.equal(result.success, false);
  assert.match(printed, /✗ xcrun/);
  assert.match(printed, /Required to access iOS simulator tooling\./);
});

test('runDoctorCommand defaults to both platforms on mac and marks warnings distinctly', async () => {
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk) => {
    printed += chunk.toString();
  });

  const observedPlatforms: Array<typeof PLATFORM_ANDROID | typeof PLATFORM_IOS> = [];
  const result = await runDoctorCommand(
    {
      output,
    },
    {
      hostPreflightDependencies: {
        getPlatform: () => 'darwin',
      },
      async runHostPreflight(options) {
        observedPlatforms.push(...options.requestedPlatforms);
        return {
          requestedPlatforms: options.requestedPlatforms,
          checks: [
            {
              platform: PLATFORM_ANDROID,
              status: 'ok',
              id: 'adb',
              title: 'adb',
              summary: 'Required to communicate with Android devices.',
              detail: '/mock/adb',
              blocking: true,
            },
            {
              platform: PLATFORM_IOS,
              status: 'warning',
              id: 'ffmpeg',
              title: 'ffmpeg',
              summary: 'Used to compress iOS recordings after capture.',
              detail: 'ffmpeg was not found in PATH.',
              blocking: false,
            },
          ],
        };
      },
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(observedPlatforms, [PLATFORM_ANDROID, PLATFORM_IOS]);
  // Doctor prints one ✓/✗/⚠ line per check — passing and warning checks are
  // distinguished by their marker, not by grouped sections.
  assert.match(printed, /✓ adb/);
  assert.match(printed, /⚠ ffmpeg — Used to compress iOS recordings after capture\./);
  assert.doesNotMatch(printed, /✗ /);
});

test('finalrun check reports an env ambiguity error instead of a parser error when --env is omitted', async () => {
  const rootDir = createTempWorkspace({
    envFiles: {
      'staging.yaml': '{}\n',
      'prod.yaml': '{}\n',
    },
  });

  try {
    const result = runCli(['check'], rootDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pass --env <name>\. Available environments: prod, staging/);
    assert.doesNotMatch(result.stderr, /required option '--env <name>' not specified/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun check works without --env when .finalrun/env is absent and the test is env-free', async () => {
  const rootDir = createTempWorkspace({
    includeEnvDir: false,
  });

  try {
    const result = runCli(['check'], rootDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /using no env bindings\./);
    assert.equal(result.stderr, '');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun check fails with actionable binding guidance when .finalrun/env is absent and the test references env bindings', async () => {
  const rootDir = createTempWorkspace({
    includeEnvDir: false,
    testLines: ['name: login', 'steps:', '  - Enter ${secrets.email} on the login screen.'],
  });

  try {
    const result = runCli(['check'], rootDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no environment configuration was resolved/);
    assert.match(result.stderr, /\$\{secrets\.email\}/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun check rejects tests with preconditions keys', async () => {
  const rootDir = createTempWorkspace({
    testLines: [
      'name: login',
      'preconditions:',
      '  - App is installed.',
      'steps:',
      '  - Open the login screen.',
    ],
  });

  try {
    const result = runCli(['check'], rootDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /contains unsupported key "preconditions"/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun check accepts repeated selectors and comma-delimited selectors', async () => {
  const rootDir = createTempWorkspace({
    testFiles: {
      'login.yaml': ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
      'auth/profile/edit.yaml': ['name: edit', 'steps:', '  - Edit the profile.'].join('\n'),
    },
  });

  try {
    const repeatedResult = runCli(['check', 'login.yaml', 'auth/profile/edit.yaml'], rootDir);
    assert.equal(repeatedResult.status, 0);
    assert.match(repeatedResult.stdout, /Validated 2 test\(s\)/);
    assert.equal(repeatedResult.stderr, '');

    const commaResult = runCli(['check', 'login.yaml,auth/profile/edit.yaml'], rootDir);
    assert.equal(commaResult.status, 0);
    assert.match(commaResult.stdout, /Validated 2 test\(s\)/);
    assert.equal(commaResult.stderr, '');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun check validates suite manifests with --suite', async () => {
  const rootDir = createTempWorkspace({
    testFiles: {
      'login.yaml': ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
      'dashboard/home.yaml': ['name: home', 'steps:', '  - Open dashboard.'].join('\n'),
    },
    suites: {
      'login_suite.yaml': [
        'name: login suite',
        'tests:',
        '  - login.yaml',
        '  - dashboard/**',
      ].join('\n'),
    },
  });

  try {
    const result = runCli(['check', '--suite', 'login_suite.yaml'], rootDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Validated 2 test\(s\)/);
    assert.equal(result.stderr, '');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test resolves nested test paths without requiring the .finalrun/tests prefix', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'model: google/gemini-3-flash-preview\n',
    testFiles: {
      'login/auth.yaml': ['name: auth login', 'steps:', '  - Open auth login.'].join('\n'),
    },
  });

  try {
    const result = runCli(['test', 'login/auth.yaml'], rootDir, EMPTY_PROVIDER_ENV_VARS);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /API key is required for provider "google"\. Provide via --api-key or GOOGLE_API_KEY\./,
    );
    assert.doesNotMatch(result.stderr, /Test file not found/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun suite resolves suite manifests without requiring the .finalrun/suites prefix', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'model: google/gemini-3-flash-preview\n',
    testFiles: {
      'login/auth.yaml': ['name: auth login', 'steps:', '  - Open auth login.'].join('\n'),
    },
    suites: {
      'login/auth_suite.yaml': ['name: auth suite', 'tests:', '  - login/auth.yaml'].join('\n'),
    },
  });

  try {
    const result = runCli(['suite', 'login/auth_suite.yaml'], rootDir, EMPTY_PROVIDER_ENV_VARS);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /API key is required for provider "google"\. Provide via --api-key or GOOGLE_API_KEY\./,
    );
    assert.doesNotMatch(result.stderr, /Suite manifest not found/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test rejects --suite flag as an unknown option', async () => {
  const rootDir = createTempWorkspace({
    suites: {
      'login_suite.yaml': ['name: login suite', 'tests:', '  - login.yaml'].join('\n'),
    },
  });

  try {
    const result = runCli(['test', '--suite', 'login_suite.yaml'], rootDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown option '--suite'/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test reports missing selectors before API key validation', async () => {
  const rootDir = createTempWorkspace();

  try {
    const result = runCli(['test'], rootDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /At least one test selector is required/);
    assert.doesNotMatch(result.stderr, /API key is required/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test explains local model setup before resolving the workspace environment', async () => {
  const rootDir = createTempWorkspace({
    envFiles: {
      'prod.yaml': '{}\n',
      'staging.yaml': '{}\n',
    },
  });

  try {
    const result = runCli(['test', 'login.yaml'], rootDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /One more step — choose how to run this test/);
    assert.match(result.stderr, /This command runs tests locally, so finalrun needs a provider\/model\./);
    assert.match(result.stderr, /macOS\/Linux: export FINALRUN_API_KEY=fr_\.\.\./);
    assert.match(result.stderr, /PowerShell: {2}\$env:FINALRUN_API_KEY = 'fr_\.\.\.'/);
    assert.match(result.stderr, /finalrun cloud test login\.yaml --platform android/);
    assert.match(result.stderr, /model: google\/gemini-3-flash-preview/);
    assert.match(result.stderr, /macOS\/Linux: export GOOGLE_API_KEY=\.\.\./);
    assert.match(result.stderr, /PowerShell: {2}\$env:GOOGLE_API_KEY = '\.\.\.'/);
    assert.match(result.stderr, /finalrun test login\.yaml --model google\/gemini-3-flash-preview/);
    assert.match(result.stderr, /Supported providers: openai, google, anthropic\./);
    assert.doesNotMatch(result.stderr, /Pass --env <name>\. Available environments:/);
    assert.doesNotMatch(result.stderr, /API key is required/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun suite explains local model setup before resolving the workspace environment', async () => {
  const rootDir = createTempWorkspace({
    includeSuitesDir: true,
    envFiles: {
      'prod.yaml': '{}\n',
      'staging.yaml': '{}\n',
    },
  });

  try {
    const result = runCli(['suite', 'login_suite.yaml'], rootDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /One more step — choose how to run this test/);
    assert.match(result.stderr, /This command runs tests locally, so finalrun needs a provider\/model\./);
    assert.match(result.stderr, /finalrun cloud suite login_suite\.yaml --platform android/);
    assert.match(result.stderr, /finalrun suite login_suite\.yaml --model google\/gemini-3-flash-preview/);
    assert.doesNotMatch(result.stderr, /Pass --env <name>\. Available environments:/);
    assert.doesNotMatch(result.stderr, /API key is required/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test uses .finalrun/config.yaml model when --model is omitted', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'model: google/gemini-3-flash-preview\n',
  });

  try {
    const result = runCli(['test', 'login.yaml'], rootDir, EMPTY_PROVIDER_ENV_VARS);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /API key is required for provider "google"\. Provide via --api-key or GOOGLE_API_KEY\./,
    );
    assert.doesNotMatch(result.stderr, /--model is required/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test validates malformed config models before resolving the workspace environment', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'model: not-a-provider-model\n',
    envFiles: {
      'prod.yaml': '{}\n',
      'staging.yaml': '{}\n',
    },
  });

  try {
    const result = runCli(['test', 'login.yaml'], rootDir, EMPTY_PROVIDER_ENV_VARS);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Invalid model format: "not-a-provider-model"\. Expected provider\/model with non-empty provider and model name\. Supported providers: openai, google, anthropic\./,
    );
    assert.doesNotMatch(result.stderr, /Pass --env <name>\. Available environments:/);
    assert.doesNotMatch(result.stderr, /API key is required/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test validates unsupported config providers before resolving the workspace environment', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'model: bedrock/claude\n',
    envFiles: {
      'prod.yaml': '{}\n',
      'staging.yaml': '{}\n',
    },
  });

  try {
    const result = runCli(['test', 'login.yaml'], rootDir, EMPTY_PROVIDER_ENV_VARS);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Unsupported AI provider: "bedrock"\. Supported providers: openai, google, anthropic\./,
    );
    assert.doesNotMatch(result.stderr, /Pass --env <name>\. Available environments:/);
    assert.doesNotMatch(result.stderr, /API key is required/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test uses .finalrun/config.yaml env when --env is omitted', async () => {
  const rootDir = createTempWorkspace({
    configYaml: ['env: staging', 'model: google/gemini-3-flash-preview'].join('\n'),
    envFiles: {
      'prod.yaml': '{}\n',
      'staging.yaml': '{}\n',
    },
  });

  try {
    const result = runCli(['test', 'login.yaml'], rootDir, EMPTY_PROVIDER_ENV_VARS);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /API key is required for provider "google"\. Provide via --api-key or GOOGLE_API_KEY\./,
    );
    assert.doesNotMatch(result.stderr, /Pass --env <name>\. Available environments:/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test prefers explicit --model over .finalrun/config.yaml model', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'model: bedrock/claude\n',
  });

  try {
    const result = runCli(
      ['test', 'login.yaml', '--model', 'google/gemini-3-flash-preview'],
      rootDir,
      EMPTY_PROVIDER_ENV_VARS,
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /API key is required for provider "google"\. Provide via --api-key or GOOGLE_API_KEY\./,
    );
    assert.doesNotMatch(result.stderr, /Unsupported AI provider: "bedrock"/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test prefers explicit --env over .finalrun/config.yaml env', async () => {
  const rootDir = createTempWorkspace({
    configYaml: ['env: qa', 'model: google/gemini-3-flash-preview'].join('\n'),
    envFiles: {
      'prod.yaml': '{}\n',
      'staging.yaml': '{}\n',
    },
  });

  try {
    const result = runCli(
      ['test', 'login.yaml', '--env', 'prod'],
      rootDir,
      EMPTY_PROVIDER_ENV_VARS,
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /API key is required for provider "google"\. Provide via --api-key or GOOGLE_API_KEY\./,
    );
    assert.doesNotMatch(result.stderr, /Environment "qa" was not found/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test rejects unsupported providers before resolving the workspace environment', async () => {
  const rootDir = createTempWorkspace({
    envFiles: {
      'prod.yaml': '{}\n',
      'staging.yaml': '{}\n',
    },
  });

  try {
    const result = runCli(['test', 'login.yaml', '--model', 'bedrock/claude'], rootDir);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Unsupported AI provider: "bedrock"\. Supported providers: openai, google, anthropic\./,
    );
    assert.doesNotMatch(result.stderr, /Pass --env <name>\. Available environments:/);
    assert.doesNotMatch(result.stderr, /API key is required/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test prints blocked Android preflight failures raw and does not create a run', async () => {
  const rootDir = createTempWorkspace();

  try {
    const result = runCli(
      ['test', 'login.yaml', '--platform', 'android', '--model', 'openai/gpt-5.4-mini'],
      rootDir,
      {
        OPENAI_API_KEY: 'test-key',
        PATH: '',
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Run setup failed before execution:/);
    assert.match(result.stderr, /Local device setup is blocked for android\./i);
    assert.match(result.stderr, /scrcpy not found/i);
    assert.match(result.stderr, /finalrun doctor --platform android/);
    assertNoRunOutput(result);
    await assertNoRunArtifacts(rootDir);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test prints missing test selector failures raw and does not create a run', async () => {
  const rootDir = createTempWorkspace();

  try {
    const result = runCli(['test', 'missing.yaml', '--model', 'openai/gpt-5.4-mini'], rootDir, {
      OPENAI_API_KEY: 'test-key',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Test file not found:/);
    assertNoRunOutput(result);
    await assertNoRunArtifacts(rootDir);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun suite prints missing manifest failures raw and does not create a run', async () => {
  const rootDir = createTempWorkspace({
    includeSuitesDir: true,
  });

  try {
    const result = runCli(['suite', 'missing_suite.yaml', '--model', 'openai/gpt-5.4-mini'], rootDir, {
      OPENAI_API_KEY: 'test-key',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Suite manifest not found:/);
    assertNoRunOutput(result);
    await assertNoRunArtifacts(rootDir);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test prints invalid YAML failures raw and does not create a run', async () => {
  const rootDir = createTempWorkspace({
    testFiles: {
      'login.yaml': 'name: login\nsteps: [\n',
    },
  });

  try {
    const result = runCli(['test', 'login.yaml', '--model', 'openai/gpt-5.4-mini'], rootDir, {
      OPENAI_API_KEY: 'test-key',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid YAML in/);
    assertNoRunOutput(result);
    await assertNoRunArtifacts(rootDir);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test prints unresolved env binding failures raw and does not create a run', async () => {
  const rootDir = createTempWorkspace({
    includeEnvDir: false,
    testLines: ['name: login', 'steps:', '  - Enter ${secrets.email} on the login screen.'],
  });

  try {
    const result = runCli(['test', 'login.yaml', '--model', 'openai/gpt-5.4-mini'], rootDir, {
      OPENAI_API_KEY: 'test-key',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no environment configuration was resolved/);
    assertNoRunOutput(result);
    await assertNoRunArtifacts(rootDir);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test prints unsupported app override failures raw and does not create a run', async () => {
  const rootDir = createTempWorkspace();
  const badAppPath = path.join(rootDir, 'fake-app.txt');
  fs.writeFileSync(badAppPath, 'not an app bundle', 'utf-8');

  try {
    const result = runCli(
      ['test', 'login.yaml', '--model', 'openai/gpt-5.4-mini', '--app', badAppPath],
      rootDir,
      {
        OPENAI_API_KEY: 'test-key',
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported --app override/);
    assertNoRunOutput(result);
    await assertNoRunArtifacts(rootDir);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun test prints device setup failures raw and does not create a run', async () => {
  const rootDir = createTempWorkspace();

  try {
    const result = runCli(
      ['test', 'login.yaml', '--model', 'openai/gpt-5.4-mini', '--platform', 'android'],
      rootDir,
      {
        OPENAI_API_KEY: 'test-key',
        FINALRUN_CLI_TEST_SKIP_HOST_PREFLIGHT: '1',
        FINALRUN_CLI_TEST_FORCE_DEVICE_SETUP_FAILURE:
          'No runnable devices or startable targets were found.',
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Using Android package: org\.wikipedia/);
    assert.match(result.stderr, /Run setup failed before execution:/);
    assert.match(result.stderr, /No runnable devices or startable targets were found\./);
    assertNoRunOutput(result);
    await assertNoRunArtifacts(rootDir);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun start-server reports guidance outside a FinalRun repo when --workspace is omitted', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-cli-no-workspace-'));

  try {
    const result = runCli(['start-server'], rootDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pass --workspace <path> to target a FinalRun workspace explicitly/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun start-server ignores a parent .finalrun home directory without tests', async () => {
  const fakeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-cli-fake-home-'));
  const outsideDir = path.join(fakeHomeDir, 'projects', 'outside');
  fs.mkdirSync(path.join(fakeHomeDir, '.finalrun'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  try {
    const result = runCli(['start-server'], outsideDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pass --workspace <path> to target a FinalRun workspace explicitly/);
    assert.doesNotMatch(result.stderr, /Missing \.finalrun\/tests directory/);
  } finally {
    await fsp.rm(fakeHomeDir, { recursive: true, force: true });
  }
});

test('finalrun start-server --help shows --workspace and top-level stop/status commands are available', async () => {
  const rootDir = createTempWorkspace();

  try {
    const startHelp = runCli(['start-server', '--help'], rootDir);
    const stopHelp = runCli(['stop-server', '--help'], rootDir);
    const statusHelp = runCli(['server-status', '--help'], rootDir);

    assert.equal(startHelp.status, 0);
    assert.match(startHelp.stdout, /--workspace <path>/);
    assert.equal(stopHelp.status, 0);
    // stop-server is workspace-independent: it stops every running server and
    // clears stale state, so it takes no --workspace option.
    assert.match(stopHelp.stdout, /stop all running finalrun report servers/i);
    assert.doesNotMatch(stopHelp.stdout, /--workspace <path>/);
    assert.equal(statusHelp.status, 0);
    assert.match(statusHelp.stdout, /show the local finalrun report server status/i);
    assert.match(statusHelp.stdout, /--workspace <path>/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun report serve is rejected after the breaking command removal', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-cli-no-report-workspace-'));

  try {
    const result = runCli(['report', 'serve'], rootDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown command 'report'/i);

    const reportHelp = runCli(['report', '--help'], rootDir);
    assert.equal(reportHelp.status, 0);
    assert.doesNotMatch(reportHelp.stdout, /^\s+report\b/m);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun runs --json prints the saved runs index', async () => {
  const rootDir = createTempWorkspace();
  const workspace = await resolveWorkspaceForHome(rootDir, CLI_TEST_HOME);
  const artifactsDir = workspace.artifactsDir;
  await fsp.mkdir(artifactsDir, { recursive: true });
  await fsp.writeFile(
    path.join(artifactsDir, 'runs.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: '2026-03-23T18:00:00.000Z',
        runs: [
          {
            runId: '2026-03-23T18-00-00.000Z-dev-android',
            success: false,
            status: 'failure',
            startedAt: '2026-03-23T18:00:00.000Z',
            completedAt: '2026-03-23T18:00:10.000Z',
            durationMs: 10000,
            envName: 'dev',
            platform: 'android',
            modelLabel: 'openai/gpt-5.4-mini',
            appLabel: 'repo app',
            testCount: 1,
            passedCount: 0,
            failedCount: 1,
            stepCount: 1,
            paths: {
              runJson: '2026-03-23T18-00-00.000Z-dev-android/run.json',
              log: '2026-03-23T18-00-00.000Z-dev-android/runner.log',
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );

  try {
    const result = runCli(['runs', '--json'], rootDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"runId": "2026-03-23T18-00-00.000Z-dev-android"/);
    assert.equal(result.stderr, '');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun runs prints a console summary and suggests starting the local report UI', async () => {
  const rootDir = createTempWorkspace();
  const workspace = await resolveWorkspaceForHome(rootDir, CLI_TEST_HOME);
  const artifactsDir = workspace.artifactsDir;
  await fsp.mkdir(artifactsDir, { recursive: true });
  await fsp.writeFile(
    path.join(artifactsDir, 'runs.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: '2026-03-23T18:00:00.000Z',
        runs: [
          {
            runId: '2026-03-23T18-00-00.000Z-dev-android',
            success: true,
            status: 'success',
            startedAt: '2026-03-23T18:00:00.000Z',
            completedAt: '2026-03-23T18:00:10.000Z',
            durationMs: 10000,
            envName: 'dev',
            platform: 'android',
            modelLabel: 'openai/gpt-5.4-mini',
            appLabel: 'repo app',
            testCount: 2,
            passedCount: 2,
            failedCount: 0,
            stepCount: 4,
            paths: {
              runJson: '2026-03-23T18-00-00.000Z-dev-android/run.json',
              log: '2026-03-23T18-00-00.000Z-dev-android/runner.log',
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );

  try {
    const result = runCli(['runs'], rootDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /PASS/);
    assert.match(
      result.stdout,
      /finalrun start-server --workspace "/,
    );
    assert.match(
      result.stdout,
      new RegExp(`${path.basename(workspace.rootDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    );
    assert.equal(result.stderr, '');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun start-server rejects malformed and out-of-range --port values', async () => {
  const rootDir = createTempWorkspace();

  try {
    const malformedPortResult = runCli(
      ['start-server', '--port', '4173foo'],
      rootDir,
      { FINALRUN_DISABLE_BROWSER: '1' },
    );
    assert.equal(malformedPortResult.status, 1);
    assert.match(malformedPortResult.stderr, /Invalid --port value "4173foo"/);

    const outOfRangePortResult = runCli(
      ['start-server', '--port', '70000'],
      rootDir,
      { FINALRUN_DISABLE_BROWSER: '1' },
    );
    assert.equal(outOfRangePortResult.status, 1);
    assert.match(outOfRangePortResult.stderr, /Invalid --port value "70000"/);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('finalrun runs --workspace works from outside any workspace', async () => {
  const workspaceRoot = createTempWorkspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-cli-outside-runs-'));
  const workspace = await resolveWorkspaceForHome(workspaceRoot, CLI_TEST_HOME);
  await fsp.mkdir(workspace.artifactsDir, { recursive: true });
  await fsp.writeFile(
    path.join(workspace.artifactsDir, 'runs.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: '2026-03-23T18:00:00.000Z',
        runs: [
          {
            runId: '2026-03-23T18-00-00.000Z-dev-android',
            success: true,
            status: 'success',
            startedAt: '2026-03-23T18:00:00.000Z',
            completedAt: '2026-03-23T18:00:10.000Z',
            durationMs: 10000,
            envName: 'dev',
            platform: 'android',
            modelLabel: 'openai/gpt-5.4-mini',
            appLabel: 'repo app',
            testCount: 1,
            passedCount: 1,
            failedCount: 0,
            stepCount: 1,
            paths: {
              runJson: '2026-03-23T18-00-00.000Z-dev-android/run.json',
              log: '2026-03-23T18-00-00.000Z-dev-android/runner.log',
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );

  try {
    const result = runCli(['runs', '--workspace', workspaceRoot, '--json'], outsideDir);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"runId": "2026-03-23T18-00-00.000Z-dev-android"/);
    assert.equal(result.stderr, '');
  } finally {
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
    await fsp.rm(outsideDir, { recursive: true, force: true });
  }
});

test('finalrun runs --workspace overrides the current workspace', async () => {
  const currentWorkspaceRoot = createTempWorkspace();
  const targetWorkspaceRoot = createTempWorkspace();
  const currentWorkspace = await resolveWorkspaceForHome(currentWorkspaceRoot, CLI_TEST_HOME);
  const targetWorkspace = await resolveWorkspaceForHome(targetWorkspaceRoot, CLI_TEST_HOME);
  await fsp.mkdir(currentWorkspace.artifactsDir, { recursive: true });
  await fsp.mkdir(targetWorkspace.artifactsDir, { recursive: true });
  await fsp.writeFile(
    path.join(currentWorkspace.artifactsDir, 'runs.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: '2026-03-23T18:00:00.000Z',
        runs: [],
      },
      null,
      2,
    ),
    'utf-8',
  );
  await fsp.writeFile(
    path.join(targetWorkspace.artifactsDir, 'runs.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: '2026-03-23T18:00:00.000Z',
        runs: [
          {
            runId: '2026-03-23T19-00-00.000Z-dev-ios',
            success: true,
            status: 'success',
            startedAt: '2026-03-23T19:00:00.000Z',
            completedAt: '2026-03-23T19:00:20.000Z',
            durationMs: 20000,
            envName: 'dev',
            platform: 'ios',
            modelLabel: 'openai/gpt-5.4-mini',
            appLabel: 'repo app',
            testCount: 2,
            passedCount: 2,
            failedCount: 0,
            stepCount: 2,
            paths: {
              runJson: '2026-03-23T19-00-00.000Z-dev-ios/run.json',
              log: '2026-03-23T19-00-00.000Z-dev-ios/runner.log',
            },
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );

  try {
    const result = runCli(
      ['runs', '--workspace', targetWorkspaceRoot, '--json'],
      currentWorkspaceRoot,
    );
    assert.equal(result.status, 0);
    assert.match(result.stdout, /2026-03-23T19-00-00.000Z-dev-ios/);
    assert.doesNotMatch(result.stdout, /"runs": \[\]/);
  } finally {
    await fsp.rm(currentWorkspaceRoot, { recursive: true, force: true });
    await fsp.rm(targetWorkspaceRoot, { recursive: true, force: true });
  }
});

test('finalrun runs reports a clear error for an invalid explicit workspace path', async () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-cli-invalid-workspace-'));

  try {
    const result = runCli(
      ['runs', '--workspace', path.join(outsideDir, 'missing-workspace')],
      outsideDir,
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Path is not inside a FinalRun workspace/);
  } finally {
    await fsp.rm(outsideDir, { recursive: true, force: true });
  }
});

test('finalrun start-server, server-status, and stop-server work from outside a workspace with --workspace', async () => {
  const workspaceRoot = createTempWorkspace();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-cli-server-outside-'));
  const port = await findAvailablePort();
  const workspace = await resolveWorkspaceForHome(workspaceRoot, CLI_TEST_HOME);

  try {
    const startResult = runCli(
      ['start-server', '--workspace', workspaceRoot, '--port', String(port)],
      outsideDir,
      {
        FINALRUN_DISABLE_BROWSER: '1',
      },
    );
    assert.equal(startResult.status, 0);
    assert.match(startResult.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}`));

    const statusResult = runCli(['server-status', '--workspace', workspaceRoot], outsideDir, {
      FINALRUN_DISABLE_BROWSER: '1',
    });
    assert.equal(statusResult.status, 0);
    assert.match(statusResult.stdout, /FinalRun report server status/);
    assert.match(statusResult.stdout, new RegExp(`Workspace root: ${workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(statusResult.stdout, new RegExp(`URL: http://127\\.0\\.0\\.1:${port}`));
    assert.match(statusResult.stdout, /Healthy: yes/);

    // stop-server is workspace-independent — it stops every running server.
    const stopResult = runCli(['stop-server'], outsideDir, {
      FINALRUN_DISABLE_BROWSER: '1',
    });
    assert.equal(stopResult.status, 0);
    assert.match(stopResult.stdout, /Stopped \d+ FinalRun report server process\(es\)/);
    await assert.rejects(() => fsp.stat(path.join(workspace.artifactsDir, '.server.json')));

    const stoppedStatusResult = runCli(
      ['server-status', '--workspace', workspaceRoot],
      outsideDir,
      {
        FINALRUN_DISABLE_BROWSER: '1',
      },
    );
    assert.equal(stoppedStatusResult.status, 0);
    assert.match(stoppedStatusResult.stdout, /is not running/);
  } finally {
    runCli(['stop-server'], outsideDir, {
      FINALRUN_DISABLE_BROWSER: '1',
    });
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
    await fsp.rm(outsideDir, { recursive: true, force: true });
  }
});
