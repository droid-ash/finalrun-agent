import { performance } from 'node:perf_hooks';
import { Logger } from '@finalrun/common';
import type {
  AgentActionTrace,
  TraceSpan as CommonTraceSpan,
  SpanTiming as CommonSpanTiming,
  TimingInfo,
} from '@finalrun/common';

export type TraceStatus = 'success' | 'failure';

// Re-export common types under the names used internally
export type TraceSpan = CommonTraceSpan;
export type StepTrace = AgentActionTrace;
export type SpanTiming = CommonSpanTiming;
export type TimingMetadata = TimingInfo;

export interface LLMTrace {
  totalMs: number;
  promptBuildMs: number;
  llmMs: number;
  parseMs: number;
}

/**
 * Per-LLM-call observability data — prompt, response, tokens, timing.
 * Populated in AIAgent._callLLM() and bubbled up to TestExecutor so
 * consumers (cloud-server) can forward to observability backends
 * (e.g., Langfuse) without agent itself depending on any SDK.
 *
 * Field names mirror Langfuse's canonical ingestion schema to make
 * forwarding a straight pass-through on the consumer side.
 */
export interface LLMCallTrace {
  /** AI provider: 'openai' | 'google' | 'anthropic'. */
  provider: string;
  /** Full model name, e.g. 'gpt-4.1-mini', 'gemini-2.0-flash'. */
  model: string;
  /** Logical feature the call served: 'planner', 'grounder', 'visual_grounder', etc. */
  feature: string;
  /** Full prompt as the provider saw it — array of role/content messages (includes any base64 images inline). */
  prompt: unknown;
  /** Raw model response text. */
  completion: string;
  /** Normalized token counts (Langfuse canonical names — input/output/total). */
  usage: {
    input: number;
    output: number;
    total: number;
    /** Only present if the provider reported cache-read input tokens > 0. */
    input_cached_tokens?: number;
  };
  /** ISO-8601 timestamp when the call started. */
  startedAt: string;
  /** ISO-8601 timestamp when the call returned or errored. */
  completedAt: string;
  /** Wall-clock duration of the LLM call in ms. */
  durationMs: number;
  /** Provider error message, if the call threw. */
  statusMessage?: string;
}

export interface ActiveTracePhase {
  phase: string;
  startedAt: number;
  step: number;
}

const SUMMARY_GROUPS: Array<{ group: string; label: string; children: string[] }> = [
  {
    group: 'capture.total',
    label: 'capture',
    children: ['capture.stability', 'capture.final_payload'],
  },
  {
    group: 'planning.total',
    label: 'planning',
    children: ['planning.llm', 'planning.parse'],
  },
  {
    group: 'action.total',
    label: 'action',
    children: [
      'action.prep',
      'action.ground',
      'action.visual_fallback',
      'action.device',
      'action.wait',
    ],
  },
  {
    group: 'post_capture.total',
    label: 'post_capture',
    children: ['post_capture.stability', 'post_capture.final_payload'],
  },
];

export function nowMs(): number {
  return performance.now();
}

export function roundDuration(durationMs: number): number {
  return Math.max(0, Math.round(durationMs));
}

export function startTracePhase(
  step: number | undefined,
  phase: string,
  detail?: string,
): ActiveTracePhase | null {
  if (step !== undefined) {
    Logger.d(`[trace step=${step} phase=${phase}] start${formatDetail(detail)}`);
  }

  return step !== undefined
    ? {
        phase,
        startedAt: nowMs(),
        step,
      }
    : null;
}

export function finishTracePhase(
  activePhase: ActiveTracePhase | null,
  status: TraceStatus,
  detail?: string,
): number {
  const finishedAt = nowMs();
  const durationMs = activePhase
    ? roundDuration(finishedAt - activePhase.startedAt)
    : 0;

  if (activePhase) {
    Logger.d(
      `[trace step=${activePhase.step} phase=${activePhase.phase}] done duration=${durationMs}ms status=${status}${formatDetail(detail)}`,
    );
  }

  return durationMs;
}

export function describeLLMTrace(params: {
  promptBuildMs: number;
  llmMs: number;
  parseMs?: number;
  extraDetail?: string;
}): string {
  const parts = [
    `prompt=${params.promptBuildMs}ms`,
    `model=${params.llmMs}ms`,
  ];

  if (params.parseMs !== undefined) {
    parts.push(`parse=${params.parseMs}ms`);
  }
  if (params.extraDetail) {
    parts.push(params.extraDetail);
  }

  return parts.join(' ');
}

export class StepTraceBuilder {
  private readonly _step: number;
  private readonly _stepStartedAt: number;
  private readonly _spans: TraceSpan[] = [];
  private _action = 'pending';
  private _status: TraceStatus = 'success';
  private _failureReason: string | undefined;

  constructor(step: number) {
    this._step = step;
    this._stepStartedAt = nowMs();
  }

  setAction(action: string): void {
    this._action = action;
  }

  markFailure(reason: string): void {
    this._status = 'failure';
    this._failureReason = collapseWhitespace(reason);
  }

  addSpanFromActivePhase(
    phase: ActiveTracePhase | null,
    status: TraceStatus,
    detail?: string,
  ): TraceSpan {
    const durationMs = finishTracePhase(phase, status, detail);
    const startedAt = phase?.startedAt ?? nowMs();
    const span: TraceSpan = {
      name: phase?.phase ?? 'unknown',
      startMs: roundDuration(startedAt - this._stepStartedAt),
      durationMs,
      status,
      detail: detail ? collapseWhitespace(detail) : undefined,
    };
    this._spans.push(span);
    return span;
  }

