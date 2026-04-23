import type { ClaudeAgentLike } from '@mastra/core/claude-agents';
import type { RequestContext } from '@mastra/core/request-context';
import type { ChunkType } from '@mastra/core/stream';

import { HTTPException } from '../http-exception';
import {
  claudeAgentApprovalPathParams,
  claudeAgentIdPathParams,
  claudeAgentQuestionPathParams,
  claudeAgentSessionPathParams,
  claudeAgentSessionResponseSchema,
  createClaudeAgentSessionBodySchema,
  deleteClaudeAgentSessionResponseSchema,
  forkClaudeAgentSessionBodySchema,
  getClaudeAgentResponseSchema,
  listClaudeAgentSessionsQuerySchema,
  listClaudeAgentSessionsResponseSchema,
  listClaudeAgentsResponseSchema,
  resolveClaudeAgentApprovalBodySchema,
  resolveClaudeAgentApprovalResponseSchema,
  resolveClaudeAgentQuestionBodySchema,
  resolveClaudeAgentQuestionResponseSchema,
  streamClaudeAgentTurnBodySchema,
  streamClaudeAgentTurnResponseSchema,
  updateClaudeAgentSessionBodySchema,
} from '../schemas/claude-agents';
import { createRoute } from '../server-adapter/routes/route-builder';
import { handleError } from './error';

// ============================================================================
// Structural type for a Claude Agent as seen by server handlers.
//
// Core exports only a minimal `ClaudeAgentLike` (id/name/description); the
// richer stream + session CRUD methods live on the concrete `ClaudeAgent`
// class in `@mastra/claude-agent-sdk`. We can't import that package from
// `@mastra/server` (layering), so we describe the surface structurally and
// cast registered agents to it at the edge. Every method matches the shape
// on `ClaudeAgent` — if that ever drifts, these casts will start failing at
// runtime and the handler tests will catch it.
// ============================================================================

type StreamMethod = (options: {
  prompt: string;
  sessionId?: string;
  resourceId?: string;
  title?: string;
  permissionMode?: string;
  requestContext: RequestContext;
  abortController?: AbortController;
}) => AsyncGenerator<ChunkType, void, void>;

interface ClaudeAgentServerShape extends ClaudeAgentLike {
  readonly model?: string;
  readonly agentCount?: number;
  readonly workflowCount?: number;
  readonly toolCount?: number;

  stream: StreamMethod;

  getSession(sessionId: string): Promise<unknown>;
  listSessions(input?: { resourceId?: string; page?: number; perPage?: number }): Promise<{
    sessions: unknown[];
    total: number;
    page: number;
    perPage: number;
    hasMore: boolean;
  }>;
  updateSession(
    sessionId: string,
    input: { title?: string; tags?: string[]; metadata?: Record<string, unknown> },
  ): Promise<unknown>;
  deleteSession(sessionId: string): Promise<void>;
  forkSession(input: { sourceId: string; newId: string; title?: string; resourceId?: string }): Promise<unknown>;

  resolveApproval(
    sessionId: string,
    correlationId: string,
    resolution: {
      decision: 'allow' | 'deny';
      updatedInput?: Record<string, unknown>;
      message?: string;
      remember?: boolean;
    },
  ): void;
  resolveQuestion(
    sessionId: string,
    correlationId: string,
    resolution: {
      answers: Record<string, { selected: string[]; other?: string }>;
    },
  ): void;
}

// ============================================================================
// Helpers
// ============================================================================

function getClaudeAgentOrThrow(mastra: { getClaudeAgentById: (id: string) => ClaudeAgentLike }, agentId: string) {
  try {
    const agent = mastra.getClaudeAgentById(agentId);
    return agent as unknown as ClaudeAgentServerShape;
  } catch (error) {
    throw new HTTPException(404, {
      message: `Claude agent '${agentId}' not found`,
      cause: error,
    });
  }
}

function resolveAgentKey(mastra: { resolveClaudeAgentKey?: (id: string) => string }, fallbackId: string): string {
  return mastra.resolveClaudeAgentKey?.(fallbackId) ?? fallbackId;
}

/**
 * Adapt an `AsyncGenerator` (what `ClaudeAgent.stream()` returns) into a
 * `ReadableStream<ChunkType>` (what our stream route contract expects). The
 * server adapter runs each chunk through `convertMastraChunkToAISDKv5` on
 * the way out, so the ChunkType-ness of the values is preserved.
 */
