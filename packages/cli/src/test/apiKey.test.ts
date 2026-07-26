import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliEnv } from '@finalrun/common';
import { resolveApiKey, resolveApiKeys } from '../apiKey.js';

function createEnv(values: Record<string, string>) {
  return {
    get(key: string): string | undefined {
      return values[key];
    },
  };
}

test('resolveApiKey prefers the env var that matches the selected provider', () => {
  const apiKey = resolveApiKey({
    env: createEnv({
      OPENAI_API_KEY: 'openai-key',
      GOOGLE_API_KEY: 'google-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
    }),
    provider: 'google',
  });

  assert.equal(apiKey, 'google-key');
});

test('resolveApiKey lets --api-key override environment variables', () => {
  const apiKey = resolveApiKey({
    env: createEnv({
      GOOGLE_API_KEY: 'google-key',
    }),
    provider: 'google',
    providedApiKey: 'flag-key',
  });

  assert.equal(apiKey, 'flag-key');
});

test('resolveApiKey reads provider-specific env vars loaded from .env and .env.<env>', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-api-key-env-files-'));
  const env = new CliEnv();

  try {
    await fsp.writeFile(path.join(rootDir, '.env'), 'OPENAI_API_KEY=base-key\n', 'utf-8');
    await fsp.writeFile(path.join(rootDir, '.env.dev'), 'OPENAI_API_KEY=dev-key\n', 'utf-8');

    env.load('dev', {
      cwd: rootDir,
      processEnv: {},
    });

    assert.equal(
      resolveApiKey({
        env,
        provider: 'openai',
      }),
      'dev-key',
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('resolveApiKey prefers process env over .env files for the selected provider', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-api-key-process-env-'));
  const env = new CliEnv();

  try {
    await fsp.writeFile(path.join(rootDir, '.env'), 'GOOGLE_API_KEY=file-key\n', 'utf-8');

    env.load(undefined, {
      cwd: rootDir,
      processEnv: {
        GOOGLE_API_KEY: 'process-key',
      },
    });

    assert.equal(
      resolveApiKey({
        env,
        provider: 'google',
      }),
      'process-key',
    );
  } finally {
    await fsp.rm(rootDir, { recursive: true, force: true });
  }
});

test('resolveApiKey no longer accepts API_KEY as a shared fallback', () => {
  assert.throws(
    () =>
      resolveApiKey({
        env: createEnv({
          API_KEY: 'shared-key',
        }),
        provider: 'anthropic',
      }),
    /Provide via --api-key or ANTHROPIC_API_KEY/,
  );
});

test('resolveApiKey reports the provider-matched env var in its error message', () => {
  assert.throws(
    () =>
      resolveApiKey({
        env: createEnv({}),
        provider: 'google',
      }),
    /Provide via --api-key or GOOGLE_API_KEY/,
  );
});

test('resolveApiKeys returns a per-provider map from env vars', () => {
  const env = createEnv({
    OPENAI_API_KEY: 'openai-key',
    GOOGLE_API_KEY: 'google-key',
    ANTHROPIC_API_KEY: 'anthropic-key',
  });

  const keys = resolveApiKeys({
    env,
    providers: new Set(['openai', 'google']),
  });

  assert.deepEqual(keys, {
    openai: 'openai-key',
    google: 'google-key',
  });
});

test('resolveApiKeys routes --api-key to the single active provider', () => {
  const keys = resolveApiKeys({
    env: createEnv({}),
    providers: ['openai'],
    providedApiKey: 'flag-key',
  });

  assert.deepEqual(keys, { openai: 'flag-key' });
});

test('resolveApiKeys treats empty --api-key as unset and falls through to env vars', () => {
  const keys = resolveApiKeys({
    env: createEnv({ OPENAI_API_KEY: 'env-key' }),
    providers: ['openai'],
    providedApiKey: '',
  });

  assert.deepEqual(keys, { openai: 'env-key' });
});

test('resolveApiKeys rejects --api-key when multiple providers are configured', () => {
  assert.throws(
    () =>
      resolveApiKeys({
        env: createEnv({}),
        providers: ['openai', 'anthropic'],
        providedApiKey: 'flag-key',
      }),
    /--api-key is only valid when a single provider is active/,
  );
});

test('resolveApiKeys aggregates missing provider errors into one message', () => {
  assert.throws(
    () =>
      resolveApiKeys({
        env: createEnv({ OPENAI_API_KEY: 'openai-key' }),
        providers: ['openai', 'google', 'anthropic'],
      }),
    /google \(GOOGLE_API_KEY\), anthropic \(ANTHROPIC_API_KEY\)/,
  );
});
