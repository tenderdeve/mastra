import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ClaudeAgent } from './claude-agent';

const aTool = () =>
  createTool({
    id: 'echo',
    description: 'echo',
    inputSchema: z.object({ input: z.string() }),
    execute: async ({ input }) => input,
  });

describe('ClaudeAgent (MVP shell)', () => {
  it('requires a non-empty id', () => {
    // @ts-expect-error: id is required
    expect(() => new ClaudeAgent({})).toThrow(/`id` is required/);
    expect(() => new ClaudeAgent({ id: '' })).toThrow(/`id` is required/);
    expect(() => new ClaudeAgent({ id: '   ' })).toThrow(/`id` is required/);
  });

  it('defaults name to id and leaves optional fields undefined', () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    expect(agent.id).toBe('demo');
    expect(agent.name).toBe('demo');
    expect(agent.description).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(agent.systemPrompt).toBeUndefined();
    expect(agent.permissionMode).toBeUndefined();
    expect(agent.cwd).toBeUndefined();
    expect(agent.toolCount).toBe(0);
    expect(agent.agentCount).toBe(0);
    expect(agent.workflowCount).toBe(0);
  });

  it('preserves explicit name + description + model + cwd', () => {
    const agent = new ClaudeAgent({
      id: 'demo',
      name: 'Claude Demo Agent',
      description: 'a demo',
      model: 'sonnet',
      cwd: '/tmp/x',
    });
    expect(agent.name).toBe('Claude Demo Agent');
    expect(agent.description).toBe('a demo');
    expect(agent.model).toBe('sonnet');
    expect(agent.cwd).toBe('/tmp/x');
  });

  it('accepts permissionMode across the full PermissionMode enum', () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const) {
      const agent = new ClaudeAgent({ id: 'x', permissionMode: mode });
      expect(agent.permissionMode).toBe(mode);
    }
  });

  it('forwards all three systemPrompt variants verbatim', () => {
    expect(new ClaudeAgent({ id: 'x', systemPrompt: 'hi' }).systemPrompt).toBe('hi');
    expect(
      new ClaudeAgent({
        id: 'x',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'more' },
      }).systemPrompt,
    ).toEqual({ type: 'preset', preset: 'claude_code', append: 'more' });
    expect(
      new ClaudeAgent({ id: 'x', systemPrompt: { type: 'string', value: 'full' } }).systemPrompt,
    ).toEqual({ type: 'string', value: 'full' });
  });

  it('defaults disableNonEssentialModelCalls to true for clean traces', () => {
    expect(new ClaudeAgent({ id: 'x' }).disableNonEssentialModelCalls).toBe(true);
    expect(new ClaudeAgent({ id: 'x', disableNonEssentialModelCalls: false }).disableNonEssentialModelCalls).toBe(
      false,
    );
  });

  it('returns defensive copies of tools/agents/workflows/subagents', () => {
    const tools = { echo: aTool() };
    const subagents: Record<string, AgentDefinition> = {
      helper: { description: 'help', prompt: 'You help.' },
    };

    const agent = new ClaudeAgent({ id: 'x', tools, subagents });

    const snap1 = agent.getTools();
    const snap2 = agent.getTools();
    expect(snap1).not.toBe(snap2);
    expect(snap1).toEqual(tools);

    // Mutating the snapshot must not leak back into the agent.
    delete (snap1 as Record<string, unknown>).echo;
    expect(agent.getTools()).toEqual(tools);
    expect(agent.toolCount).toBe(1);

    // Same for subagents.
    const subSnap = agent.getSubagents();
    delete (subSnap as Record<string, unknown>).helper;
    expect(agent.getSubagents()).toEqual(subagents);
  });

  it('collapses Mastra agents + SDK subagents into a single agentCount', () => {
    const fakeAgent = { id: 'chef', name: 'chef' } as any;
    const agent = new ClaudeAgent({
      id: 'x',
      agents: { chef: fakeAgent },
      subagents: {
        helper: { description: 'help', prompt: 'You help.' },
        researcher: { description: 'research', prompt: 'You research.' },
      },
    });
    expect(agent.agentCount).toBe(3);
  });

  it('counts workflows and tools independently', () => {
    const agent = new ClaudeAgent({
      id: 'x',
      tools: { a: aTool(), b: aTool() },
      workflows: { w: { id: 'w' } as any },
    });
    expect(agent.toolCount).toBe(2);
    expect(agent.workflowCount).toBe(1);
  });

  it('exposes mastra via __registerMastra / __getMastra', () => {
    const agent = new ClaudeAgent({ id: 'x' });
    expect(agent.__getMastra()).toBeUndefined();

    const mastra = { tag: 'mastra' };
    agent.__registerMastra(mastra);
    expect(agent.__getMastra()).toBe(mastra);

    // Subsequent register overwrites (Mastra re-registers on reconfigure).
    const mastra2 = { tag: 'mastra2' };
    agent.__registerMastra(mastra2);
    expect(agent.__getMastra()).toBe(mastra2);
  });

  it('satisfies the ClaudeAgentLike structural contract', () => {
    const agent = new ClaudeAgent({ id: 'demo', name: 'Demo', description: 'd' });
    // Duck-type the ClaudeAgentLike shape: id + optional name + description + __registerMastra.
    const like: {
      id: string;
      name?: string;
      description?: string;
      __registerMastra?: (m: unknown) => void;
    } = agent;
    expect(like.id).toBe('demo');
    expect(like.name).toBe('Demo');
    expect(like.description).toBe('d');
    expect(typeof like.__registerMastra).toBe('function');
  });
});
