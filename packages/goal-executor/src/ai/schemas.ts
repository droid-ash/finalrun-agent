// Zod schemas for LLM structured output on the Anthropic path.
//
// The Vercel AI SDK's Anthropic adapter (`@ai-sdk/anthropic`) cannot enforce
// JSON output without a schema — Anthropic has no schema-less JSON mode. When
// a schema is supplied, the adapter routes through Anthropic's structured-
// output APIs (`output_format` or a `json` tool, depending on
// `structuredOutputMode`) so Claude emits exactly one well-formed JSON object.
//
// OpenAI (`response_format: json_object`) and Google
// (`response_mime_type: application/json`) work schema-less today, so this
// file is only consumed on the Anthropic call path in `AIAgent._callLLM`.
//
// IMPORTANT — no outer `output` wrapper.
// The prompts tell the model to emit `{"output": {...}}` because OpenAI and
// Google are in text-JSON mode and the parsers look for that convention.
// On the Anthropic structured-output path, the schema IS the shape of the
// tool call arguments (or the `output_format` payload) — adding an `output`
// wrapper here causes Claude to nest twice: `{"output":{"output":{...}}}`.
// Schemas below describe the inner shape directly; `_parsePlannerResponse`
// and `_parseGrounderResponse` already accept both wrapped and unwrapped
// shapes via their fallback branches.
//
// Each schema mirrors the corresponding prompt in `src/prompts/*.md`. When
// a prompt changes, update the matching schema here.

import { z } from 'zod';
import {
  FEATURE_GROUNDER,
  FEATURE_INPUT_FOCUS_GROUNDER,
  FEATURE_LAUNCH_APP_GROUNDER,
  FEATURE_PLANNER,
  FEATURE_SCROLL_INDEX_GROUNDER,
  FEATURE_SET_LOCATION_GROUNDER,
  FEATURE_VISUAL_GROUNDER,
  type FeatureName,
} from '@finalrun/common';

// ----------------------------------------------------------------------------
// Planner — canonical shape from `prompts/planner.md` <output_schema>
// ----------------------------------------------------------------------------

const PLANNER_ACTION_TYPES = [
  'tap',
  'long_press',
  'input_text',
  'swipe',
  'navigate_back',
  'navigate_home',
  'rotate',
  'hide_keyboard',
  'keyboard_enter',
  'wait',
  'deep_link',
  'set_location',
  'launch_app',
  'status',
] as const;

const plannerActionSchema = z
  .object({
    action_type: z.enum(PLANNER_ACTION_TYPES),
  })
  .passthrough();

const plannerThoughtSchema = z
  .object({
    plan: z.string().optional(),
    think: z.string().optional(),
    act: z.string().optional(),
  })
  .passthrough();

export const PLANNER_SCHEMA = z.object({
  thought: plannerThoughtSchema.optional(),
  action: plannerActionSchema,
  remember: z.array(z.string()).optional(),
});

// ----------------------------------------------------------------------------
// Grounder — per-feature shapes from the grounder prompt files
// ----------------------------------------------------------------------------

// Numeric fields use plain z.number() — Anthropic's tool-schema validator
// rejects `minimum`/`maximum` keywords on the `integer` type, and zod v4's
// .int() emits those bounds by default. Downstream parsers already coerce
// to integers where needed (ActionExecutor + GrounderResponseConverter).

const errorShape = z.object({
  isError: z.literal(true),
  reason: z.string(),
});

// `FEATURE_GROUNDER` — `prompts/grounder.md`
// Three success variants: visual-fallback, index match, or error.
const grounderSchema = z.union([
  errorShape,
  z
    .object({
      needsVisualGrounding: z.literal(true),
      reason: z.string(),
    })
    .passthrough(),
  z
    .object({
      index: z.number(),
      reason: z.string().optional(),
    })
    .passthrough(),
]);

// `FEATURE_INPUT_FOCUS_GROUNDER` — `prompts/input-focus-grounder.md`
// Variants: index match, null index (already focused), x/y coords, or error.
const inputFocusGrounderSchema = z.union([
  errorShape,
  z
    .object({
      index: z.number().nullable(),
      reason: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      x: z.number(),
      y: z.number(),
      reason: z.string().optional(),
    })
    .passthrough(),
]);

// `FEATURE_VISUAL_GROUNDER` — `prompts/visual-grounder.md`
const visualGrounderSchema = z.union([
  errorShape,
  z
    .object({
      x: z.number(),
      y: z.number(),
      reason: z.string().optional(),
    })
    .passthrough(),
]);

// `FEATURE_SCROLL_INDEX_GROUNDER` — `prompts/scroll-grounder.md`
const scrollIndexGrounderSchema = z.union([
  errorShape,
  z
    .object({
      start_x: z.number(),
      start_y: z.number(),
      end_x: z.number(),
      end_y: z.number(),
      durationMs: z.number(),
      reason: z.string().optional(),
    })
    .passthrough(),
]);

// `FEATURE_LAUNCH_APP_GROUNDER` — `prompts/launch-app-grounder.md`
// Keep permissions and arguments as permissive records; the prompt documents
// free-form values.
const launchAppGrounderSchema = z.union([
  errorShape,
  z
    .object({
      packageName: z.string(),
      reason: z.string().optional(),
      clearState: z.boolean().optional(),
      allowAllPermissions: z.boolean().optional(),
      stopAppBeforeLaunch: z.boolean().optional(),
      shouldUninstallBeforeLaunch: z.boolean().optional(),
      permissions: z.object({}).passthrough().optional(),
      arguments: z.object({}).passthrough().optional(),
    })
    .passthrough(),
]);

// `FEATURE_SET_LOCATION_GROUNDER` — `prompts/set-location-grounder.md`
// lat/long are strings by spec (4-6 decimal places).
const setLocationGrounderSchema = z.union([
  errorShape,
  z
    .object({
      lat: z.string(),
      long: z.string(),
      reason: z.string().optional(),
    })
    .passthrough(),
]);

// ----------------------------------------------------------------------------
// Lookup
// ----------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FEATURE_SCHEMAS: Record<FeatureName, z.ZodType<any>> = {
  [FEATURE_PLANNER]: PLANNER_SCHEMA,
  [FEATURE_GROUNDER]: grounderSchema,
  [FEATURE_INPUT_FOCUS_GROUNDER]: inputFocusGrounderSchema,
  [FEATURE_VISUAL_GROUNDER]: visualGrounderSchema,
  [FEATURE_SCROLL_INDEX_GROUNDER]: scrollIndexGrounderSchema,
  [FEATURE_LAUNCH_APP_GROUNDER]: launchAppGrounderSchema,
  [FEATURE_SET_LOCATION_GROUNDER]: setLocationGrounderSchema,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function schemaForFeature(feature: FeatureName): z.ZodType<any> {
  const schema = FEATURE_SCHEMAS[feature];
  if (!schema) {
    throw new Error(`No schema registered for feature "${feature}".`);
  }
  return schema;
}
