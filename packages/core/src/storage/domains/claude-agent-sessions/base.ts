import { StorageDomain } from '../base';

/**
 * A Claude Agent SDK session as persisted by Mastra.
 *
 * The `messages` field stores the *raw* SDK message envelope stream returned
 * by `@anthropic-ai/claude-agent-sdk`. The integration package owns the
 * `SDKMessage` type; core stores it as opaque JSON (`unknown[]`) so that it
 * can evolve independently of storage adapter schemas.
 *
 * Sessions are keyed by their SDK-minted session id. Core also tracks the
 * `agentKey` (the Mastra registration key under which the Claude agent was
 * declared) so the same storage adapter can host sessions for multiple
 * Claude agents without collisions.
 */
export interface MastraClaudeAgentSession {
  /** SDK-minted session id (uuid-like). Primary key. */
  id: string;
  /** Mastra registration key for the owning claude agent. */
  agentKey: string;
  /** Optional resource (user / organization / etc.) the session belongs to. */
  resourceId?: string;
  /** Optional title (user-renamable). */
  title?: string;
  /** Raw SDK message envelope stream for this session. */
  messages: unknown[];
  /** Free-form tags on the session. */
  tags?: string[];
  /** Free-form metadata attached to the session. */
  metadata?: Record<string, unknown>;
  /** Session this one was forked from, if any. */
  forkedFrom?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input for creating or overwriting a session. `createdAt` / `updatedAt` are
 * stamped by the adapter; callers may pass them for imports/tests.
 */
export interface SaveClaudeAgentSessionInput {
  id: string;
  agentKey: string;
  resourceId?: string;
  title?: string;
  messages: unknown[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  forkedFrom?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Partial-update input. Only provided fields are touched. */
export interface UpdateClaudeAgentSessionInput {
  title?: string;
  messages?: unknown[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** Pagination / filter input for listing sessions. */
export interface ListClaudeAgentSessionsInput {
  agentKey: string;
  resourceId?: string;
  /** Zero-indexed page. Defaults to 0. */
  page?: number;
  /** Items per page. Defaults to 50. */
  perPage?: number;
}

export interface ListClaudeAgentSessionsOutput {
  sessions: MastraClaudeAgentSession[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
}

/**
 * Storage domain for Claude Agent SDK sessions. Adapters implement this
 * interface; consumers access it via `storage.getStore('claudeAgentSessions')`.
 */
export abstract class ClaudeAgentSessionsStorage extends StorageDomain {
  constructor() {
    super({
      component: 'STORAGE',
      name: 'CLAUDE_AGENT_SESSIONS',
    });
  }

  async dangerouslyClearAll(): Promise<void> {
    // Default no-op - subclasses override
  }

  /** Insert or overwrite a session record. */
  abstract saveSession(input: SaveClaudeAgentSessionInput): Promise<MastraClaudeAgentSession>;

  /** Read a session by id. Returns null when the id is unknown. */
  abstract getSession(id: string): Promise<MastraClaudeAgentSession | null>;

  /** Paginated list of sessions for an agent, optionally scoped to a resource. */
  abstract listSessions(input: ListClaudeAgentSessionsInput): Promise<ListClaudeAgentSessionsOutput>;

  /**
   * Partial update. Returns the updated record, or null if the id is unknown.
   * `updatedAt` is always bumped by the adapter.
   */
  abstract updateSession(id: string, update: UpdateClaudeAgentSessionInput): Promise<MastraClaudeAgentSession | null>;

  /** Delete a session. No-op if the id is unknown. */
  abstract deleteSession(id: string): Promise<void>;

  /**
   * Fork an existing session: create a new session whose messages are a copy
   * of `sourceId`'s messages at fork time. Returns null if `sourceId` is
   * unknown.
   */
  abstract forkSession(input: {
    sourceId: string;
    newId: string;
    title?: string;
    resourceId?: string;
  }): Promise<MastraClaudeAgentSession | null>;
}
