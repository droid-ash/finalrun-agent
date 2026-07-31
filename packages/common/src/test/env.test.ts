import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliEnv, parseModel, parseReasoningLevel } from '../env.js';

/** Create a temp directory containing the given dotenv files. */
function createTempDotEnvDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finalrun-clienv-'));
  for (const [fileName, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, fileName), contents, 'utf-8');
  }
  return dir;
}

test('CliEnv.load: .env.<env> wins over plain .env for shared keys; both files contribute', () => {
  const dir = createTempDotEnvDir({
    '.env.dev': ['SHARED=from-env-dev', 'ONLY_DEV=dev-value'].join('\n'),
    '.env': ['SHARED=from-plain', 'ONLY_PLAIN=plain-value'].join('\n'),
  });

  try {
    const env = new CliEnv();
    env.load('dev', { cwd: dir, processEnv: {} });
    assert.equal(env.get('SHARED'), 'from-env-dev');
    assert.equal(env.get('ONLY_DEV'), 'dev-value');
    assert.equal(env.get('ONLY_PLAIN'), 'plain-value');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliEnv.load: process env takes highest precedence over both .env files', () => {
  const dir = createTempDotEnvDir({
    '.env.dev': 'SHARED=from-env-dev\n',
    '.env': 'SHARED=from-plain\n',
  });

  try {
    const env = new CliEnv();
    env.load('dev', { cwd: dir, processEnv: { SHARED: 'from-process' } });
    assert.equal(env.get('SHARED'), 'from-process');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliEnv.load: plain .env is loaded even when no envName is given', () => {
  const dir = createTempDotEnvDir({
    '.env.dev': 'ONLY_DEV=dev-value\n',
    '.env': 'ONLY_PLAIN=plain-value\n',
  });

  try {
    const env = new CliEnv();
    env.load(undefined, { cwd: dir, processEnv: {} });
    assert.equal(env.get('ONLY_PLAIN'), 'plain-value');
    assert.equal(env.get('ONLY_DEV'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliEnv.load: includeDotEnv false skips both .env files but keeps process env', () => {
  const dir = createTempDotEnvDir({
    '.env.dev': 'ONLY_DEV=dev-value\n',
    '.env': 'ONLY_PLAIN=plain-value\n',
  });

  try {
    const env = new CliEnv();
    env.load('dev', { cwd: dir, includeDotEnv: false, processEnv: { FROM_PROCESS: 'yes' } });
    assert.equal(env.get('ONLY_DEV'), undefined);
    assert.equal(env.get('ONLY_PLAIN'), undefined);
    assert.equal(env.get('FROM_PROCESS'), 'yes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseModel requires an explicit model value', () => {
  assert.throws(
    () => parseModel(undefined),
    /--model is required\. Use provider\/model, for example google\/gemini-3-flash-preview\. Supported providers: openai, google, anthropic\./,
  );
});

test('parseModel trims outer whitespace before validation', () => {
  assert.deepEqual(parseModel('  google/gemini-3-flash-preview  '), {
    provider: 'google',
    modelName: 'gemini-3-flash-preview',
  });
});

test('parseModel rejects malformed values without a slash', () => {
  assert.throws(
    () => parseModel('openai'),
    /Invalid model format: "openai"\. Expected provider\/model with non-empty provider and model name\. Supported providers: openai, google, anthropic\./,
  );
});

test('parseModel rejects an empty provider segment', () => {
  assert.throws(
    () => parseModel('/gpt-5.4-mini'),
    /Invalid model format: "\/gpt-5.4-mini"\. Expected provider\/model with non-empty provider and model name\. Supported providers: openai, google, anthropic\./,
  );
});

test('parseModel rejects an empty model segment', () => {
  assert.throws(
    () => parseModel('openai/'),
    /Invalid model format: "openai\/"\. Expected provider\/model with non-empty provider and model name\. Supported providers: openai, google, anthropic\./,
  );
});

test('parseModel rejects unsupported providers', () => {
  assert.throws(
    () => parseModel('bedrock/claude'),
    /Unsupported AI provider: "bedrock"\. Supported providers: openai, google, anthropic\./,
  );
});

test('parseModel prefixes errors with the provided label for context', () => {
  // Trailing whitespace after the slash collapses under the outer trim, so
  // the echoed value is "openai/" (empty model half) and the label prefix
  // points the user at the exact config entry that tripped validation.
  assert.throws(
    () => parseModel('openai/ ', 'features.planner.model'),
    /features\.planner\.model has invalid model format: "openai\/"\./,
  );
  assert.throws(
    () => parseModel('bedrock/claude', 'features.planner.model'),
    /features\.planner\.model has unsupported AI provider: "bedrock"\./,
  );
  // Sanity: omitting the label keeps the pre-existing CLI-style error text
  // that other tests (and --model users) depend on.
  assert.throws(
    () => parseModel(undefined),
    /--model is required\./,
  );
});

test('parseReasoningLevel returns undefined when unset', () => {
  assert.equal(parseReasoningLevel(undefined, 'reasoning'), undefined);
  assert.equal(parseReasoningLevel(null, 'reasoning'), undefined);
  assert.equal(parseReasoningLevel('', 'reasoning'), undefined);
});

test('parseReasoningLevel accepts minimal, low, medium, high', () => {
  for (const value of ['minimal', 'low', 'medium', 'high']) {
    assert.equal(parseReasoningLevel(value, 'reasoning'), value);
  }
});

test('parseReasoningLevel trims surrounding whitespace', () => {
  assert.equal(parseReasoningLevel('  high  ', 'reasoning'), 'high');
});

test('parseReasoningLevel rejects non-string values with a labeled error', () => {
  assert.throws(
    () => parseReasoningLevel(42, 'config.yaml reasoning'),
    /config\.yaml reasoning must be a string\. Allowed values: minimal, low, medium, high\./,
  );
});

test('parseReasoningLevel rejects unknown values with a labeled error', () => {
  assert.throws(
    () => parseReasoningLevel('extreme', 'config.yaml reasoning'),
    /config\.yaml reasoning has invalid value "extreme"\. Allowed values: minimal, low, medium, high\./,
  );
});

// Pinning tests appended by change 260731-65sg (env structural refactor pilot).
// They pin behavior the pre-existing suite left uncovered, so the refactor's
// no-behavior-change invariant is checked by tests rather than by inspection.

test('CliEnv.getRequired throws when the key is absent', () => {
  const env = new CliEnv();
  env.load(undefined, { includeDotEnv: false, processEnv: {} });
  assert.throws(
    () => env.getRequired('NOT_SET'),
    /^Error: Missing required environment variable: NOT_SET$/,
  );
});

test('CliEnv.getRequired treats an empty-string value as missing', () => {
  // Pins the falsy check (`if (!value)`) — an empty string throws exactly
  // like an absent key, rather than being returned.
  const env = new CliEnv();
  env.load(undefined, { includeDotEnv: false, processEnv: { EMPTY: '' } });
  assert.equal(env.get('EMPTY'), '');
  assert.throws(
    () => env.getRequired('EMPTY'),
    /^Error: Missing required environment variable: EMPTY$/,
  );
});

test('CliEnv.getRequired returns a present non-empty value', () => {
  const env = new CliEnv();
  env.load(undefined, { includeDotEnv: false, processEnv: { PRESENT: 'value' } });
  assert.equal(env.getRequired('PRESENT'), 'value');
});

test('CliEnv.load: explicitly passing includeDotEnv undefined still loads .env files', () => {
  // Pins the `options?.includeDotEnv !== false` default — only a literal
  // `false` opts out; an explicit `undefined` behaves like the default.
  const dir = createTempDotEnvDir({
    '.env.dev': 'ONLY_DEV=dev-value\n',
    '.env': 'ONLY_PLAIN=plain-value\n',
  });

  try {
    const env = new CliEnv();
    env.load('dev', { includeDotEnv: undefined, cwd: dir, processEnv: {} });
    assert.equal(env.get('ONLY_DEV'), 'dev-value');
    assert.equal(env.get('ONLY_PLAIN'), 'plain-value');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CliEnv.set followed by get round-trips a programmatic value', () => {
  const env = new CliEnv();
  env.load(undefined, { includeDotEnv: false, processEnv: {} });
  env.set('FROM_CLI', 'cli-value');
  assert.equal(env.get('FROM_CLI'), 'cli-value');
  assert.equal(env.getRequired('FROM_CLI'), 'cli-value');
});
