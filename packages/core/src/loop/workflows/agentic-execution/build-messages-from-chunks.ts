import type { ToolSet } from '@internal/ai-sdk-v5';

import type { MastraDBMessage, MastraMessagePart } from '../../../agent/message-list';
import type {
  FilePayload,
  ReasoningDeltaPayload,
  ReasoningStartPayload,
  SourcePayload,
  TextDeltaPayload,
  TextStartPayload,
  ToolCallPayload,
  ToolResultPayload,
} from '../../../stream/types';
import { findProviderToolByName, inferProviderExecuted } from '../../../tools/provider-tool-utils';

/**
 * A raw chunk collected during the stream.
 * We only store the type and payload — everything needed to reconstruct messages post-stream.
 */
export type CollectedChunk = { type: string; payload: any };

/**
 * Build MastraDBMessage entries from the full sequence of stream chunks.
 *
 * This replaces the previous approach of flushing text/reasoning deltas into
 * messages mid-stream. By walking the complete chunk sequence we:
 *
 * 1. Produce exactly one text part per text-start/text-end span (no duplicates)
 * 2. Produce exactly one reasoning part per reasoning-start/reasoning-end span
 * 3. Preserve correct stream ordering (text before tool-call if that's how they arrived)
 * 4. Use providerMetadata with "last seen wins" semantics per AI SDK convention
 * 5. Skip empty text spans (empty-string deltas only) — no more empty text parts in DB
 * 6. Merge tool-call + tool-result into a single part with state: 'result' when applicable
 */
