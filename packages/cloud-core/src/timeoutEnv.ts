/**
 * Reads a millisecond timeout override from the environment.
 *
 * Returns `defaultMs` when `envVar` is unset or empty. Otherwise the parsed
 * value must be a positive integer, and the thrown message is the authoritative
 * statement of that contract — it is the only documentation a user of the
 * variable gets, so the guard must not be looser than its own wording.
 *
 * The check tests the parsed **value**, never the literal's spelling:
 * `Number.isInteger` also rejects `NaN` and `±Infinity` (so no separate
 * finiteness clause is needed), while `'1e3'` and `'0x10'` stay accepted as the
 * integers 1000 and 16 and `'1.5'` is rejected. A string-format regex would
 * reject integral spellings the message never promises to reject.
 *
 * This lives in one place because it did not: `submit.ts` was corrected to
 * `Number.isInteger` and `upload.ts` kept a `Number.isFinite` copy, so the
 * upload variable accepted a fractional millisecond while telling the caller it
 * could not. One definition is what makes the two unable to drift again.
 */
export function parseTimeoutMsFromEnv(envVar: string, defaultMs: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return defaultMs;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${envVar}=${JSON.stringify(raw)}: must be a positive integer (milliseconds).`,
    );
  }
  return parsed;
}
