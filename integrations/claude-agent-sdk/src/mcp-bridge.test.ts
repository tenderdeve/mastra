import { createTool } from '@mastra/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { buildMastraToolsMcpServer, extractZodShape, wrapMastraToolForSdk } from './mcp-bridge';
import type { MastraToolExecutionContext } from './mcp-bridge';
import { qualifyMastraToolName } from './tool-names';

const stubContext = (): MastraToolExecutionContext => ({
  mastra: {} as never,
  requestContext: {} as never,
  abortSignal: undefined,
});

describe('extractZodShape', () => {
  it('recovers the raw shape from a tool built with a Zod object', () => {
    const tool = createTool({
      id: 'echo',
      description: 'Echo a title + body',
      inputSchema: z.object({ title: z.string(), body: z.string() }),
      execute: async args => args,
    });

    const shape = extractZodShape(tool);
    expect(shape).not.toBeNull();
    expect(Object.keys(shape!).sort()).toEqual(['body', 'title']);
  });

  it('returns null when the tool has no input schema', () => {
    const tool = createTool({
      id: 'noop',
      description: 'nothing',
      execute: async () => ({ ok: true }),
    });

    expect(extractZodShape(tool)).toBeNull();
  });

  it('round-trips a JSON-Schema-backed tool through jsonSchemaToZod', () => {
    // Simulate a tool whose schema came in as raw JSON Schema rather than Zod. We do
    // that by wrapping JSON Schema as a standard-schema with the JSON adapter — which
    // is what createTool() uses internally for non-Zod inputs.
    const tool = createTool({
      id: 'json-schema-tool',
      description: 'Has a JSON-Schema input',
      inputSchema: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          radiusKm: { type: 'number' },
        },
        required: ['city'],
      },
      execute: async args => args,
    });

    const shape = extractZodShape(tool);
    expect(shape).not.toBeNull();
    // Keys should survive the JSON-Schema → Zod round-trip.
    expect(Object.keys(shape!).sort()).toEqual(['city', 'radiusKm']);
  });
});

describe('wrapMastraToolForSdk', () => {
  it('produces an SDK tool definition whose handler calls the Mastra execute', async () => {
    const execute = vi.fn(async (args: { title: string; body: string }) => ({
      saved: `${args.title}: ${args.body}`,
    }));

    const tool = createTool({
      id: 'writeNote',
      description: 'Write a note',
      inputSchema: z.object({ title: z.string(), body: z.string() }),
      execute,
    });

    const wrapped = wrapMastraToolForSdk('writeNote', tool, stubContext)!;
    expect(wrapped).not.toBeNull();
    expect(wrapped.name).toBe('writeNote');

    // Call the handler exactly the way the SDK would: with the validated args at top
    // level, NOT wrapped in a `context` / `__args` envelope. If we regress to the old
    // bug the execute assertion below will fail with undefined fields.
    const result = await wrapped.handler({ title: 'hi', body: 'there' }, {});

    expect(execute).toHaveBeenCalledTimes(1);
    const [firstArg] = execute.mock.calls[0]!;
    expect(firstArg).toEqual({ title: 'hi', body: 'there' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      saved: 'hi: there',
    });
  });

  it('surfaces execute() throws as isError CallToolResult instead of crashing the SDK', async () => {
    const tool = createTool({
      id: 'boom',
      description: 'Always throws',
      inputSchema: z.object({ x: z.number() }),
      execute: async () => {
        throw new Error('kaboom');
      },
    });

    const wrapped = wrapMastraToolForSdk('boom', tool, stubContext)!;
    const result = await wrapped.handler({ x: 1 }, {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe('kaboom');
  });

  it('returns null when the tool has no execute', () => {
    const tool = createTool({
      id: 'no-exec',
      description: 'Not runnable',
      inputSchema: z.object({ x: z.number() }),
    });

    expect(wrapMastraToolForSdk('no-exec', tool, stubContext)).toBeNull();
  });

  it('returns null when the tool has no schema', () => {
    const tool = createTool({
      id: 'no-schema',
      description: 'No schema',
      execute: async () => 'ok',
    });

    expect(wrapMastraToolForSdk('no-schema', tool, stubContext)).toBeNull();
  });

  it('passes MCP-shaped execute() results through unchanged', async () => {
    const tool = createTool({
      id: 'mcp-shaped',
      description: 'Returns MCP content',
      inputSchema: z.object({}).passthrough(),
      execute: async () => ({
        content: [{ type: 'text' as const, text: 'already-shaped' }],
      }),
    });

    const wrapped = wrapMastraToolForSdk('mcp-shaped', tool, stubContext)!;
    const result = await wrapped.handler({}, {});
    expect(result.content[0]).toEqual({ type: 'text', text: 'already-shaped' });
  });
});

describe('buildMastraToolsMcpServer', () => {
  it('registers every runnable tool and qualifies allowed tool names', () => {
    const tools = {
      echo: createTool({
        id: 'echo',
        description: 'Echo',
        inputSchema: z.object({ msg: z.string() }),
        execute: async a => a,
      }),
      add: createTool({
        id: 'add',
        description: 'Add',
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: async ({ a, b }) => ({ sum: a + b }),
      }),
    };

    const { server, allowedTools } = buildMastraToolsMcpServer(tools, stubContext);
    expect(server).toBeTruthy();
    expect(allowedTools.sort()).toEqual([qualifyMastraToolName('add'), qualifyMastraToolName('echo')].sort());
  });

  it('omits approval-gated tools from allowedTools so canUseTool fires', () => {
    // This is the landmine from earlier rounds: if a requireApproval tool lands in
    // allowedTools, the SDK auto-approves it and canUseTool never fires, defeating
    // the entire approval flow.
    const tools = {
      echo: createTool({
        id: 'echo',
        description: 'Echo (no approval)',
        inputSchema: z.object({ msg: z.string() }),
        execute: async a => a,
      }),
      writeNote: createTool({
        id: 'writeNote',
        description: 'Write a note (approval-gated)',
        inputSchema: z.object({ title: z.string(), body: z.string() }),
        requireApproval: true,
        execute: async a => a,
      }),
    };

    const { allowedTools } = buildMastraToolsMcpServer(tools, stubContext);

    expect(allowedTools).toContain(qualifyMastraToolName('echo'));
    expect(allowedTools).not.toContain(qualifyMastraToolName('writeNote'));
  });

  it('silently skips tools that cannot be wrapped', () => {
    const tools = {
      good: createTool({
        id: 'good',
        description: 'Fine',
        inputSchema: z.object({ x: z.number() }),
        execute: async a => a,
      }),
      noExec: createTool({
        id: 'noExec',
        description: 'Missing execute',
        inputSchema: z.object({ x: z.number() }),
      }),
      noSchema: createTool({
        id: 'noSchema',
        description: 'Missing schema',
        execute: async () => 'ok',
      }),
    };

    const { allowedTools } = buildMastraToolsMcpServer(tools, stubContext);
    expect(allowedTools).toEqual([qualifyMastraToolName('good')]);
  });
});
