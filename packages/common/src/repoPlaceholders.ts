import type { RuntimeBindings } from './models/Environment.js';

const PLACEHOLDER_PATTERN = /\$\{(variables|secrets)\.([A-Za-z0-9_-]+)\}/g;

// Non-capturing mirror of PLACEHOLDER_PATTERN above, used as the final branch
// of redactResolvedValue's alternation. Keep the two in sync by hand rather
// than deriving this from PLACEHOLDER_PATTERN.source: that pattern's capture
// groups happen to be harmless today (the replacer ignores its group
// arguments), but splicing capturing groups into a composed alternation
// shifts group numbering for any future branch that does capture.
const PLACEHOLDER_TOKEN_ALTERNATIVE = '\\$\\{(?:variables|secrets)\\.[A-Za-z0-9_-]+\\}';

export function resolveRuntimePlaceholders(
  value: string,
  bindings: RuntimeBindings,
): string {
  return value.replace(
    PLACEHOLDER_PATTERN,
    (_match, namespace: string, key: string) => {
      if (namespace === 'variables') {
        const variableValue = bindings.variables[key];
        return variableValue === undefined ? `\${${namespace}.${key}}` : String(variableValue);
      }

      const secretValue = bindings.secrets[key];
      return secretValue === undefined ? `\${${namespace}.${key}}` : secretValue;
    },
  );
}

export function containsSecretPlaceholder(value: string): boolean {
  return /\$\{secrets\.[A-Za-z0-9_-]+\}/.test(value);
}

// A 1-2 character secret value collides with ordinary text near-certainly, so
// substituting it corrupts arbitrary strings. Values below this length are
// therefore never redacted anywhere — the accepted trade is that such short
// secret values reach prompts, report artifacts, spans, and error strings raw.
// 3 is the largest threshold that leaves the pinned overlap-ordering fixture
// (3-char 'abc' in packages/cli/src/test/testRunner.test.ts) untouched.
const MIN_REDACTABLE_SECRET_LENGTH = 3;

export function redactResolvedValue(
  value: string | undefined,
  bindings: RuntimeBindings,
): string | undefined {
  if (!value) {
    return value;
  }

  // Substring-leak guard: the sort is longest value first, and that order is
  // load-bearing. All secret values are matched by the single regex alternation
  // built below in this order, so when one secret's value is a substring of
  // another's the longer secret wins the match. Alternating shorter-first would
  // match the short value inside the longer one's occurrence, leaving the rest
  // of the longer secret unredacted in the output.
  const replacements = Object.entries(bindings.secrets)
    .filter(
      ([, secretValue]) =>
        Boolean(secretValue) && secretValue.length >= MIN_REDACTABLE_SECRET_LENGTH,
    )
    .sort(([, left], [, right]) => right.length - left.length);
  if (replacements.length === 0) {
    return value;
  }

  const placeholderBySecretValue = new Map<string, string>();
  for (const [key, secretValue] of replacements) {
    if (!placeholderBySecretValue.has(secretValue)) {
      placeholderBySecretValue.set(secretValue, `\${secrets.${key}}`);
    }
  }

  // The placeholder-token alternative is deliberately the LAST branch: every
  // secret-value alternative (longest first) is tried before it at each
  // position, so a secret-value occurrence always wins over token protection
  // when both match at the same position — leak-safety over token cosmetics.
  // Token-first would preempt a value that BEGINS with a literal token (e.g.
  // value ${secrets.BAR}hunter2), leaving its raw tail in the output. Token
  // protection still holds where it matters: a value occurring strictly
  // INSIDE a token (e.g. value PASSWORD inside ${secrets.PASSWORD}, common in
  // testObjective and report text) cannot match at the token's start
  // position, so absent a value match there the token branch consumes the
  // token whole and its interior is never exposed to the value alternatives —
  // no nested, invalid token. Accepted edges: a secret whose value is EXACTLY
  // a well-formed token is matched by its own value alternative and rewritten
  // placeholder-to-placeholder via the map — harmless (nothing raw on either
  // side) and identical to pre-change behavior; consequently a token matched
  // by the token branch matches no secret value, so the replacer's `?? match`
  // passes it through verbatim. Value matching stays UNANCHORED on purpose:
  // word boundaries would miss a secret embedded in concatenated text
  // (user=xabcd1234y), the same leak class the sort order above guards
  // against. Residual: a value >= 3 chars that is a common substring of prose
  // still rewrites that prose.
  const secretPattern = new RegExp(
    [
      ...replacements.map(([, secretValue]) => escapeRegExp(secretValue)),
      PLACEHOLDER_TOKEN_ALTERNATIVE,
    ].join('|'),
    'g',
  );

  return value.replace(secretPattern, (match) => {
    return placeholderBySecretValue.get(match) ?? match;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
