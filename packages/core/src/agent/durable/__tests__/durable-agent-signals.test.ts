import type { LanguageModelV2 } from '@ai-sdk/provider-v5';
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EventEmitterPubSub } from '../../../events/event-emitter';
import { createTool } from '../../../tools';
import { Agent } from '../../agent';
import { createDurableAgent } from '../create-durable-agent';

describe('DurableAgent signals', () => {
  it('injects queued signals into the next LLM request after a tool boundary in FIFO order', async () => {
    const prompts: unknown[] = [];
    let callCount = 0;
    let durableAgent: ReturnType<typeof createDurableAgent>;

    const model = new MockLanguageModelV2({
      doStream: async options => {
        prompts.push(options.prompt);
        callCount++;
        if (callCount === 1) {
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'response-metadata', id: 'id-0', modelId: 'mock-model-id', timestamp: new Date(0) },
              {
                type: 'tool-call',
                toolCallType: 'function',
                toolCallId: 'call-1',
                toolName: 'queueSignal',
                input: JSON.stringify({}),
                providerExecuted: false,
              },
              {
                type: 'finish',
                finishReason: 'tool-calls',
                usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
              },
            ]),
            rawCall: { rawPrompt: null, rawSettings: {} },
            warnings: [],
          };
        }

        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'id-1', modelId: 'mock-model-id', timestamp: new Date(0) },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'done' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
          warnings: [],
        };
      },
    });

    const queueSignal = createTool({
      id: 'queueSignal',
      description: 'queues a signal',
      inputSchema: z.object({}),
      execute: async () => {
        durableAgent.sendSignal(
          { type: 'user-message', contents: 'first signal', username: 'Tyler' },
          { resourceId: 'user-1', threadId: 'thread-1' },
        );
        durableAgent.sendSignal(
          { type: 'system-reminder', contents: 'second signal' },
          { resourceId: 'user-1', threadId: 'thread-1' },
        );
        return 'queued';
      },
    });

    const agent = new Agent({
      id: 'signal-agent',
      name: 'Signal Agent',
      instructions: 'Use tools',
      model: model as LanguageModelV2,
      tools: { queueSignal },
    });
    durableAgent = createDurableAgent({ agent, pubsub: new EventEmitterPubSub(), cleanupTimeoutMs: 0 });

    const result = await durableAgent.stream('start', { memory: { resource: 'user-1', thread: 'thread-1' } });
    for await (const _chunk of result.fullStream as AsyncIterable<any>) {
    }
    result.cleanup();

    expect(prompts).toHaveLength(2);
    const secondPrompt = JSON.stringify(prompts[1]);
    expect(secondPrompt.indexOf('first signal')).toBeLessThan(secondPrompt.indexOf('second signal'));
    expect(secondPrompt).toContain('<user name=\\"Tyler\\">');
    expect(secondPrompt).toContain('system-reminder');
    expect(secondPrompt).toContain('agent-signal');
  });

  it('continues the loop when a signal arrives during final text streaming', async () => {
    const prompts: unknown[] = [];
    let callCount = 0;
    let resolveFirstTextStarted!: () => void;
    let releaseFirstStream!: () => void;
    const firstTextStarted = new Promise<void>(resolve => {
      resolveFirstTextStarted = resolve;
    });
    const firstStreamCanFinish = new Promise<void>(resolve => {
      releaseFirstStream = resolve;
    });

    const model = new MockLanguageModelV2({
      doStream: async options => {
        prompts.push(options.prompt);
        callCount++;

        if (callCount === 1) {
          return {
            stream: new ReadableStream({
              async start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({
                  type: 'response-metadata',
                  id: 'id-0',
                  modelId: 'mock-model-id',
                  timestamp: new Date(0),
                });
                controller.enqueue({ type: 'text-start', id: 'text-1' });
                controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'final text' });
                resolveFirstTextStarted();
                await firstStreamCanFinish;
                controller.enqueue({ type: 'text-end', id: 'text-1' });
                controller.enqueue({
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
                });
                controller.close();
              },
            }),
            rawCall: { rawPrompt: null, rawSettings: {} },
            warnings: [],
          };
        }

        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'id-1', modelId: 'mock-model-id', timestamp: new Date(0) },
            { type: 'text-start', id: 'text-2' },
            { type: 'text-delta', id: 'text-2', delta: 'responded to signal' },
            { type: 'text-end', id: 'text-2' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
          warnings: [],
        };
      },
    });

    const agent = new Agent({
      id: 'signal-during-final-agent',
      name: 'Signal During Final Agent',
      instructions: 'Respond to signals',
      model: model as LanguageModelV2,
    });
    const durableAgent = createDurableAgent({ agent, pubsub: new EventEmitterPubSub(), cleanupTimeoutMs: 0 });

    const result = await durableAgent.stream('start', { memory: { resource: 'user-1', thread: 'thread-1' } });
    const streamChunks: any[] = [];
    const drainPromise = (async () => {
      for await (const chunk of result.fullStream as AsyncIterable<any>) {
        streamChunks.push(chunk);
      }
    })();

    await firstTextStarted;
    durableAgent.sendSignal(
      { type: 'user-message', contents: 'interrupt during final text', username: 'Follower' },
      { resourceId: 'user-1', threadId: 'thread-1' },
    );
    releaseFirstStream();
    await drainPromise;
    result.cleanup();

    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain('interrupt during final text');
    const firstTextEndIndex = streamChunks.findIndex(chunk => chunk.type === 'text-end');
    const signalMessageIndex = streamChunks.findIndex(chunk => chunk.type === 'data-user-message');
    const secondTextStartIndex = streamChunks.findIndex(
      (chunk, index) => index > signalMessageIndex && chunk.type === 'text-start',
    );
    expect(signalMessageIndex).toBeGreaterThan(firstTextEndIndex);
    expect(signalMessageIndex).toBeLessThan(secondTextStartIndex);
    expect(streamChunks[signalMessageIndex]).toMatchObject({
      type: 'data-user-message',
      data: {
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'interrupt during final text' }],
          metadata: { username: 'Follower' },
        },
      },
    });
  });

  it('rejects run-id-only signals when no active run exists', () => {
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: convertArrayToReadableStream([]),
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      }),
    });

    const agent = new Agent({
      id: 'signal-agent',
      name: 'Signal Agent',
      instructions: 'Use tools',
      model: model as LanguageModelV2,
    });
    const durableAgent = createDurableAgent({ agent, pubsub: new EventEmitterPubSub(), cleanupTimeoutMs: 0 });

    expect(() => {
      durableAgent.sendSignal({ type: 'user-message', contents: 'queued before stream' }, { runId: 'run-1' });
    }).toThrow('No active durable agent run found for signal target');
  });

  it('starts an idle thread when sendSignal targets resource and thread', async () => {
    const prompts: unknown[] = [];
    let resolvePrompt!: () => void;
    const promptSeen = new Promise<void>(resolve => {
      resolvePrompt = resolve;
    });
    const model = new MockLanguageModelV2({
      doStream: async options => {
        prompts.push(options.prompt);
        resolvePrompt();
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'id-0', modelId: 'mock-model-id', timestamp: new Date(0) },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'done' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
          warnings: [],
        };
      },
    });

    const agent = new Agent({
      id: 'signal-agent',
      name: 'Signal Agent',
      instructions: 'Use tools',
      model: model as LanguageModelV2,
    });
    const durableAgent = createDurableAgent({ agent, pubsub: new EventEmitterPubSub(), cleanupTimeoutMs: 0 });

    const result = durableAgent.sendSignal(
      { type: 'user-message', contents: 'start from signal' },
      { resourceId: 'user-1', threadId: 'thread-1' },
    );
    await promptSeen;

    expect(result.accepted).toBe(true);
    expect(result.runId).toBeTruthy();
    expect(JSON.stringify(prompts[0])).toContain('start from signal');
  });
});
