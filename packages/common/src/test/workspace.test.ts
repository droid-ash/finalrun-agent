import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runCheck, SUITE_SELECTOR_CONFLICT_ERROR } from '../checkRunner.js';
import {
  ensureWorkspaceDirectories,
  resolveWorkspaceArtifactsDir,
  resolveWorkspaceArtifactsRootDir,
  resolveWorkspace,
  resolveWorkspaceFromPath,
  resolveWorkspaceForCommand,
  validateAppOverride,
} from '../workspace.js';

function createTempWorkspace(params?: {
  envYaml?: string;
  envFiles?: Record<string, string>;
  includeEnvDir?: boolean;
  includeSuitesDir?: boolean;
  configYaml?: string | null;
  testFiles?: Record<string, string>;
  suites?: Record<string, string>;
}): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-workspace-'));
  const testsDir = path.join(rootDir, '.finalrun', 'tests');
  const envDir = path.join(rootDir, '.finalrun', 'env');
  const suitesDir = path.join(rootDir, '.finalrun', 'suites');
  fs.mkdirSync(testsDir, { recursive: true });
  const includeEnvDir = params?.includeEnvDir ?? true;
  if (includeEnvDir) {
    fs.mkdirSync(envDir, { recursive: true });
  }
  const suites = params?.suites ?? {};
  const includeSuitesDir = params?.includeSuitesDir ?? Object.keys(suites).length > 0;
  if (includeSuitesDir) {
    fs.mkdirSync(suitesDir, { recursive: true });
  }

  const configYaml = buildWorkspaceConfigYaml(params?.configYaml);
  if (configYaml !== undefined) {
    fs.writeFileSync(
      path.join(rootDir, '.finalrun', 'config.yaml'),
      configYaml,
      'utf-8',
    );
  }

  const envFiles = params?.envFiles ?? {
    'dev.yaml': params?.envYaml ?? '{}\n',
  };
  if (includeEnvDir) {
    for (const [fileName, contents] of Object.entries(envFiles)) {
      fs.writeFileSync(path.join(envDir, fileName), contents, 'utf-8');
    }
  }

  const testFiles = params?.testFiles ?? {
    'login.yaml': ['name: login', 'steps:', '  - Open the login screen.'].join('\n'),
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

async function withTempHome<T>(callback: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-workspace-home-'));
  const previousHome = process.env.HOME;

  process.env.HOME = homeDir;
  try {
    return await callback(homeDir);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await fsp.rm(homeDir, { recursive: true, force: true });
  }
}

test('runCheck resolves the nearest .finalrun workspace and runtime bindings from a nested cwd', async () => {
  const secretEnvVar = 'FINALRUN_WORKSPACE_EMAIL_SECRET';
  const previousSecret = process.env[secretEnvVar];
  process.env[secretEnvVar] = 'person@example.com';

  const rootDir = createTempWorkspace({
    envYaml: [
      'secrets:',
      `  email: \${${secretEnvVar}}`,
      'variables:',
      '  language: Spanish',
    ].join('\n'),
    testFiles: {
      'auth/login.yaml': [
        'name: login',
        'steps:',
        '  - Enter ${secrets.email} on the login screen.',
        '  - Verify ${variables.language} is visible after login.',
      ].join('\n'),
    },
  });

  try {
    const nestedCwd = path.join(rootDir, 'packages', 'app');
    fs.mkdirSync(nestedCwd, { recursive: true });

    const result = await runCheck({
      envName: 'dev',
      cwd: nestedCwd,
    });

    assert.equal(result.workspace.rootDir, rootDir);
    assert.equal(result.tests.length, 1);
    assert.equal(result.tests[0]?.relativePath, 'auth/login.yaml');
    assert.equal(result.environment.bindings.variables.language, 'Spanish');
    assert.equal(result.environment.bindings.secrets.email, 'person@example.com');
    assert.equal(result.environment.secretReferences[0]?.envVar, secretEnvVar);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
    if (previousSecret === undefined) {
      delete process.env[secretEnvVar];
    } else {
      process.env[secretEnvVar] = previousSecret;
    }
  }
});

test('runCheck defaults to dev when envName is omitted and dev.yaml exists', async () => {
  const rootDir = createTempWorkspace({
    envFiles: {
      'dev.yaml': ['variables:', '  language: Spanish'].join('\n'),
      'staging.yaml': ['variables:', '  language: German'].join('\n'),
    },
    testFiles: {
      'language.yaml': [
        'name: language',
        'steps:',
        '  - Verify ${variables.language} is visible.',
      ].join('\n'),
    },
  });

  try {
    const result = await runCheck({ cwd: rootDir });
    assert.equal(result.environment.envName, 'dev');
    assert.equal(result.environment.bindings.variables.language, 'Spanish');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck uses .finalrun/config.yaml env when --env is omitted', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'env: staging\n',
    envFiles: {
      'dev.yaml': ['variables:', '  language: Spanish'].join('\n'),
      'staging.yaml': ['variables:', '  language: German'].join('\n'),
    },
    testFiles: {
      'language.yaml': [
        'name: language',
        'steps:',
        '  - Verify ${variables.language} is visible.',
      ].join('\n'),
    },
  });

  try {
    const result = await runCheck({ cwd: rootDir });
    assert.equal(result.environment.envName, 'staging');
    assert.equal(result.environment.bindings.variables.language, 'German');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck prefers explicit envName over .finalrun/config.yaml env', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'env: staging\n',
    envFiles: {
      'dev.yaml': ['variables:', '  language: Spanish'].join('\n'),
      'staging.yaml': ['variables:', '  language: German'].join('\n'),
    },
    testFiles: {
      'language.yaml': [
        'name: language',
        'steps:',
        '  - Verify ${variables.language} is visible.',
      ].join('\n'),
    },
  });

  try {
    const result = await runCheck({ cwd: rootDir, envName: 'dev' });
    assert.equal(result.environment.envName, 'dev');
    assert.equal(result.environment.bindings.variables.language, 'Spanish');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck succeeds with empty bindings when envName is omitted and .finalrun/env is absent', async () => {
  const rootDir = createTempWorkspace({
    includeEnvDir: false,
    testFiles: {
      'smoke.yaml': ['name: smoke', 'steps:', '  - Open the app.'].join('\n'),
    },
  });

  try {
    const result = await runCheck({ cwd: rootDir });
    assert.equal(result.environment.envName, 'none');
    assert.deepEqual(result.environment.bindings, { secrets: {}, variables: {} });
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck succeeds with empty bindings when envName is omitted and .finalrun/env exists but has no env files', async () => {
  const rootDir = createTempWorkspace({
    envFiles: {},
    testFiles: {
      'smoke.yaml': ['name: smoke', 'steps:', '  - Open the app.'].join('\n'),
    },
  });

  try {
    const result = await runCheck({ cwd: rootDir });
    assert.equal(result.environment.envName, 'none');
    assert.deepEqual(result.environment.bindings, { secrets: {}, variables: {} });
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck falls back to the sole env file when envName is omitted and dev.yaml is absent', async () => {
  const rootDir = createTempWorkspace({
    envFiles: {
      'qa.yaml': ['variables:', '  locale: en-GB'].join('\n'),
    },
    testFiles: {
      'locale.yaml': [
        'name: locale',
        'steps:',
        '  - Verify ${variables.locale} is selected.',
      ].join('\n'),
    },
  });

  try {
    const result = await runCheck({ cwd: rootDir });
    assert.equal(result.environment.envName, 'qa');
    assert.equal(result.environment.bindings.variables.locale, 'en-GB');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck fails with an actionable ambiguity error when envName is omitted and multiple non-dev env files exist', async () => {
  const rootDir = createTempWorkspace({
    envFiles: {
      'staging.yaml': '{}\n',
      'prod.yaml': '{}\n',
    },
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /Pass --env <name>\. Available environments: prod, staging/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck fails with actionable guidance when a test references env bindings but .finalrun/env is absent', async () => {
  const rootDir = createTempWorkspace({
    includeEnvDir: false,
    testFiles: {
      'language.yaml': [
        'name: language',
        'steps:',
        '  - Verify ${variables.language} is visible.',
      ].join('\n'),
    },
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /no environment configuration was resolved.*\$\{variables\.language\}/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck fails with actionable guidance when --env is explicit but .finalrun/env is absent', async () => {
  const rootDir = createTempWorkspace({
    includeEnvDir: false,
  });

  try {
    await assert.rejects(
      () => runCheck({ envName: 'dev', cwd: rootDir }),
      /Environment "dev" was requested, but .*\/\.finalrun\/env does not exist/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck preserves the missing-env error when .finalrun/config.yaml points to a missing env file', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'env: staging\n',
    envFiles: {
      'dev.yaml': '{}\n',
    },
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /Environment "staging" was not found .* Available environments: dev/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck requires app config in .finalrun/config.yaml', async () => {
  const rootDir = createTempWorkspace({
    configYaml: null,
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /\.finalrun\/config\.yaml must define app\.packageName and\/or app\.bundleId/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck accepts env app overrides and resolves the env-specific identifier', async () => {
  const rootDir = createTempWorkspace({
    configYaml: ['env: staging', 'app:', '  packageName: org.wikipedia'].join('\n'),
    envFiles: {
      'staging.yaml': ['app:', '  packageName: org.wikipedia.beta'].join('\n'),
    },
  });

  try {
    const result = await runCheck({ cwd: rootDir });
    assert.equal(result.environment.envName, 'staging');
    assert.equal(result.resolvedApp.platform, 'android');
    assert.equal(result.resolvedApp.identifier, 'org.wikipedia.beta');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck fails when both Android and iOS apps are configured without an explicit platform', async () => {
  const rootDir = createTempWorkspace({
    configYaml: [
      'app:',
      '  packageName: org.wikipedia',
      '  bundleId: org.wikipedia',
    ].join('\n'),
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /Both Android and iOS app identifiers are configured\. Pass --platform android or --platform ios\./,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck fails when the requested platform is missing from the app config', async () => {
  const rootDir = createTempWorkspace({
    configYaml: ['app:', '  packageName: org.wikipedia'].join('\n'),
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir, platform: 'ios' }),
      /No app config found for platform "ios"/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck fails when an iOS app override bundle ID does not match config', async () => {
  const rootDir = createTempWorkspace({
    includeEnvDir: false,
    configYaml: ['app:', '  bundleId: org.wikipedia'].join('\n'),
  });
  const appBundlePath = path.join(rootDir, 'Wikipedia.app');
  fs.mkdirSync(appBundlePath, { recursive: true });
  fs.writeFileSync(
    path.join(appBundlePath, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>CFBundleIdentifier</key>',
      '  <string>org.wikipedia.beta</string>',
      '</dict>',
      '</plist>',
    ].join('\n'),
    'utf-8',
  );

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir, appPath: appBundlePath }),
      /Configured iOS bundle ID is "org\.wikipedia", but the override app resolved to "org\.wikipedia\.beta"/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects nested app config and points to the flat schema', async () => {
  const rootDir = createTempWorkspace({
    configYaml: ['app:', '  android:', '    packageName: org.wikipedia'].join('\n'),
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /\.finalrun\/config\.yaml app uses an unsupported nested format\. Use app\.name, app\.packageName, and app\.bundleId\./,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects empty app identifiers in workspace config', async () => {
  const rootDir = createTempWorkspace({
    configYaml: ['app:', '  packageName: ""'].join('\n'),
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /\.finalrun\/config\.yaml app packageName must not be empty\./,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck treats env app config as a full replacement', async () => {
  const rootDir = createTempWorkspace({
    configYaml: ['env: staging', 'app:', '  packageName: org.wikipedia', '  bundleId: org.wikipedia.ios'].join('\n'),
    envFiles: {
      'staging.yaml': ['app:', '  packageName: org.wikipedia.beta'].join('\n'),
    },
  });

  try {
    const result = await runCheck({ cwd: rootDir });
    assert.equal(result.environment.envName, 'staging');
    assert.equal(result.resolvedApp.platform, 'android');
    assert.equal(result.resolvedApp.identifier, 'org.wikipedia.beta');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects tests with preconditions keys', async () => {
  const rootDir = createTempWorkspace({
    testFiles: {
      'login.yaml': [
        'name: login',
        'preconditions:',
        '  - App is installed.',
        'steps:',
        '  - Open the login screen.',
      ].join('\n'),
    },
  });

  try {
    await assert.rejects(
      () => runCheck({ envName: 'dev', cwd: rootDir }),
      /contains unsupported key "preconditions"/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck ignores invalid model formats in .finalrun/config.yaml', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'model: "not-a-provider-model"\n',
  });

  try {
    const result = await runCheck({ cwd: rootDir });
    assert.equal(result.environment.envName, 'dev');
    assert.equal(result.tests.length, 1);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck ignores unsupported model providers in .finalrun/config.yaml', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'model: "bedrock/claude"\n',
  });

  try {
    const result = await runCheck({ cwd: rootDir });
    assert.equal(result.environment.envName, 'dev');
    assert.equal(result.tests.length, 1);
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects invalid YAML in .finalrun/config.yaml', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'env: [dev\n',
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /Invalid YAML in .*\/\.finalrun\/config\.yaml:/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects unknown keys in .finalrun/config.yaml', async () => {
  const rootDir = createTempWorkspace({
    configYaml: ['env: dev', 'region: us-west-2'].join('\n'),
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /config\.yaml contains unsupported key "region"\. Supported keys: env, model, reasoning, features, app\./,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects non-string env values in .finalrun/config.yaml', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'env: 123\n',
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /config\.yaml env must be a string\./,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects non-string model values in .finalrun/config.yaml', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'model: 123\n',
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /config\.yaml model must be a string\./,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects empty env values in .finalrun/config.yaml', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'env: "   "\n',
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /config\.yaml env must not be empty\./,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects invalid reasoning level in .finalrun/config.yaml', async () => {
  const rootDir = createTempWorkspace({
    configYaml: 'reasoning: extreme\n',
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /config\.yaml reasoning has invalid value "extreme"\. Allowed values: minimal, low, medium, high\./,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects unknown feature names in .finalrun/config.yaml', async () => {
  const rootDir = createTempWorkspace({
    configYaml: ['features:', '  plannerX:', '    reasoning: high'].join('\n'),
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /features contains unsupported key "plannerX"\. Supported keys: planner, grounder, visual-grounder, scroll-index-grounder, input-focus-grounder, launch-app-grounder, set-location-grounder\./,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects unknown inner keys in a features override', async () => {
  const rootDir = createTempWorkspace({
    configYaml: ['features:', '  planner:', '    temperature: 0.2'].join('\n'),
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /features\.planner contains unsupported key "temperature"\. Supported keys: model, reasoning\./,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects invalid reasoning in a features override', async () => {
  const rootDir = createTempWorkspace({
    configYaml: ['features:', '  planner:', '    reasoning: extreme'].join('\n'),
  });

  try {
    await assert.rejects(
      () => runCheck({ cwd: rootDir }),
      /features\.planner\.reasoning has invalid value "extreme"\./,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck accepts a valid features block and preserves unset features', async () => {
  const rootDir = createTempWorkspace({
    configYaml: [
      'model: openai/gpt-5.4-mini',
      'reasoning: medium',
      'features:',
      '  planner:',
      '    model: anthropic/claude-opus-4-7',
      '    reasoning: high',
      '  scroll-index-grounder:',
      '    reasoning: low',
    ].join('\n'),
  });

  try {
    await assert.doesNotReject(() => runCheck({ cwd: rootDir }));
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck accepts empty-string secret environment values when the variable is present', async () => {
  const secretEnvVar = 'FINALRUN_EMPTY_SECRET';
  const previousSecret = process.env[secretEnvVar];
  process.env[secretEnvVar] = '';

  const rootDir = createTempWorkspace({
    envYaml: ['secrets:', `  otp: \${${secretEnvVar}}`].join('\n'),
    testFiles: {
      'otp.yaml': ['name: otp', 'steps:', '  - Enter ${secrets.otp}.'].join('\n'),
    },
  });

  try {
    const result = await runCheck({ envName: 'dev', cwd: rootDir });
    assert.equal(result.environment.bindings.secrets.otp, '');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
    if (previousSecret === undefined) {
      delete process.env[secretEnvVar];
    } else {
      process.env[secretEnvVar] = previousSecret;
    }
  }
});

test('runCheck resolves secrets from workspace-root .env.<env> without process.env', async () => {
  const secretEnvVar = 'FINALRUN_DOTENV_SECRET_BINDING_TEST';
  const previousSecret = process.env[secretEnvVar];
  delete process.env[secretEnvVar];

  const rootDir = createTempWorkspace({
    envYaml: ['secrets:', `  token: \${${secretEnvVar}}`].join('\n'),
    testFiles: {
      'auth.yaml': [
        'name: auth',
        'steps:',
        '  - Send ${secrets.token} to the API.',
      ].join('\n'),
    },
  });

  fs.writeFileSync(
    path.join(rootDir, '.env.dev'),
    `${secretEnvVar}=only-in-dotenv\n`,
    'utf-8',
  );

  try {
    const result = await runCheck({ envName: 'dev', cwd: rootDir });
    assert.equal(result.environment.bindings.secrets.token, 'only-in-dotenv');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
    if (previousSecret === undefined) {
      delete process.env[secretEnvVar];
    } else {
      process.env[secretEnvVar] = previousSecret;
    }
  }
});

test('runCheck loads workspace-root .env.<env> when cwd is nested under the workspace', async () => {
  const secretEnvVar = 'FINALRUN_DOTENV_NESTED_CWD_TEST';
  const previousSecret = process.env[secretEnvVar];
  delete process.env[secretEnvVar];

  const rootDir = createTempWorkspace({
    envYaml: ['secrets:', `  token: \${${secretEnvVar}}`].join('\n'),
    testFiles: {
      'auth.yaml': ['name: auth', 'steps:', '  - Open login.'].join('\n'),
    },
  });

  fs.writeFileSync(
    path.join(rootDir, '.env.dev'),
    `${secretEnvVar}=from-workspace-dotenv\n`,
    'utf-8',
  );

  try {
    const nestedCwd = path.join(rootDir, 'packages', 'app');
    fs.mkdirSync(nestedCwd, { recursive: true });

    const result = await runCheck({ envName: 'dev', cwd: nestedCwd });
    assert.equal(result.workspace.rootDir, rootDir);
    assert.equal(result.environment.bindings.secrets.token, 'from-workspace-dotenv');
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
    if (previousSecret === undefined) {
      delete process.env[secretEnvVar];
    } else {
      process.env[secretEnvVar] = previousSecret;
    }
  }
});

test('runCheck rejects selectors that escape .finalrun/tests', async () => {
  const rootDir = createTempWorkspace();

  try {
    await assert.rejects(
      () =>
        runCheck({
          envName: 'dev',
          cwd: rootDir,
          selectors: ['../outside.yaml'],
        }),
      /Test selector must stay inside/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck expands multiple selectors with comma splitting and de-duplicates first-seen matches', async () => {
  const rootDir = createTempWorkspace({
    testFiles: {
      'smoke.yaml': ['name: smoke', 'steps:', '  - Open the app.'].join('\n'),
      'auth/login.yaml': ['name: login', 'steps:', '  - Open login.'].join('\n'),
      'auth/settings.yaml': ['name: settings', 'steps:', '  - Open settings.'].join('\n'),
      'auth/profile/edit.yaml': ['name: edit', 'steps:', '  - Edit profile.'].join('\n'),
      'auth/profile/view.yaml': ['name: view', 'steps:', '  - View profile.'].join('\n'),
    },
  });

  try {
    const result = await runCheck({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['smoke.yaml,auth/login.yaml', 'auth/profile', 'auth/**'],
    });

    assert.deepEqual(
      result.tests.map((t) => t.relativePath),
      [
        'smoke.yaml',
        'auth/login.yaml',
        'auth/profile/edit.yaml',
        'auth/profile/view.yaml',
        'auth/settings.yaml',
      ],
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck treats raw directory selectors as recursive and * as shallow while ** is recursive', async () => {
  const rootDir = createTempWorkspace({
    testFiles: {
      'auth/login.yaml': ['name: login', 'steps:', '  - Open login.'].join('\n'),
      'auth/profile/edit.yaml': ['name: edit', 'steps:', '  - Edit profile.'].join('\n'),
      'auth/profile/view.yaml': ['name: view', 'steps:', '  - View profile.'].join('\n'),
      'auth/settings.yaml': ['name: settings', 'steps:', '  - Open settings.'].join('\n'),
    },
  });

  try {
    const recursiveDirectory = await runCheck({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['auth'],
    });
    const shallowGlob = await runCheck({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['auth/*'],
    });
    const recursiveGlob = await runCheck({
      envName: 'dev',
      cwd: rootDir,
      selectors: ['auth/**'],
    });

    assert.deepEqual(
      recursiveDirectory.tests.map((t) => t.relativePath),
      [
        'auth/login.yaml',
        'auth/profile/edit.yaml',
        'auth/profile/view.yaml',
        'auth/settings.yaml',
      ],
    );
    assert.deepEqual(
      shallowGlob.tests.map((t) => t.relativePath),
      ['auth/login.yaml', 'auth/settings.yaml'],
    );
    assert.deepEqual(
      recursiveGlob.tests.map((t) => t.relativePath),
      [
        'auth/login.yaml',
        'auth/profile/edit.yaml',
        'auth/profile/view.yaml',
        'auth/settings.yaml',
      ],
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck resolves suite manifests into an ordered shared test list', async () => {
  const rootDir = createTempWorkspace({
    testFiles: {
      'smoke.yaml': ['name: smoke', 'steps:', '  - Open the app.'].join('\n'),
      'auth/login.yaml': ['name: login', 'steps:', '  - Open login.'].join('\n'),
      'auth/settings.yaml': ['name: settings', 'steps:', '  - Open settings.'].join('\n'),
    },
    suites: {
      'login_suite.yaml': [
        'name: login suite',
        'description: Covers login entry points.',
        'tests:',
        '  - smoke.yaml',
        '  - auth/**',
      ].join('\n'),
    },
  });

  try {
    const result = await runCheck({
      envName: 'dev',
      cwd: rootDir,
      suitePath: 'login_suite.yaml',
    });

    assert.deepEqual(result.target, {
      type: 'suite',
      suiteId: 'login_suite',
      suiteName: 'login suite',
      suitePath: 'login_suite.yaml',
    });
    assert.equal(result.suite?.name, 'login suite');
    assert.equal(result.suite?.description, 'Covers login entry points.');
    assert.deepEqual(
      result.tests.map((t) => t.relativePath),
      ['smoke.yaml', 'auth/login.yaml', 'auth/settings.yaml'],
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects mixing --suite with positional selectors', async () => {
  const rootDir = createTempWorkspace({
    suites: {
      'login_suite.yaml': ['name: login suite', 'tests:', '  - login.yaml'].join('\n'),
    },
  });

  try {
    await assert.rejects(
      () =>
        runCheck({
          envName: 'dev',
          cwd: rootDir,
          suitePath: 'login_suite.yaml',
          selectors: ['login.yaml'],
        }),
      new RegExp(SUITE_SELECTOR_CONFLICT_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects suite manifests with empty tests arrays', async () => {
  const rootDir = createTempWorkspace({
    suites: {
      'empty_suite.yaml': ['name: empty suite', 'tests: []'].join('\n'),
    },
  });

  try {
    await assert.rejects(
      () =>
        runCheck({
          envName: 'dev',
          cwd: rootDir,
          suitePath: 'empty_suite.yaml',
        }),
      /must define a non-empty tests array/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects suite manifests with non-string descriptions', async () => {
  const rootDir = createTempWorkspace({
    suites: {
      'invalid_suite.yaml': [
        'name: invalid suite',
        'description: 42',
        'tests:',
        '  - login.yaml',
      ].join('\n'),
    },
  });

  try {
    await assert.rejects(
      () =>
        runCheck({
          envName: 'dev',
          cwd: rootDir,
          suitePath: 'invalid_suite.yaml',
        }),
      /description must be a string when provided/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck requires at least one selector when requireSelection is enabled', async () => {
  const rootDir = createTempWorkspace();

  try {
    await assert.rejects(
      () =>
        runCheck({
          envName: 'dev',
          cwd: rootDir,
          requireSelection: true,
        }),
      /At least one test selector is required/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('runCheck rejects tests with empty steps arrays', async () => {
  const rootDir = createTempWorkspace({
    testFiles: {
      'broken.yaml': ['name: broken', 'steps: []'].join('\n'),
    },
  });

  try {
    await assert.rejects(
      () => runCheck({ envName: 'dev', cwd: rootDir }),
      /must define a non-empty steps array/,
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('validateAppOverride accepts .apk and .app bundles and rejects unsupported paths', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-app-override-'));
  const apkPath = path.join(tempDir, 'app.apk');
  const apkDirPath = path.join(tempDir, 'fake.apk');
  const iosAppPath = path.join(tempDir, 'My.app');
  const zipPath = path.join(tempDir, 'archive.zip');

  fs.writeFileSync(apkPath, 'apk', 'utf-8');
  fs.mkdirSync(apkDirPath, { recursive: true });
  fs.mkdirSync(iosAppPath, { recursive: true });
  fs.writeFileSync(zipPath, 'zip', 'utf-8');

  try {
    const androidOverride = await validateAppOverride(apkPath, 'android');
    const iosOverride = await validateAppOverride(iosAppPath, 'ios');

    assert.equal(androidOverride.inferredPlatform, 'android');
    assert.equal(iosOverride.inferredPlatform, 'ios');

    await assert.rejects(
      () => validateAppOverride(zipPath),
      /Unsupported --app override/,
    );
    await assert.rejects(
      () => validateAppOverride(apkDirPath, 'android'),
      /must point to an APK file/,
    );
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test('ensureWorkspaceDirectories creates a hashed external artifacts directory and metadata', async () => {
  await withTempHome(async (homeDir) => {
    const rootDir = createTempWorkspace();

    try {
      const nestedCwd = path.join(rootDir, 'apps', 'mobile');
      fs.mkdirSync(nestedCwd, { recursive: true });

      const workspace = await resolveWorkspace(nestedCwd);
      const rootWorkspace = await resolveWorkspace(rootDir);
      await ensureWorkspaceDirectories(workspace);

      assert.equal(workspace.artifactsDir, rootWorkspace.artifactsDir);
      assert.equal(
        workspace.artifactsDir.startsWith(path.join(homeDir, '.finalrun', 'workspaces') + path.sep),
        true,
      );

      const artifactsStat = await fsp.stat(workspace.artifactsDir);
      assert.equal(artifactsStat.isDirectory(), true);

      const metadataPath = path.join(workspace.artifactsDir, '..', 'workspace.json');
      const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf-8')) as {
        workspaceRoot: string;
        canonicalWorkspaceRoot: string;
        workspaceHash: string;
        artifactsDir: string;
      };
      const canonicalRootDir = await fsp.realpath(rootDir);
      assert.equal(metadata.workspaceRoot, rootDir);
      assert.equal(metadata.canonicalWorkspaceRoot, canonicalRootDir);
      assert.equal(metadata.artifactsDir, workspace.artifactsDir);
      assert.equal(metadata.workspaceHash.length, 16);
    } finally {
      await fsp.rm(rootDir, { recursive: true, force: true });
    }
  });
});

test('resolveWorkspace refreshes lastUsedAt for direct callers', async () => {
  await withTempHome(async () => {
    const rootDir = createTempWorkspace();
    const existingLastUsedAt = '2020-01-01T00:00:00.000Z';

    try {
      const artifactsDir = await resolveWorkspaceArtifactsDir(rootDir);
      const metadataPath = path.join(artifactsDir, '..', 'workspace.json');
      await fsp.mkdir(path.dirname(metadataPath), { recursive: true });
      await fsp.writeFile(
        metadataPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            workspaceRoot: rootDir,
            canonicalWorkspaceRoot: await fsp.realpath(rootDir),
            workspaceHash: 'seeded-workspace-hash',
            artifactsDir,
            lastUsedAt: existingLastUsedAt,
          },
          null,
          2,
        ),
        'utf-8',
      );

      const workspace = await resolveWorkspace(rootDir);
      const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf-8')) as {
        lastUsedAt?: string;
      };

      assert.equal(workspace.rootDir, rootDir);
      assert.ok(Date.parse(metadata.lastUsedAt ?? '') > Date.parse(existingLastUsedAt));
    } finally {
      await fsp.rm(rootDir, { recursive: true, force: true });
    }
  });
});

test('resolveWorkspaceForCommand resolves an explicit workspace path, persists a derived display name, and refreshes lastUsedAt', async () => {
  await withTempHome(async () => {
    const rootDir = createTempWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-outside-workspace-'));
    const existingLastUsedAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(
      path.join(rootDir, 'package.json'),
      JSON.stringify({ name: 'sample/mobile-app' }, null, 2),
      'utf-8',
    );
    const nestedWorkspacePath = path.join(rootDir, 'packages', 'mobile');
    fs.mkdirSync(nestedWorkspacePath, { recursive: true });

    try {
      const seededWorkspace = await resolveWorkspace(rootDir);
      const metadataPath = path.join(seededWorkspace.artifactsDir, '..', 'workspace.json');
      await fsp.mkdir(path.dirname(metadataPath), { recursive: true });
      await fsp.writeFile(
        metadataPath,
        JSON.stringify(
          {
            schemaVersion: 1,
            workspaceRoot: rootDir,
            canonicalWorkspaceRoot: await fsp.realpath(rootDir),
            workspaceHash: 'seeded-workspace-hash',
            artifactsDir: seededWorkspace.artifactsDir,
            lastUsedAt: existingLastUsedAt,
          },
          null,
          2,
        ),
        'utf-8',
      );

      const workspace = await resolveWorkspaceForCommand({
        cwd: outsideDir,
        workspacePath: nestedWorkspacePath,
        io: {
          input: new PassThrough(),
          output: new PassThrough(),
          isTTY: false,
        },
      });

      assert.equal(workspace.rootDir, rootDir);
      const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf-8')) as {
        displayName?: string;
        lastUsedAt?: string;
      };
      assert.equal(metadata.displayName, 'sample/mobile-app');
      assert.match(metadata.lastUsedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(Date.parse(metadata.lastUsedAt ?? '') > Date.parse(existingLastUsedAt));
    } finally {
      await fsp.rm(rootDir, { recursive: true, force: true });
      await fsp.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test('resolveWorkspaceForCommand shows the TTY picker, ignores stale and malformed registry entries, and persists runtime-derived labels', async () => {
  await withTempHome(async () => {
    const alphaRoot = createTempWorkspace();
    const bravoRoot = createTempWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-picker-outside-'));
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = '';
    output.on('data', (chunk: Buffer | string) => {
      outputText += String(chunk);
    });

    fs.writeFileSync(
      path.join(alphaRoot, 'package.json'),
      JSON.stringify({ name: 'alpha/mobile-app' }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(bravoRoot, 'package.json'),
      JSON.stringify({ name: 'bravo/mobile-app' }, null, 2),
      'utf-8',
    );

    try {
      await ensureWorkspaceDirectories(await resolveWorkspaceFromPath(alphaRoot));
      await ensureWorkspaceDirectories(await resolveWorkspaceFromPath(bravoRoot));

      const staleMetadataDir = path.join(resolveWorkspaceArtifactsRootDir(), 'stale-workspace');
      await fsp.mkdir(staleMetadataDir, { recursive: true });
      await fsp.writeFile(
        path.join(staleMetadataDir, 'workspace.json'),
        JSON.stringify({
          schemaVersion: 1,
          workspaceRoot: path.join(outsideDir, 'missing-workspace'),
          canonicalWorkspaceRoot: path.join(outsideDir, 'missing-workspace'),
          workspaceHash: 'stale-workspace',
          artifactsDir: path.join(staleMetadataDir, 'artifacts'),
        }),
        'utf-8',
      );

      const malformedMetadataDir = path.join(resolveWorkspaceArtifactsRootDir(), 'malformed-workspace');
      await fsp.mkdir(malformedMetadataDir, { recursive: true });
      await fsp.writeFile(
        path.join(malformedMetadataDir, 'workspace.json'),
        JSON.stringify({
          schemaVersion: 1,
          workspaceRoot: 42,
          canonicalWorkspaceRoot: bravoRoot,
          workspaceHash: 'malformed-workspace',
          artifactsDir: path.join(malformedMetadataDir, 'artifacts'),
        }),
        'utf-8',
      );

      input.write('0\n');
      setTimeout(() => {
        input.write('2\n');
        input.end();
      }, 25);

      const selectedWorkspace = await resolveWorkspaceForCommand({
        cwd: outsideDir,
        io: {
          input,
          output,
          isTTY: true,
        },
      });

      assert.equal(selectedWorkspace.rootDir, bravoRoot);
      assert.match(outputText, /Select a FinalRun workspace/);
      assert.match(outputText, /1\. alpha\/mobile-app/);
      assert.match(outputText, new RegExp(alphaRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(outputText, /2\. bravo\/mobile-app/);
      assert.match(outputText, /Invalid selection/);
      assert.doesNotMatch(outputText, /stale-workspace/);

      const alphaMetadata = JSON.parse(
        await fsp.readFile(path.join(await resolveWorkspaceArtifactsDir(alphaRoot), '..', 'workspace.json'), 'utf-8'),
      ) as { displayName?: string };
      const bravoMetadata = JSON.parse(
        await fsp.readFile(path.join(await resolveWorkspaceArtifactsDir(bravoRoot), '..', 'workspace.json'), 'utf-8'),
      ) as { displayName?: string };
      assert.equal(alphaMetadata.displayName, 'alpha/mobile-app');
      assert.equal(bravoMetadata.displayName, 'bravo/mobile-app');
    } finally {
      await fsp.rm(alphaRoot, { recursive: true, force: true });
      await fsp.rm(bravoRoot, { recursive: true, force: true });
      await fsp.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test('resolveWorkspaceForCommand fails with guidance outside a workspace when no TTY or explicit workspace is available', async () => {
  await withTempHome(async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-missing-workspace-'));

    try {
      await assert.rejects(
        () =>
          resolveWorkspaceForCommand({
            cwd: outsideDir,
            io: {
              input: new PassThrough(),
              output: new PassThrough(),
              isTTY: false,
            },
          }),
        /Pass --workspace <path> to target a FinalRun workspace explicitly/,
      );
    } finally {
      await fsp.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test('resolveWorkspaceFromPath reports a clear error for invalid explicit workspace paths', async () => {
  await withTempHome(async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-invalid-workspace-'));

    try {
      await assert.rejects(
        () =>
          resolveWorkspaceForCommand({
            cwd: outsideDir,
            workspacePath: path.join(outsideDir, 'missing'),
            io: {
              input: new PassThrough(),
              output: new PassThrough(),
              isTTY: false,
            },
          }),
        /Path is not inside a FinalRun workspace/,
      );
    } finally {
      await fsp.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
