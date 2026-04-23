import { z } from 'zod/v4';

// ============================================================================
// Path parameter schemas
// ============================================================================

export const claudeAgentIdPathParams = z.object({
  agentId: z.string().describe('Claude agent id or registration key'),
});

export const claudeAgentSessionPathParams = claudeAgentIdPathParams.extend({
  sessionId: z.string().describe('Claude agent session id'),
});

export const claudeAgentApprovalPathParams = claudeAgentSessionPathParams.extend({
  approvalId: z.string().describe('Pending approval correlation id'),
});

export const claudeAgentQuestionPathParams = claudeAgentSessionPathParams.extend({
  questionId: z.string().describe('Pending question correlation id'),
});

// ============================================================================
// Query parameter schemas
// ============================================================================

export const listClaudeAgentSessionsQuerySchema = z.object({
  resourceId: z.string().optional().describe('Filter sessions by resource id'),
  page: z.coerce.number().int().min(0).optional().describe('Zero-indexed page (default 0)'),
  perPage: z.coerce.number().int().min(1).max(200).optional().describe('Items per page (default 50)'),
});

// ============================================================================
// Body schemas
// ============================================================================

const permissionModeSchema = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']);

export const createClaudeAgentSessionBodySchema = z.object({
  sessionId: z.string().optional().describe('Optional existing session id to seed (rarely used)'),
  resourceId: z.string().optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const streamClaudeAgentTurnBodySchema = z.object({
  prompt: z.string().min(1).describe('Prompt text for this turn'),
  resourceId: z.string().optional(),
  title: z.string().optional(),
  permissionMode: permissionModeSchema.optional(),
  requestContext: z.record(z.string(), z.unknown()).optional(),
});

export const forkClaudeAgentSessionBodySchema = z.object({
  title: z.string().optional(),
  resourceId: z.string().optional(),
});

export const updateClaudeAgentSessionBodySchema = z.object({
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const resolveClaudeAgentApprovalBodySchema = z.object({
  decision: z.enum(['allow', 'deny']),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  message: z.string().optional(),
  remember: z.boolean().optional(),
});

export const resolveClaudeAgentQuestionBodySchema = z.object({
  answers: z.record(
    z.string(),
    z.object({
      selected: z.array(z.string()),
      other: z.string().optional(),
    }),
  ),
});

// ============================================================================
// Response schemas
// ============================================================================

export const claudeAgentSummarySchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  agentCount: z.number(),
  workflowCount: z.number(),
  toolCount: z.number(),
});

export const listClaudeAgentsResponseSchema = z.object({
  agents: z.array(claudeAgentSummarySchema),
});

export const getClaudeAgentResponseSchema = claudeAgentSummarySchema;

export const claudeAgentSessionSchema = z.object({
  id: z.string(),
  agentKey: z.string(),
  resourceId: z.string().optional(),
  title: z.string().optional(),
  messages: z.array(z.unknown()),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  forkedFrom: z.string().optional(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
});

export const listClaudeAgentSessionsResponseSchema = z.object({
  sessions: z.array(claudeAgentSessionSchema),
  total: z.number(),
  page: z.number(),
  perPage: z.number(),
  hasMore: z.boolean(),
});

export const claudeAgentSessionResponseSchema = claudeAgentSessionSchema;

export const resolveClaudeAgentApprovalResponseSchema = z.object({
  resolved: z.boolean(),
});

export const resolveClaudeAgentQuestionResponseSchema = z.object({
  resolved: z.boolean(),
});

export const deleteClaudeAgentSessionResponseSchema = z.object({
  deleted: z.boolean(),
});

export const streamClaudeAgentTurnResponseSchema = z.object({}).describe('Mastra ChunkType stream (SSE)');
