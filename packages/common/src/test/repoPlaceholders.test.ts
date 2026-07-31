import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeBindings } from '../models/Environment.js';
import { redactResolvedValue } from '../repoPlaceholders.js';

function bindings(secrets: Record<string, string>): RuntimeBindings {
  return { secrets, variables: {} };
}

test('redactResolvedValue keeps an existing placeholder token intact when a secret value equals its own key name', () => {
  // Regression (unanchored-match corruption): the value alternative used to
  // match PASSWORD inside the literal ${secrets.PASSWORD} token, producing
  // the nested, invalid ${secrets.${secrets.PASSWORD}}.
  const redacted = redactResolvedValue(
    'Use ${secrets.PASSWORD} then type PASSWORD manually',
    bindings({ PASSWORD: 'PASSWORD' }),
  );

  assert.equal(redacted, 'Use ${secrets.PASSWORD} then type ${secrets.PASSWORD} manually');
});

test('redactResolvedValue leaves prose unchanged for a single-character secret value', () => {
  // Regression (prose destruction): a 1-char value used to rewrite every
  // occurrence of that character, mangling the entire string.
  const redacted = redactResolvedValue('assemble the secrets list', bindings({ TOKEN: 's' }));

  assert.equal(redacted, 'assemble the secrets list');
});

test('redactResolvedValue leaves prose unchanged for a two-character secret value that is a substring of it', () => {
  const redacted = redactResolvedValue('these tests pass', bindings({ AB: 'es' }));

  assert.equal(redacted, 'these tests pass');
});

test('redactResolvedValue still redacts a secret embedded in concatenated text', () => {
  // Pins the deliberate absence of word-boundary anchoring: anchors would
  // miss embedded values like this one and leak them.
  const redacted = redactResolvedValue('x=zabcd1234q', bindings({ KEY: 'abcd1234' }));

  assert.equal(redacted, 'x=z${secrets.KEY}q');
});

test('redactResolvedValue token protection composes with longest-value-first overlap ordering', () => {
  // The ${secrets.abc} token is discriminating: its interior contains the
  // overlapping value abc, so the pre-fix implementation (no token branch)
  // nests it into ${secrets.${secrets.short}} and fails this case.
  const redacted = redactResolvedValue(
    'keep ${secrets.abc} primary=abcd secondary=abc',
    bindings({ short: 'abc', long: 'abcd' }),
  );

  assert.equal(
    redacted,
    'keep ${secrets.abc} primary=${secrets.long} secondary=${secrets.short}',
  );
});

test('redactResolvedValue redacts a secret value that begins with a literal placeholder token', () => {
  // Regression (token-FIRST leak): with the token alternative as the first
  // branch, ${secrets.BAR} was consumed as token protection before the value
  // alternative could match, leaving the raw hunter2 tail in the output. The
  // token branch is last so the value alternative wins at the $ position.
  const redacted = redactResolvedValue(
    'creds=${secrets.BAR}hunter2 end',
    bindings({ FOO: '${secrets.BAR}hunter2' }),
  );

  assert.equal(redacted, 'creds=${secrets.FOO} end');
});
