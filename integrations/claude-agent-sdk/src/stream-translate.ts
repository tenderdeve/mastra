// Translates `ShellStreamEvent` (the outbound contract from `ClaudeAgent.stream()`)
// into Mastra's native stream `ChunkType`. This is the same wire format emitted
// by `Agent.stream()` — downstream consumers (Studio, `convertMastraChunkToAISDKv5`,
// `convertFullStreamChunkToUIMessageStream`) can treat a Claude Agent stream
// identically to a regular Mastra agent stream.
//
// Claude-specific transport signals (real SDK session id, approval/question
// request + resolution) ride on `DataChunkType` entries (`data-claude-agent-*`)
// and are marked `transient: true` so they drive Studio UI state without
// polluting persisted message history.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentChunkType,
  ChunkType,
  ReasoningDeltaPayload,
  ReasoningStartPayload,
  TextDeltaPayload,
  TextStartPayload,
  ToolCallPayload,
  ToolResultPayload,
} from '@mastra/core/stream';
import { ChunkFrom } from '@mastra/core/stream';

import type { ShellStreamEvent } from './stream-events';

// ---------- Helpers ----------

type AnyContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

function blocksFrom(content: unknown): AnyContentBlock[] {
  if (Array.isArray(content)) return content as AnyContentBlock[];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (block && typeof block === 'object' && 'text' in block && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text;
        }
        try {
          return JSON.stringify(block);
        } catch {
          return String(block);
        }
      })
      .join('');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

type ExtractPayload<T extends AgentChunkType['type']> = Extract<AgentChunkType, { type: T }> extends {
  payload: infer P;
}
  ? P
  : never;

function agentChunk<T extends AgentChunkType['type']>(
  runId: string,
  type: T,
  payload: ExtractPayload<T>,
): ChunkType {
  return { runId, from: ChunkFrom.AGENT, type, payload } as ChunkType;
}

function dataChunk(type: `data-claude-agent-${string}`, data: unknown): ChunkType {
  return { type, data, transient: true } as ChunkType;
}

function* messageToChunks(runId: string, message: SDKMessage): Generator<ChunkType, void, void> {
  // Skip streaming deltas + envelopes that don't render in chat (Landmine #13).
  if (message.type === 'stream_event') return;
  if (message.type === 'system') return;
  if (message.type === 'result') return;

  if (message.type === 'assistant') {
    const blocks = blocksFrom((message.message as { content?: unknown } | undefined)?.content);
    const uuid = (message as { uuid?: string }).uuid ?? 'asst';
    let textIdx = 0;
    let reasoningIdx = 0;

    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const id = `${uuid}-text-${textIdx++}`;
        yield agentChunk(runId, 'text-start', { id } satisfies TextStartPayload);
        yield agentChunk(runId, 'text-delta', { id, text: block.text } satisfies TextDeltaPayload);
        yield agentChunk(runId, 'text-end', { id });
        continue;
      }

      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        const id = `${uuid}-reasoning-${reasoningIdx++}`;
        yield agentChunk(runId, 'reasoning-start', { id } satisfies ReasoningStartPayload);
        yield agentChunk(runId, 'reasoning-delta', { id, text: block.thinking } satisfies ReasoningDeltaPayload);
        yield agentChunk(runId, 'reasoning-end', { id });
        continue;
      }

      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const payload: ToolCallPayload = {
          toolCallId: block.id,
          toolName: block.name,
          args: block.input as Record<string, unknown> | undefined,
        };
        yield agentChunk(runId, 'tool-call', payload);
        continue;
      }
    }
    return;
  }

  if (message.type === 'user') {
    const blocks = blocksFrom((message.message as { content?: unknown } | undefined)?.content);
    for (const block of blocks) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const text = stringifyToolResultContent(block.content);
        const payload: ToolResultPayload = {
          toolCallId: block.tool_use_id,
          toolName: '',
          result: text,
          isError: block.is_error === true,
        };
        yield agentChunk(runId, 'tool-result', payload);
      }
    }
    return;
  }
}

// ---------- Main translator ----------

export type ShellStreamToChunksOptions = {
  /** Stable run id threaded onto every emitted `AgentChunkType`. */
  runId: string;
  /** Optional message id surfaced on the leading `start` / `step-start` chunks. */
  messageId?: string;
};

/**
 * Translate a `ShellStreamEvent` async iterable into a Mastra `ChunkType`
 * iterable. Emission order is: `start` → `step-start` → ...message-derived
 * text/reasoning/tool chunks interleaved with `data-claude-agent-*` transport
 * chunks... → `step-finish` → `finish`.
 *
 * Errors from the shell are surfaced as `error` chunks, but the stream is
 * always closed with `step-finish` + `finish` so Studio can release spinner
 * state regardless of outcome.
 */
export async function* shellStreamToMastraChunks(
  events: AsyncIterable<ShellStreamEvent>,
  opts: ShellStreamToChunksOptions,
): AsyncGenerator<ChunkType, void, void> {
  const { runId, messageId } = opts;

  yield agentChunk(runId, 'start', {});
  yield agentChunk(runId, 'step-start', { messageId, request: {} });

  let finishMetadata:
    | { isError: boolean; totalCostUsd?: number; numTurns?: number; durationMs?: number }
    | undefined;
  let sawError = false;

  for await (const event of events) {
    switch (event.type) {
      case 'session':
        yield dataChunk('data-claude-agent-session', { sessionId: event.sessionId });
        break;

      case 'message':
        yield* messageToChunks(runId, event.message);
        break;

      case 'approval-request':
        yield dataChunk('data-claude-agent-approval-request', event.request);
        break;

      case 'approval-resolved':
        yield dataChunk('data-claude-agent-approval-resolved', {
          approvalId: event.approvalId,
          decision: event.decision,
        });
        break;

      case 'question-request':
        yield dataChunk('data-claude-agent-question-request', event.request);
        break;

      case 'question-resolved':
        yield dataChunk('data-claude-agent-question-resolved', { questionId: event.questionId });
        break;

      case 'finish':
        finishMetadata = {
          isError: event.isError,
          ...(event.totalCostUsd !== undefined ? { totalCostUsd: event.totalCostUsd } : {}),
          ...(event.numTurns !== undefined ? { numTurns: event.numTurns } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        };
        break;

      case 'error':
        sawError = true;
        yield agentChunk(runId, 'error', { error: event.error });
        break;
    }
  }

  const emptyUsage = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined };
  const finishReason = sawError ? 'error' : 'stop';

  yield agentChunk(runId, 'step-finish', {
    messageId,
    stepResult: { reason: finishReason, isContinued: false },
    output: { usage: emptyUsage },
    metadata: { ...(finishMetadata ?? {}) },
  });

  yield agentChunk(runId, 'finish', {
    stepResult: { reason: finishReason },
    output: { usage: emptyUsage },
    metadata: { ...(finishMetadata ?? {}) },
    messages: { all: [], user: [], nonUser: [] },
  });
}
