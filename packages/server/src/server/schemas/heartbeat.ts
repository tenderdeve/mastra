import { z } from 'zod/v4';

// Path parameters
export const agentIdPathParams = z.object({
  agentId: z.string().describe('Unique identifier for the agent'),
});

export const heartbeatThreadPathParams = agentIdPathParams.extend({
  threadId: z.string().describe('Unique identifier for the thread'),
});

// Request bodies
export const setHeartbeatBodySchema = z.object({
  threadId: z.string().describe('Thread ID to enable/update heartbeat for'),
  resourceId: z.string().optional().describe('Resource ID for the thread. Auto-resolved from the thread if omitted.'),
  enabled: z.boolean().optional().describe('Whether to enable or disable the heartbeat. Defaults to true.'),
  intervalMs: z.number().optional().describe('Override interval in milliseconds for this thread'),
  prompt: z.string().optional().describe('Override heartbeat prompt for this thread'),
});

// Response schemas
export const heartbeatListResponseSchema = z.object({
  threadIds: z.array(z.string()).describe('Thread IDs with active heartbeat timers'),
});

export const heartbeatSuccessResponseSchema = z.object({
  success: z.boolean(),
});