function generatorToReadableStream<T>(gen: AsyncGenerator<T, void, void>): ReadableStream<T> {
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      try {
        await gen.return();
      } catch {
        // swallow - the generator may already be closed
      }
    },
  });
}

function serializeAgent(agent: ClaudeAgentServerShape, key: string) {
  return {
    id: agent.id,
    key,
    name: agent.name,
    description: agent.description,
    model: agent.model,
    agentCount: agent.agentCount ?? 0,
    workflowCount: agent.workflowCount ?? 0,
    toolCount: agent.toolCount ?? 0,
  };
}

// ============================================================================
// Route Definitions
// ============================================================================

export const LIST_CLAUDE_AGENTS_ROUTE = createRoute({
  method: 'GET',
  path: '/claude-agents',
  responseType: 'json',
  responseSchema: listClaudeAgentsResponseSchema,
  summary: 'List Claude agents',
  description: 'Returns all Claude Agent SDK–backed agents registered on this Mastra instance.',
  tags: ['Claude Agents'],
  requiresAuth: true,
  requiresPermission: 'agents:read',
  handler: async ({ mastra }) => {
    try {
      const registry = (mastra.getClaudeAgents?.() ?? {}) as Record<string, ClaudeAgentServerShape>;
      const agents = Object.entries(registry).map(([key, agent]) => serializeAgent(agent, key));
      return { agents };
    } catch (error) {
      return handleError(error, 'error listing claude agents');
    }
  },
});

export const GET_CLAUDE_AGENT_ROUTE = createRoute({
  method: 'GET',
  path: '/claude-agents/:agentId',
  responseType: 'json',
  pathParamSchema: claudeAgentIdPathParams,
  responseSchema: getClaudeAgentResponseSchema,
  summary: 'Get Claude agent',
  description: 'Return metadata for a single Claude Agent SDK–backed agent.',
  tags: ['Claude Agents'],
  requiresAuth: true,
  requiresPermission: 'agents:read',
  handler: async ({ mastra, agentId }) => {
    try {
      const agent = getClaudeAgentOrThrow(mastra, agentId);
      const key = resolveAgentKey(mastra, agentId);
      return serializeAgent(agent, key);
    } catch (error) {
      return handleError(error, 'error retrieving claude agent');
    }
  },
});

export const LIST_CLAUDE_AGENT_SESSIONS_ROUTE = createRoute({
  method: 'GET',
  path: '/claude-agents/:agentId/sessions',
  responseType: 'json',
  pathParamSchema: claudeAgentIdPathParams,
  queryParamSchema: listClaudeAgentSessionsQuerySchema,
  responseSchema: listClaudeAgentSessionsResponseSchema,
  summary: 'List Claude agent sessions',
  description: 'Paginated list of persisted sessions for a Claude agent.',
  tags: ['Claude Agents'],
  requiresAuth: true,
  requiresPermission: 'agents:read',
  handler: async ({ mastra, agentId, resourceId, page, perPage }) => {
    try {
      const agent = getClaudeAgentOrThrow(mastra, agentId);
      const result = await agent.listSessions({ resourceId, page, perPage });
      return result as any;
    } catch (error) {
      return handleError(error, 'error listing claude agent sessions');
    }
  },
});

export const GET_CLAUDE_AGENT_SESSION_ROUTE = createRoute({
  method: 'GET',
  path: '/claude-agents/:agentId/sessions/:sessionId',
  responseType: 'json',
  pathParamSchema: claudeAgentSessionPathParams,
  responseSchema: claudeAgentSessionResponseSchema,
  summary: 'Get Claude agent session',
  description: 'Return a single persisted session by id.',
  tags: ['Claude Agents'],
  requiresAuth: true,
  requiresPermission: 'agents:read',
  handler: async ({ mastra, agentId, sessionId }) => {
    try {
      const agent = getClaudeAgentOrThrow(mastra, agentId);
      const session = await agent.getSession(sessionId);
      if (!session) {
        throw new HTTPException(404, { message: `Session '${sessionId}' not found` });
      }
      return session as any;
    } catch (error) {
      return handleError(error, 'error retrieving claude agent session');
    }
  },
});

