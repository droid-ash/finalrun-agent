---
type: memory
description: "`CliEnv` environment loading (`packages/common/src/env.ts`): `load` layers `.env.<envName>` → plain `.env` (fill-only) → OS env (highest precedence), `includeDotEnv` opts out only on a literal `false`, and `getRequired`'s falsy check makes an empty string as missing as an absent key. Model and reasoning-level validation live in `constants.ts` beside their level lists, while `env.ts`'s re-export block is a deliberate backward-compat shim for the one import path that still routes through it."
---
# CLI Environment Loading (common)

**Domain**: common

## Overview

`packages/common/src/env.ts` holds `CliEnv`, the CLI's environment value store: `load` merges
dotenv files and the OS environment into one `Map`, and `get` / `getRequired` / `set` read and
write it. Production consumers import only `CliEnv` from `env.js` — `checkRunner.ts:4`,
`testLoader.ts:14`, and the package root at `index.ts:114`. The loader's precedence order and its
two falsy-value traps are pinned by nine `CliEnv` tests in
`packages/common/src/test/env.test.ts` (21 tests in that file, 128 in the package).

## Requirements

### Requirement: `load` applies three layers in a fixed order
`CliEnv.load(envName?, options?)` MUST clear the value map, then apply exactly these layers in
order:

1. `.env.<envName>` — only when `envName` is given, merged with `keepExisting: false` so it wins
   over nothing yet and sets every key it carries.
2. Plain `.env` — merged with `keepExisting: true`, so it fills **only** keys layer 1 did not set.
3. The OS environment (`options?.processEnv ?? process.env`) — every non-`undefined` value
   overwrites whatever the files set.

Dotenv paths resolve against `options?.cwd ?? process.cwd()`, and a file that does not exist MUST
be skipped silently (`fs.existsSync` guard in `_mergeDotEnvFile`) rather than throwing.

#### Scenario: the environment-specific file wins a shared key
- **GIVEN** a directory holding `.env.dev` with `SHARED=from-env-dev` and `.env` with `SHARED=from-plain`
- **WHEN** `load('dev', { cwd: dir, processEnv: {} })` runs
- **THEN** `SHARED` is `from-env-dev`, and keys unique to either file are both present

#### Scenario: the OS environment outranks both files
- **GIVEN** the same two files, and `processEnv` carrying the same key
- **WHEN** `load` runs
- **THEN** the `processEnv` value wins

#### Scenario: plain `.env` loads with no envName
- **GIVEN** no `envName` argument
- **WHEN** `load(undefined, { cwd: dir })` runs
- **THEN** layer 1 is skipped and plain `.env` still contributes every key it carries

### Requirement: `includeDotEnv` opts out only on a literal `false`
The guard is `options?.includeDotEnv !== false`. An absent option **and an explicitly passed
`undefined`** MUST both still load both dotenv files; only `includeDotEnv: false` skips them, and
even then layer 3 (the OS environment) still applies.

#### Scenario: an explicit `undefined` behaves like the default
- **GIVEN** `.env.dev` and `.env` in the working directory
- **WHEN** `load('dev', { includeDotEnv: undefined, cwd: dir, processEnv: {} })` runs
- **THEN** keys from both files are present

### Requirement: `getRequired` treats every falsy value as missing
`getRequired(key)` MUST throw `Missing required environment variable: ${key}` whenever the stored
value is falsy. The check is `if (!value)`, **not** `=== undefined`, so a key whose value is the
empty string throws exactly like an absent key — even though `get(key)` returns `''` for it.
`set(key, value)` writes into the same map, so a programmatically set value is visible to both
`get` and `getRequired`.

#### Scenario: an empty string is as missing as an absent key
- **GIVEN** `load(undefined, { includeDotEnv: false, processEnv: { EMPTY: '' } })`
- **WHEN** `getRequired('EMPTY')` is called
- **THEN** it throws `Missing required environment variable: EMPTY`, while `get('EMPTY')` returns `''`

### Requirement: model and reasoning-level validation lives in `constants.ts`
`REASONING_LEVELS_LABEL` and `parseReasoningLevel` live in `packages/common/src/constants.ts`
immediately after the `REASONING_LEVELS` / `ReasoningLevel` block, mirroring
`SUPPORTED_AI_PROVIDERS_LABEL` / `parseModel` beside `SUPPORTED_AI_PROVIDERS`. In-package
consumers import from `./constants.js` (`workspace.ts:18`, used at `workspace.ts:456` and `:485`),
and the symbols reach the package root through `index.ts:94`'s `export * from './constants.js'` —
so `index.ts:114` exports only `CliEnv` from `./env.js`.

`parseReasoningLevel(value, label)` MUST return `undefined` for `undefined`, `null`, or a
whitespace-only string; MUST throw ``${label} must be a string. Allowed values: minimal, low,
medium, high.`` for a non-string; and MUST throw ``${label} has invalid value "${trimmed}".
Allowed values: minimal, low, medium, high.`` for an unrecognized value. Callers (config-file and
CLI validation in `workspace.ts`) depend on those exact strings.

