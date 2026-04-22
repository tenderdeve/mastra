import { StorageDomain } from '../base';

/** Persisted user decision for a Claude Agent SDK tool call. */
export type ClaudeAgentPermissionDecision = 'allow' | 'deny';

/**
 * A "remembered" permission decision. When a user approves/denies a tool
 * once and asks Mastra to remember the choice, we store a rule so subsequent
 * invocations of the same tool are auto-resolved without prompting again.
 *
 * Rules are scoped by `agentKey` + `resourceId` so decisions made in one
 * user's session don't leak across tenants.
 */
export interface MastraClaudeAgentPermissionRule {
  id: string;
  agentKey: string;
  resourceId?: string;
  /** SDK-visible tool name (including MCP prefix when relevant). */
  toolName: string;
  decision: ClaudeAgentPermissionDecision;
  updatedAt: Date;
}

export interface SaveClaudeAgentPermissionRuleInput {
  id: string;
  agentKey: string;
  resourceId?: string;
  toolName: string;
  decision: ClaudeAgentPermissionDecision;
}

export interface ListClaudeAgentPermissionRulesInput {
  agentKey: string;
  resourceId?: string;
}

export abstract class ClaudeAgentPermissionRulesStorage extends StorageDomain {
  constructor() {
    super({
      component: 'STORAGE',
      name: 'CLAUDE_AGENT_PERMISSION_RULES',
    });
  }

  async dangerouslyClearAll(): Promise<void> {
    // Default no-op - subclasses override
  }

  /** Upsert a rule. */
  abstract saveRule(input: SaveClaudeAgentPermissionRuleInput): Promise<MastraClaudeAgentPermissionRule>;

  /**
   * Look up the decision for a specific tool on an agent/resource pair.
   * Returns null when no rule has been recorded.
   */
  abstract getRule(input: {
    agentKey: string;
    resourceId?: string;
    toolName: string;
  }): Promise<MastraClaudeAgentPermissionRule | null>;

  /** List all rules for an agent, optionally scoped to a resource. */
  abstract listRules(input: ListClaudeAgentPermissionRulesInput): Promise<MastraClaudeAgentPermissionRule[]>;

  /** Delete a rule by id. No-op if the id is unknown. */
  abstract deleteRule(id: string): Promise<void>;
}
