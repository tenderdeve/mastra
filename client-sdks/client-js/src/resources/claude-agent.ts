import type {
  ClientOptions,
  ClaudeAgentSummary,
  ClaudeAgentSessionResponse,
  ListClaudeAgentSessionsParams,
  ListClaudeAgentSessionsResponse,
  CreateClaudeAgentSessionParams,
  StreamClaudeAgentTurnParams,
  ForkClaudeAgentSessionParams,
  UpdateClaudeAgentSessionParams,
  ResolveClaudeAgentApprovalParams,
  ResolveClaudeAgentApprovalResponse,
  ResolveClaudeAgentQuestionParams,
  ResolveClaudeAgentQuestionResponse,
  DeleteClaudeAgentSessionResponse,
} from '../types';

import { BaseResource } from './base';

/**
 * Resource for interacting with a specific Claude Agent SDK agent.
 * Obtain via `client.getClaudeAgent(agentId)`.
 */
export class ClaudeAgent extends BaseResource {
  constructor(
    options: ClientOptions,
    private readonly agentId: string,
  ) {
    super(options);
  }

  private encodedAgentId(): string {
    return encodeURIComponent(this.agentId);
  }

  /**
   * Fetches the summary for this Claude agent.
   */
  details(): Promise<ClaudeAgentSummary> {
    return this.request(`/claude-agents/${this.encodedAgentId()}`);
  }

  /**
   * Lists persisted sessions for this agent.
   */
  listSessions(params?: ListClaudeAgentSessionsParams): Promise<ListClaudeAgentSessionsResponse> {
    const searchParams = new URLSearchParams();
    if (params?.resourceId) searchParams.set('resourceId', params.resourceId);
    if (params?.page !== undefined) searchParams.set('page', String(params.page));
    if (params?.perPage !== undefined) searchParams.set('perPage', String(params.perPage));
    const queryString = searchParams.toString();
    return this.request(`/claude-agents/${this.encodedAgentId()}/sessions${queryString ? `?${queryString}` : ''}`);
  }

  /**
   * Retrieves a persisted session by id.
   */
  getSession(sessionId: string): Promise<ClaudeAgentSessionResponse> {
    return this.request(`/claude-agents/${this.encodedAgentId()}/sessions/${encodeURIComponent(sessionId)}`);
  }

  /**
   * Seeds a new session row with optional metadata.
   * Most callers should skip this and just call `streamTurn` — the SDK
   * will mint the session id on first turn.
   */
  createSession(params: CreateClaudeAgentSessionParams): Promise<ClaudeAgentSessionResponse> {
    return this.request(`/claude-agents/${this.encodedAgentId()}/sessions`, {
      method: 'POST',
      body: params,
    });
  }

  /**
   * Streams a single agent turn. Emits Mastra `ChunkType` chunks encoded as
   * AI-SDK v5 SSE on the wire. Pass `sessionId: "new"` to start a fresh
   * session (the SDK will mint the real id and emit it as the first chunk).
   */
  async streamTurn(sessionId: string, params: StreamClaudeAgentTurnParams): Promise<Response> {
    return this.request<Response>(
      `/claude-agents/${this.encodedAgentId()}/sessions/${encodeURIComponent(sessionId)}/stream`,
      {
        method: 'POST',
        body: params,
        stream: true,
      },
    );
  }

  /**
   * Forks an existing session, copying its messages into a new row.
   */
  forkSession(sourceSessionId: string, params?: ForkClaudeAgentSessionParams): Promise<ClaudeAgentSessionResponse> {
    return this.request(
      `/claude-agents/${this.encodedAgentId()}/sessions/${encodeURIComponent(sourceSessionId)}/fork`,
      {
        method: 'POST',
        body: params ?? {},
      },
    );
  }

  /**
   * Updates session metadata (title, tags, metadata).
   */
  updateSession(sessionId: string, params: UpdateClaudeAgentSessionParams): Promise<ClaudeAgentSessionResponse> {
    return this.request(`/claude-agents/${this.encodedAgentId()}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: params,
    });
  }

  /**
   * Deletes a persisted session. Cancels any in-flight approvals or questions.
   */
  deleteSession(sessionId: string): Promise<DeleteClaudeAgentSessionResponse> {
    return this.request(`/claude-agents/${this.encodedAgentId()}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Resolves a pending tool-approval request (approve / deny / approve-with-changes).
   */
  resolveApproval(
    sessionId: string,
    approvalId: string,
    params: ResolveClaudeAgentApprovalParams,
  ): Promise<ResolveClaudeAgentApprovalResponse> {
    return this.request(
      `/claude-agents/${this.encodedAgentId()}/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/resolve`,
      {
        method: 'POST',
        body: params,
      },
    );
  }

  /**
   * Resolves a pending AskUserQuestion request with the user's answers.
   */
  resolveQuestion(
    sessionId: string,
    questionId: string,
    params: ResolveClaudeAgentQuestionParams,
  ): Promise<ResolveClaudeAgentQuestionResponse> {
    return this.request(
      `/claude-agents/${this.encodedAgentId()}/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}/resolve`,
      {
        method: 'POST',
        body: params,
      },
    );
  }
}