  addSpan(
    name: string,
    durationMs: number,
    status: TraceStatus,
    options?: {
      startMs?: number;
      detail?: string;
    },
  ): TraceSpan {
    const span: TraceSpan = {
      name,
      startMs:
        options?.startMs ??
        this._nextSequentialStartMs(),
      durationMs: roundDuration(durationMs),
      status,
      detail: options?.detail ? collapseWhitespace(options.detail) : undefined,
    };
    this._spans.push(span);
    return span;
  }

  addSequentialTimings(
    timings: TimingMetadata | undefined,
    options?: {
      startMs?: number;
    },
  ): void {
    if (!timings) {
      return;
    }

    let cursor = options?.startMs ?? this._nextSequentialStartMs();
    for (const span of timings.spans) {
      this.addSpan(span.name, span.durationMs, span.status, {
        startMs: cursor,
        detail: span.detail,
      });
      cursor += roundDuration(span.durationMs);
    }
  }

  build(): StepTrace {
    const totalMs = roundDuration(nowMs() - this._stepStartedAt);

    return {
      step: this._step,
      action: this._action,
      status: this._status,
      totalMs,
      spans: [
        {
          name: 'step.total',
          startMs: 0,
          durationMs: totalMs,
          status: this._status,
          detail: this._failureReason,
        },
        ...this._spans.sort((left, right) => left.startMs - right.startMs),
      ],
      failureReason: this._failureReason,
    };
  }

  private _nextSequentialStartMs(): number {
    if (this._spans.length === 0) {
      return 0;
    }

    const lastSpan = this._spans[this._spans.length - 1];
    return lastSpan.startMs + lastSpan.durationMs;
  }
}

export function formatStepTraceSummary(stepTrace: StepTrace): string {
  const spanMap = new Map(stepTrace.spans.map((span) => [span.name, span]));
  const parts = [`summary total=${stepTrace.totalMs}ms`];

  for (const group of SUMMARY_GROUPS) {
    const groupSpan = spanMap.get(group.group);
    if (!groupSpan) {
      continue;
    }

    const childSummaries = group.children
      .map((childName) => spanMap.get(childName))
      .filter((childSpan): childSpan is TraceSpan => childSpan !== undefined)
      .map((childSpan) => `${stripPrefix(childSpan.name)}=${childSpan.durationMs}ms`);

    if (childSummaries.length > 0) {
      parts.push(
        `${group.label}=${groupSpan.durationMs}ms(${childSummaries.join(',')})`,
      );
    } else {
      parts.push(`${group.label}=${groupSpan.durationMs}ms`);
    }
  }

  parts.push(`result=${stepTrace.status}`);
  parts.push(`action=${stepTrace.action}`);
  if (stepTrace.failureReason) {
    parts.push(`reason=${JSON.stringify(stepTrace.failureReason)}`);
  }

  return `[trace step=${stepTrace.step}] ${parts.join(' ')}`;
}

const BLUE = '\x1b[34m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export function formatPlannerReasoning(params: {
  step: number;
  thought?: { plan?: string; think?: string; act?: string };
  action: string;
  reason: string;
}): string {
  const lines: string[] = [
    `[step ${params.step}] ${BLUE}Planner${RESET} → ${params.action}`,
  ];

  if (params.thought?.plan) {
    lines.push(`  Plan: ${params.thought.plan}`);
  }
  if (params.thought?.think) {
    lines.push(`  ${BLUE}Think${RESET}: ${params.thought.think}`);
  }

  if (!params.thought) {
    lines.push(`  Reason: ${params.reason}`);
  }

  return lines.join('\n');
}

export function formatGrounderRequest(params: {
  step: number;
  feature: string;
  act: string;
}): string {
  return `[step ${params.step}] ${YELLOW}Grounding${RESET} → feature=${params.feature} act="${params.act}"`;
}

export function formatGrounderResult(params: {
  step: number;
  output: Record<string, unknown>;
  bounds?: [number, number, number, number] | null;
}): string {
  const { output } = params;

  if (output['isError']) {
    return `[step ${params.step}] ${RED}Grounded${RESET} → ${RED}error: ${output['reason'] ?? 'unknown'}${RESET}`;
  }

  if (output['needsVisualGrounding']) {
    return `[step ${params.step}] ${YELLOW}Grounded${RESET} → needsVisualGrounding`;
  }

  if (typeof output['index'] === 'number') {
    const boundsStr = params.bounds
      ? ` bounds=[${params.bounds.join(',')}]`
      : '';
    return `[step ${params.step}] ${GREEN}Grounded${RESET} → index=${output['index']}${boundsStr} reason="${output['reason'] ?? ''}"`;
  }

  if (typeof output['x'] === 'number' && typeof output['y'] === 'number') {
    return `[step ${params.step}] ${GREEN}Grounded${RESET} → x=${output['x']} y=${output['y']}`;
  }

  return `[step ${params.step}] ${GREEN}Grounded${RESET} → ${JSON.stringify(output)}`;
}

function formatDetail(detail: string | undefined): string {
  if (!detail) {
    return '';
  }

  return ` detail=${JSON.stringify(collapseWhitespace(detail))}`;
}

function stripPrefix(value: string): string {
  const slashIndex = value.indexOf('.');
  return slashIndex === -1 ? value : value.slice(slashIndex + 1);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
