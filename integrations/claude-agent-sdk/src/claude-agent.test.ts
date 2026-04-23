import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeAgentPermissionRulesInMemory,
  ClaudeAgentSessionsInMemory,
  InMemoryDB,
} from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ClaudeAgent } from './claude-agent';
import type { MastraLike } from './claude-agent';

function registerAgent(agent: ClaudeAgent) {
  const db = new InMemoryDB();
  const sessionsStore = new ClaudeAgentSessionsInMemory({ db });
  const permissionRulesStore = new ClaudeAgentPermissionRulesInMemory({ db });
  const mastra: MastraLike = {
    getStorage: () =>
      ({
        getStore: async (name: string) => {
          if (name === 'claudeAgentSessions') return sessionsStore;
          if (name === 'claudeAgentPermissionRules') return permissionRulesStore;
          return undefined;
        },
      }) as any,
    resolveClaudeAgentKey: (idOrKey: string) => idOrKey,
  };
  agent.__registerMastra(mastra, agent.id);
  return { sessionsStore, permissionRulesStore };
}

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

describe('ClaudeAgent session CRUD facade', () => {
  it('reads, lists, updates, deletes, and forks persisted sessions', async () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    const { sessionsStore } = registerAgent(agent);

    // Seed two sessions directly through the store.
    await sessionsStore.saveSession({
      id: 's-1',
      agentKey: 'demo',
      messages: [{ type: 'user', content: 'hi' }] as any,
      title: 'first',
    });
    await sessionsStore.saveSession({
      id: 's-2',
      agentKey: 'demo',
      messages: [] as any,
      title: 'second',
    });

    // getSession
    const s1 = await agent.getSession('s-1');
    expect(s1?.id).toBe('s-1');
    const missing = await agent.getSession('does-not-exist');
    expect(missing).toBeNull();

    // listSessions
    const list = await agent.listSessions();
    expect(list.sessions.map(s => s.id).sort()).toEqual(['s-1', 's-2']);

    // updateSession
    const renamed = await agent.updateSession('s-1', { title: 'renamed' });
    expect(renamed?.title).toBe('renamed');

    // forkSession
    const forked = await agent.forkSession({ sourceId: 's-1', newId: 's-fork' });
    expect(forked?.forkedFrom).toBe('s-1');
    expect(forked?.id).toBe('s-fork');
    expect(forked?.messages.length).toBe(1);

    // deleteSession
    await agent.deleteSession('s-2');
    expect(await agent.getSession('s-2')).toBeNull();
  });

  it('throws when facade methods are called before registration', async () => {
    const agent = new ClaudeAgent({ id: 'orphan' });
    await expect(agent.getSession('x')).rejects.toThrow(/not registered with a Mastra instance/);
    await expect(agent.listSessions()).rejects.toThrow(/not registered with a Mastra instance/);
    await expect(agent.deleteSession('x')).rejects.toThrow(/not registered with a Mastra instance/);
  });
});

describe('ClaudeAgent approval + question resolution', () => {
  it('routes resolveApproval + resolveQuestion through the shared pending registry', async () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    const registry = agent.__getRegistry();

    const approvalPromise = registry.registerApproval({
      kind: 'approval',
      sessionId: 'sess-1',
      correlationId: 'cid-1',
      toolName: 'writeNote',
      input: { body: 'x' },
    });
    agent.resolveApproval('sess-1', 'cid-1', { decision: 'allow' });
    await expect(approvalPromise).resolves.toEqual({ decision: 'allow' });

    const questionPromise = registry.registerQuestion({
      kind: 'question',
      sessionId: 'sess-1',
      correlationId: 'cid-2',
      questions: [
        { id: 'q1', question: 'pick one', options: [{ label: 'a' }, { label: 'b' }] },
      ],
    });
    agent.resolveQuestion('sess-1', 'cid-2', { answers: { q1: { selected: ['a'] } } });
    await expect(questionPromise).resolves.toEqual({ answers: { q1: { selected: ['a'] } } });
  });

  it('cancels everything pending for a session', async () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    const registry = agent.__getRegistry();

    const p = registry.registerApproval({
      kind: 'approval',
      sessionId: 'sess-1',
      correlationId: 'cid-a',
      toolName: 't',
      input: {},
    });
    agent.cancelAllPending('sess-1', 'user aborted');
    await expect(p).rejects.toThrow(/user aborted/);
  });
});