export function buildMessagesFromChunks({
  chunks,
  messageId,
  responseModelMetadata,
  tools,
}: {
  chunks: CollectedChunk[];
  messageId: string;
  responseModelMetadata?: { metadata: Record<string, unknown> };
  tools?: ToolSet;
}): MastraDBMessage[] {
  // Parts are pushed in stream-start order. Text and reasoning spans push a real
  // part on first encounter (text-start or first text-delta) and mutate it in place
  // as deltas arrive. This preserves stream-start ordering without needing slots/nulls.
  const parts: MastraMessagePart[] = [];

  // Collect tool results so we can match them to tool calls
  const toolResults = new Map<
    string,
    { result: any; args: any; providerMetadata: any; providerExecuted: boolean | undefined; toolName: string }
  >();
  for (const chunk of chunks) {
    if (chunk.type === 'tool-result' && chunk.payload.result != null) {
      const p = chunk.payload as ToolResultPayload;
      toolResults.set(p.toolCallId, {
        result: p.result,
        args: p.args,
        providerMetadata: p.providerMetadata,
        providerExecuted: p.providerExecuted,
        toolName: p.toolName,
      });
    }
  }

  // Live references to text parts in the parts array, keyed by text ID.
  // Used to append deltas and update providerMetadata in place.
  const textRefs = new Map<string, { type: 'text'; text: string; providerMetadata?: Record<string, any> }>();

  // Live references to reasoning parts in the parts array, keyed by reasoning ID.
  const reasoningRefs = new Map<
    string,
    { type: 'reasoning'; reasoning: string; details: any[]; providerMetadata?: Record<string, any> }
  >();

  for (const chunk of chunks) {
    switch (chunk.type) {
      // ── Text span ──────────────────────────────────────────────
      case 'text-start': {
        const p = chunk.payload as TextStartPayload;
        if (!textRefs.has(p.id)) {
          // Push a real part now so it appears at the stream-start position
          const part = { type: 'text' as const, text: '', providerMetadata: p.providerMetadata };
          parts.push(part as MastraMessagePart);
          textRefs.set(p.id, part);
        } else if (p.providerMetadata) {
          textRefs.get(p.id)!.providerMetadata = p.providerMetadata;
        }
        break;
      }
      case 'text-delta': {
        const p = chunk.payload as TextDeltaPayload;
        let ref = textRefs.get(p.id);
        // Auto-create part if delta arrives without a matching text-start
        if (!ref) {
          ref = { type: 'text' as const, text: '', providerMetadata: p.providerMetadata };
          parts.push(ref as MastraMessagePart);
          textRefs.set(p.id, ref);
        }
        ref.text += p.text;
        if (p.providerMetadata) {
          ref.providerMetadata = p.providerMetadata;
        }
        break;
      }
      case 'text-end': {
        const pEnd = chunk.payload as { id: string; providerMetadata?: Record<string, any> };
        const ref = textRefs.get(pEnd.id);
        if (ref) {
          if (pEnd.providerMetadata) {
            ref.providerMetadata = pEnd.providerMetadata;
          }
          // Clean up undefined providerMetadata so we don't serialize { providerMetadata: undefined }
          if (!ref.providerMetadata) {
            delete ref.providerMetadata;
          }
          textRefs.delete(pEnd.id);
        }
        break;
      }

      // ── Reasoning span ─────────────────────────────────────────
      case 'reasoning-start': {
        const p = chunk.payload as ReasoningStartPayload;
        const isRedacted = Object.values(p.providerMetadata || {}).some((v: any) => v?.redactedData);

        if (!reasoningRefs.has(p.id)) {
          const part = {
            type: 'reasoning' as const,
            reasoning: '',
            details: isRedacted ? [{ type: 'redacted', data: '' }] : [{ type: 'text', text: '' }],
            providerMetadata: p.providerMetadata,
          };
          parts.push(part as MastraMessagePart);
          reasoningRefs.set(p.id, part);
        } else {
          const existing = reasoningRefs.get(p.id)!;
          if (p.providerMetadata) {
            existing.providerMetadata = p.providerMetadata;
          }
          if (isRedacted && existing.details[0]?.type !== 'redacted') {
            existing.details = [{ type: 'redacted', data: '' }];
          }
        }
        break;
      }
      case 'reasoning-delta': {
        const p = chunk.payload as ReasoningDeltaPayload;
        let ref = reasoningRefs.get(p.id);
        // Auto-create part if delta arrives without a matching reasoning-start
        if (!ref) {
          ref = {
            type: 'reasoning' as const,
            reasoning: '',
            details: [{ type: 'text', text: '' }],
            providerMetadata: p.providerMetadata,
          };
          parts.push(ref as MastraMessagePart);
          reasoningRefs.set(p.id, ref);
        }
        // Append to the text detail
        const detail = ref.details[0];
        if (detail && detail.type === 'text') {
          detail.text += p.text;
        }
        if (p.providerMetadata) {
          ref.providerMetadata = p.providerMetadata;
        }
        break;
      }
      case 'reasoning-end': {
        const p = chunk.payload as { id: string; providerMetadata?: Record<string, any> };
        const ref = reasoningRefs.get(p.id);
        if (ref) {
          if (p.providerMetadata) {
            ref.providerMetadata = p.providerMetadata;
          }
          reasoningRefs.delete(p.id);
        }
        break;
      }

      // Redacted reasoning can appear as a standalone chunk (not wrapped in start/end)
      case 'redacted-reasoning': {
        const p = chunk.payload as { id: string; data: unknown; providerMetadata?: Record<string, any> };
        parts.push({
          type: 'reasoning' as const,
          reasoning: '',
          details: [{ type: 'redacted', data: '' }],
          providerMetadata: p.providerMetadata,
        } as MastraMessagePart);
        break;
      }

      // ── Source ──────────────────────────────────────────────────
      case 'source': {
        const p = chunk.payload as SourcePayload;
        parts.push({
          type: 'source',
          source: {
            sourceType: 'url',
            id: p.id,
            url: p.url || '',
            title: p.title,
            providerMetadata: p.providerMetadata,
          },
        } as MastraMessagePart);
        break;
      }

      // ── File ───────────────────────────────────────────────────
      case 'file': {
        const p = chunk.payload as FilePayload;
        parts.push({
          type: 'file' as const,
          data: p.data,
          mimeType: p.mimeType,
          ...(p.providerMetadata ? { providerMetadata: p.providerMetadata } : {}),
        } as MastraMessagePart);
        break;
      }

      // ── Tool call ──────────────────────────────────────────────
      case 'tool-call': {
        const p = chunk.payload as ToolCallPayload;
        const toolDef = tools?.[p.toolName] || findProviderToolByName(tools, p.toolName);
        const providerExecuted = inferProviderExecuted(p.providerExecuted, toolDef);

        // Check if we have a matching result from a provider-executed tool
        const result = toolResults.get(p.toolCallId);

        if (result) {
          // Merge call + result into a single 'result' state part
          const resultProviderExecuted = inferProviderExecuted(result.providerExecuted, toolDef);
          parts.push({
            type: 'tool-invocation' as const,
            toolInvocation: {
              state: 'result' as const,
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              args: p.args,
              result: result.result,
            },
            providerMetadata: result.providerMetadata ?? p.providerMetadata,
            providerExecuted: resultProviderExecuted,
          } as MastraMessagePart);
        } else {
          // No result yet — emit as 'call' state
          parts.push({
            type: 'tool-invocation' as const,
            toolInvocation: {
              state: 'call' as const,
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              args: p.args,
            },
            providerMetadata: p.providerMetadata,
            providerExecuted,
          } as MastraMessagePart);
        }
        break;
      }

      // tool-result is consumed above via the toolResults map — no direct handling needed here
      // All other chunk types (finish, error, response-metadata, etc.) don't produce message parts
      default:
        break;
    }
  }

  // Finalize any unclosed text spans (stream ended without text-end)
  for (const [, ref] of textRefs) {
    if (!ref.providerMetadata) {
      delete ref.providerMetadata;
    }
  }

  // Filter out empty text parts (spans that received no deltas)
  const filteredParts = parts.filter(p => !(p.type === 'text' && (p as any).text === ''));

  // Insert step-start markers between tool-invocation and subsequent text parts.
  // This matches the convention used by MessageMerger.pushNewPart when merging messages,
  // and is required so that AI SDK convertToModelMessages splits them into separate steps.
  const finalParts: MastraMessagePart[] = [];
  for (let i = 0; i < filteredParts.length; i++) {
    const part = filteredParts[i]!;
    if (
      part.type === 'text' &&
      finalParts.length > 0 &&
      finalParts[finalParts.length - 1]?.type === 'tool-invocation'
    ) {
      finalParts.push({ type: 'step-start' } as MastraMessagePart);
    }
    finalParts.push(part);
  }

  if (finalParts.length === 0) {
    return [];
  }

  // TODO: remove in v2, this is added for backwards compatibility. We used to double add response messages accidentally, and the second path added them in ai sdk format, which had this duplicated content field.
  const contentString = finalParts
    .filter((part): part is Extract<MastraMessagePart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('\n');

  // Build a single assistant message with all parts in stream order
  const message: MastraDBMessage = {
    id: messageId,
    role: 'assistant' as const,
    content: {
      format: 2,
      parts: finalParts,
      ...(contentString ? { content: contentString } : {}),
      ...responseModelMetadata,
    },
    createdAt: new Date(),
  };

  return [message];
}
