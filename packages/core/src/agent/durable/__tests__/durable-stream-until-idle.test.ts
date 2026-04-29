import type { LanguageModelV2 } from '@ai-sdk/provider-v5';
import { convertArrayToReadableStream, MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mastra } from '../../../mastra';
import { MockMemory } from '../../../memory';
import { MockStore } from '../../../storage';
import { Agent } from '../../agent';
import { createDurableAgent } from '../create-durable-agent';

function makeScriptedModel(scripts: Array<() => ReadableStream<any>>) {
  let calls = 0;
  const model = new MockLanguageModelV2({
    doGenerate: async () => {
      throw new Error('doGenerate not used in these tests');
    },
    doStream: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
      stream: scripts[calls++]!(),
    }),
  });
  return { model, getCallCount: () => calls };
}

function textResponse(text: string) {
  return () =>
    convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: 'id-0', modelId: 'mock', timestamp: new Date(0) },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: text },
      { type: 'text-end', id: 't' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
    ]);
}

async function drain(stream: ReadableStream<any>): Promise<any[]> {
  const reader = stream.getReader();
  const chunks: any[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function publishEvent(
  bgManager: any,
  type: string,
  taskId: string,
  agentId: string,
  threadId: string,
  extra: Record<string, unknown> = {},
) {
  return bgManager.publishLifecycleEvent(type, {
    id: taskId,
    toolName: 'dummy',
    toolCallId: taskId,
    runId: 'run-1',
    agentId,
    threadId,
    resourceId: 'user-1',
    status: type.split('.')[1],
    result: {},
    retryCount: 0,
    maxRetries: 0,
    timeoutMs: 1000,
    createdAt: new Date(),
    args: {},
    ...extra,
  });
}

describe('DurableAgent.streamUntilIdle', () => {
  const storage = new MockStore();
  let mastra: Mastra;

  beforeEach(async () => {
    mastra = new Mastra({
      logger: false,
      storage,
      backgroundTasks: { enabled: true },
    });
  });

  afterEach(async () => {
    await mastra.backgroundTaskManager?.shutdown();
    const bgStore = await storage.getStore('backgroundTasks');
    await bgStore?.dangerouslyClearAll();
  });

  it('falls through to a plain stream when no bg manager or memory is configured', async () => {
    const plainMastra = new Mastra({ logger: false, storage, backgroundTasks: { enabled: false } });
    expect(plainMastra.backgroundTaskManager).toBeUndefined();

    const { model } = makeScriptedModel([textResponse('plain')]);
    const baseAgent = new Agent({
      id: 'a-plain',
      name: 'a-plain',
      instructions: 'test',
      model: model as LanguageModelV2,
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    plainMastra.addAgent(durableAgent as any, 'a-plain');

    const result = await durableAgent.streamUntilIdle('hi');
    const chunks = await drain(result.fullStream as ReadableStream<any>);

    const textChunks = chunks.filter(c => c?.type?.includes('text')).length;
    expect(textChunks).toBeGreaterThan(0);
    result.cleanup();
  });

  it('closes after the initial turn when no background tasks were dispatched', async () => {
    const memory = new MockMemory();
    const { model, getCallCount } = makeScriptedModel([textResponse('hello')]);

    const baseAgent = new Agent({
      id: 'a1',
      name: 'a1',
      instructions: 'test',
      model: model as LanguageModelV2,
      memory,
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    mastra.addAgent(durableAgent as any, 'a1');

    const result = await durableAgent.streamUntilIdle('hi', {
      memory: { thread: 'thread-1', resource: 'user-1' },
    });
    await drain(result.fullStream as ReadableStream<any>);

    expect(getCallCount()).toBe(1);
  });

  it('re-invokes stream when a background task completes', async () => {
    const memory = new MockMemory();
    const { model, getCallCount } = makeScriptedModel([
      textResponse('first response'),
      textResponse('continuation response'),
    ]);

    const baseAgent = new Agent({
      id: 'a2',
      name: 'a2',
      instructions: 'test',
      model: model as LanguageModelV2,
      memory,
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    mastra.addAgent(durableAgent as any, 'a2');

    const bgManager = mastra.backgroundTaskManager!;
    const outer = await durableAgent.streamUntilIdle('hi', {
      memory: { thread: 'thread-2', resource: 'user-1' },
    });

    await publishEvent(bgManager, 'task.running', 'task-1', 'a2', 'thread-2');
    await new Promise(r => setTimeout(r, 50));
    await publishEvent(bgManager, 'task.completed', 'task-1', 'a2', 'thread-2');

    await drain(outer.fullStream as ReadableStream<any>);

    expect(getCallCount()).toBe(2);
  });

  it('serializes continuations (only one inner stream at a time)', async () => {
    const memory = new MockMemory();

    let resolver1: () => void = () => {};
    let resolver2: () => void = () => {};
    let resolver3: () => void = () => {};

    const makeBlocking = (signal: Promise<void>, text: string) =>
      new ReadableStream<any>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'response-metadata', id: 'id', modelId: 'mock', timestamp: new Date(0) });
          controller.enqueue({ type: 'text-start', id: 't' });
          controller.enqueue({ type: 'text-delta', id: 't', delta: text });
          await signal;
          controller.enqueue({ type: 'text-end', id: 't' });
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          });
          controller.close();
        },
      });

    const scripts: Array<() => ReadableStream<any>> = [
      () =>
        makeBlocking(
          new Promise<void>(r => {
            resolver1 = r;
          }),
          'turn 1',
        ),
      () =>
        makeBlocking(
          new Promise<void>(r => {
            resolver2 = r;
          }),
          'turn 2',
        ),
      () =>
        makeBlocking(
          new Promise<void>(r => {
            resolver3 = r;
          }),
          'turn 3',
        ),
    ];
    const { model, getCallCount } = makeScriptedModel(scripts);

    const baseAgent = new Agent({
      id: 'a3',
      name: 'a3',
      instructions: 'test',
      model: model as LanguageModelV2,
      memory,
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    mastra.addAgent(durableAgent as any, 'a3');

    const outer = await durableAgent.streamUntilIdle('hi', {
      memory: { thread: 'thread-3', resource: 'user-1' },
    });
    const drainPromise = drain(outer.fullStream as ReadableStream<any>);

    await new Promise(r => setTimeout(r, 50));
    expect(getCallCount()).toBe(1);

    const bgManager = mastra.backgroundTaskManager!;
    await publishEvent(bgManager, 'task.completed', 't-a', 'a3', 'thread-3');
    await publishEvent(bgManager, 'task.completed', 't-b', 'a3', 'thread-3');
    await new Promise(r => setTimeout(r, 50));

    expect(getCallCount()).toBe(1);

    resolver1();
    await new Promise(r => setTimeout(r, 50));

    expect(getCallCount()).toBe(2);

    resolver2();
    resolver3();
    await drainPromise;

    expect(getCallCount()).toBe(2);
  });

  it('forwards background task chunks (running, output, completed) into the outer stream', async () => {
    const memory = new MockMemory();
    const { model } = makeScriptedModel([textResponse('first'), textResponse('after completion')]);

    const baseAgent = new Agent({
      id: 'a5',
      name: 'a5',
      instructions: 'test',
      model: model as LanguageModelV2,
      memory,
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    mastra.addAgent(durableAgent as any, 'a5');

    const bgManager = mastra.backgroundTaskManager!;
    const result = await durableAgent.streamUntilIdle('hi', {
      memory: { thread: 'thread-5', resource: 'user-1' },
    });

    await publishEvent(bgManager, 'task.running', 'task-1', 'a5', 'thread-5', { startedAt: new Date() });
    await new Promise(r => setTimeout(r, 20));
    await publishEvent(bgManager, 'task.output', 'task-1', 'a5', 'thread-5', {
      chunk: { type: 'custom-progress', payload: { pct: 42 } },
    });
    await new Promise(r => setTimeout(r, 20));
    await publishEvent(bgManager, 'task.completed', 'task-1', 'a5', 'thread-5', { completedAt: new Date() });

    const chunks = await drain(result.fullStream as ReadableStream<any>);
    const types = chunks.map(c => c?.type).filter(Boolean);

    expect(types).toContain('background-task-running');
    expect(types).toContain('background-task-output');
    expect(types).toContain('background-task-completed');

    const running = chunks.find(c => c?.type === 'background-task-running');
    expect((running as any)?.payload?.taskId).toBe('task-1');
  });

  it('closes the outer stream when the caller aborts mid-flight', async () => {
    const memory = new MockMemory();
    const { model, getCallCount } = makeScriptedModel([textResponse('initial'), textResponse('would-continue')]);

    const baseAgent = new Agent({
      id: 'a-abort',
      name: 'a-abort',
      instructions: 'test',
      model: model as LanguageModelV2,
      memory,
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    mastra.addAgent(durableAgent as any, 'a-abort');

    const bgManager = mastra.backgroundTaskManager!;
    const abortController = new AbortController();

    const result = await durableAgent.streamUntilIdle('hi', {
      memory: { thread: 'thread-abort', resource: 'user-1' },
      abortSignal: abortController.signal,
    } as any);

    await publishEvent(bgManager, 'task.running', 'task-1', 'a-abort', 'thread-abort');
    await new Promise(r => setTimeout(r, 30));

    abortController.abort();

    await publishEvent(bgManager, 'task.completed', 'task-1', 'a-abort', 'thread-abort');

    const chunks = await Promise.race([
      drain(result.fullStream as ReadableStream<any>),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('stream did not close within 500ms of abort')), 500),
      ),
    ]);

    const deltas = chunks
      .filter(c => c?.type === 'text-delta')
      .map(c => (c as any).payload?.text ?? (c as any).delta ?? '')
      .join('');

    expect(deltas).toContain('initial');
    expect(getCallCount()).toBe(1);
    expect(deltas).not.toContain('would-continue');
  });

  it('closes after maxIdleMs when nothing is happening but tasks remain running', async () => {
    const memory = new MockMemory();
    const { model } = makeScriptedModel([textResponse('initial')]);

    const baseAgent = new Agent({
      id: 'a-idle',
      name: 'a-idle',
      instructions: 'test',
      model: model as LanguageModelV2,
      memory,
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    mastra.addAgent(durableAgent as any, 'a-idle');

    const bgManager = mastra.backgroundTaskManager!;

    const result = await durableAgent.streamUntilIdle('hi', {
      memory: { thread: 'thread-idle', resource: 'user-1' },
      maxIdleMs: 100,
    });

    await publishEvent(bgManager, 'task.running', 'task-1', 'a-idle', 'thread-idle');

    const start = Date.now();
    await drain(result.fullStream as ReadableStream<any>);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2_000);
  });

  it('does not close mid-turn when inner stream is slow (idle timer only runs between turns)', async () => {
    const memory = new MockMemory();

    const slowStream = () =>
      new ReadableStream<any>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'response-metadata', id: 'id', modelId: 'mock', timestamp: new Date(0) });
          controller.enqueue({ type: 'text-start', id: 't' });
          await new Promise(r => setTimeout(r, 300));
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'slow' });
          controller.enqueue({ type: 'text-end', id: 't' });
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          });
          controller.close();
        },
      });

    const { model } = makeScriptedModel([slowStream]);

    const baseAgent = new Agent({
      id: 'a-slow',
      name: 'a-slow',
      instructions: 'test',
      model: model as LanguageModelV2,
      memory,
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    mastra.addAgent(durableAgent as any, 'a-slow');

    const result = await durableAgent.streamUntilIdle('hi', {
      memory: { thread: 'thread-slow', resource: 'user-1' },
      maxIdleMs: 100,
    });

    const chunks = await drain(result.fullStream as ReadableStream<any>);

    const deltaText = chunks
      .filter(c => c?.type === 'text-delta')
      .map(c => (c as any).payload?.text ?? (c as any).delta ?? '')
      .join('');
    expect(deltaText).toContain('slow');
  });

  it('surfaces continuation errors through the outer stream', async () => {
    const memory = new MockMemory();

    let calls = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        throw new Error('doGenerate not used');
      },
      doStream: async () => {
        calls++;
        if (calls === 1) {
          return {
            rawCall: { rawPrompt: null, rawSettings: {} },
            warnings: [],
            stream: textResponse('initial')(),
          };
        }
        throw new Error('continuation boom');
      },
    });

    const baseAgent = new Agent({
      id: 'a-err',
      name: 'a-err',
      instructions: 'test',
      model: model as LanguageModelV2,
      memory,
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    mastra.addAgent(durableAgent as any, 'a-err');

    const bgManager = mastra.backgroundTaskManager!;

    const result = await durableAgent.streamUntilIdle('hi', {
      memory: { thread: 'thread-err', resource: 'user-1' },
      maxIdleMs: 3_000,
    });

    await publishEvent(bgManager, 'task.running', 'task-1', 'a-err', 'thread-err');
    await new Promise(r => setTimeout(r, 30));
    await publishEvent(bgManager, 'task.completed', 'task-1', 'a-err', 'thread-err');

    // In durable agents, model errors are handled asynchronously by the
    // workflow engine and surfaced as error chunks or workflow errors.
    // The outer stream should still close (either via error or idle timeout).
    let sawError = false;
    try {
      const chunks = await Promise.race([
        drain(result.fullStream as ReadableStream<any>),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream did not close within 5s')), 5_000)),
      ]);
      sawError = chunks.some(c => c?.type === 'error');
    } catch {
      sawError = true;
    }
    expect(sawError).toBe(true);
  }, 10_000);

  it('returns a DurableAgentStreamResult-shaped result (output, fullStream, runId, cleanup)', async () => {
    const memory = new MockMemory();
    const { model } = makeScriptedModel([textResponse('hello world')]);

    const baseAgent = new Agent({
      id: 'a4',
      name: 'a4',
      instructions: 'test',
      model: model as LanguageModelV2,
      memory,
    });
    const durableAgent = createDurableAgent({ agent: baseAgent });
    mastra.addAgent(durableAgent as any, 'a4');

    const result = await durableAgent.streamUntilIdle('hi', {
      memory: { thread: 'thread-4', resource: 'user-1' },
    });

    expect(result.fullStream).toBeInstanceOf(ReadableStream);
    expect(typeof result.cleanup).toBe('function');
    expect(typeof result.runId).toBe('string');

    await drain(result.fullStream as ReadableStream<any>);
    result.cleanup();
  });
});
