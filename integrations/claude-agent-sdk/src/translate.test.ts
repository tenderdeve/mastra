import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { sdkMessagesToUiMessages } from './translate';
import type { UiToolPart } from './translate';

function userMessage(content: unknown, uuid = 'user-1'): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content } as any,
    parent_tool_use_id: null,
    uuid,
    session_id: 'sess-1',
  } as unknown as SDKMessage;
}

function assistantMessage(content: unknown[], uuid = 'asst-1'): SDKMessage {
  return {
    type: 'assistant',
    message: { id: 'msg', role: 'assistant', content, model: 'claude', stop_reason: 'end_turn' } as any,
    parent_tool_use_id: null,
    uuid,
    session_id: 'sess-1',
  } as unknown as SDKMessage;
}

describe('sdkMessagesToUiMessages', () => {
  it('returns empty array for empty input', () => {
    expect(sdkMessagesToUiMessages([])).toEqual([]);
  });

  it('converts a string-content user message into a single text part', () => {
    const out = sdkMessagesToUiMessages([userMessage('hello there')]);
    expect(out).toEqual([
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'hello there' }],
      },
    ]);
  });

  it('converts assistant text + thinking + tool_use blocks', () => {
    const out = sdkMessagesToUiMessages([
      assistantMessage([
        { type: 'thinking', thinking: 'let me think...' },
        { type: 'text', text: 'Sure, here is the result.' },
        { type: 'tool_use', id: 'tu_1', name: 'mcp__mastra__writeNote', input: { title: 'a', body: 'b' } },
      ]),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('assistant');
    expect(out[0]?.parts).toEqual([
      { type: 'reasoning', text: 'let me think...', state: 'done' },
      { type: 'text', text: 'Sure, here is the result.', state: 'done' },
      {
        type: 'tool-mcp__mastra__writeNote',
        toolCallId: 'tu_1',
        state: 'input-available',
        input: { title: 'a', body: 'b' },
      },
    ]);
  });

  it('pairs tool_result back into the matching assistant tool_use part', () => {
    const out = sdkMessagesToUiMessages([
      assistantMessage(
        [{ type: 'tool_use', id: 'tu_1', name: 'mcp__mastra__writeNote', input: { title: 'a' } }],
        'asst-1',
      ),
      userMessage(
        [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'note saved' }],
        'tool-result-1',
      ),
    ]);

    // tool_result should fold into the assistant message, not create a new user bubble.
    expect(out).toHaveLength(1);
    const part = out[0]?.parts[0] as UiToolPart;
    expect(part.type).toBe('tool-mcp__mastra__writeNote');
    expect(part.state).toBe('output-available');
    expect(part.output).toBe('note saved');
  });

  it('marks tool result as output-error when is_error is true', () => {
    const out = sdkMessagesToUiMessages([
      assistantMessage(
        [{ type: 'tool_use', id: 'tu_err', name: 'mcp__mastra__writeNote', input: {} }],
        'asst-1',
      ),
      userMessage(
        [{ type: 'tool_result', tool_use_id: 'tu_err', content: 'boom', is_error: true }],
        'tool-result-1',
      ),
    ]);

    const part = out[0]?.parts[0] as UiToolPart;
    expect(part.state).toBe('output-error');
    expect(part.errorText).toBe('boom');
    expect(part.output).toBeUndefined();
  });

  it('flattens array-shaped tool_result content (text blocks) into a string', () => {
    const out = sdkMessagesToUiMessages([
      assistantMessage([{ type: 'tool_use', id: 'tu_1', name: 'mcp__mastra__echo', input: {} }]),
      userMessage([
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: [
            { type: 'text', text: 'one ' },
            { type: 'text', text: 'two' },
          ],
        },
      ]),
    ]);

    expect((out[0]?.parts[0] as UiToolPart).output).toBe('one two');
  });

  it('falls back to plain text when tool_result has no matching tool_use', () => {
    const out = sdkMessagesToUiMessages([
      userMessage([{ type: 'tool_result', tool_use_id: 'orphan', content: 'orphan output' }]),
    ]);

    expect(out).toEqual([
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'orphan output' }],
      },
    ]);
  });

  it('skips partial_assistant (stream_event) messages — landmine #13', () => {
    const partial = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
      parent_tool_use_id: null,
      uuid: 'partial-1',
      session_id: 'sess-1',
    } as unknown as SDKMessage;

    const out = sdkMessagesToUiMessages([
      partial,
      assistantMessage([{ type: 'text', text: 'final answer' }]),
    ]);

    // Only the final assistant message survives.
    expect(out).toHaveLength(1);
    expect(out[0]?.parts).toEqual([{ type: 'text', text: 'final answer', state: 'done' }]);
  });

  it('skips system + result envelopes', () => {
    const systemInit = {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'env',
      cwd: '/tmp',
      tools: [],
      mcp_servers: [],
      model: 'claude',
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      claude_code_version: '0.2',
      uuid: 'sys-1',
      session_id: 'sess-1',
    } as unknown as SDKMessage;

    const result = {
      type: 'result',
      subtype: 'success',
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 1,
      result: 'ok',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: {} as any,
      modelUsage: {},
      permission_denials: [],
      uuid: 'res-1',
      session_id: 'sess-1',
    } as unknown as SDKMessage;

    const out = sdkMessagesToUiMessages([
      systemInit,
      userMessage('hi'),
      assistantMessage([{ type: 'text', text: 'hello' }]),
      result,
    ]);

    expect(out.map(m => m.role)).toEqual(['user', 'assistant']);
  });

  it('preserves SDK uuid as message id when present', () => {
    const out = sdkMessagesToUiMessages([
      userMessage('a', 'u-aaa'),
      assistantMessage([{ type: 'text', text: 'b' }], 'a-bbb'),
    ]);

    expect(out[0]?.id).toBe('u-aaa');
    expect(out[1]?.id).toBe('a-bbb');
  });

  it('drops assistant messages that contain only unknown blocks', () => {
    const out = sdkMessagesToUiMessages([
      assistantMessage([{ type: 'image', source: { type: 'base64', data: 'x' } } as any]),
    ]);

    expect(out).toEqual([]);
  });

  it('handles multiple tool_use → tool_result pairs in order', () => {
    const out = sdkMessagesToUiMessages([
      assistantMessage([
        { type: 'tool_use', id: 'a', name: 'mcp__mastra__one', input: {} },
        { type: 'tool_use', id: 'b', name: 'mcp__mastra__two', input: {} },
      ]),
      userMessage([
        { type: 'tool_result', tool_use_id: 'b', content: 'two-result' },
        { type: 'tool_result', tool_use_id: 'a', content: 'one-result' },
      ]),
    ]);

    expect(out).toHaveLength(1);
    const [partA, partB] = out[0]!.parts as UiToolPart[];
    expect(partA.toolCallId).toBe('a');
    expect(partA.output).toBe('one-result');
    expect(partB.toolCallId).toBe('b');
    expect(partB.output).toBe('two-result');
  });
});
