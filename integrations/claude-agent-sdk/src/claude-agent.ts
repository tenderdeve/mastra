import type { AgentDefinition, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeAgentLike } from '@mastra/core/claude-agents';

import type { AnyMastraAgent, AnyMastraWorkflow } from './delegation';
import type { AnyMastraTool } from './mcp-bridge';

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

  #mastra?: unknown;

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

  /** @internal — called by {@link Mastra} on registration. */
  __registerMastra(mastra: unknown): void {
    this.#mastra = mastra;
  }

  /** @internal — exposed for `.stream()` (commit 5f) + tests. */
  __getMastra(): unknown {
    return this.#mastra;
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
}
