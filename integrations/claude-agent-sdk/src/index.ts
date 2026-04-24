// @mastra/claude-agent-sdk
// First-class Claude Agent SDK integration for Mastra.

export {
  MASTRA_MCP_SERVER_NAME,
  isQualifiedMastraToolName,
  qualifyMastraToolName,
  unqualifyMastraToolName,
} from './tool-names';

export {
  PendingRegistry,
  PendingRequestKindMismatchError,
  PendingRequestNotFoundError,
} from './pending-registry';
export type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolution,
  PendingRequest,
  QuestionOption,
  QuestionPrompt,
  QuestionRequest,
  QuestionResolution,
} from './pending-registry';

export { buildMastraToolsMcpServer, extractZodShape, wrapMastraToolForSdk } from './mcp-bridge';
export type { AnyMastraTool, MastraToolExecutionContext, MastraToolsMcpServer } from './mcp-bridge';

export { buildAgentDelegationTool, buildWorkflowDelegationTool, mergeDelegationTools } from './delegation';
export type { AnyMastraAgent, AnyMastraWorkflow } from './delegation';

export { sdkMessagesToUiMessages } from './translate';
export type {
  UiMessage,
  UiMessagePart,
  UiReasoningPart,
  UiStepStartPart,
  UiTextPart,
  UiToolPart,
} from './translate';

export type {
  ShellApprovalRequestEvent,
  ShellApprovalResolvedEvent,
  ShellErrorEvent,
  ShellFinishEvent,
  ShellMessageEvent,
  ShellQuestionRequestEvent,
  ShellQuestionResolvedEvent,
  ShellSessionEvent,
  ShellStreamEvent,
} from './stream-events';

export { shellStreamToMastraChunks } from './stream-translate';
export type { ShellStreamToChunksOptions } from './stream-translate';

export { ClaudeAgent } from './claude-agent';
export type {
  ClaudeAgentOptions,
  ClaudeAgentStreamDeps,
  ClaudeAgentStreamOptions,
  ClaudeAgentSystemPrompt,
  MastraLike,
} from './claude-agent';

export { runClaudeAgentStream } from './stream';

export {
  ASK_USER_QUESTION_TOOL_NAME,
  NON_ESSENTIAL_SUPPRESSION_ENV,
  buildQueryOptions,
  normalizeSystemPrompt,
} from './query-options';
export type { BuildQueryOptionsInput } from './query-options';

export { buildCanUseTool } from './can-use-tool';
export type { BuildCanUseToolInput, CanUseToolLogger } from './can-use-tool';

// OTLP ingest pipeline
export { convertOtlpBatch, mapSpanName, sanitizeAttributes } from './otel-ingest/converter';
export type { MastraChildSpanDescriptor, MastraClaudeSpanType } from './otel-ingest/converter';
export { buildOtelEnv, INGEST_ID_RESOURCE_KEY } from './otel-ingest/env';
export type { BuildOtelEnvOptions } from './otel-ingest/env';
export { getOrStartReceiver, startReceiver } from './otel-ingest/receiver';
export type { IngestHandler, OtlpReceiverHandle } from './otel-ingest/receiver';
export type { OtlpSpan, OtlpTracesRequest } from './otel-ingest/otlp-json';

// Mastra-side tracing helpers
export {
  attachOtlpChildren,
  emitEventSpan,
  endAgentRunSpan,
  startAgentRunSpan,
} from './tracing';
export type { EventSpanKind, StartAgentRunSpanOptions } from './tracing';
