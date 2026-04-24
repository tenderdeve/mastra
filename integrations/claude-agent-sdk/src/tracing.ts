/**
 * Mastra-side tracing helpers for the Claude Agent SDK integration.
 *
 * We emit *outside-the-loop* spans only (landmine #36):
 *
 * - `AGENT_RUN` root per `ClaudeAgent.stream()` turn, enriched with model /
 *   cwd / permissionMode / tool + subagent names / result aggregates.
 * - Event spans for approval/question/permission_mode lifecycle and session
 *   lifecycle. These land under the `AGENT_RUN` root.
 *
 * Actual LLM/tool spans come from the Claude Code CLI's native OTLP output,
 * ingested via {@link ./otel-ingest/receiver} and hung off the same
 * `AGENT_RUN` root using {@link attachOtlpChildren}.
 */

import type { AnySpan, Span } from '@mastra/core/observability';
import { getOrCreateSpan, SpanType } from '@mastra/core/observability';
import type { RequestContext } from '@mastra/core/request-context';

import type { MastraChildSpanDescriptor } from './otel-ingest/converter';

export interface StartAgentRunSpanOptions {
  readonly mastra?: { observability?: unknown } & Record<string, unknown>;
  readonly requestContext?: RequestContext;
  readonly agentId: string;
  readonly agentName: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly permissionMode?: string;
  readonly toolNames?: readonly string[];
  readonly subagentNames?: readonly string[];
}

/**
 * Open the AGENT_RUN root span for a Claude Agent turn. Returns the span
 * or `undefined` when observability is disabled.
 */
export function startAgentRunSpan(options: StartAgentRunSpanOptions): Span<SpanType.AGENT_RUN> | undefined {
  const {
    mastra,
    requestContext,
    agentId,
    agentName,
    sessionId,
    model,
    cwd,
    permissionMode,
    toolNames,
    subagentNames,
  } = options;

  return getOrCreateSpan<SpanType.AGENT_RUN>({
    type: SpanType.AGENT_RUN,
    name: agentName,
    mastra: mastra as never,
    requestContext,
    attributes: {
      agentId,
      instructions: '',
    } as never,
    entityId: agentId,
    entityName: agentName,
    metadata: {
      kind: 'claude-agent-sdk',
      sessionId,
      model,
      cwd,
      permissionMode,
      toolNames,
      subagentNames,
    },
  });
}

/**
 * Populate the AGENT_RUN root's output from the CLI's terminal `result`
 * message and close the span.
 */
export function endAgentRunSpan(
  span: Span<SpanType.AGENT_RUN> | undefined,
  finish: {
    readonly isError: boolean;
    readonly totalCostUsd?: number;
    readonly numTurns?: number;
    readonly durationMs?: number;
    readonly errorMessage?: string;
  },
): void {
  if (!span) return;
  if (finish.isError) {
    span.error({
      error: new Error(finish.errorMessage ?? 'claude agent run error'),
      metadata: {
        totalCostUsd: finish.totalCostUsd,
        numTurns: finish.numTurns,
        durationMs: finish.durationMs,
      },
    });
    return;
  }
  span.end({
    output: {
      totalCostUsd: finish.totalCostUsd,
      numTurns: finish.numTurns,
      durationMs: finish.durationMs,
    },
    metadata: {
      totalCostUsd: finish.totalCostUsd,
      numTurns: finish.numTurns,
      durationMs: finish.durationMs,
    },
  });
}

export type EventSpanKind =
  | 'approval.requested'
  | 'approval.resolved'
  | 'question.asked'
  | 'question.answered'
  | 'permission_mode.changed'
  | 'session.created'
  | 'session.forked'
  | 'session.renamed'
  | 'session.tagged'
  | 'session.deleted';

/**
 * Emit a short-lived event span under the AGENT_RUN root. Events are
 * immediate (start == end): we use them to record lifecycle markers
 * rather than measuring duration.
 */
export function emitEventSpan(
  parent: AnySpan | undefined,
  kind: EventSpanKind,
  attributes: Record<string, unknown>,
): void {
  if (!parent) return;
  const child = parent.createChildSpan({
    type: SpanType.GENERIC,
    name: kind,
    metadata: attributes,
  });
  if (!child) return;
  child.end({ metadata: attributes });
}

/**
 * Attach a batch of OTLP-derived child span descriptors under the given
 * parent. Landmine #32: spans whose parent is *inside* the batch retain
 * that parent (so the CLI's internal hierarchy is preserved), while orphan
 * roots reparent onto `parent`.
 */
export function attachOtlpChildren(
  parent: AnySpan | undefined,
  descriptors: MastraChildSpanDescriptor[],
): void {
  if (!parent || descriptors.length === 0) return;

  // Build a map from OTLP spanId -> freshly-created Mastra child span so
  // in-batch parent references can be resolved as we go.
  const spanBySourceId = new Map<string, AnySpan>();

  // Sort by start time so parents are likely to be created before children.
  const sorted = [...descriptors].sort((a, b) => {
    const at = a.startTime?.getTime() ?? 0;
    const bt = b.startTime?.getTime() ?? 0;
    return at - bt;
  });

  for (const desc of sorted) {
    const parentSpan = desc.parentSpanId ? spanBySourceId.get(desc.parentSpanId) ?? parent : parent;

    const child = parentSpan.createChildSpan({
      type: spanTypeFor(desc.mastraSpanType),
      name: desc.name,
      input: desc.input,
      metadata: {
        ...desc.attributes,
        source: 'claude-code-cli',
        cliStartTime: desc.startTime?.toISOString(),
        cliEndTime: desc.endTime?.toISOString(),
      },
    });
    if (!child) continue;

    spanBySourceId.set(desc.spanId, child);

    if (desc.errorMessage) {
      child.error({
        error: new Error(desc.errorMessage),
        metadata: desc.output,
      });
    } else {
      child.end({
        output: desc.output,
        metadata: desc.output,
      });
    }
  }
}

function spanTypeFor(t: MastraChildSpanDescriptor['mastraSpanType']): SpanType {
  switch (t) {
    case 'model_generation':
      return SpanType.MODEL_GENERATION;
    case 'model_step':
      return SpanType.MODEL_STEP;
    case 'tool_call':
      return SpanType.TOOL_CALL;
    case 'generic':
    default:
      return SpanType.GENERIC;
  }
}