export const CREATE_CLAUDE_AGENT_SESSION_ROUTE = createRoute({
  method: 'POST',
  path: '/claude-agents/:agentId/sessions',
  responseType: 'json',
  pathParamSchema: claudeAgentIdPathParams,
  bodySchema: createClaudeAgentSessionBodySchema,
  responseSchema: claudeAgentSessionResponseSchema,
  summary: 'Create an empty Claude agent session placeholder',
  description:
    'Create a session row up-front (for example when pre-navigating to a chat). The SDK still mints the real session id on the first turn; this endpoint is mostly for clients that want an identifier before streaming.',
  tags: ['Claude Agents'],
  requiresAuth: true,
  requiresPermission: 'agents:write',
  handler: async ({ mastra, agentId, sessionId, resourceId, title, tags, metadata }) => {
    try {
      const agent = getClaudeAgentOrThrow(mastra, agentId);
      if (!sessionId) {
        throw new HTTPException(400, {
          message:
            'createSession requires an explicit sessionId. Omit this call and stream directly to let the SDK mint one.',
        });
      }
      const updated = await agent.updateSession(sessionId, { title, tags, metadata });
      if (updated) return updated as any;
      // No existing row — update is a no-op. Return a stub the client can use.
      return {
        id: sessionId,
        agentKey: resolveAgentKey(mastra, agentId),
        resourceId,
        title,
        messages: [],
        tags,
        metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    } catch (error) {
      return handleError(error, 'error creating claude agent session');
    }
  },
});

export const STREAM_CLAUDE_AGENT_TURN_ROUTE = createRoute({
  method: 'POST',
  path: '/claude-agents/:agentId/sessions/:sessionId/stream',
  responseType: 'stream' as const,
  streamFormat: 'sse' as const,
  pathParamSchema: claudeAgentSessionPathParams,
  bodySchema: streamClaudeAgentTurnBodySchema,
  responseSchema: streamClaudeAgentTurnResponseSchema,
  summary: 'Stream a Claude agent turn',
  description:
    'Run a single Claude Agent SDK turn against the session id in the path. Emits Mastra `ChunkType` chunks over SSE; the server adapter converts each chunk to AI-SDK v5 wire format on the way out.',
  tags: ['Claude Agents'],
  requiresAuth: true,
  requiresPermission: 'agents:execute',
  handler: async ({
    mastra,
    agentId,
    sessionId,
    abortSignal,
    requestContext: serverRequestContext,
    prompt,
    resourceId,
    title,
    permissionMode,
    requestContext: bodyRequestContext,
  }) => {
    try {
      const agent = getClaudeAgentOrThrow(mastra, agentId);

      // Merge body-supplied requestContext onto the server-managed instance,
      // matching the pattern used by the regular agents stream endpoint.
      if (bodyRequestContext && typeof bodyRequestContext === 'object') {
        for (const [key, value] of Object.entries(bodyRequestContext)) {
          if (serverRequestContext.get(key) === undefined) {
            serverRequestContext.set(key, value);
          }
        }
      }

      const abortController = new AbortController();
      if (abortSignal) {
        if (abortSignal.aborted) abortController.abort(abortSignal.reason);
        else abortSignal.addEventListener('abort', () => abortController.abort(abortSignal.reason), { once: true });
      }

      const generator = agent.stream({
        prompt,
        sessionId: sessionId === 'new' ? undefined : sessionId,
        resourceId,
        title,
        permissionMode,
        requestContext: serverRequestContext,
        abortController,
      });
      return generatorToReadableStream(generator);
    } catch (error) {
      return handleError(error, 'error streaming claude agent turn');
    }
  },
});

export const FORK_CLAUDE_AGENT_SESSION_ROUTE = createRoute({
  method: 'POST',
  path: '/claude-agents/:agentId/sessions/:sessionId/fork',
  responseType: 'json',
  pathParamSchema: claudeAgentSessionPathParams,
  bodySchema: forkClaudeAgentSessionBodySchema,
  responseSchema: claudeAgentSessionResponseSchema,
  summary: 'Fork a Claude agent session',
  description: 'Create a new session whose message history is copied from an existing session.',
  tags: ['Claude Agents'],
  requiresAuth: true,
  requiresPermission: 'agents:write',
  handler: async ({ mastra, agentId, sessionId, title, resourceId }) => {
    try {
      const agent = getClaudeAgentOrThrow(mastra, agentId);
      const newId =
        typeof (globalThis as any).crypto?.randomUUID === 'function'
          ? (globalThis as any).crypto.randomUUID()
          : `${sessionId}-fork-${Date.now()}`;
      const forked = await agent.forkSession({ sourceId: sessionId, newId, title, resourceId });
      if (!forked) {
        throw new HTTPException(404, { message: `Source session '${sessionId}' not found` });
      }
      return forked as any;
    } catch (error) {
      return handleError(error, 'error forking claude agent session');
    }
  },
});

export const UPDATE_CLAUDE_AGENT_SESSION_ROUTE = createRoute({
  method: 'PATCH',
  path: '/claude-agents/:agentId/sessions/:sessionId',
  responseType: 'json',
  pathParamSchema: claudeAgentSessionPathParams,
  bodySchema: updateClaudeAgentSessionBodySchema,
  responseSchema: claudeAgentSessionResponseSchema,
  summary: 'Update Claude agent session metadata',
  description: 'Update title / tags / metadata on a persisted session.',
  tags: ['Claude Agents'],
  requiresAuth: true,
  requiresPermission: 'agents:write',
  handler: async ({ mastra, agentId, sessionId, title, tags, metadata }) => {
    try {
      const agent = getClaudeAgentOrThrow(mastra, agentId);
      const updated = await agent.updateSession(sessionId, { title, tags, metadata });
      if (!updated) {
        throw new HTTPException(404, { message: `Session '${sessionId}' not found` });
      }
      return updated as any;
    } catch (error) {
      return handleError(error, 'error updating claude agent session');
    }
  },
});

export const DELETE_CLAUDE_AGENT_SESSION_ROUTE = createRoute({
  method: 'DELETE',
  path: '/claude-agents/:agentId/sessions/:sessionId',
  responseType: 'json',
  pathParamSchema: claudeAgentSessionPathParams,
  responseSchema: deleteClaudeAgentSessionResponseSchema,
  summary: 'Delete Claude agent session',
  description: 'Delete a persisted session. Also cancels anything pending on that session id.',
  tags: ['Claude Agents'],
  requiresAuth: true,
  requiresPermission: 'agents:write',
  handler: async ({ mastra, agentId, sessionId }) => {
    try {
      const agent = getClaudeAgentOrThrow(mastra, agentId);
      await agent.deleteSession(sessionId);
      return { deleted: true };
    } catch (error) {
      return handleError(error, 'error deleting claude agent session');
    }
  },
});

export const RESOLVE_CLAUDE_AGENT_APPROVAL_ROUTE = createRoute({
  method: 'POST',
  path: '/claude-agents/:agentId/sessions/:sessionId/approvals/:approvalId/resolve',
  responseType: 'json',
  pathParamSchema: claudeAgentApprovalPathParams,
  bodySchema: resolveClaudeAgentApprovalBodySchema,
  responseSchema: resolveClaudeAgentApprovalResponseSchema,
  summary: 'Resolve a pending Claude agent tool-approval',
  description:
    'Settles a pending `canUseTool` approval request. `decision: allow` may include an `updatedInput` for the "approve with changes" UI; `decision: deny` may include a `message` shown back to the model.',
  tags: ['Claude Agents'],
  requiresAuth: true,
  requiresPermission: 'agents:execute',
  handler: async ({ mastra, agentId, sessionId, approvalId, decision, updatedInput, message, remember }) => {
    try {
      const agent = getClaudeAgentOrThrow(mastra, agentId);
      agent.resolveApproval(sessionId, approvalId, { decision, updatedInput, message, remember });
      return { resolved: true };
    } catch (error) {
      return handleError(error, 'error resolving claude agent approval');
    }
  },
});

export const RESOLVE_CLAUDE_AGENT_QUESTION_ROUTE = createRoute({
  method: 'POST',
  path: '/claude-agents/:agentId/sessions/:sessionId/questions/:questionId/resolve',
  responseType: 'json',
  pathParamSchema: claudeAgentQuestionPathParams,
  bodySchema: resolveClaudeAgentQuestionBodySchema,
  responseSchema: resolveClaudeAgentQuestionResponseSchema,
  summary: 'Resolve a pending AskUserQuestion request',
  description:
    'Settles a pending AskUserQuestion batch. The body carries the selected-option labels (and optional free-text "other") per question id.',
  tags: ['Claude Agents'],
  requiresAuth: true,
  requiresPermission: 'agents:execute',
  handler: async ({ mastra, agentId, sessionId, questionId, answers }) => {
    try {
      const agent = getClaudeAgentOrThrow(mastra, agentId);
      agent.resolveQuestion(sessionId, questionId, { answers });
      return { resolved: true };
    } catch (error) {
      return handleError(error, 'error resolving claude agent question');
    }
  },
});
