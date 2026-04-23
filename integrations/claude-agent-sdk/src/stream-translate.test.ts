import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChunkType } from '@mastra/core/stream';
import { ChunkFrom } from '@mastra/core/stream';
import { describe, expect, it } from 'vitest';

import type { ShellStreamEvent } from './stream-events';
import { shellStreamToMastraChunks } from './stream-translate';

async function* fromArray<T>(items: T[]): AsyncGenerator<T, void, void> {
  for (const item of items) yield item;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
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

function userMessage(content: unknown, uuid = 'user-1'): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content } as any,
    parent_tool_use_id: null,
    uuid,
    session_id: 'sess-1',
  } as unknown as SDKMessage;
}

const RUN = 'run-test';
const mk = (events: ShellStreamEvent[]) =>
  shellStreamToMastraChunks(fromArray(events), { runId: RUN });

describe('shellStreamToMastraChunks', () => {
  it('brackets an empty event stream with start → step-start → step-finish → finish', async () => {
    const out = await collect(mk([]));
    expect(out.map(c => c.type)).toEqual(['start', 'step-start', 'step-finish', 'finish']);
  });

  it('tags every AgentChunkType with runId + ChunkFrom.AGENT', async () => {
    const out = await collect(mk([]));
    for (const chunk of out) {
      // Only AgentChunkType entries carry runId + from.
      expect(chunk).toMatchObject({ runId: RUN, from: ChunkFrom.AGENT });
    }
  });

  it('forwards messageId onto step-start/step-finish payloads', async () => {
    const out = await collect(
      shellStreamToMastraChunks(fromArray<ShellStreamEvent>([]), { runId: RUN, messageId: 'm-42' }),
    );
    const stepStart = out.find(c => c.type === 'step-start') as any;
    const stepFinish = out.find(c => c.type === 'step-finish') as any;
    expect(stepStart.payload.messageId).toBe('m-42');
    expect(stepFinish.payload.messageId).toBe('m-42');
  });

  it('emits a transient data-claude-agent-session chunk for a session event', async () => {
    const out = await collect(mk([{ type: 'session', sessionId: 'sess-real-id' }]));
    const session = out.find(c => c.type === 'data-claude-agent-session');
    expect(session).toEqual({
      type: 'data-claude-agent-session',
      data: { sessionId: 'sess-real-id' },
      transient: true,
    });
  });

  it('translates assistant text → text-start/text-delta/text-end with Mastra payloads', async () => {
    const out = await collect(
      mk([{ type: 'message', message: assistantMessage([{ type: 'text', text: 'hello' }]) }]),
    );

    const between = out.slice(2, -2);
    expect(between).toEqual([
      { runId: RUN, from: ChunkFrom.AGENT, type: 'text-start', payload: { id: 'asst-1-text-0' } },
      { runId: RUN, from: ChunkFrom.AGENT, type: 'text-delta', payload: { id: 'asst-1-text-0', text: 'hello' } },
      { runId: RUN, from: ChunkFrom.AGENT, type: 'text-end', payload: { id: 'asst-1-text-0' } },
    ]);
  });

  it('translates assistant thinking → reasoning-{start,delta,end}', async () => {
    const out = await collect(
      mk([{ type: 'message', message: assistantMessage([{ type: 'thinking', thinking: 'plan' }]) }]),
    );

    const between = out.slice(2, -2);
    expect(between).toEqual([
      { runId: RUN, from: ChunkFrom.AGENT, type: 'reasoning-start', payload: { id: 'asst-1-reasoning-0' } },
      {
        runId: RUN,
        from: ChunkFrom.AGENT,
        type: 'reasoning-delta',
        payload: { id: 'asst-1-reasoning-0', text: 'plan' },
      },
      { runId: RUN, from: ChunkFrom.AGENT, type: 'reasoning-end', payload: { id: 'asst-1-reasoning-0' } },
    ]);
  });

  it('translates assistant tool_use → tool-call with ToolCallPayload', async () => {
    const out = await collect(
      mk([
        {
          type: 'message',
          message: assistantMessage([
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'mcp__mastra__writeNote',
              input: { title: 'a', body: 'b' },
            },
          ]),
        },
      ]),
    );

    expect(out).toContainEqual({
      runId: RUN,
      from: ChunkFrom.AGENT,
      type: 'tool-call',
      payload: {
        toolCallId: 'tu_1',
        toolName: 'mcp__mastra__writeNote',
        args: { title: 'a', body: 'b' },
      },
    });
  });

  it('translates user tool_result → tool-result with stringified content', async () => {
    const out = await collect(
      mk([
        {
          type: 'message',
          message: userMessage([{ type: 'tool_result', tool_use_id: 'tu_1', content: 'note saved' }]),
        },
      ]),
    );

    expect(out).toContainEqual({
      runId: RUN,
      from: ChunkFrom.AGENT,
      type: 'tool-result',
      payload: {
        toolCallId: 'tu_1',
        toolName: '',
        result: 'note saved',
        isError: false,
      },
    });
  });

  it('translates is_error tool_result → tool-result with isError=true', async () => {
    const out = await collect(
      mk([
        {
          type: 'message',
          message: userMessage([
            { type: 'tool_result', tool_use_id: 'tu_x', content: 'boom', is_error: true },
          ]),
        },
      ]),
    );

    expect(out).toContainEqual({
      runId: RUN,
      from: ChunkFrom.AGENT,
      type: 'tool-result',
      payload: { toolCallId: 'tu_x', toolName: '', result: 'boom', isError: true },
    });
  });

  it('skips partial_assistant (stream_event) message envelopes (Landmine #13)', async () => {
    const partial = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
      parent_tool_use_id: null,
      uuid: 'partial',
      session_id: 'sess-1',
    } as unknown as SDKMessage;

    const out = await collect(
      mk([
        { type: 'message', message: partial },
        { type: 'message', message: assistantMessage([{ type: 'text', text: 'final' }]) },
      ]),
    );

    const between = out.slice(2, -2);
    expect(between.map(c => c.type)).toEqual(['text-start', 'text-delta', 'text-end']);
    expect(between).toContainEqual({
      runId: RUN,
      from: ChunkFrom.AGENT,
      type: 'text-delta',
      payload: { id: 'asst-1-text-0', text: 'final' },
    });
  });

  it('passes approval-request + approval-resolved as transient data-* chunks', async () => {
    const request = {
      approvalId: 'a-1',
      sessionId: 's-1',
      toolName: 'mcp__mastra__writeNote',
      input: { title: 'x' },
      createdAt: 0,
    } as any;

    const out = await collect(
      mk([
        { type: 'approval-request', request },
        { type: 'approval-resolved', approvalId: 'a-1', decision: 'approve' },
      ]),
    );

    expect(out).toContainEqual({
      type: 'data-claude-agent-approval-request',
      data: request,
      transient: true,
    });
    expect(out).toContainEqual({
      type: 'data-claude-agent-approval-resolved',
      data: { approvalId: 'a-1', decision: 'approve' },
      transient: true,
    });
  });

  it('passes question-request + question-resolved as transient data-* chunks', async () => {
    const request = {
      questionId: 'q-1',
      sessionId: 's-1',
      questions: [
        {
          question: 'pick',
          header: 'h',
          multiSelect: false,
          options: [{ label: 'one', description: 'd' }],
        },
      ],
      createdAt: 0,
    } as any;

    const out = await collect(
      mk([
        { type: 'question-request', request },
        { type: 'question-resolved', questionId: 'q-1' },
      ]),
    );

    expect(out).toContainEqual({
      type: 'data-claude-agent-question-request',
      data: request,
      transient: true,
    });
    expect(out).toContainEqual({
      type: 'data-claude-agent-question-resolved',
      data: { questionId: 'q-1' },
      transient: true,
    });
  });

  it('emits an error chunk for shell error events but still closes the stream cleanly', async () => {
    const out = await collect(mk([{ type: 'error', error: { message: 'boom' } }]));
    expect(out).toContainEqual({
      runId: RUN,
      from: ChunkFrom.AGENT,
      type: 'error',
      payload: { error: { message: 'boom' } },
    });
    // Always finalize so Studio can release spinner state.
    expect(out[out.length - 2]?.type).toBe('step-finish');
    expect(out[out.length - 1]?.type).toBe('finish');
    // Finish reason reflects the error.
    const finish = out[out.length - 1] as any;
    expect(finish.payload.stepResult.reason).toBe('error');
  });

  it('attaches finish event aggregates as metadata on the finish chunk', async () => {
    const out = await collect(
      mk([{ type: 'finish', isError: false, totalCostUsd: 0.0123, numTurns: 1, durationMs: 4000 }]),
    );

    const finish = out[out.length - 1] as any;
    expect(finish.type).toBe('finish');
    expect(finish.payload.metadata).toMatchObject({
      isError: false,
      totalCostUsd: 0.0123,
      numTurns: 1,
      durationMs: 4000,
    });
    expect(finish.payload.stepResult.reason).toBe('stop');
  });

  it('emits chunks in stream order: session → message → approval → finish', async () => {
    const events: ShellStreamEvent[] = [
      { type: 'session', sessionId: 's-1' },
      { type: 'message', message: assistantMessage([{ type: 'text', text: 'hi' }]) },
      {
        type: 'approval-request',
        request: {
          approvalId: 'a-1',
          sessionId: 's-1',
          toolName: 't',
          input: {},
          createdAt: 0,
        } as any,
      },
      { type: 'finish', isError: false },
    ];

    const out = await collect(mk(events));
    const types: ChunkType['type'][] = out.map(c => c.type);

    const idxSession = types.indexOf('data-claude-agent-session');
    const idxText = types.indexOf('text-start');
    const idxApproval = types.indexOf('data-claude-agent-approval-request');
    const idxFinish = types.indexOf('finish');

    expect(idxSession).toBeLessThan(idxText);
    expect(idxText).toBeLessThan(idxApproval);
    expect(idxApproval).toBeLessThan(idxFinish);
  });
});
