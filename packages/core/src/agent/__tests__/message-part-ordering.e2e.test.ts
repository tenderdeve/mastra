/**
 * E2E reproduction for issue #16007:
 *   "Message persistence ordering issue"
 *
 * When a reasoning model (e.g. gpt-5) emits chunks that interleave reasoning
 * and tool-calls — i.e. `reasoning-start` → `reasoning-delta` → `tool-call`
 * → `reasoning-end` → `text` — `buildMessagesFromChunks` flushes the
 * tool-invocation part to the saved DB message immediately while it only
 * pushes the reasoning part on `reasoning-end`. The result is that the
 * persisted message has its parts re-ordered relative to the live stream:
 *
 *   live:  reasoning, tool-call, ..., reasoning, text
 *   saved: tool-call, ..., reasoning, reasoning, text   ← BUG
 *
 * This test drives a real OpenAI reasoning model with tools and asserts that
 * the order of parts saved to memory matches the order they appeared in the
 * live `fullStream`. The test is recorded via `createGatewayMock`, so it can
 * run offline against the checked-in recording.
 */
import { createOpenAI as createOpenAIV6 } from '@ai-sdk/openai-v6';
import { getLLMTestMode } from '@internal/llm-recorder';
import { createGatewayMock, setupDummyApiKeys } from '@internal/test-utils';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { MockMemory } from '../../memory/mock';
import { createTool } from '../../tools';
import { Agent } from '../agent';

config();

const MODE = getLLMTestMode();
setupDummyApiKeys(MODE, ['openai']);

const mock = createGatewayMock();
const openai_v6 = createOpenAIV6({ apiKey: process.env.OPENAI_API_KEY });

beforeAll(() => mock.start());
afterAll(() => mock.saveAndStop());

type PartKind = 'reasoning' | 'tool-call' | 'text';

const readFile = createTool({
  id: 'readFile',
  description: 'Read the contents of a file at the given path.',
  inputSchema: z.object({
    path: z.string().describe('Absolute or repo-relative file path to read.'),
  }),
  execute: async ({ path }) => {
    return {
      path,
      contents: `// stub contents of ${path}\nexport const value = 42;\n`,
    };
  },
});

const grepFiles = createTool({
  id: 'grepFiles',
  description: 'Search files matching a glob for a regex pattern.',
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern to search for.'),
    glob: z.string().describe('Glob of files to search, e.g. **/*.ts.'),
  }),
  execute: async ({ pattern, glob }) => {
    return {
      pattern,
      glob,
      matches: [
        { path: 'src/a.ts', line: 12, text: `// matched ${pattern}` },
        { path: 'src/b.ts', line: 7, text: `// matched ${pattern}` },
      ],
    };
  },
});

describe('issue #16007: persisted part order should match live stream order (e2e)', { timeout: 120_000 }, () => {
  it('persists reasoning/tool-call/text parts in the same order they streamed', async () => {
    const memory = new MockMemory();

    const agent = new Agent({
      id: 'issue-16007-agent',
      name: 'Issue 16007 Agent',
      instructions: [
        'You are a careful code investigator. When the user asks a single question that requires',
        'multiple lookups, gather all the information you need IN PARALLEL in one batch:',
        'call readFile AND grepFiles simultaneously in a single step. After the tool results come',
        'back, write a one-sentence summary.',
      ].join(' '),
      model: openai_v6('gpt-5.4'),
      memory,
      tools: { readFile, grepFiles },
    });

    const threadId = 'issue-16007-thread';
    const resourceId = 'issue-16007-resource';

    const response = await agent.stream(
      [
        'In ONE batch, in parallel, call readFile on src/a.ts AND grepFiles for `export const value` over **/*.ts.',
        'Then summarize in one sentence.',
      ].join(' '),
      {
        memory: { thread: threadId, resource: resourceId },
        providerOptions: {
          openai: {
            reasoningEffort: 'medium',
            reasoningSummary: 'detailed',
            include: ['reasoning.encrypted_content'],
          } as any,
        },
      },
    );

    // Capture the live stream order. We track BOTH start and end timing for
    // reasoning/text spans so we can prove whether a span's *close* occurs
    // after an intervening tool-call — which is the precise condition that
    // triggers the reordering bug in `buildMessagesFromChunks`.
    const liveOrder: PartKind[] = [];
    const fullChunkSeq: string[] = [];
    for await (const chunk of response.fullStream) {
      if (chunk.type === 'reasoning-start') {
        liveOrder.push('reasoning');
        fullChunkSeq.push('reasoning-start');
      } else if (chunk.type === 'reasoning-end') {
        fullChunkSeq.push('reasoning-end');
      } else if (chunk.type === 'tool-call') {
        liveOrder.push('tool-call');
        fullChunkSeq.push('tool-call');
      } else if (chunk.type === 'text-start') {
        liveOrder.push('text');
        fullChunkSeq.push('text-start');
      } else if (chunk.type === 'text-end') {
        fullChunkSeq.push('text-end');
      }
    }

    // Wait for the save queue to drain.
    await response.text;
    // The agent's save-queue is debounced — give it a tick to flush.
    await new Promise(r => setTimeout(r, 250));

    const saved = await memory.recall({ threadId, resourceId });
    const savedAssistant = saved.messages.filter((m: any) => m.role === 'assistant');
    expect(savedAssistant.length).toBeGreaterThan(0);

    const savedOrder: PartKind[] = [];
    for (const msg of savedAssistant) {
      const parts = (msg as any).content?.parts ?? [];
      for (const p of parts) {
        if (p.type === 'reasoning') savedOrder.push('reasoning');
        else if (p.type === 'tool-invocation' || p.type === 'tool-call') savedOrder.push('tool-call');
        else if (p.type === 'text') savedOrder.push('text');
        // ignore step-start / file / source for this comparison
      }
    }

    console.log('[#16007] live order :', liveOrder.join(' → '));

    console.log('[#16007] saved order:', savedOrder.join(' → '));

    console.log('[#16007] chunk seq  :', fullChunkSeq.join(' → '));

    // Sanity: the model actually produced reasoning, tool-calls, and text.
    expect(liveOrder).toContain('reasoning');
    expect(liveOrder).toContain('tool-call');
    expect(liveOrder).toContain('text');

    // The reproducer: when reasoning interleaves with tool-calls, the saved
    // order currently differs from the live order. We assert equality, which
    // demonstrates the bug.
    expect(savedOrder).toEqual(liveOrder);
  });
});
