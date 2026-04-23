/**
 * Tests for `ClaudeAgent.stream()` via `runClaudeAgentStream`.
 *
 * We stub the SDK's `query()` with a handcrafted async generator so the tests
 * exercise:
 *
 *   - Session creation on a fresh stream (captures `system(init)` id, persists
 *     the synthetic user message, appends SDK messages).
 *   - Session resume on an existing session (appends to prior transcript,
 *     no synthetic prompt re-injection).
 *   - Partial-assistant / stream_event filtering before persistence.
 *   - `canUseTool` wiring → approval-request event emitted + resolution
 *     flows through the pending registry.
 *   - Final chunk ordering: `start` → ... → `step-finish` → `finish` with
 *     session + message chunks in between.
 *   - Error path: SDK query throws → error chunk surfaced, session still
 *     persisted with whatever was accumulated.
 */

import type {
  PermissionMode,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeAgentPermissionRulesInMemory,
  ClaudeAgentSessionsInMemory,
  InMemoryDB,
} from '@mastra/core/storage';
import type { ChunkType } from '@mastra/core/stream';
import { describe, expect, it, vi } from 'vitest';

import { ClaudeAgent } from './claude-agent';
import type { MastraLike } from './claude-agent';
import { runClaudeAgentStream } from './stream';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sysInit(sessionId: string): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    uuid: `u-${sessionId}`,
    agents: [],
    apiKeySource: 'apiKey',
    betas: [],
    claude_code_version: 'test',
    cwd: '/tmp',
    tools: [],
    mcp_servers: [],
    model: 'sonnet',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
  } as unknown as SDKSystemMessage;
}

function assistantText(text: string, uuid: string, sessionId: string): SDKAssistantMessage {
  return {
    type: 'assistant',
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as unknown as SDKAssistantMessage;
}

function resultOk(sessionId: string): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    uuid: `r-${sessionId}`,
    result: 'ok',
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 1,
    total_cost_usd: 0.01,
    stop_reason: 'end_turn',
    api_error_status: null,
    usage: {} as any,
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKResultMessage;
}

function asQuery(messages: SDKMessage[]): Query {
  async function* gen(): AsyncGenerator<SDKMessage, void, void> {
    for (const m of messages) yield m;
  }
  const iter = gen();
  const q: Partial<Query> = {
    [Symbol.asyncIterator]: () => iter as any,
    next: () => iter.next(),
    return: () => iter.return!(undefined as any),
    throw: (e: any) => iter.throw!(e),
    interrupt: async () => {},
    setPermissionMode: async (_: PermissionMode) => {},
    setModel: async () => {},
    setMaxThinkingTokens: async () => {},
  };
  return q as Query;
}

function makeMastra(): { mastra: MastraLike; sessionsStore: ClaudeAgentSessionsInMemory; permissionRulesStore: ClaudeAgentPermissionRulesInMemory } {
  const db = new InMemoryDB();
  const sessionsStore = new ClaudeAgentSessionsInMemory({ db });
  const permissionRulesStore = new ClaudeAgentPermissionRulesInMemory({ db });
  const fakeComposite = {
    getStore: async (name: string) => {
      if (name === 'claudeAgentSessions') return sessionsStore;
      if (name === 'claudeAgentPermissionRules') return permissionRulesStore;
      return undefined;
    },
  };
  const mastra: MastraLike = {
    getStorage: () => fakeComposite as any,
    resolveClaudeAgentKey: (idOrKey: string) => idOrKey,
  };
  return { mastra, sessionsStore, permissionRulesStore };
}

