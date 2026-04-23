// Translates Claude Agent SDK message envelopes (`SDKMessage`) into Mastra v5
// UIMessage shapes that the Studio Thread component already knows how to render.
//
// We avoid importing `@internal/ai-sdk-v5` directly to keep this package
// publishable; the output structurally matches the v5 `UIMessage` contract that
// `AIV5Adapter.fromUIMessage()` consumes via duck-typing.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// ---------- Local v5-shaped UIMessage subset ----------

export type UiTextPart = {
  type: 'text';
  text: string;
  state?: 'streaming' | 'done';
};

export type UiReasoningPart = {
  type: 'reasoning';
  text: string;
  state?: 'streaming' | 'done';
};

export type UiToolPart = {
  // v5 encodes the tool name in the part type, e.g. `tool-mcp__mastra__writeNote`.
  type: `tool-${string}`;
  toolCallId: string;
  state: 'input-available' | 'output-available' | 'output-error';
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export type UiStepStartPart = { type: 'step-start' };

export type UiMessagePart = UiTextPart | UiReasoningPart | UiToolPart | UiStepStartPart;

export type UiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: UiMessagePart[];
  metadata?: Record<string, unknown>;
};

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

function toolPartType(name: string): `tool-${string}` {
  return `tool-${name}` as `tool-${string}`;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (block && typeof block === 'object' && 'text' in block && typeof (block as any).text === 'string') {
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

// ---------- Main translator ----------

/**
 * Convert an array of raw SDK messages into v5 UIMessage[] for Studio Thread.
 *
 * Behaviour:
 *  - `partial_assistant` (`type: 'stream_event'`) messages are filtered out.
 *    They're streaming deltas; the final `assistant` message contains the
 *    complete content. Persisting partials causes duplicate assistant
 *    bubbles on refresh.
 *  - `user` messages contribute either a plain text bubble or a synthetic
 *    `tool-*` part with `output-available` (when `tool_result` blocks
 *    appear). Tool results are paired into the *previous* assistant
 *    message's matching tool part by `tool_use_id`.
 *  - `assistant` messages map text → text part, thinking → reasoning part,
 *    tool_use → tool part with `state: 'input-available'`.
 *  - `system` and `result` messages are skipped — they're metadata, not
 *    chat-renderable.
 */
export function sdkMessagesToUiMessages(sdkMessages: readonly SDKMessage[]): UiMessage[] {
  const out: UiMessage[] = [];
  // Index of the most recent assistant message that has unresolved tool_use parts.
  // Maps tool_use_id -> { messageIndex, partIndex }.
  const pendingToolUses = new Map<string, { messageIndex: number; partIndex: number }>();

  for (const m of sdkMessages) {
    // Skip streaming deltas + non-chat envelopes.
    if (m.type === 'stream_event') continue;
    if (m.type === 'result') continue;
    if (m.type === 'system') continue;

    if (m.type === 'user') {
      const blocks = blocksFrom((m.message as { content?: unknown } | undefined)?.content);
      const parts: UiMessagePart[] = [];
      let bubbleText = '';

      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          bubbleText += block.text;
          continue;
        }

        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const target = pendingToolUses.get(block.tool_use_id);
          const resultText = stringifyToolResultContent(block.content);
          if (target) {
            const targetMsg = out[target.messageIndex];
            const targetPart = targetMsg?.parts[target.partIndex] as UiToolPart | undefined;
            if (targetPart && targetPart.type.startsWith('tool-')) {
              if (block.is_error) {
                targetPart.state = 'output-error';
                targetPart.errorText = resultText;
              } else {
                targetPart.state = 'output-available';
                targetPart.output = resultText;
              }
              pendingToolUses.delete(block.tool_use_id);
              continue;
            }
          }
          // No matching pending tool_use — surface the result as plain text so
          // it isn't silently dropped.
          bubbleText += resultText;
        }
      }

      if (bubbleText.length > 0) parts.unshift({ type: 'text', text: bubbleText });
      if (parts.length === 0) continue;

      out.push({
        id: (m as { uuid?: string }).uuid ?? `user-${out.length}`,
        role: 'user',
        parts,
      });
      continue;
    }

    if (m.type === 'assistant') {
      const blocks = blocksFrom((m.message as { content?: unknown } | undefined)?.content);
      const parts: UiMessagePart[] = [];
      const messageIndex = out.length;

      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text, state: 'done' });
          continue;
        }

        if (block.type === 'thinking' && typeof block.thinking === 'string') {
          parts.push({ type: 'reasoning', text: block.thinking, state: 'done' });
          continue;
        }

        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          const part: UiToolPart = {
            type: toolPartType(block.name),
            toolCallId: block.id,
            state: 'input-available',
            input: block.input,
          };
          parts.push(part);
          pendingToolUses.set(block.id, { messageIndex, partIndex: parts.length - 1 });
          continue;
        }
      }

      if (parts.length === 0) continue;

      out.push({
        id: (m as { uuid?: string }).uuid ?? `assistant-${out.length}`,
        role: 'assistant',
        parts,
      });
      continue;
    }
  }

  return out;
}