### Requirement: `env.ts` keeps a byte-compatible export surface
`env.ts` MUST keep re-exporting `MODEL_FORMAT_EXAMPLE`, `PROVIDER_ENV_VARS`,
`REASONING_LEVELS_LABEL`, `SUPPORTED_AI_PROVIDERS`, `SUPPORTED_AI_PROVIDERS_LABEL`, `parseModel`,
`parseReasoningLevel`, `ParsedModel`, and `SupportedProvider` from `./constants.js`, so every
symbol importable from `env.js` resolves to the same binding `constants.js` exports. The one place
in the repo that reaches these symbols through `env.js` is `env.test.ts:6`
(`parseModel`, `parseReasoningLevel`); no production module does.

## Design Decisions

### Reasoning-level validation lives beside its level list, not in the env loader
**Decision**: `REASONING_LEVELS_LABEL` and `parseReasoningLevel` sit in `constants.ts` directly
after `REASONING_LEVELS`, and consumers that validate config or CLI values import them from
`./constants.js`.
**Why**: A validator's home is beside the list it validates against — `parseModel` and
`SUPPORTED_AI_PROVIDERS_LABEL` already sit beside `SUPPORTED_AI_PROVIDERS` in the same file, so
this is the file's existing convention rather than a new one. Placing them in `env.ts` makes the
module graph lie about ownership: a reader looking for reasoning-level validation finds it in the
dotenv loader, and `workspace.ts` imports config validation *through* the environment module,
which has nothing to do with either. The env module's own subject is `CliEnv`.
**Rejected**: leaving the helpers in `env.ts` and treating the import path as harmless — the
misplacement is what invites the next symbol to be added there too, deepening a false coupling to
the env module that no consumer actually needs.
*Introduced by*: 260731-65sg-env-structural-refactor-pilot

### The `env.js` re-export block is a shim, kept for one import line
**Decision**: `env.ts` keeps a full re-export block for the nine `constants.js` symbols and
carries a comment naming it a backward-compatibility shim. The block retains all nine symbols even
though no production module imports through it.
**Why**: `env.test.ts:6` imports `parseModel` and `parseReasoningLevel` from `../env.js`, and the
re-export is what keeps that import path resolving — the shim exists for consumer compatibility with
the one line in the repo that still reaches these symbols through `env.js`. Keeping the block
also makes `env.js`'s export surface independent of where the validators are defined, which is what
lets a move like this one claim zero observable behavior change. The block's justification is exactly
that one import line: no production module imports anything but `CliEnv` from `env.js`, and
`MODEL_FORMAT_EXAMPLE`, `PROVIDER_ENV_VARS`, `SUPPORTED_AI_PROVIDERS`,
`SUPPORTED_AI_PROVIDERS_LABEL`, `ParsedModel`, and `SupportedProvider` have no `env.js` consumer
anywhere in the repo.
**Rejected**: (a) deleting the barrel and repointing `env.test.ts`'s import at `../constants.js` —
an edit the constitution's Test Integrity rule permits (it allows updating a test to match the spec,
and prohibits only reshaping *implementation* to suit test infrastructure), but one that narrows
`env.js`'s export surface for no consumer's benefit, and that surface stability is what makes the
move's zero-observable-change claim checkable; (b) leaving a duplicate definition in `env.ts` so
the package root's export set stays literally identical — two definitions of the same validator is
exactly the drift a single home exists to prevent.
*Introduced by*: 260731-65sg-env-structural-refactor-pilot

### `export *` widens the package surface, and the widening is accepted as additive
**Decision**: `REASONING_LEVELS_LABEL` is reachable from the package root, as a consequence of
living in `constants.ts` under `index.ts:94`'s `export * from './constants.js'`. The widened
surface is accepted rather than suppressed.
**Why**: TypeScript has no `export * except X`, so the alternatives are to enumerate `constants.ts`'s
~40 symbols as named exports at `index.ts:94` or to keep a second definition of the label outside
`constants.ts`. Both are worse than one additional exported string constant: the surface delta is
purely additive — one string constant reachable, nothing dropped, every other binding resolving to
the same value (checkable by listing `Object.keys()` of the built `dist/env.js` and `dist/index.js`)
— so no consumer can observe a behavior change.
**Rejected**: (a) rewriting `index.ts:94` as an explicit named-export list — a large, churn-prone
edit whose only purpose is to hide one constant; (b) keeping the label defined in `env.ts` while
the function moves — splits a two-line pair across modules and leaves the misplacement half in
place.
*Introduced by*: 260731-65sg-env-structural-refactor-pilot

### A behavior trap is pinned before the code that carries it moves
**Decision**: Tests that pin an untested behavior are appended and run **green against the
pre-move source** before any production edit, then re-run after the move — characterize, pin,
move, verify. `getRequired`'s empty-string-is-missing check, the `includeDotEnv !== false` default,
and the `set`/`get` round-trip are the pinned traps here.
**Why**: A pinning test only proves an invariant if it demonstrably passed against the original
behavior first; written after the move, it pins whatever the relocated code does at that point and
can never detect that the move changed something. The same argument the batched-refactor rule makes about
mutation-verifying coverage applies to the sequence in which that coverage is written — see
[/ci/pr-quality-gate.md](/ci/pr-quality-gate.md).
**Rejected**: writing the tests after the move under the project's default `test-alongside`
strategy — the tests would then be a description of the post-move code rather than a movement
detector, and the refactor's zero-behavior-change claim would rest on inspection alone.
*Introduced by*: 260731-65sg-env-structural-refactor-pilot