async function collect(gen: AsyncGenerator<ChunkType, void, void>): Promise<ChunkType[]> {
  const out: ChunkType[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runClaudeAgentStream — fresh session', () => {
  it('captures minted session id, persists synthetic user message + assistant transcript', async () => {
    const { mastra, sessionsStore } = makeMastra();
    const agent = new ClaudeAgent({ id: 'demo' });
    agent.__registerMastra(mastra, 'demoKey');

    const realSessionId = 'real-session-123';
    const queryImpl = vi.fn(() =>
      asQuery([sysInit(realSessionId), assistantText('hello world', 'asst-1', realSessionId), resultOk(realSessionId)]),
    );

    const chunks = await collect(
      runClaudeAgentStream(
        agent,
        {
          prompt: 'hi there',
          requestContext: { get: () => undefined, set: () => {} } as any,
          newSessionId: () => 'placeholder',
          newCorrelationId: () => 'cid',
        },
        {
          sessionsStore,
          registry: agent.__getRegistry(),
          agentKey: 'demoKey',
          queryImpl,
        },
      ),
    );

    // session event emitted with real SDK id.
    const sessionEv = chunks.find(c => (c as any).type === 'data-claude-agent-session');
    expect(sessionEv).toBeDefined();
    expect((sessionEv as any).data).toEqual({ sessionId: realSessionId });

    // text delta carries assistant content.
    const textDelta = chunks.find(c => c.type === 'text-delta');
    expect((textDelta as any).payload.text).toBe('hello world');

    // stream opens + closes cleanly.
    expect(chunks[0].type).toBe('start');
    expect(chunks.at(-1)?.type).toBe('finish');

    // session persisted under the SDK id with user + system + assistant + result.
    const persisted = await sessionsStore.getSession(realSessionId);
    expect(persisted).not.toBeNull();
    expect(persisted!.agentKey).toBe('demoKey');
    const persistedTypes = (persisted!.messages as any[]).map(m => m.type);
    expect(persistedTypes[0]).toBe('user'); // synthetic prepended prompt
    expect(persistedTypes).toContain('assistant');
    expect(persistedTypes).toContain('result');
    // partial / stream_event / status envelopes are NOT persisted (landmine #13).
    expect(persistedTypes).not.toContain('stream_event');
    expect(persistedTypes).not.toContain('partial_assistant');
  });

  it('skips persistence of partial_assistant / stream_event envelopes (landmine #13)', async () => {
    const { mastra, sessionsStore } = makeMastra();
    const agent = new ClaudeAgent({ id: 'demo' });
    agent.__registerMastra(mastra, 'demoKey');

    const realSessionId = 'sid-filter';
    const partial: any = { type: 'partial_assistant', session_id: realSessionId };
    const streamEv: any = { type: 'stream_event', session_id: realSessionId };
    const status: any = { type: 'status', session_id: realSessionId };
    const queryImpl = vi.fn(() =>
      asQuery([
        sysInit(realSessionId),
        partial as SDKMessage,
        streamEv as SDKMessage,
        status as SDKMessage,
        assistantText('final', 'asst-1', realSessionId),
        resultOk(realSessionId),
      ]),
    );

    await collect(
      runClaudeAgentStream(
        agent,
        { prompt: 'hi', requestContext: {} as any, newSessionId: () => 'ph' },
        { sessionsStore, registry: agent.__getRegistry(), agentKey: 'demoKey', queryImpl },
      ),
    );

    const persisted = await sessionsStore.getSession(realSessionId);
    const types = (persisted!.messages as any[]).map(m => m.type);
    expect(types).toContain('user');
    expect(types).toContain('assistant');
    expect(types).toContain('result');
    expect(types).not.toContain('stream_event');
    expect(types).not.toContain('partial_assistant');
    expect(types).not.toContain('status');
  });
});

describe('runClaudeAgentStream — resume', () => {
  it('appends to the existing session transcript without re-injecting the user prompt', async () => {
    const { mastra, sessionsStore } = makeMastra();
    const agent = new ClaudeAgent({ id: 'demo' });
    agent.__registerMastra(mastra, 'demoKey');

    const priorMsg: any = { type: 'assistant', uuid: 'prior', session_id: 'existing-id', message: { role: 'assistant', content: [] } };
    await sessionsStore.saveSession({
      id: 'existing-id',
      agentKey: 'demoKey',
      messages: [priorMsg],
    });

    const queryImpl = vi.fn(() =>
      asQuery([sysInit('existing-id'), assistantText('second turn', 'asst-2', 'existing-id'), resultOk('existing-id')]),
    );

    await collect(
      runClaudeAgentStream(
        agent,
        {
          prompt: 'follow-up',
          sessionId: 'existing-id',
          requestContext: {} as any,
        },
        { sessionsStore, registry: agent.__getRegistry(), agentKey: 'demoKey', queryImpl },
      ),
    );

    const persisted = await sessionsStore.getSession('existing-id');
    // prior + 2 new (system init is not persistable per our filter, wait — it is kept).
    // types should be: assistant (prior), system (init), assistant (new), result.
    const types = (persisted!.messages as any[]).map(m => m.type);
    expect(types).toEqual(['assistant', 'system', 'assistant', 'result']);
    // no synthetic user prepend on resume.
    expect(types.filter(t => t === 'user').length).toBe(0);
  });
});

