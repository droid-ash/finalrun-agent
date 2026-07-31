import type { RuntimeBindings } from './models/Environment.js';

const PLACEHOLDER_PATTERN = /\$\{(variables|secrets)\.([A-Za-z0-9_-]+)\}/g;

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
    .filter(([, secretValue]) => Boolean(secretValue))
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

  const secretPattern = new RegExp(
    replacements
      .map(([, secretValue]) => escapeRegExp(secretValue))
      .join('|'),
    'g',
  );

  return value.replace(secretPattern, (match) => {
    return placeholderBySecretValue.get(match) ?? match;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
