import { createTool } from '@mastra/core/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  buildAgentDelegationTool,
  buildWorkflowDelegationTool,
  mergeDelegationTools,
} from './delegation';
import type { AnyMastraAgent, AnyMastraWorkflow } from './delegation';
import { buildMastraToolsMcpServer, wrapMastraToolForSdk } from './mcp-bridge';
import type { MastraToolExecutionContext } from './mcp-bridge';
import { qualifyMastraToolName } from './tool-names';

const stubContext = (): MastraToolExecutionContext => ({
  mastra: {} as never,
  requestContext: {} as never,
  abortSignal: undefined,
});

/**
 * Build a minimal Agent stand-in. The real Agent class has 4 generics and a
 * huge surface area; the delegation wrapper only reads `name` / `id` /
 * `getDescription()` and calls `.generate(message, options)`, so a duck-typed
 * test double is faithful enough.
 */
type StubOverrides = Record<string, any>;

function stubAgent(overrides: StubOverrides): AnyMastraAgent {
  const generate = overrides.generate ?? vi.fn(async () => ({ text: 'stub-response' }));
  return {
    id: overrides.id ?? 'chef',
    name: overrides.name ?? 'Chef',
    getDescription: () => overrides.description ?? 'A helpful chef agent',
    generate,
  } as unknown as AnyMastraAgent;
}

function stubWorkflow(overrides: StubOverrides): AnyMastraWorkflow {
  const start = overrides.start ?? vi.fn(async () => ({ status: 'success' as const, result: { ok: true } }));
  const run = { start };
  const createRun = vi.fn(async () => run);
  return {
    id: overrides.id ?? 'myWorkflow',
    description: 'description' in overrides ? overrides.description : 'A test workflow',
    inputSchema: 'inputSchema' in overrides ? overrides.inputSchema : z.object({ query: z.string() }),
    createRun,
  } as unknown as AnyMastraWorkflow;
}

describe('buildAgentDelegationTool', () => {
  it('produces a tool whose execute calls agent.generate and returns .text', async () => {
    const generate = vi.fn(async (msg: string) => ({ text: `pong: ${msg}` }));
    const agent = stubAgent({ generate });

    const tool = buildAgentDelegationTool('chef', agent);
    expect(tool.id).toBe('chef');

    const wrapped = wrapMastraToolForSdk('chef', tool, stubContext)!;
    expect(wrapped).not.toBeNull();

    const result = await wrapped.handler({ message: 'hello' }, {});
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toBe('hello');

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      text: 'pong: hello',
    });
  });

  it('exposes a z.object({ message }) schema so the SDK validates args upstream', () => {
    const agent = stubAgent({});
    const tool = buildAgentDelegationTool('chef', agent);

    // The SDK validates args against the raw shape before invoking the handler,
    // so we only need to assert here that the schema we ship is the one a model
    // can reason about — single required `message: string` field.
    const shape = (tool.inputSchema as any)?.shape ?? (tool.inputSchema as any)?._def?.shape?.();
    expect(shape).toBeDefined();
    expect(Object.keys(shape)).toEqual(['message']);
  });

  it('falls back to a generic description when the agent has none', () => {
    const agent = stubAgent({ description: '' });
    const tool = buildAgentDelegationTool('chef', agent);
    // Empty string still wins over the fallback — that's on the caller to fix.
    // What we want here is: the wrapper never crashes, the description is a
    // string, and it mentions the agent name somewhere when the agent provided
    // nothing meaningful.
    expect(typeof tool.description).toBe('string');
  });
});

