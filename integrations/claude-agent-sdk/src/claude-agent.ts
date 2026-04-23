import type { AgentDefinition, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeAgentLike } from '@mastra/core/claude-agents';
import type {
  ClaudeAgentPermissionRulesStorage,
  ClaudeAgentSessionsStorage,
  ListClaudeAgentSessionsOutput,
  MastraClaudeAgentSession,
  MastraCompositeStore,
} from '@mastra/core/storage';
import type { ChunkType } from '@mastra/core/stream';

import type { AnyMastraAgent, AnyMastraWorkflow } from './delegation';
import type { AnyMastraTool } from './mcp-bridge';
import type { ApprovalResolution, QuestionResolution } from './pending-registry';
import { PendingRegistry } from './pending-registry';
import type { ClaudeAgentStreamDeps, ClaudeAgentStreamOptions } from './stream';
import { runClaudeAgentStream } from './stream';

/**
 * System prompt handed to the SDK. Mirrors the shape the SDK accepts on
 * `Options.systemPrompt` so users don't have to think about variants twice:
 *
 * - `undefined` / omitted → SDK uses its built-in "claude_code" preset.
 * - `string`              → wrapped as `{ type: "preset", preset: "claude_code", append }`
 *                           so default tools + safety prompts stay in place.
 * - `{ type: "preset", preset, append? }`
 *                         → forwarded as-is.
 * - `{ type: "string", value }`
 *                         → forwarded as-is; replaces preset entirely.
 */
/**
 * Minimal structural view of the owning `Mastra` instance. We keep this
 * narrow so the integration package doesn't take a hard dependency on the
 * full `Mastra` class; `__registerMastra` is nominally typed via
 * {@link ClaudeAgentLike} to accept `unknown`, and the stream loop upcasts
 * through this interface.
 */
export interface MastraLike {
  getStorage(): MastraCompositeStore | undefined | null;
  resolveClaudeAgentKey?: (idOrKey: string) => string;
}

export type ClaudeAgentSystemPrompt =
  | string
  | { readonly type: 'preset'; readonly preset: 'claude_code'; readonly append?: string }
  | { readonly type: 'string'; readonly value: string };

/**
 * Constructor options for {@link ClaudeAgent}. Intentionally small — the class
 * is a registration/metadata shell. Streaming, approvals, permissions,
 * observability are layered on in follow-up commits (5f onward) but every
 * field they need is already captured here so 5f is purely additive.
 */
export interface ClaudeAgentOptions {
  /** Stable id. Surfaces in URLs and traces; MUST be unique across Claude agents. */
  readonly id: string;
  /** Human-readable name. Defaults to `id`. */
  readonly name?: string;
  /** One-line description rendered in Studio. */
  readonly description?: string;

  /**
   * Model alias ('sonnet', 'opus', 'haiku') or full Anthropic model id.
   * Forwarded to the SDK's main turn. Sub-agents may override via
   * {@link AgentDefinition.model}.
   */
  readonly model?: string;

  /** System prompt override. See {@link ClaudeAgentSystemPrompt}. */
  readonly systemPrompt?: ClaudeAgentSystemPrompt;

  /** Default permission mode for new sessions. Per-session overrides win. */
  readonly permissionMode?: PermissionMode;

  /** Working directory for the SDK subprocess. */
  readonly cwd?: string;

  /** Mastra tools exposed to the SDK via the MCP bridge. */
  readonly tools?: Record<string, AnyMastraTool>;

  /** Mastra agents exposed as delegation tools (one synthetic tool per agent). */
  readonly agents?: Record<string, AnyMastraAgent>;

  /** Mastra workflows exposed as delegation tools. */
  readonly workflows?: Record<string, AnyMastraWorkflow>;

  /** Native SDK subagents. Forwarded to the SDK's `Options.agents`. */
  readonly subagents?: Record<string, AgentDefinition>;

  /**
   * Suppress CLI cache-warmup + auxiliary model calls on session init.
   * Keeps trace trees focused on the turn model. Default `true`.
   */
  readonly disableNonEssentialModelCalls?: boolean;
}

/**
 * Metadata/registration shell for a Claude Agent SDK–backed agent.
 *
 * This class is deliberately a bag of accessors at this stage. It exists so:
 * - {@link Mastra} can register it under `claudeAgents` (the `ClaudeAgentLike`
 *   structural contract is satisfied by `id` / `name` / `description` /
 *   `__registerMastra`).
 * - Studio can render agent metadata (model, system prompt, tools, subagents)
 *   without needing an active session.
 * - The forthcoming `.stream()` (commit 5f) reads everything from here.
 *
 * The class DOES NOT own SDK sessions, MastraStorage, or tracing —
 * those live in `.stream()` so this file stays easy to read and to test.
 */
export class ClaudeAgent implements ClaudeAgentLike {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly systemPrompt?: ClaudeAgentSystemPrompt;
  readonly permissionMode?: PermissionMode;
  readonly cwd?: string;
  readonly disableNonEssentialModelCalls: boolean;

