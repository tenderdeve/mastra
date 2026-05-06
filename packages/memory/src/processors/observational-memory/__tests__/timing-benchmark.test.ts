/**
 * OM lifecycle timing benchmark.
 *
 * Skipped by default. Run with:
 *
 *   OM_TIMING_BENCHMARK=1 OM_TIMING=1 \
 *     pnpm --filter @mastra/memory exec vitest run \
 *     src/processors/observational-memory/__tests__/timing-benchmark.test.ts \
 *     --reporter=dot --no-color
 *
 * Aggregates per-label total / mean / p95 from the OM timing log so we can see
 * which OM lifecycle parts dominate per-step latency.
 */
import fs from 'node:fs';
import path from 'node:path';

import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { describe, it, beforeEach } from 'vitest';
import { z } from 'zod';

import { Memory } from '../../../index';

const ENABLED = process.env.OM_TIMING_BENCHMARK === '1';
const TOOL_CALL_STEPS = Number(process.env.OM_BENCH_STEPS ?? 5);
const ITERATIONS = Number(process.env.OM_BENCH_ITERATIONS ?? 3);

// Multi-step mock model: emits N tool calls (one per step), then a final text response.
function createMultiStepModel(steps: number, finalText: string) {
  let generateCallCount = 0;
  let streamCallCount = 0;

  return new MockLanguageModelV2({
    doGenerate: async () => {
      generateCallCount++;
      if (generateCallCount <= steps) {
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: 'tool-calls' as const,
          usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
          text: '',
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: `call-${generateCallCount}`,
              toolName: 'test',
              input: JSON.stringify({ action: 'trigger', step: generateCallCount }),
            },
          ],
          warnings: [],
        };
      }
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: 'stop' as const,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        text: finalText,
        content: [{ type: 'text' as const, text: finalText }],
        warnings: [],
      };
    },
    doStream: async () => {
      streamCallCount++;
      if (streamCallCount <= steps) {
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start' as const, warnings: [] },
            {
              type: 'response-metadata' as const,
              id: `mock-step-${streamCallCount}`,
              modelId: 'mock-model',
              timestamp: new Date(),
            },
            { type: 'tool-input-start' as const, id: `call-${streamCallCount}`, toolName: 'test' },
            {
              type: 'tool-input-delta' as const,
              id: `call-${streamCallCount}`,
              delta: JSON.stringify({ action: 'trigger', step: streamCallCount }),
            },
            { type: 'tool-input-end' as const, id: `call-${streamCallCount}` },
            {
              type: 'finish' as const,
              finishReason: 'tool-calls' as const,
              usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
            },
          ]),
        };
      }
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start' as const, warnings: [] },
          {
            type: 'response-metadata' as const,
            id: `mock-step-${streamCallCount}`,
            modelId: 'mock-model',
            timestamp: new Date(),
          },
          { type: 'text-start' as const, id: 'text-1' },
          { type: 'text-delta' as const, id: 'text-1', delta: finalText },
          { type: 'text-end' as const, id: 'text-1' },
          {
            type: 'finish' as const,
            finishReason: 'stop' as const,
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          },
        ]),
      };
    },
  });
}

function createObserverModel() {
  const text = `<observations>
## ${new Date().toDateString()}
- 🔴 User asked for help with a task
- Assistant provided a detailed response
</observations>`;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      throw new Error('Unexpected doGenerate');
    },
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start' as const, warnings: [] },
        {
          type: 'response-metadata' as const,
          id: 'obs-1',
          modelId: 'mock-observer-model',
          timestamp: new Date(),
        },
        { type: 'text-start' as const, id: 'text-1' },
        { type: 'text-delta' as const, id: 'text-1', delta: text },
        { type: 'text-end' as const, id: 'text-1' },
        {
          type: 'finish' as const,
          finishReason: 'stop' as const,
          usage: { inputTokens: 50, outputTokens: 100, totalTokens: 150 },
        },
      ]),
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
    }),
  });
}

const triggerTool = createTool({
  id: 'test',
  description: 'Trigger tool for OM benchmarking',
  inputSchema: z.object({
    action: z.string().optional(),
    step: z.number().optional(),
  }),
  execute: async () => ({ success: true, message: 'Tool executed' }),
});

const finalText =
  'I understand your request. Let me give you a comprehensive answer covering all the relevant aspects of what you asked. ' +
  'Based on the information provided, here are the key points and recommendations. ' +
  'Please let me know if you need any clarification or have follow-up questions.';

interface TimingRecord {
  label: string;
  durationMs: number;
  step?: number;
}

function readTimingLog(p: string): TimingRecord[] {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as TimingRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is TimingRecord => r !== null);
}

