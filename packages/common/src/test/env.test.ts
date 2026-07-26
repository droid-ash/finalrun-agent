import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModel, parseReasoningLevel } from '../env.js';

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
