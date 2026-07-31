// Port of constants/lib/constants.dart — only the subset this repo's
// TypeScript packages actually use.

// ============================================================================
// Platform identifiers
// ============================================================================
export const PLATFORM_ANDROID = 'android';
export const PLATFORM_IOS = 'ios';

// ============================================================================
// AI feature names — used by the goal-executor (AIAgent, VisualGrounder,
// ActionExecutor) to select prompts/models per feature, by ai/schemas.ts to
// key FEATURE_SCHEMAS (the per-feature response schemas), and by workspace.ts
// to key per-feature config overrides
// ============================================================================
export const FEATURE_PLANNER = 'planner';
export const FEATURE_GROUNDER = 'grounder';
export const FEATURE_VISUAL_GROUNDER = 'visual-grounder';
export const FEATURE_SCROLL_INDEX_GROUNDER = 'scroll-index-grounder';
export const FEATURE_INPUT_FOCUS_GROUNDER = 'input-focus-grounder';
export const FEATURE_LAUNCH_APP_GROUNDER = 'launch-app-grounder';
export const FEATURE_SET_LOCATION_GROUNDER = 'set-location-grounder';

export const ALL_FEATURES = [
  FEATURE_PLANNER,
  FEATURE_GROUNDER,
  FEATURE_VISUAL_GROUNDER,
  FEATURE_SCROLL_INDEX_GROUNDER,
  FEATURE_INPUT_FOCUS_GROUNDER,
  FEATURE_LAUNCH_APP_GROUNDER,
  FEATURE_SET_LOCATION_GROUNDER,
] as const;
export type FeatureName = (typeof ALL_FEATURES)[number];

// ============================================================================
// Reasoning effort — unified level mapped per-provider inside AIAgent.
// 'minimal' is OpenAI-only; Google/Anthropic reject it at call time.
// ============================================================================
export const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

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

// ============================================================================
// AI provider identifiers and shared model-string parsing. Lives here so
// both the CLI (workspace config, --model flag) and the goal-executor
// (per-feature overrides) can validate model strings with identical errors.
// ============================================================================
export const SUPPORTED_AI_PROVIDERS = ['openai', 'google', 'anthropic'] as const;
export type SupportedProvider = (typeof SUPPORTED_AI_PROVIDERS)[number];
export const SUPPORTED_AI_PROVIDERS_LABEL = SUPPORTED_AI_PROVIDERS.join(', ');
export const MODEL_FORMAT_EXAMPLE = 'google/gemini-3-flash-preview';
export const PROVIDER_ENV_VARS: Record<SupportedProvider, string> = {
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

export interface ParsedModel {
  provider: SupportedProvider;
  modelName: string;
}

/**
 * Parse a `provider/model` string (e.g. `openai/gpt-5.4-mini`) into its
 * provider and model name. Validates that both halves are non-empty after
 * trimming and that the provider is one of `SUPPORTED_AI_PROVIDERS`.
 *
 * @param modelStr the raw string from YAML or the CLI `--model` flag
 * @param label optional context prefix for errors (e.g. `features.planner.model`).
 *              When omitted, errors read as CLI-style (`--model is required...`).
 */
export function parseModel(modelStr: string | undefined, label?: string): ParsedModel {
  const normalizedModel = modelStr?.trim();
  if (!normalizedModel) {
    throw new Error(
      label
        ? `${label} is required. Use provider/model, for example ${MODEL_FORMAT_EXAMPLE}. Supported providers: ${SUPPORTED_AI_PROVIDERS_LABEL}.`
        : `--model is required. Use provider/model, for example ${MODEL_FORMAT_EXAMPLE}. Supported providers: ${SUPPORTED_AI_PROVIDERS_LABEL}.`,
    );
  }

  const segments = normalizedModel.split('/');
  if (
    segments.length !== 2 ||
    segments[0] === undefined ||
    segments[1] === undefined ||
    segments[0].trim() === '' ||
    segments[1].trim() === ''
  ) {
    const detail = `Expected provider/model with non-empty provider and model name. Supported providers: ${SUPPORTED_AI_PROVIDERS_LABEL}.`;
    throw new Error(
      label
        ? `${label} has invalid model format: "${normalizedModel}". ${detail}`
        : `Invalid model format: "${normalizedModel}". ${detail}`,
    );
  }

  const provider = segments[0].trim();
  const modelName = segments[1].trim();
  if (!SUPPORTED_AI_PROVIDERS.includes(provider as SupportedProvider)) {
    throw new Error(
      label
        ? `${label} has unsupported AI provider: "${provider}". Supported providers: ${SUPPORTED_AI_PROVIDERS_LABEL}.`
        : `Unsupported AI provider: "${provider}". Supported providers: ${SUPPORTED_AI_PROVIDERS_LABEL}.`,
    );
  }

  return { provider: provider as SupportedProvider, modelName };
}

/**
 * Per-feature override resolved from `features:` in .finalrun/config.yaml.
 * Each field is optional; unset fields inherit workspace-level defaults.
 * `model` is a "provider/modelName" string (validated via parseModel at use site).
 */
export interface FeatureOverride {
  model?: string;
  reasoning?: ReasoningLevel;
}

export type FeatureOverrides = Partial<Record<FeatureName, FeatureOverride>>;

export interface ModelDefaults {
  provider: string;
  modelName: string;
  reasoning?: ReasoningLevel;
}

// ============================================================================
// Defaults
// ============================================================================
export const DEFAULT_MAX_ITERATIONS = 110;
export const DEFAULT_GRPC_PORT_START = 50051;

// ============================================================================
// Planner output action keys — the normalized `act` values AIAgent maps the
// planner's snake_case action_type strings onto (see FIXED_PROMPT_ACTIONS in
// AIAgent.ts); ActionExecutor routes its handler map on them and TestExecutor
// checks the completed/failed terminals.
// ============================================================================
export const PLANNER_ACTION_TAP = 'tap';
export const PLANNER_ACTION_LONG_PRESS = 'longPress';
export const PLANNER_ACTION_TYPE = 'type';
export const PLANNER_ACTION_SCROLL = 'scroll';
export const PLANNER_ACTION_BACK = 'back';
export const PLANNER_ACTION_HOME = 'home';
export const PLANNER_ACTION_ROTATE = 'rotate';
export const PLANNER_ACTION_HIDE_KEYBOARD = 'hideKeyboard';
export const PLANNER_ACTION_PRESS_ENTER = 'pressEnter';
export const PLANNER_ACTION_LAUNCH_APP = 'launchApp';
export const PLANNER_ACTION_SET_LOCATION = 'setLocation';
export const PLANNER_ACTION_WAIT = 'wait';
export const PLANNER_ACTION_COMPLETED = 'completed';
export const PLANNER_ACTION_FAILED = 'failed';
export const PLANNER_ACTION_DEEPLINK = 'deeplink';
