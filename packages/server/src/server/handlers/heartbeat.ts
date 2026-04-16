import { coreFeatures } from '@mastra/core/features';

import {
  agentIdPathParams,
  heartbeatThreadPathParams,
  setHeartbeatBodySchema,
  heartbeatListResponseSchema,
  heartbeatSuccessResponseSchema,
} from '../schemas/heartbeat';
import { createRoute } from '../server-adapter/routes/route-builder';

import { getAgentFromSystem } from './agents';
import { handleError } from './error';
import { HTTPException } from '../http-exception';

// ============================================================================
// Feature gate
// ============================================================================

function assertHeartbeatsAvailable(): void {
  if (!coreFeatures.has('heartbeats')) {
    throw new HTTPException(501, { message: 'Heartbeats require a newer version of @mastra/core' });
  }
}

// ============================================================================
// Routes
// ============================================================================

/**
 * PUT /agents/:agentId/heartbeat - Set (enable/update/disable) heartbeat for a thread
 */
export const SET_HEARTBEAT_ROUTE = createRoute({
  method: 'PUT',
  path: '/agents/:agentId/heartbeat',
  responseType: 'json',
  pathParamSchema: agentIdPathParams,
  bodySchema: setHeartbeatBodySchema,
  responseSchema: heartbeatSuccessResponseSchema,
  summary: 'Set thread heartbeat',
  description:
    'Enable, update, or disable a heartbeat for a specific thread on an agent. The agent must have heartbeat defaults configured in its constructor.',
  tags: ['Agents', 'Heartbeat'],
  requiresAuth: true,
  handler: async ({ mastra, agentId, threadId, resourceId, enabled, intervalMs, prompt }) => {
    assertHeartbeatsAvailable();
    try {
      const agent = await getAgentFromSystem({ mastra, agentId });
      if (!agent) {
        throw new HTTPException(404, { message: `Agent "${agentId}" not found` });
      }

      if (enabled === false) {
        await agent.setHeartbeat({ threadId, enabled: false });
      } else {
        await agent.setHeartbeat({
          threadId,
          resourceId,
          enabled: true,
          intervalMs,
          prompt,
        });
      }

      return { success: true };
    } catch (error) {
      return handleError(error, 'Error setting heartbeat');
    }
  },
});

/**
 * DELETE /agents/:agentId/heartbeat/:threadId - Disable heartbeat for a thread
 */
export const DELETE_HEARTBEAT_ROUTE = createRoute({
  method: 'DELETE',
  path: '/agents/:agentId/heartbeat/:threadId',
  responseType: 'json',
  pathParamSchema: heartbeatThreadPathParams,
  responseSchema: heartbeatSuccessResponseSchema,
  summary: 'Disable thread heartbeat',
  description: 'Disable and remove the heartbeat for a specific thread.',
  tags: ['Agents', 'Heartbeat'],
  requiresAuth: true,
  handler: async ({ mastra, agentId, threadId }) => {
    assertHeartbeatsAvailable();
    try {
      const agent = await getAgentFromSystem({ mastra, agentId });
      if (!agent) {
        throw new HTTPException(404, { message: `Agent "${agentId}" not found` });
      }

      await agent.setHeartbeat({ threadId, enabled: false });

      return { success: true };
    } catch (error) {
      return handleError(error, 'Error disabling heartbeat');
    }
  },
});

/**
 * GET /agents/:agentId/heartbeats - List active heartbeats for an agent
 */
export const LIST_HEARTBEATS_ROUTE = createRoute({
  method: 'GET',
  path: '/agents/:agentId/heartbeats',
  responseType: 'json',
  pathParamSchema: agentIdPathParams,
  responseSchema: heartbeatListResponseSchema,
  summary: 'List active heartbeats',
  description: 'Returns the thread IDs that have active heartbeat timers for this agent.',
  tags: ['Agents', 'Heartbeat'],
  requiresAuth: true,
  handler: async ({ mastra, agentId }) => {
    assertHeartbeatsAvailable();
    try {
      const agent = await getAgentFromSystem({ mastra, agentId });
      if (!agent) {
        throw new HTTPException(404, { message: `Agent "${agentId}" not found` });
      }

      return { threadIds: agent.getHeartbeats() };
    } catch (error) {
      return handleError(error, 'Error listing heartbeats');
    }
  },
});
