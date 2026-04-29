import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { LanguageModelV2 } from '@ai-sdk/provider-v5';
import { afterEach, describe, expect, it } from 'vitest';

import { Agent } from '../agent';
import { createDurableAgent, UnixSocketDurableRunCoordinator } from '../agent/durable';
import { EventEmitterPubSub } from '../events/event-emitter';
import { AgentsMDInjector } from '../processors';
import { InMemoryStore } from '../storage/mock';
import { createTool } from '../tools';
import { Harness } from './harness';
import type { HarnessEvent } from './types';

function createTempDir() {
  const dir = join('/tmp', `mastra-hd-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const streamFrom = (items: unknown[]) =>
  new ReadableStream({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });

function createOwnerAgent(prompts: unknown[], signalArrived: Promise<void>, onReadyForSignal: () => void) {
  let callCount = 0;
  const model: LanguageModelV2 = {
    specificationVersion: 'v2',
    provider: 'mock-provider',
    modelId: 'mock-model-id',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('doGenerate not implemented');
    },
    doStream: async options => {
      prompts.push(options.prompt);
      callCount++;
      if (callCount === 1) {
        return {
          stream: streamFrom([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'id-0', modelId: 'mock-model-id', timestamp: new Date(0) },
            {
              type: 'tool-call',
              toolCallType: 'function',
              toolCallId: 'call-1',
              toolName: 'waitForSignal',
              input: JSON.stringify({}),
              providerExecuted: false,
            },
            { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
          warnings: [],
        };
      }
      return {
        stream: streamFrom([
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: 'id-1', modelId: 'mock-model-id', timestamp: new Date(0) },
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'done' },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      };
    },
  };

  const waitForSignal = createTool({
    id: 'waitForSignal',
    description: 'waits for another harness to send a signal',
    execute: async () => {
      onReadyForSignal();
      await signalArrived;
      return 'ok';
    },
  });

  return createDurableAgent({
    agent: new Agent({
      id: 'owner-agent',
      name: 'Owner Agent',
      instructions: 'Use tools',
      model,
      tools: { waitForSignal },
      inputProcessors: [
        {
          id: 'emit-om-status',
          processInputStep: async ({ writer, stepNumber }: any) => {
            await writer?.custom({
              type: 'data-om-status',
              data: {
                windows: {
                  active: {
                    messages: { tokens: stepNumber + 1, threshold: 10 },
                    observations: { tokens: stepNumber + 2, threshold: 20 },
                  },
                  buffered: { observations: {}, reflection: {} },
                },
                recordId: 'record-1',
                threadId: 'shared-thread',
                stepNumber,
                generationCount: 1,
              },
            });
          },
        },
      ],
    }),
    pubsub: new EventEmitterPubSub(),
  });
}

function createObserverAgent() {
  const model: LanguageModelV2 = {
    specificationVersion: 'v2',
    provider: 'mock-provider',
    modelId: 'mock-model-id',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('doGenerate not implemented');
    },
    doStream: async () => ({
      stream: streamFrom([
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: 'id-observer', modelId: 'mock-model-id', timestamp: new Date(0) },
        { type: 'text-start', id: 'text-observer' },
        { type: 'text-delta', id: 'text-observer', delta: 'observer should not own' },
        { type: 'text-end', id: 'text-observer' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ]),
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
    }),
  };

  return createDurableAgent({
    agent: new Agent({ id: 'observer-agent', name: 'Observer Agent', instructions: 'Observe', model }),
    pubsub: new EventEmitterPubSub(),
  });
}

function waitFor(predicate: () => boolean, label = 'condition', timeoutMs = 2000) {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('Harness durable multiplayer', () => {
  let tempDir: string | undefined;
  let coordinator: UnixSocketDurableRunCoordinator | undefined;
  const harnesses: Array<Harness<any>> = [];

  it('completes a simple owner message without observers', async () => {
    tempDir = createTempDir();
    const socketPath = join(tempDir, 'coordinator.sock');
    const agent = createDurableAgent({
      agent: new Agent({
        id: 'simple-agent',
        name: 'Simple Agent',
        instructions: 'Reply',
        model: ({ requestContext }) => createObserverAgent().getModel({ requestContext }) as any,
        inputProcessors: [
          {
            id: 'emit-system-reminder',
            processInputStep: async ({ writer }: any) => {
              await writer?.custom({
                type: 'data-system-reminder',
                data: {
                  message: 'remember this',
                  reminderType: 'test',
                  precedesMessageId: 'message-1',
                },
              });
            },
          },
          new AgentsMDInjector({
            getIgnoredInstructionPaths: () => [],
          }),
        ],
      }),
    });
    const harness = new Harness({
      id: 'mastra-code',
      resourceId: 'simple-resource',
      storage: new InMemoryStore(),
      durableStreams: { unixSocketPath: socketPath, attachToActiveThread: true, signalWhileRunning: true },
      modes: [{ id: 'default', default: true, agent: agent as any }],
    });
    harnesses.push(harness);
    const events: HarnessEvent[] = [];
    harness.subscribe(event => {
      events.push(event);
    });

    await harness.init();
    await harness.createThread({ title: 'simple' });
    await (harness as any).durableRunClient.claimThread({
      resourceId: 'simple-resource',
      threadId: harness.getCurrentThreadId(),
      runId: 'stale-self-owned-run',
    });
    await harness.watchActiveThreadRuns();
    await Promise.race([
      harness.sendMessage({ content: 'hi' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('simple send timed out')), 1000)),
    ]);

    expect(events.some(event => event.type === 'agent_end' && event.reason === 'complete')).toBe(true);
    expect(events.some(event => event.type === 'thread_observing')).toBe(false);
    expect(events.some(event => event.type === 'stream_attached')).toBe(false);
  });

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(harness => harness.destroy()));
    await coordinator?.close();
    coordinator = undefined;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('attaches observers and sends user messages as signals while a thread is active', async () => {
    tempDir = createTempDir();
    const socketPath = join(tempDir, 'coordinator.sock');
    coordinator = new UnixSocketDurableRunCoordinator({ socketPath });
    await coordinator.start();

    const storage = new InMemoryStore();
    const prompts: unknown[] = [];
    let releaseSignal!: () => void;
    const signalArrived = new Promise<void>(resolve => {
      releaseSignal = resolve;
    });
    let readyForSignal = false;

    const owner = new Harness({
      id: 'mastra-code',
      resourceId: 'shared-resource',
      storage,
      initialState: { yolo: true },
      durableStreams: { unixSocketPath: socketPath, attachToActiveThread: true, signalWhileRunning: true },
      modes: [
        {
          id: 'default',
          default: true,
          agent: createOwnerAgent(prompts, signalArrived, () => {
            readyForSignal = true;
          }) as any,
        },
      ],
    });
    const signaler = new Harness({
      id: 'mastra-code',
      resourceId: 'shared-resource',
      storage,
      durableStreams: { unixSocketPath: socketPath, attachToActiveThread: true, signalWhileRunning: true },
      modes: [{ id: 'default', default: true, agent: createObserverAgent() as any }],
    });
    const observer = new Harness({
      id: 'mastra-code',
      resourceId: 'shared-resource',
      storage,
      durableStreams: { unixSocketPath: socketPath, attachToActiveThread: true, signalWhileRunning: true },
      modes: [{ id: 'default', default: true, agent: createObserverAgent() as any }],
    });
    harnesses.push(owner, signaler, observer);

    const ownerEvents: HarnessEvent[] = [];
    const signalerEvents: HarnessEvent[] = [];
    const observerEvents: HarnessEvent[] = [];
    owner.subscribe(event => {
      ownerEvents.push(event);
    });
    signaler.subscribe(event => {
      signalerEvents.push(event);
    });
    observer.subscribe(event => {
      observerEvents.push(event);
    });

    await owner.init();
    await signaler.init();
    await observer.init();

    const thread = await owner.createThread({ title: 'shared' });
    await signaler.switchThread({ threadId: thread.id });
    await observer.switchThread({ threadId: thread.id });

    const ownerRun = owner.sendMessage({ content: 'start' });
    await waitFor(() => readyForSignal, 'owner to reach waitForSignal tool');

    await waitFor(
      () => observerEvents.some(event => event.type === 'stream_attached'),
      'observer to attach to active stream',
    );

    await signaler.sendMessage({ content: 'signal from another harness' });
    releaseSignal();

    await ownerRun;
    await waitFor(() => observerEvents.some(event => event.type === 'agent_end'), 'observer stream to end');

    expect(ownerEvents.some(event => event.type === 'thread_claimed')).toBe(true);
    expect(observerEvents.some(event => event.type === 'thread_observing')).toBe(true);
    expect(signalerEvents.some(event => event.type === 'signal_sent')).toBe(true);
    expect(
      observerEvents.some(
        event =>
          event.type === 'message_start' &&
          event.message.role === 'user' &&
          JSON.stringify(event.message).includes('start'),
      ),
    ).toBe(true);
    expect(
      observerEvents.some(
        event =>
          event.type === 'message_start' &&
          event.message.role === 'user' &&
          JSON.stringify(event.message).includes('signal from another harness'),
      ),
    ).toBe(true);
    expect(JSON.stringify(prompts[1])).toContain('signal from another harness');
    expect(ownerEvents.some(event => event.type === 'om_status')).toBe(true);
    expect(observerEvents.some(event => event.type === 'om_status')).toBe(true);
    expect(ownerEvents.some(event => event.type === 'tool_end' && event.toolCallId === 'call-1')).toBe(true);
    expect(observerEvents.some(event => event.type === 'tool_end' && event.toolCallId === 'call-1')).toBe(true);
    expect(observerEvents.some(event => event.type === 'message_update')).toBe(true);
  });
});
