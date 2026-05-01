import { describe, expect, it } from 'vitest';

import type { CollectedChunk } from './build-messages-from-chunks';
import { buildMessagesFromChunks } from './build-messages-from-chunks';

function build(chunks: CollectedChunk[], tools?: any) {
  return buildMessagesFromChunks({
    chunks,
    messageId: 'msg-1',
    tools,
  });
}

function parts(chunks: CollectedChunk[], tools?: any) {
  const msgs = build(chunks, tools);
  return msgs[0]?.content.parts ?? [];
}

describe('buildMessagesFromChunks', () => {
  // ── Text spans ──────────────────────────────────────────────

  it('should produce a single text part from a text-start/delta/end span', () => {
    const result = parts([
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-delta', payload: { id: 't1', text: 'Hello' } },
      { type: 'text-delta', payload: { id: 't1', text: ', world!' } },
      { type: 'text-end', payload: { id: 't1' } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'text', text: 'Hello, world!' });
  });

  it('should skip empty text spans (no deltas)', () => {
    const result = parts([
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-end', payload: { id: 't1' } },
    ]);
    expect(result).toHaveLength(0);
  });

  it('should skip text spans with only empty-string deltas', () => {
    const result = parts([
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-delta', payload: { id: 't1', text: '' } },
      { type: 'text-delta', payload: { id: 't1', text: '' } },
      { type: 'text-end', payload: { id: 't1' } },
    ]);
    expect(result).toHaveLength(0);
  });

  it('should handle text-delta without a matching text-start', () => {
    const result = parts([
      { type: 'text-delta', payload: { id: 't1', text: 'orphan' } },
      { type: 'text-end', payload: { id: 't1' } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'text', text: 'orphan' });
  });

  it('should flush unclosed text spans at end of stream', () => {
    const result = parts([
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-delta', payload: { id: 't1', text: 'truncated' } },
      // No text-end
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'text', text: 'truncated' });
  });

  // ── Interleaved text spans ──────────────────────────────────

  it('should correctly separate interleaved text spans by ID', () => {
    const result = parts([
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-start', payload: { id: 't2' } },
      { type: 'text-delta', payload: { id: 't1', text: 'Hello' } },
      { type: 'text-delta', payload: { id: 't2', text: 'Goodbye' } },
      { type: 'text-delta', payload: { id: 't1', text: ', world!' } },
      { type: 'text-end', payload: { id: 't2' } },
      { type: 'text-end', payload: { id: 't1' } },
    ]);
    expect(result).toHaveLength(2);
    // Parts are emitted in text-start order (the order spans began in the stream).
    // See #16007 — emitting at *-end caused tool-calls and other interleaved parts
    // to be reordered relative to the spans that started before them.
    expect(result[0]).toMatchObject({ type: 'text', text: 'Hello, world!' });
    expect(result[1]).toMatchObject({ type: 'text', text: 'Goodbye' });
  });

  // ── ProviderMetadata cascading ──────────────────────────────

  it('should use providerMetadata from text-start by default', () => {
    const meta = { openai: { itemId: 'msg_1' } };
    const result = parts([
      { type: 'text-start', payload: { id: 't1', providerMetadata: meta } },
      { type: 'text-delta', payload: { id: 't1', text: 'hi' } },
      { type: 'text-end', payload: { id: 't1' } },
    ]);
    expect(result[0]?.providerMetadata).toEqual(meta);
  });

  it('should use latest non-null providerMetadata (text-end wins)', () => {
    const startMeta = { openai: { itemId: 'start' } };
    const endMeta = { openai: { itemId: 'end' } };
    const result = parts([
      { type: 'text-start', payload: { id: 't1', providerMetadata: startMeta } },
      { type: 'text-delta', payload: { id: 't1', text: 'hi' } },
      { type: 'text-end', payload: { id: 't1', providerMetadata: endMeta } },
    ]);
    expect(result[0]?.providerMetadata).toEqual(endMeta);
  });

  // ── Reasoning spans ─────────────────────────────────────────

  it('should produce a reasoning part from a reasoning-start/delta/end span', () => {
    const result = parts([
      { type: 'reasoning-start', payload: { id: 'r1' } },
      { type: 'reasoning-delta', payload: { id: 'r1', text: 'Thinking...' } },
      { type: 'reasoning-end', payload: { id: 'r1' } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'reasoning',
      details: [{ type: 'text', text: 'Thinking...' }],
    });
  });

  it('should emit empty reasoning parts (needed for OpenAI item_reference)', () => {
    const result = parts([
      { type: 'reasoning-start', payload: { id: 'r1' } },
      { type: 'reasoning-end', payload: { id: 'r1' } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'reasoning',
      details: [{ type: 'text', text: '' }],
    });
  });

  it('should use latest providerMetadata for reasoning (end wins)', () => {
    const startMeta = { openai: { itemId: 'rs_start', signature: 'aaa' } };
    const endMeta = { openai: { itemId: 'rs_end', signature: 'bbb' } };
    const result = parts([
      { type: 'reasoning-start', payload: { id: 'r1', providerMetadata: startMeta } },
      { type: 'reasoning-delta', payload: { id: 'r1', text: 'think' } },
      { type: 'reasoning-end', payload: { id: 'r1', providerMetadata: endMeta } },
    ]);
    expect(result[0]?.providerMetadata).toEqual(endMeta);
  });

  it('should handle redacted reasoning', () => {
    const result = parts([
      {
        type: 'reasoning-start',
        payload: { id: 'r1', providerMetadata: { deepseek: { redactedData: 'abc' } } },
      },
      { type: 'reasoning-end', payload: { id: 'r1' } },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'reasoning',
      details: [{ type: 'redacted', data: '' }],
    });
  });

  it('should handle standalone redacted-reasoning chunks', () => {
    const meta = { deepseek: { redactedData: 'abc' } };
    const result = parts([{ type: 'redacted-reasoning', payload: { id: 'r1', data: 'abc', providerMetadata: meta } }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'reasoning',
      details: [{ type: 'redacted', data: '' }],
      providerMetadata: meta,
    });
  });

  it('should merge interleaved reasoning spans by ID', () => {
    const result = parts([
      { type: 'reasoning-start', payload: { id: 'r1' } },
      { type: 'reasoning-start', payload: { id: 'r2' } },
      { type: 'reasoning-delta', payload: { id: 'r1', text: 'Thought A. ' } },
      { type: 'reasoning-delta', payload: { id: 'r2', text: 'Thought B.' } },
      { type: 'reasoning-delta', payload: { id: 'r1', text: 'More A.' } },
      { type: 'reasoning-end', payload: { id: 'r1' } },
      { type: 'reasoning-end', payload: { id: 'r2' } },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'reasoning', details: [{ type: 'text', text: 'Thought A. More A.' }] });
    expect(result[1]).toMatchObject({ type: 'reasoning', details: [{ type: 'text', text: 'Thought B.' }] });
  });

  // ── Tool calls ──────────────────────────────────────────────

  it('should produce a tool-invocation part with state: call', () => {
    const result = parts([
      {
        type: 'tool-call',
        payload: { toolCallId: 'tc1', toolName: 'myTool', args: { q: 'test' } },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'tool-invocation',
      toolInvocation: {
        state: 'call',
        toolCallId: 'tc1',
        toolName: 'myTool',
        args: { q: 'test' },
      },
    });
  });

  it('should merge tool-call + tool-result into a single result part', () => {
    const result = parts([
      {
        type: 'tool-call',
        payload: { toolCallId: 'tc1', toolName: 'myTool', args: { q: 'test' } },
      },
      {
        type: 'tool-result',
        payload: {
          toolCallId: 'tc1',
          toolName: 'myTool',
          args: { q: 'test' },
          result: { answer: '42' },
        },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'tool-invocation',
      toolInvocation: {
        state: 'result',
        toolCallId: 'tc1',
        toolName: 'myTool',
        args: { q: 'test' },
        result: { answer: '42' },
      },
    });
  });

  // ── Source and file parts ───────────────────────────────────

  it('should produce a source part', () => {
    const result = parts([
      {
        type: 'source',
        payload: { id: 's1', url: 'https://example.com', title: 'Example' },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'source',
      source: { sourceType: 'url', url: 'https://example.com', title: 'Example' },
    });
  });

  it('should produce a file part', () => {
    const result = parts([
      {
        type: 'file',
        payload: { data: 'base64data', mimeType: 'image/png' },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'file', data: 'base64data', mimeType: 'image/png' });
  });

  // ── step-start insertion ────────────────────────────────────

  it('should insert step-start between tool-invocation and text', () => {
    const result = parts([
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-delta', payload: { id: 't1', text: 'Before tool' } },
      { type: 'text-end', payload: { id: 't1' } },
      {
        type: 'tool-call',
        payload: { toolCallId: 'tc1', toolName: 'myTool', args: {} },
      },
      {
        type: 'tool-result',
        payload: { toolCallId: 'tc1', toolName: 'myTool', args: {}, result: 'ok' },
      },
      { type: 'text-start', payload: { id: 't2' } },
      { type: 'text-delta', payload: { id: 't2', text: 'After tool' } },
      { type: 'text-end', payload: { id: 't2' } },
    ]);

    const types = result.map((p: any) => p.type);
    expect(types).toEqual(['text', 'tool-invocation', 'step-start', 'text']);
  });

  it('should NOT insert step-start between text and text', () => {
    const result = parts([
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-delta', payload: { id: 't1', text: 'First' } },
      { type: 'text-end', payload: { id: 't1' } },
      { type: 'text-start', payload: { id: 't2' } },
      { type: 'text-delta', payload: { id: 't2', text: 'Second' } },
      { type: 'text-end', payload: { id: 't2' } },
    ]);

    const types = result.map((p: any) => p.type);
    expect(types).toEqual(['text', 'text']);
  });

  // ── Mixed content ordering ──────────────────────────────────

  it('should preserve correct order: reasoning, text, tool-call', () => {
    const result = parts([
      { type: 'reasoning-start', payload: { id: 'r1' } },
      { type: 'reasoning-delta', payload: { id: 'r1', text: 'Thinking' } },
      { type: 'reasoning-end', payload: { id: 'r1' } },
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-delta', payload: { id: 't1', text: 'Response' } },
      { type: 'text-end', payload: { id: 't1' } },
      {
        type: 'tool-call',
        payload: { toolCallId: 'tc1', toolName: 'myTool', args: {} },
      },
    ]);

    const types = result.map((p: any) => p.type);
    expect(types).toEqual(['reasoning', 'text', 'tool-invocation']);
  });

  /**
   * Regression test for GitHub issue #16007
   * https://github.com/mastra-ai/mastra/issues/16007
   *
   * OpenAI reasoning models (gpt-5/o3) with AI SDK v6 emit chunk sequences
   * where tool-call chunks arrive INSIDE a reasoning span (between
   * reasoning-start and reasoning-end). The live trace order is:
   *   reasoning → tool:read → tool:grep → reasoning → text
   *
   * But the part-emission strategy in buildMessagesFromChunks pushes
   * tool-invocation parts immediately while reasoning parts are only pushed
   * at reasoning-end. With interleaved chunks this reorders the persisted
   * message: tools end up BEFORE the reasoning that produced them.
   */
  it('should preserve order when tool-call arrives inside a reasoning span (#16007)', () => {
    const result = parts([
      // First reasoning span wraps the first batch of tool calls
      { type: 'reasoning-start', payload: { id: 'r1' } },
      { type: 'reasoning-delta', payload: { id: 'r1', text: 'Need to read and grep.' } },
      {
        type: 'tool-call',
        payload: { toolCallId: 'tc-read', toolName: 'read', args: { path: 'a.txt' } },
      },
      {
        type: 'tool-result',
        payload: { toolCallId: 'tc-read', toolName: 'read', args: { path: 'a.txt' }, result: 'ok' },
      },
      {
        type: 'tool-call',
        payload: { toolCallId: 'tc-grep', toolName: 'grep', args: { pattern: 'foo' } },
      },
      {
        type: 'tool-result',
        payload: { toolCallId: 'tc-grep', toolName: 'grep', args: { pattern: 'foo' }, result: 'match' },
      },
      { type: 'reasoning-end', payload: { id: 'r1' } },
      // Second reasoning span, then final text answer
      { type: 'reasoning-start', payload: { id: 'r2' } },
      { type: 'reasoning-delta', payload: { id: 'r2', text: 'Now answer.' } },
      { type: 'reasoning-end', payload: { id: 'r2' } },
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-delta', payload: { id: 't1', text: 'Final answer' } },
      { type: 'text-end', payload: { id: 't1' } },
    ]);

    const types = result.map((p: any) => p.type);

    // Expected order matches the live stream order reported in the issue:
    //   reasoning → tool:read → tool:grep → reasoning → text
    // The first reasoning part is preserved before the tool-invocations
    // because its slot was reserved at reasoning-start time.
    expect(types).toEqual(['reasoning', 'tool-invocation', 'tool-invocation', 'reasoning', 'text']);

    // And the first reasoning part must contain the deltas that actually
    // arrived before the tool-calls in the stream.
    const firstReasoning = result[0] as any;
    expect(firstReasoning.type).toBe('reasoning');
    expect(firstReasoning.details[0]).toEqual({
      type: 'text',
      text: 'Need to read and grep.',
    });
  });

  /**
   * #16007 — broader coverage: an unclosed reasoning span that wraps
   * tool-calls must still land BEFORE the tool-invocations once flushed.
   */
  it('should preserve order when an unclosed reasoning span wraps tool-calls (#16007)', () => {
    const result = parts([
      { type: 'reasoning-start', payload: { id: 'r1' } },
      { type: 'reasoning-delta', payload: { id: 'r1', text: 'thinking…' } },
      {
        type: 'tool-call',
        payload: { toolCallId: 'tc-1', toolName: 'read', args: {} },
      },
      {
        type: 'tool-result',
        payload: { toolCallId: 'tc-1', toolName: 'read', args: {}, result: 'ok' },
      },
      // No reasoning-end — span flushed at end of stream
    ]);

    const types = result.map((p: any) => p.type);
    expect(types).toEqual(['reasoning', 'tool-invocation']);
    expect((result[0] as any).details[0]).toEqual({ type: 'text', text: 'thinking…' });
  });

  /**
   * #16007 — slot reservation must work for `source` and `file` parts that
   * arrive between reasoning-start and reasoning-end. Source/file parts are
   * pushed immediately, so they should land between the reserved reasoning
   * slot and any later parts.
   */
  it('should preserve order when source/file parts arrive inside a reasoning span (#16007)', () => {
    const result = parts([
      { type: 'reasoning-start', payload: { id: 'r1' } },
      { type: 'reasoning-delta', payload: { id: 'r1', text: 'consulting sources' } },
      {
        type: 'source',
        payload: {
          id: 's1',
          sourceType: 'url',
          url: 'https://example.com',
          title: 'Example',
        },
      },
      {
        type: 'file',
        payload: { mediaType: 'text/plain', data: 'hello' },
      },
      { type: 'reasoning-end', payload: { id: 'r1' } },
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-delta', payload: { id: 't1', text: 'done' } },
      { type: 'text-end', payload: { id: 't1' } },
    ]);

    const types = result.map((p: any) => p.type);
    expect(types).toEqual(['reasoning', 'source', 'file', 'text']);
  });

  /**
   * #16007 — empty text spans inside a reasoning span must not shift
   * neighbouring slots out of order. The empty text leaves a `null` placeholder
   * which is filtered out at the end without disturbing other parts.
   */
  it('should keep order intact when an empty text span sits between reasoning and tool-call (#16007)', () => {
    const result = parts([
      { type: 'reasoning-start', payload: { id: 'r1' } },
      { type: 'reasoning-delta', payload: { id: 'r1', text: 'plan' } },
      // Empty text span — reserves a slot but produces no part
      { type: 'text-start', payload: { id: 't-empty' } },
      { type: 'text-end', payload: { id: 't-empty' } },
      {
        type: 'tool-call',
        payload: { toolCallId: 'tc-1', toolName: 'read', args: {} },
      },
      {
        type: 'tool-result',
        payload: { toolCallId: 'tc-1', toolName: 'read', args: {}, result: 'ok' },
      },
      { type: 'reasoning-end', payload: { id: 'r1' } },
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-delta', payload: { id: 't1', text: 'answer' } },
      { type: 'text-end', payload: { id: 't1' } },
    ]);

    const types = result.map((p: any) => p.type);
    expect(types).toEqual(['reasoning', 'tool-invocation', 'step-start', 'text']);
  });

  /**
   * #16007 — auto-created spans (delta arrives without *-start) must also
   * reserve their slot at the position the delta first appeared.
   */
  it('should preserve order for auto-created reasoning span wrapping a tool-call (#16007)', () => {
    const result = parts([
      // No reasoning-start — span auto-created on first delta
      { type: 'reasoning-delta', payload: { id: 'r1', text: 'auto' } },
      {
        type: 'tool-call',
        payload: { toolCallId: 'tc-1', toolName: 'read', args: {} },
      },
      {
        type: 'tool-result',
        payload: { toolCallId: 'tc-1', toolName: 'read', args: {}, result: 'ok' },
      },
      { type: 'reasoning-end', payload: { id: 'r1' } },
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-delta', payload: { id: 't1', text: 'final' } },
      { type: 'text-end', payload: { id: 't1' } },
    ]);

    const types = result.map((p: any) => p.type);
    expect(types).toEqual(['reasoning', 'tool-invocation', 'step-start', 'text']);
  });

  // ── Empty stream / no parts ─────────────────────────────────

  it('should return empty array for empty chunks', () => {
    const result = build([]);
    expect(result).toEqual([]);
  });

  it('should return empty array when only non-part chunks exist', () => {
    const result = build([
      { type: 'response-metadata', payload: { id: 'id-1', modelId: 'test' } },
      { type: 'finish', payload: { finishReason: 'stop', usage: {} } },
    ]);
    expect(result).toEqual([]);
  });

  // ── Message structure ───────────────────────────────────────

  it('should produce a single assistant message with correct ID and format', () => {
    const msgs = build([
      { type: 'text-start', payload: { id: 't1' } },
      { type: 'text-delta', payload: { id: 't1', text: 'Hello' } },
      { type: 'text-end', payload: { id: 't1' } },
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.id).toBe('msg-1');
    expect(msgs[0]!.role).toBe('assistant');
    expect(msgs[0]!.content.format).toBe(2);
    expect(msgs[0]!.createdAt).toBeInstanceOf(Date);
  });

  it('should include responseModelMetadata in content', () => {
    const msgs = buildMessagesFromChunks({
      chunks: [
        { type: 'text-start', payload: { id: 't1' } },
        { type: 'text-delta', payload: { id: 't1', text: 'hi' } },
        { type: 'text-end', payload: { id: 't1' } },
      ],
      messageId: 'msg-1',
      responseModelMetadata: { metadata: { modelId: 'gpt-5' } },
    });
    expect(msgs[0]!.content.metadata).toEqual({ modelId: 'gpt-5' });
  });

  it('should prefer configured modelId over API response modelId in metadata', () => {
    // This test documents that responseModelMetadata should contain the configured
    // model ID (e.g., 'gpt-5.4'), not the API response model ID (e.g., 'gpt-5.4-2026-03-05').
    // The caller (buildResponseModelMetadata) is responsible for this preference.
    const msgs = buildMessagesFromChunks({
      chunks: [
        { type: 'text-start', payload: { id: 't1' } },
        { type: 'text-delta', payload: { id: 't1', text: 'response' } },
        { type: 'text-end', payload: { id: 't1' } },
      ],
      messageId: 'msg-1',
      responseModelMetadata: { metadata: { modelId: 'gpt-5.4', provider: 'openai.responses' } },
    });
    // Verify the configured modelId is preserved in the message metadata
    expect(msgs[0]!.content.metadata).toEqual({ modelId: 'gpt-5.4', provider: 'openai.responses' });
  });
});
