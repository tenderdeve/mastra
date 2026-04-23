import { describe, it, expect, vi } from 'vitest';

import {
  CREATE_CLAUDE_AGENT_SESSION_ROUTE,
  DELETE_CLAUDE_AGENT_SESSION_ROUTE,
  FORK_CLAUDE_AGENT_SESSION_ROUTE,
  GET_CLAUDE_AGENT_ROUTE,
  GET_CLAUDE_AGENT_SESSION_ROUTE,
  LIST_CLAUDE_AGENTS_ROUTE,
  LIST_CLAUDE_AGENT_SESSIONS_ROUTE,
  RESOLVE_CLAUDE_AGENT_APPROVAL_ROUTE,
  RESOLVE_CLAUDE_AGENT_QUESTION_ROUTE,
  STREAM_CLAUDE_AGENT_TURN_ROUTE,
  UPDATE_CLAUDE_AGENT_SESSION_ROUTE,
} from './claude-agents';

type StreamOptions = Parameters<any>[0];

function createMockAgent(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'claude-demo',
    name: 'Claude Demo Agent',
    description: 'Test agent',
    model: 'claude-sonnet-4-5',
    agentCount: 1,
    workflowCount: 0,
    toolCount: 2,
    stream: vi.fn((_options: StreamOptions) => {
      return (async function* () {
        yield { type: 'start', runId: 'r1' } as any;
      })();
    }),
    getSession: vi.fn(async (id: string) => (id === 'missing' ? null : { id, agentKey: 'claude-demo', messages: [] })),
    listSessions: vi.fn(async () => ({ sessions: [], total: 0, page: 0, perPage: 50, hasMore: false })),
    updateSession: vi.fn(async (id: string, patch: any) =>
      id === 'missing' ? null : { id, agentKey: 'claude-demo', messages: [], ...patch },
    ),
    deleteSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async ({ sourceId, newId }: any) =>
      sourceId === 'missing' ? null : { id: newId, agentKey: 'claude-demo', forkedFrom: sourceId, messages: [] },
    ),
    resolveApproval: vi.fn(),
    resolveQuestion: vi.fn(),
    ...overrides,
  };
}

function createMockMastra(agent: ReturnType<typeof createMockAgent> | null) {
  return {
    getClaudeAgentById: vi.fn((id: string) => {
      if (!agent || agent.id !== id) {
        throw new Error(`claude agent '${id}' not found`);
      }
      return agent;
    }),
    getClaudeAgents: vi.fn(() => (agent ? { [agent.id]: agent } : {})),
    resolveClaudeAgentKey: vi.fn((id: string) => id),
  } as any;
}

function createMockRequestContext() {
  const store = new Map<string, unknown>();
  return {
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => store.set(k, v),
  } as any;
}