describe('runClaudeAgentStream — errors', () => {
  it('surfaces SDK errors as an error chunk and still persists the session', async () => {
    const { mastra, sessionsStore } = makeMastra();
    const agent = new ClaudeAgent({ id: 'demo' });
    agent.__registerMastra(mastra, 'demoKey');

    const realSessionId = 'sid-err';
    const queryImpl = vi.fn(() => {
      async function* gen(): AsyncGenerator<SDKMessage, void, void> {
        yield sysInit(realSessionId);
        throw new Error('boom');
      }
      const iter = gen();
      return {
        [Symbol.asyncIterator]: () => iter,
        next: () => iter.next(),
        return: () => iter.return!(undefined as any),
        throw: (e: any) => iter.throw!(e),
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
      } as unknown as Query;
    });

    const chunks = await collect(
      runClaudeAgentStream(
        agent,
        { prompt: 'hi', requestContext: {} as any, newSessionId: () => 'ph' },
        { sessionsStore, registry: agent.__getRegistry(), agentKey: 'demoKey', queryImpl },
      ),
    );

    expect(chunks.some(c => c.type === 'error')).toBe(true);
    expect(chunks.at(-1)?.type).toBe('finish');
    // session row exists even though the turn failed.
    const persisted = await sessionsStore.getSession(realSessionId);
    expect(persisted).not.toBeNull();
  });

  it('throws when the agent has not been registered with a Mastra instance', async () => {
    const agent = new ClaudeAgent({ id: 'orphan' });
    await expect(async () => {
      for await (const _ of agent.stream({ prompt: 'hi', requestContext: {} as any })) {
        // never reached
      }
    }).rejects.toThrow(/not registered with a Mastra instance/);
  });
});

describe('runClaudeAgentStream — permission flow', () => {
  it('falls through canUseTool → approval-request event, resolves via registry', async () => {
    const { mastra, sessionsStore } = makeMastra();
    const agent = new ClaudeAgent({ id: 'demo' });
    agent.__registerMastra(mastra, 'demoKey');

    const realSessionId = 'sid-approve';
    const queryImpl = (params: { options?: any }) => {
      const canUse = params.options.canUseTool as (...args: any[]) => Promise<any>;
      async function* gen(): AsyncGenerator<SDKMessage, void, void> {
        yield sysInit(realSessionId);
        // kick off an approval then wait for it to resolve before finishing.
        const res = await canUse('mcp__mastra__writeNote', { body: 'x' }, {
          signal: new AbortController().signal,
          suggestions: [],
          toolUseID: 'tu-1',
        });
        expect(res.behavior).toBe('allow');
        yield resultOk(realSessionId);
      }
      const iter = gen();
      return {
        [Symbol.asyncIterator]: () => iter,
        next: () => iter.next(),
        return: () => iter.return!(undefined as any),
        throw: (e: any) => iter.throw!(e),
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
      } as unknown as Query;
    };

    // Drive the generator and resolve the approval mid-stream.
    const gen = runClaudeAgentStream(
      agent,
      {
        prompt: 'write a note',
        requestContext: {} as any,
        newCorrelationId: () => 'cid-approve',
        newSessionId: () => 'ph',
      },
      {
        sessionsStore,
        registry: agent.__getRegistry(),
        agentKey: 'demoKey',
        queryImpl,
      },
    );

    const collected: ChunkType[] = [];
    for await (const chunk of gen) {
      collected.push(chunk);
      if ((chunk as any).type === 'data-claude-agent-approval-request') {
        const req = (chunk as any).data as { sessionId: string; correlationId: string };
        agent.__getRegistry().resolveApproval(req.sessionId, req.correlationId, { decision: 'allow' });
      }
    }

    const approvalReq = collected.find(c => (c as any).type === 'data-claude-agent-approval-request');
    const approvalResolved = collected.find(c => (c as any).type === 'data-claude-agent-approval-resolved');
    expect(approvalReq).toBeDefined();
    expect(approvalResolved).toBeDefined();
    expect((approvalResolved as any).data.decision).toBe('approve');
  });
});
