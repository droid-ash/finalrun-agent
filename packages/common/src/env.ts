// Port of mobile_cli/lib/mobile_cli_env.dart
// Loads environment variables from .env files or OS environment.

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { REASONING_LEVELS, type ReasoningLevel } from './constants.js';
export {
  MODEL_FORMAT_EXAMPLE,
  PROVIDER_ENV_VARS,
  SUPPORTED_AI_PROVIDERS,
  SUPPORTED_AI_PROVIDERS_LABEL,
  parseModel,
  type ParsedModel,
  type SupportedProvider,
} from './constants.js';

/**
 * Environment configuration for the CLI.
 * Supports three environments: dev, prod, local.
 *
 * Dart equivalent: MobileCliEnv in mobile_cli/lib/mobile_cli_env.dart
 */
export class CliEnv {
  private _values: Map<string, string> = new Map();

  /**
   * Load environment from a .env file or process.env.
   * Dart: Future<void> loadEnv(String envName)
   */
  load(
    envName?: string,
    options?: {
      includeDotEnv?: boolean;
      cwd?: string;
      processEnv?: NodeJS.ProcessEnv;
    },
  ): void {
    this._values.clear();
    const workingDirectory = options?.cwd ?? process.cwd();
    const processEnv = options?.processEnv ?? process.env;
    const includeDotEnv = options?.includeDotEnv !== false;

    if (includeDotEnv && envName) {
      this._mergeDotEnvFile(path.resolve(workingDirectory, `.env.${envName}`), {
        keepExisting: false,
      });
    }

    // Plain .env fills only the keys .env.<envName> did not set.
    if (includeDotEnv) {
      this._mergeDotEnvFile(path.resolve(workingDirectory, '.env'), {
        keepExisting: true,
      });
    }

    // OS environment variables take highest precedence
    for (const [key, value] of Object.entries(processEnv)) {
      if (value !== undefined) {
        this._values.set(key, value);
      }
    }
  }

  /**
   * Merge a dotenv file (when it exists) into the value map. With
   * `keepExisting`, keys already present in the map are left untouched.
   */
  private _mergeDotEnvFile(envFile: string, options: { keepExisting: boolean }): void {
    if (!fs.existsSync(envFile)) {
      return;
    }
    const parsed = dotenv.parse(fs.readFileSync(envFile, 'utf-8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (!options.keepExisting || !this._values.has(key)) {
        this._values.set(key, value);
      }
    }
  }

  /** Get a value by key. */
  get(key: string): string | undefined {
    return this._values.get(key);
  }

  /** Get a required value — throws if missing. */
  getRequired(key: string): string {
    const value = this._values.get(key);
    if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  }

  /** Set a value programmatically (e.g., from CLI args). */
  set(key: string, value: string): void {
    this._values.set(key, value);
  }
}

export const REASONING_LEVELS_LABEL = REASONING_LEVELS.join(', ');

export function parseReasoningLevel(value: unknown, label: string): ReasoningLevel | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string. Allowed values: ${REASONING_LEVELS_LABEL}.`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (!REASONING_LEVELS.includes(trimmed as ReasoningLevel)) {
    throw new Error(
      `${label} has invalid value "${trimmed}". Allowed values: ${REASONING_LEVELS_LABEL}.`,
    );
  }
  return trimmed as ReasoningLevel;
}