describe('Claude Agent Handlers', () => {
  describe('LIST_CLAUDE_AGENTS_ROUTE', () => {
    it('returns all registered claude agents', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      const result: any = await LIST_CLAUDE_AGENTS_ROUTE.handler({ mastra } as any);
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]).toMatchObject({
        id: 'claude-demo',
        key: 'claude-demo',
        agentCount: 1,
        toolCount: 2,
      });
    });

    it('returns empty list when no agents registered', async () => {
      const mastra = createMockMastra(null);
      const result: any = await LIST_CLAUDE_AGENTS_ROUTE.handler({ mastra } as any);
      expect(result.agents).toEqual([]);
    });
  });

  describe('GET_CLAUDE_AGENT_ROUTE', () => {
    it('returns the matching agent', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      const result: any = await GET_CLAUDE_AGENT_ROUTE.handler({ mastra, agentId: 'claude-demo' } as any);
      expect(result).toMatchObject({ id: 'claude-demo', key: 'claude-demo' });
    });

    it('throws a 404 for unknown agent', async () => {
      const mastra = createMockMastra(null);
      await expect(GET_CLAUDE_AGENT_ROUTE.handler({ mastra, agentId: 'does-not-exist' } as any)).rejects.toThrow(
        /not found/,
      );
    });
  });

  describe('LIST_CLAUDE_AGENT_SESSIONS_ROUTE', () => {
    it('paginates through agent sessions', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      const result: any = await LIST_CLAUDE_AGENT_SESSIONS_ROUTE.handler({
        mastra,
        agentId: 'claude-demo',
        resourceId: 'user-1',
        page: 0,
        perPage: 20,
      } as any);
      expect(result).toMatchObject({ total: 0, page: 0, perPage: 50, hasMore: false });
      expect(agent.listSessions).toHaveBeenCalledWith({ resourceId: 'user-1', page: 0, perPage: 20 });
    });
  });

  describe('GET_CLAUDE_AGENT_SESSION_ROUTE', () => {
    it('returns the session when it exists', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      const result: any = await GET_CLAUDE_AGENT_SESSION_ROUTE.handler({
        mastra,
        agentId: 'claude-demo',
        sessionId: 'sess-1',
      } as any);
      expect(result).toMatchObject({ id: 'sess-1' });
    });

    it('throws 404 for missing session', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      await expect(
        GET_CLAUDE_AGENT_SESSION_ROUTE.handler({
          mastra,
          agentId: 'claude-demo',
          sessionId: 'missing',
        } as any),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('CREATE_CLAUDE_AGENT_SESSION_ROUTE', () => {
    it('requires an explicit sessionId', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      await expect(
        CREATE_CLAUDE_AGENT_SESSION_ROUTE.handler({
          mastra,
          agentId: 'claude-demo',
        } as any),
      ).rejects.toThrow(/sessionId/);
    });

    it('applies optional metadata when sessionId provided', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      const result: any = await CREATE_CLAUDE_AGENT_SESSION_ROUTE.handler({
        mastra,
        agentId: 'claude-demo',
        sessionId: 'new-1',
        title: 'Hello',
        tags: ['x'],
      } as any);
      expect(result).toMatchObject({ id: 'new-1', title: 'Hello' });
      expect(agent.updateSession).toHaveBeenCalledWith('new-1', { title: 'Hello', tags: ['x'], metadata: undefined });
    });
  });

  describe('STREAM_CLAUDE_AGENT_TURN_ROUTE', () => {
    it('returns a ReadableStream and forwards options to agent.stream', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      const abortController = new AbortController();
      const rc = createMockRequestContext();

      const stream: any = await STREAM_CLAUDE_AGENT_TURN_ROUTE.handler({
        mastra,
        agentId: 'claude-demo',
        sessionId: 'sess-42',
        prompt: 'hello',
        resourceId: 'user-1',
        requestContext: rc,
        abortSignal: abortController.signal,
      } as any);

      expect(stream).toBeInstanceOf(ReadableStream);
      expect(agent.stream).toHaveBeenCalledTimes(1);
      const call: any = agent.stream.mock.calls[0][0];
      expect(call).toMatchObject({ prompt: 'hello', sessionId: 'sess-42', resourceId: 'user-1' });
      expect(call.abortController).toBeInstanceOf(AbortController);
      expect(call.requestContext).toBe(rc);

      // Verify the reader pulls a value from the generator
      const reader = stream.getReader();
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      expect(value).toMatchObject({ type: 'start' });
      await reader.cancel();
    });

    it('treats sessionId="new" as a new session (undefined)', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      await STREAM_CLAUDE_AGENT_TURN_ROUTE.handler({
        mastra,
        agentId: 'claude-demo',
        sessionId: 'new',
        prompt: 'hi',
        requestContext: createMockRequestContext(),
      } as any);
      expect((agent.stream.mock.calls[0][0] as any).sessionId).toBeUndefined();
    });
  });

  describe('FORK_CLAUDE_AGENT_SESSION_ROUTE', () => {
    it('forks an existing session', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      const result: any = await FORK_CLAUDE_AGENT_SESSION_ROUTE.handler({
        mastra,
        agentId: 'claude-demo',
        sessionId: 'sess-1',
        title: 'Fork',
      } as any);
      expect(result).toMatchObject({ forkedFrom: 'sess-1' });
    });

    it('throws 404 when source session missing', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      await expect(
        FORK_CLAUDE_AGENT_SESSION_ROUTE.handler({
          mastra,
          agentId: 'claude-demo',
          sessionId: 'missing',
        } as any),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('UPDATE_CLAUDE_AGENT_SESSION_ROUTE', () => {
    it('updates session metadata', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      const result: any = await UPDATE_CLAUDE_AGENT_SESSION_ROUTE.handler({
        mastra,
        agentId: 'claude-demo',
        sessionId: 'sess-1',
        title: 'Renamed',
      } as any);
      expect(result).toMatchObject({ id: 'sess-1', title: 'Renamed' });
    });

    it('throws 404 for unknown session', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      await expect(
        UPDATE_CLAUDE_AGENT_SESSION_ROUTE.handler({
          mastra,
          agentId: 'claude-demo',
          sessionId: 'missing',
          title: 'x',
        } as any),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('DELETE_CLAUDE_AGENT_SESSION_ROUTE', () => {
    it('deletes a session', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      const result: any = await DELETE_CLAUDE_AGENT_SESSION_ROUTE.handler({
        mastra,
        agentId: 'claude-demo',
        sessionId: 'sess-1',
      } as any);
      expect(result).toEqual({ deleted: true });
      expect(agent.deleteSession).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('RESOLVE_CLAUDE_AGENT_APPROVAL_ROUTE', () => {
    it('forwards allow decisions to the agent', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      const result: any = await RESOLVE_CLAUDE_AGENT_APPROVAL_ROUTE.handler({
        mastra,
        agentId: 'claude-demo',
        sessionId: 'sess-1',
        approvalId: 'ap-1',
        decision: 'allow',
        updatedInput: { foo: 1 },
        remember: true,
      } as any);
      expect(result).toEqual({ resolved: true });
      expect(agent.resolveApproval).toHaveBeenCalledWith('sess-1', 'ap-1', {
        decision: 'allow',
        updatedInput: { foo: 1 },
        message: undefined,
        remember: true,
      });
    });

    it('forwards deny decisions with optional message', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      await RESOLVE_CLAUDE_AGENT_APPROVAL_ROUTE.handler({
        mastra,
        agentId: 'claude-demo',
        sessionId: 'sess-1',
        approvalId: 'ap-2',
        decision: 'deny',
        message: 'nope',
      } as any);
      expect(agent.resolveApproval).toHaveBeenCalledWith(
        'sess-1',
        'ap-2',
        expect.objectContaining({ decision: 'deny', message: 'nope' }),
      );
    });
  });

  describe('RESOLVE_CLAUDE_AGENT_QUESTION_ROUTE', () => {
    it('forwards answers to the agent', async () => {
      const agent = createMockAgent();
      const mastra = createMockMastra(agent);
      const answers = { 'q-1': { selected: ['A'] } };
      const result: any = await RESOLVE_CLAUDE_AGENT_QUESTION_ROUTE.handler({
        mastra,
        agentId: 'claude-demo',
        sessionId: 'sess-1',
        questionId: 'q-1',
        answers,
      } as any);
      expect(result).toEqual({ resolved: true });
      expect(agent.resolveQuestion).toHaveBeenCalledWith('sess-1', 'q-1', { answers });
    });
  });
});
