import { describe, expect, beforeEach, it, vi } from 'vitest';
import { MastraClient } from '../client';

// Mock fetch globally
global.fetch = vi.fn();

describe('Claude Agent Resource', () => {
  let client: MastraClient;
  const clientOptions = {
    baseUrl: 'http://localhost:4111',
    headers: {
      Authorization: 'Bearer test-key',
      'x-mastra-client-type': 'js',
    },
  };

  const mockJsonResponse = (data: unknown) => {
    const response = new Response(undefined, {
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'Content-Type': 'application/json' }),
    });
    response.json = () => Promise.resolve(data);
    (global.fetch as any).mockResolvedValueOnce(response);
  };

  const mockStreamResponse = () => {
    const response = new Response(new ReadableStream(), {
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
    });
    (global.fetch as any).mockResolvedValueOnce(response);
    return response;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MastraClient(clientOptions);
  });

  describe('listClaudeAgents', () => {
    it('lists registered Claude agents', async () => {
      const payload = {
        agents: [
          {
            id: 'claude-demo',
            key: 'demoAgent',
            name: 'Claude Demo Agent',
            description: 'Test agent',
            model: 'sonnet',
            agentCount: 0,
            workflowCount: 1,
            toolCount: 2,
          },
        ],
      };
      mockJsonResponse(payload);

      const result = await client.listClaudeAgents();
      expect(result).toEqual(payload);
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents`,
        expect.objectContaining({ headers: expect.objectContaining(clientOptions.headers) }),
      );
    });
  });

  describe('getClaudeAgent + details', () => {
    it('fetches a single agent summary', async () => {
      const payload = {
        id: 'claude-demo',
        key: 'demoAgent',
        name: 'Claude Demo Agent',
        agentCount: 0,
        workflowCount: 1,
        toolCount: 2,
      };
      mockJsonResponse(payload);

      const agent = client.getClaudeAgent('claude-demo');
      const result = await agent.details();
      expect(result).toEqual(payload);
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo`,
        expect.objectContaining({ headers: expect.objectContaining(clientOptions.headers) }),
      );
    });

    it('encodes agent ids with special characters', async () => {
      mockJsonResponse({ id: 'a/b', key: 'a/b', agentCount: 0, workflowCount: 0, toolCount: 0 });
      await client.getClaudeAgent('a/b').details();
      expect(global.fetch).toHaveBeenCalledWith(`${clientOptions.baseUrl}/api/claude-agents/a%2Fb`, expect.any(Object));
    });
  });

  describe('listSessions', () => {
    it('fetches sessions without params', async () => {
      const payload = { sessions: [], total: 0, page: 0, perPage: 50, hasMore: false };
      mockJsonResponse(payload);

      const result = await client.getClaudeAgent('claude-demo').listSessions();
      expect(result).toEqual(payload);
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions`,
        expect.any(Object),
      );
    });

    it('encodes pagination + resourceId into query string', async () => {
      mockJsonResponse({ sessions: [], total: 0, page: 2, perPage: 10, hasMore: false });
      await client.getClaudeAgent('claude-demo').listSessions({ page: 2, perPage: 10, resourceId: 'user-1' });
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions?resourceId=user-1&page=2&perPage=10`,
        expect.any(Object),
      );
    });
  });

  describe('getSession', () => {
    it('fetches a single session', async () => {
      const payload = {
        id: 'sess-1',
        agentKey: 'demoAgent',
        messages: [],
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      };
      mockJsonResponse(payload);

      const result = await client.getClaudeAgent('claude-demo').getSession('sess-1');
      expect(result).toEqual(payload);
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions/sess-1`,
        expect.any(Object),
      );
    });
  });

  describe('createSession', () => {
    it('POSTs create body', async () => {
      const payload = {
        id: 'sess-2',
        agentKey: 'demoAgent',
        messages: [],
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      };
      mockJsonResponse(payload);

      const result = await client.getClaudeAgent('claude-demo').createSession({ title: 'New', resourceId: 'r1' });
      expect(result).toEqual(payload);
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'New', resourceId: 'r1' }),
        }),
      );
    });
  });

  describe('streamTurn', () => {
    it('POSTs stream body and returns raw Response', async () => {
      const response = mockStreamResponse();
      const result = await client.getClaudeAgent('claude-demo').streamTurn('new', { prompt: 'hi' });
      expect(result).toBe(response);
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions/new/stream`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ prompt: 'hi' }),
        }),
      );
    });

    it('passes permission mode + resourceId in body', async () => {
      mockStreamResponse();
      await client.getClaudeAgent('claude-demo').streamTurn('sess-1', {
        prompt: 'yo',
        permissionMode: 'acceptEdits',
        resourceId: 'r1',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions/sess-1/stream`,
        expect.objectContaining({
          body: JSON.stringify({ prompt: 'yo', permissionMode: 'acceptEdits', resourceId: 'r1' }),
        }),
      );
    });
  });

  describe('forkSession', () => {
    it('POSTs fork body', async () => {
      const payload = {
        id: 'sess-3',
        agentKey: 'demoAgent',
        messages: [],
        forkedFrom: 'sess-1',
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      };
      mockJsonResponse(payload);

      const result = await client.getClaudeAgent('claude-demo').forkSession('sess-1', { title: 'fork' });
      expect(result).toEqual(payload);
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions/sess-1/fork`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'fork' }),
        }),
      );
    });

    it('sends empty body when no params', async () => {
      mockJsonResponse({
        id: 'sess-3',
        agentKey: 'demoAgent',
        messages: [],
        createdAt: '',
        updatedAt: '',
      });
      await client.getClaudeAgent('claude-demo').forkSession('sess-1');
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions/sess-1/fork`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({}),
        }),
      );
    });
  });

  describe('updateSession', () => {
    it('PATCHes session metadata', async () => {
      const payload = {
        id: 'sess-1',
        agentKey: 'demoAgent',
        title: 'renamed',
        messages: [],
        createdAt: '',
        updatedAt: '',
      };
      mockJsonResponse(payload);

      const result = await client
        .getClaudeAgent('claude-demo')
        .updateSession('sess-1', { title: 'renamed', tags: ['a'] });
      expect(result).toEqual(payload);
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions/sess-1`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ title: 'renamed', tags: ['a'] }),
        }),
      );
    });
  });

  describe('deleteSession', () => {
    it('DELETEs the session', async () => {
      mockJsonResponse({ deleted: true });
      const result = await client.getClaudeAgent('claude-demo').deleteSession('sess-1');
      expect(result).toEqual({ deleted: true });
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions/sess-1`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('resolveApproval', () => {
    it('POSTs approval resolution', async () => {
      mockJsonResponse({ resolved: true });
      const result = await client
        .getClaudeAgent('claude-demo')
        .resolveApproval('sess-1', 'corr-1', { decision: 'allow', updatedInput: { x: 1 }, remember: true });
      expect(result).toEqual({ resolved: true });
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions/sess-1/approvals/corr-1/resolve`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ decision: 'allow', updatedInput: { x: 1 }, remember: true }),
        }),
      );
    });
  });

  describe('resolveQuestion', () => {
    it('POSTs question answers', async () => {
      mockJsonResponse({ resolved: true });
      const answers = { 'What is your name?': { selected: ['Alice'] } };
      const result = await client.getClaudeAgent('claude-demo').resolveQuestion('sess-1', 'q-1', { answers });
      expect(result).toEqual({ resolved: true });
      expect(global.fetch).toHaveBeenCalledWith(
        `${clientOptions.baseUrl}/api/claude-agents/claude-demo/sessions/sess-1/questions/q-1/resolve`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ answers }),
        }),
      );
    });
  });
});
