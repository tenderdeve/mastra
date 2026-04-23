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
