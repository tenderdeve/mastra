import type { InMemoryDB } from '../inmemory-db';
import { ClaudeAgentPermissionRulesStorage } from './base';
import type {
  ListClaudeAgentPermissionRulesInput,
  MastraClaudeAgentPermissionRule,
  SaveClaudeAgentPermissionRuleInput,
} from './base';

function ruleKey(agentKey: string, resourceId: string | undefined, toolName: string): string {
  return `${agentKey}::${resourceId ?? ''}::${toolName}`;
}

export class ClaudeAgentPermissionRulesInMemory extends ClaudeAgentPermissionRulesStorage {
  #db: InMemoryDB;

  constructor({ db }: { db: InMemoryDB }) {
    super();
    this.#db = db;
  }

  async dangerouslyClearAll(): Promise<void> {
    this.#db.claudeAgentPermissionRules.clear();
  }

  async saveRule(input: SaveClaudeAgentPermissionRuleInput): Promise<MastraClaudeAgentPermissionRule> {
    const record: MastraClaudeAgentPermissionRule = {
      id: input.id,
      agentKey: input.agentKey,
      resourceId: input.resourceId,
      toolName: input.toolName,
      decision: input.decision,
      updatedAt: new Date(),
    };
    // Index by the (agent, resource, tool) tuple so getRule is O(1); the
    // rule id is recoverable from the record itself.
    this.#db.claudeAgentPermissionRules.set(ruleKey(input.agentKey, input.resourceId, input.toolName), record);
    return record;
  }

  async getRule(input: {
    agentKey: string;
    resourceId?: string;
    toolName: string;
  }): Promise<MastraClaudeAgentPermissionRule | null> {
    return this.#db.claudeAgentPermissionRules.get(ruleKey(input.agentKey, input.resourceId, input.toolName)) ?? null;
  }

  async listRules(input: ListClaudeAgentPermissionRulesInput): Promise<MastraClaudeAgentPermissionRule[]> {
    return Array.from(this.#db.claudeAgentPermissionRules.values()).filter(rule => {
      if (rule.agentKey !== input.agentKey) return false;
      if (input.resourceId !== undefined && rule.resourceId !== input.resourceId) return false;
      return true;
    });
  }

  async deleteRule(id: string): Promise<void> {
    for (const [key, rule] of this.#db.claudeAgentPermissionRules) {
      if (rule.id === id) {
        this.#db.claudeAgentPermissionRules.delete(key);
        return;
      }
    }
  }
}