  readonly #tools: Record<string, AnyMastraTool>;
  readonly #agents: Record<string, AnyMastraAgent>;
  readonly #workflows: Record<string, AnyMastraWorkflow>;
  readonly #subagents: Record<string, AgentDefinition>;

  /**
   * Shared pending registry for approvals + AskUserQuestion prompts. Lives on
   * the agent so concurrent streams for the same agent can all resolve
   * through the same registry, and HTTP resolve endpoints have a stable
   * handle to reach into.
   */
  readonly #registry = new PendingRegistry();

  /**
   * Registration key under which the owning Mastra instance registered this
   * agent. Populated by {@link Mastra} on registration via
   * {@link __registerMastra} (the host-side wiring passes both the instance
   * and the key).
   */
  #agentKey?: string;

  #mastra?: MastraLike;

  constructor(options: ClaudeAgentOptions) {
    if (!options.id || options.id.trim() === '') {
      throw new Error('ClaudeAgent: `id` is required and must be non-empty.');
    }

    this.id = options.id;
    this.name = options.name ?? options.id;
    this.description = options.description;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.permissionMode = options.permissionMode;
    this.cwd = options.cwd;
    this.disableNonEssentialModelCalls = options.disableNonEssentialModelCalls ?? true;

    this.#tools = { ...(options.tools ?? {}) };
    this.#agents = { ...(options.agents ?? {}) };
    this.#workflows = { ...(options.workflows ?? {}) };
    this.#subagents = { ...(options.subagents ?? {}) };
  }

  /**
   * @internal — called by {@link Mastra} on registration. Captures both the
   * owning instance (so tool handlers can reach into other primitives) and
   * the registration key (needed to scope sessions + permission rules).
   */
  __registerMastra(mastra: unknown, agentKey?: string): void {
    this.#mastra = mastra as MastraLike | undefined;
    if (agentKey) this.#agentKey = agentKey;
  }

  /** @internal — exposed for `.stream()` + tests. */
  __getMastra(): MastraLike | undefined {
    return this.#mastra;
  }

  /** @internal — shared pending registry for approval + question resolution. */
  __getRegistry(): PendingRegistry {
    return this.#registry;
  }