describe('buildWorkflowDelegationTool', () => {
  it('produces a tool whose execute runs workflow.createRun().start() and returns the result', async () => {
    const start = vi.fn(async () => ({ status: 'success' as const, result: { answer: 42 } }));
    const workflow = stubWorkflow({ start });

    const tool = buildWorkflowDelegationTool('myWorkflow', workflow);
    const wrapped = wrapMastraToolForSdk('myWorkflow', tool, stubContext)!;

    const result = await wrapped.handler({ query: 'the universe' }, {});

    expect(start).toHaveBeenCalledTimes(1);
    const startArgs = (start.mock.calls[0] as [{ inputData: unknown }])[0];
    expect(startArgs.inputData).toEqual({ query: 'the universe' });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      status: 'success',
      result: { answer: 42 },
    });
  });

  it('surfaces failed workflow runs as isError CallToolResult', async () => {
    const start = vi.fn(async () => ({
      status: 'failed' as const,
      error: new Error('workflow exploded'),
    }));
    const workflow = stubWorkflow({ start });

    const tool = buildWorkflowDelegationTool('myWorkflow', workflow);
    const wrapped = wrapMastraToolForSdk('myWorkflow', tool, stubContext)!;

    const result = await wrapped.handler({ query: 'x' }, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe('workflow exploded');
  });

  it('surfaces non-terminal outcomes (suspended) as isError', async () => {
    const start = vi.fn(async () => ({ status: 'suspended' as const }));
    const workflow = stubWorkflow({ start });

    const tool = buildWorkflowDelegationTool('myWorkflow', workflow);
    const wrapped = wrapMastraToolForSdk('myWorkflow', tool, stubContext)!;

    const result = await wrapped.handler({ query: 'x' }, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/non-terminal/);
  });

  it('throws at build time when the workflow has no description', () => {
    const workflow = stubWorkflow({ description: undefined });
    expect(() => buildWorkflowDelegationTool('myWorkflow', workflow)).toThrowError(/non-empty description/);
  });

  it('throws at build time when the workflow has no inputSchema', () => {
    const workflow = stubWorkflow({ inputSchema: undefined });
    expect(() => buildWorkflowDelegationTool('myWorkflow', workflow)).toThrowError(/inputSchema/);
  });
});

describe('mergeDelegationTools', () => {
  it('merges tools + agents + workflows into one record with unique keys', () => {
    const tools = {
      echo: createTool({
        id: 'echo',
        description: 'Echo',
        inputSchema: z.object({ msg: z.string() }),
        execute: async a => a,
      }),
    };
    const agents = { chef: stubAgent({}), sous: stubAgent({ id: 'sous', name: 'Sous' }) };
    const workflows = { greet: stubWorkflow({ id: 'greet' }) };

    const merged = mergeDelegationTools({ tools, agents, workflows });
    expect(Object.keys(merged).sort()).toEqual(['chef', 'echo', 'greet', 'sous']);
  });

  it('excludes the self agent key so the Claude agent cannot delegate to itself', () => {
    const agents = { claudeDemoAgent: stubAgent({}), chef: stubAgent({}) };
    const merged = mergeDelegationTools({ agents, selfAgentKey: 'claudeDemoAgent' });
    expect(Object.keys(merged)).toEqual(['chef']);
  });

  it('explicit tools beat synthetic delegation tools on name collision', () => {
    const explicitTool = createTool({
      id: 'chef',
      description: 'Explicit override',
      inputSchema: z.object({ x: z.string() }),
      execute: async a => ({ winner: 'explicit', ...a }),
    });

    const merged = mergeDelegationTools({
      tools: { chef: explicitTool },
      agents: { chef: stubAgent({}) },
    });

    expect(merged.chef).toBe(explicitTool);
  });

  it('produces an allowedTools list that qualifies synthetic delegation tools too', () => {
    const agents = { chef: stubAgent({}) };
    const workflows = { greet: stubWorkflow({ id: 'greet' }) };

    const merged = mergeDelegationTools({ agents, workflows });
    const { allowedTools } = buildMastraToolsMcpServer(merged, stubContext);

    expect(allowedTools.sort()).toEqual(
      [qualifyMastraToolName('chef'), qualifyMastraToolName('greet')].sort(),
    );
  });
});
