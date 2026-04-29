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
          { type: 'user-message', contents: 'first signal' },
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
    expect(secondPrompt).toContain('system-reminder');
    expect(secondPrompt).toContain('agent-signal');
  });
});