  /** Mastra tool registry snapshot. */
  getTools(): Record<string, AnyMastraTool> {
    return { ...this.#tools };
  }

  /** Mastra agent registry snapshot. */
  getAgents(): Record<string, AnyMastraAgent> {
    return { ...this.#agents };
  }

  /** Mastra workflow registry snapshot. */
  getWorkflows(): Record<string, AnyMastraWorkflow> {
    return { ...this.#workflows };
  }

  /** Native SDK subagent definitions snapshot. */
  getSubagents(): Record<string, AgentDefinition> {
    return { ...this.#subagents };
  }

  /**
   * Combined "agents" count surfaced in Studio's list view. Mastra agents +
   * SDK subagents both answer "how many agents can this ClaudeAgent delegate
   * to?" so the Studio column collapses them.
   */
  get agentCount(): number {
    return Object.keys(this.#agents).length + Object.keys(this.#subagents).length;
  }

  /** Number of Mastra workflows registered as delegation tools. */
  get workflowCount(): number {
    return Object.keys(this.#workflows).length;
  }

  /** Number of Mastra tools exposed via the MCP bridge. */
  get toolCount(): number {
    return Object.keys(this.#tools).length;
  }

  // -------------------------------------------------------------------------
  // Stream
  // -------------------------------------------------------------------------

  /**
   * Run one turn against the Claude Agent SDK and yield Mastra `ChunkType`
   * values. The returned generator matches `Agent.stream()` output shape, so
   * server handlers can feed it through the same v5 converter pipeline used
   * for regular Mastra agents.
   *
   * Required setup:
   * - The agent must be registered on a {@link Mastra} instance so tool
   *   handlers can reach into the broader environment.
   * - That instance must expose storage with the `claudeAgentSessions`
   *   domain; without it we have nothing to persist transcripts to.
   *
   * Storage + registry wiring is resolved lazily at call time so tests can
   * inject a fake Mastra or swap in an in-memory store without reconstructing
   * the agent.
   */
  async *stream(options: ClaudeAgentStreamOptions): AsyncGenerator<ChunkType, void, void> {
    const mastra = this.#mastra;
    if (!mastra) {
      throw new Error('ClaudeAgent.stream: agent is not registered with a Mastra instance.');
    }
    const storage = mastra.getStorage();
    if (!storage) {
      throw new Error(
        'ClaudeAgent.stream: the owning Mastra instance has no storage configured; sessions cannot be persisted.',
      );
    }

    const sessionsStore = (await storage.getStore('claudeAgentSessions')) as
      | ClaudeAgentSessionsStorage
      | undefined;
    if (!sessionsStore) {
      throw new Error(
        'ClaudeAgent.stream: storage adapter does not implement the `claudeAgentSessions` domain.',
      );
    }
    const permissionRulesStore = (await storage.getStore('claudeAgentPermissionRules')) as
      | ClaudeAgentPermissionRulesStorage
      | undefined;

    const agentKey = this.#agentKey ?? mastra.resolveClaudeAgentKey?.(this.id) ?? this.id;

    yield* runClaudeAgentStream(this, options, {
      sessionsStore,
      permissionRulesStore,
      registry: this.#registry,
      agentKey,
    });
  }

  // -------------------------------------------------------------------------
  // Pending approval + question resolution
  // -------------------------------------------------------------------------

  /**
   * Settle a pending approval request. Called by the server's
   * `/approvals/:id/resolve` endpoint once the user clicks allow/deny on the
   * approval card in Studio.
   *
   * Throws `PendingRequestNotFoundError` when the registry has no live entry
   * (e.g. the stream already ended or the approval was cancelled).
   */
  resolveApproval(sessionId: string, correlationId: string, resolution: ApprovalResolution): void {
    this.#registry.resolveApproval(sessionId, correlationId, resolution);
  }

  /**
   * Settle a pending AskUserQuestion batch. Counterpart to
   * {@link resolveApproval} for question cards.
   */
  resolveQuestion(sessionId: string, correlationId: string, resolution: QuestionResolution): void {
    this.#registry.resolveQuestion(sessionId, correlationId, resolution);
  }

  /**
   * Cancel everything pending for a session — used when the user aborts a
   * turn or deletes the session while the stream is still open.
   */
  cancelAllPending(sessionId: string, reason?: string): void {
    this.#registry.cancelAll(sessionId, reason);
  }

  // -------------------------------------------------------------------------
  // Session CRUD facade
  //
  // Client-js calls these through the server handlers. They're kept on the
  // agent rather than at the Mastra level so a caller who has a reference to
  // the agent (e.g. from `mastra.getClaudeAgent(id)`) can drive every
  // session-scoped operation without having to dig through storage manually.
  // -------------------------------------------------------------------------

  /** Fetch a single persisted session by id. */
  async getSession(sessionId: string): Promise<MastraClaudeAgentSession | null> {
    const store = await this.#requireSessionsStore();
    return store.getSession(sessionId);
  }

  /**
   * List persisted sessions for this agent, optionally scoped to a resource
   * (user / org). Pagination is passed through to the storage adapter.
   */
  async listSessions(input?: {
    resourceId?: string;
    page?: number;
    perPage?: number;
  }): Promise<ListClaudeAgentSessionsOutput> {
    const store = await this.#requireSessionsStore();
    const agentKey = this.#resolveAgentKey();
    return store.listSessions({
      agentKey,
      resourceId: input?.resourceId,
      page: input?.page,
      perPage: input?.perPage,
    });
  }

  /** Update the mutable metadata on a session (title/tags/metadata). */
  async updateSession(
    sessionId: string,
    input: { title?: string; tags?: string[]; metadata?: Record<string, unknown> },
  ): Promise<MastraClaudeAgentSession | null> {
    const store = await this.#requireSessionsStore();
    return store.updateSession(sessionId, input);
  }

  /** Delete a persisted session. Also cancels anything pending on that id. */
  async deleteSession(sessionId: string): Promise<void> {
    this.#registry.cancelAll(sessionId, 'session deleted');
    const store = await this.#requireSessionsStore();
    await store.deleteSession(sessionId);
  }

  /**
   * Fork an existing session into a new one. Delegates to the storage
   * adapter's `forkSession` which is expected to copy messages without
   * mutating the source.
   */
  async forkSession(input: {
    sourceId: string;
    newId: string;
    title?: string;
    resourceId?: string;
  }): Promise<MastraClaudeAgentSession | null> {
    const store = await this.#requireSessionsStore();
    return store.forkSession(input);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  async #requireSessionsStore(): Promise<ClaudeAgentSessionsStorage> {
    const mastra = this.#mastra;
    if (!mastra) {
      throw new Error('ClaudeAgent: agent is not registered with a Mastra instance.');
    }
    const storage = mastra.getStorage();
    if (!storage) {
      throw new Error('ClaudeAgent: the owning Mastra instance has no storage configured.');
    }
    const store = (await storage.getStore('claudeAgentSessions')) as ClaudeAgentSessionsStorage | undefined;
    if (!store) {
      throw new Error('ClaudeAgent: storage adapter does not implement `claudeAgentSessions`.');
    }
    return store;
  }

  #resolveAgentKey(): string {
    if (this.#agentKey) return this.#agentKey;
    const fromMastra = this.#mastra?.resolveClaudeAgentKey?.(this.id);
    return fromMastra ?? this.id;
  }
}

export type { ClaudeAgentStreamDeps, ClaudeAgentStreamOptions };