function summarize(records: TimingRecord[]) {
  const byLabel = new Map<string, number[]>();
  for (const r of records) {
    if (!byLabel.has(r.label)) byLabel.set(r.label, []);
    byLabel.get(r.label)!.push(r.durationMs);
  }
  const rows: { label: string; n: number; total: number; mean: number; p50: number; p95: number; max: number }[] = [];
  for (const [label, vals] of byLabel) {
    const sorted = [...vals].sort((a, b) => a - b);
    const total = vals.reduce((a, b) => a + b, 0);
    const mean = total / vals.length;
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    rows.push({
      label,
      n: vals.length,
      total,
      mean,
      p50: p(0.5),
      p95: p(0.95),
      max: sorted[sorted.length - 1]!,
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return rows;
}

function printTable(rows: ReturnType<typeof summarize>) {
  console.log(
    `\n${'label'.padEnd(60)} ${'n'.padStart(4)} ${'total(ms)'.padStart(10)} ${'mean'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)}`,
  );
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(60)} ${String(r.n).padStart(4)} ${r.total.toFixed(2).padStart(10)} ${r.mean.toFixed(2).padStart(8)} ${r.p50.toFixed(2).padStart(8)} ${r.p95.toFixed(2).padStart(8)} ${r.max.toFixed(2).padStart(8)}`,
    );
  }
}

async function seedOtherThreads(store: InMemoryStore, resourceId: string, count: number, msgsPerThread = 3) {
  const memoryStore = await store.getStore('memory');
  if (!memoryStore) throw new Error('memory store missing');
  for (let t = 0; t < count; t++) {
    const threadId = `seed-thread-${t}`;
    await memoryStore.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: `Seed ${t}`,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const messages = Array.from({ length: msgsPerThread }, (_, i) => ({
      id: `msg-${t}-${i}`,
      threadId,
      resourceId,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: {
        format: 2 as const,
        parts: [
          {
            type: 'text' as const,
            text: 'A representative message body for benchmarking purposes — should be a few dozen tokens.',
          },
        ],
      },
      createdAt: new Date(Date.now() - (count - t) * 60_000 - i * 1000),
    }));
    await memoryStore.saveMessages({ messages });
  }
}

async function runScenario(
  scenarioName: string,
  buildMemory: () => { memory: Memory; store: InMemoryStore },
  setupExtras?: (store: InMemoryStore) => Promise<void>,
) {
  const logPath = path.join(process.cwd(), 'om-timing.log');
  // Warmup
  for (let w = 0; w < 1; w++) {
    const { memory } = buildMemory();
    const agent = new Agent({
      id: `bench-warmup-${scenarioName}-${w}`,
      name: 'Bench Agent',
      instructions: 'Always use the test tool first.',
      model: createMultiStepModel(TOOL_CALL_STEPS, finalText) as any,
      tools: { test: triggerTool },
      memory,
    });
    await agent.generate('Warmup ping.', {
      memory: { thread: `warmup-${w}`, resource: 'bench-resource' },
    });
  }
  // Reset log so warmup doesn't pollute the measurements.
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);

  for (let i = 0; i < ITERATIONS; i++) {
    const { memory, store } = buildMemory();
    if (setupExtras) await setupExtras(store);
    const agent = new Agent({
      id: `bench-${scenarioName}-${i}`,
      name: 'Bench Agent',
      instructions: 'Always use the test tool first.',
      model: createMultiStepModel(TOOL_CALL_STEPS, finalText) as any,
      tools: { test: triggerTool },
      memory,
    });
    await agent.generate('Hello, please use the tool a few times then summarize.', {
      memory: { thread: `bench-thread-${i}`, resource: 'bench-resource' },
    });
  }

  const records = readTimingLog(logPath);
  const rows = summarize(records);
  console.log(
    `\n=== Scenario: ${scenarioName} (steps=${TOOL_CALL_STEPS}, iters=${ITERATIONS}, totalRecords=${records.length}) ===`,
  );
  printTable(rows);
}

describe.skipIf(!ENABLED)('OM lifecycle timing benchmark', () => {
  beforeEach(() => {
    // start each scenario with a clean log
    const logPath = path.join(process.cwd(), 'om-timing.log');
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  });

  it('thread scope, no other threads', async () => {
    await runScenario('thread-scope', () => {
      const store = new InMemoryStore();
      const memory = new Memory({
        storage: store,
        options: {
          observationalMemory: {
            enabled: true,
            scope: 'thread',
            observation: {
              model: createObserverModel() as any,
              messageTokens: 280_000, // High threshold so observation never fires
              bufferTokens: false,
            },
            reflection: {
              model: createObserverModel() as any,
              observationTokens: 50_000,
            },
          },
        },
      });
      return { memory, store };
    });
  });

  it('resource scope, 0 other threads', async () => {
    await runScenario('resource-scope-0', () => {
      const store = new InMemoryStore();
      const memory = new Memory({
        storage: store,
        options: {
          observationalMemory: {
            enabled: true,
            scope: 'resource',
            observation: {
              model: createObserverModel() as any,
              messageTokens: 280_000,
              bufferTokens: false,
            },
            reflection: {
              model: createObserverModel() as any,
              observationTokens: 50_000,
            },
          },
        },
      });
      return { memory, store };
    });
  });

  it('resource scope, 10 other threads', async () => {
    await runScenario(
      'resource-scope-10',
      () => {
        const store = new InMemoryStore();
        const memory = new Memory({
          storage: store,
          options: {
            observationalMemory: {
              enabled: true,
              scope: 'resource',
              observation: {
                model: createObserverModel() as any,
                messageTokens: 280_000,
                bufferTokens: false,
              },
              reflection: {
                model: createObserverModel() as any,
                observationTokens: 50_000,
              },
            },
          },
        });
        return { memory, store };
      },
      async store => {
        await seedOtherThreads(store, 'bench-resource', 10);
      },
    );
  });

  it('resource scope, 50 other threads', async () => {
    await runScenario(
      'resource-scope-50',
      () => {
        const store = new InMemoryStore();
        const memory = new Memory({
          storage: store,
          options: {
            observationalMemory: {
              enabled: true,
              scope: 'resource',
              observation: {
                model: createObserverModel() as any,
                messageTokens: 280_000,
                bufferTokens: false,
              },
              reflection: {
                model: createObserverModel() as any,
                observationTokens: 50_000,
              },
            },
          },
        });
        return { memory, store };
      },
      async store => {
        await seedOtherThreads(store, 'bench-resource', 50);
      },
    );
  });
});
