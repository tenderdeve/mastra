/**
 * Minimal structural type core needs to know about a Claude Agent SDK–backed
 * agent. Integrations (notably `@mastra/claude-agent-sdk`) provide concrete
 * implementations. Core never imports the integration — it deals only in
 * this structural shape, mirroring how `ToolLoopAgentLike` works for
 * AI SDK v6 agents.
 *
 * Additional capability methods (stream, session listing, approvals, etc.)
 * are added by the integration and consumed by server handlers via their
 * own, richer types. This type is intentionally narrow so core stays
 * dependency-free.
 */
export interface ClaudeAgentLike {
  /** Stable id. Distinct from the registration key. */
  readonly id: string;
  /** Human-readable name surfaced in Studio. */
  readonly name?: string;
  /** One-line description surfaced in Studio. */
  readonly description?: string;
  /** Allow the host Mastra instance to hand itself to the agent. */
  __registerMastra?: (mastra: unknown) => void;
}
