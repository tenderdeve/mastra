import type { InValue, Client } from '@libsql/client';
import { ErrorCategory, ErrorDomain, MastraError } from '@mastra/core/error';
import {
  CLAUDE_AGENT_PERMISSION_RULES_SCHEMA,
  ClaudeAgentPermissionRulesStorage,
  createStorageErrorId,
  TABLE_CLAUDE_AGENT_PERMISSION_RULES,
} from '@mastra/core/storage';
import type {
  ClaudeAgentPermissionDecision,
  ListClaudeAgentPermissionRulesInput,
  MastraClaudeAgentPermissionRule,
  SaveClaudeAgentPermissionRuleInput,
} from '@mastra/core/storage';
import { LibSQLDB, resolveClient } from '../../db';
import type { LibSQLDomainConfig } from '../../db';
import { buildSelectColumns } from '../../db/utils';

/**
 * LibSQL adapter for the `claudeAgentPermissionRules` storage domain. Persists
 * "remembered" user decisions so approval-gated tools can be auto-resolved on
 * subsequent invocations.
 *
 * A rule's identity is the (agentKey, resourceId, toolName) tuple — the `id`
 * column is just a stable handle for delete. Saving a rule for an existing
 * tuple overwrites the prior decision.
 */
export class ClaudeAgentPermissionRulesLibSQL extends ClaudeAgentPermissionRulesStorage {
  #db: LibSQLDB;
  #client: Client;

  constructor(config: LibSQLDomainConfig) {
    super();
    const client = resolveClient(config);
    this.#client = client;
    this.#db = new LibSQLDB({
      client,
      maxRetries: config.maxRetries,
      initialBackoffMs: config.initialBackoffMs,
    });
  }

  async init(): Promise<void> {
    await this.#db.createTable({
      tableName: TABLE_CLAUDE_AGENT_PERMISSION_RULES,
      schema: CLAUDE_AGENT_PERMISSION_RULES_SCHEMA,
    });

    // Enforce one rule per (agentKey, resourceId, toolName) so saveRule
    // upserts cleanly. `resourceId` is nullable; SQLite treats each NULL as
    // distinct in UNIQUE indexes by default, which is what we want here —
    // NULL means "global rule (no resource scoping)" and should coexist with
    // per-resource rules for the same tool.
    await this.#client.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_agent_rules_tuple ON "${TABLE_CLAUDE_AGENT_PERMISSION_RULES}" ("agentKey", "resourceId", "toolName")`,
    );
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.#db.deleteData({ tableName: TABLE_CLAUDE_AGENT_PERMISSION_RULES });
  }

  async saveRule(input: SaveClaudeAgentPermissionRuleInput): Promise<MastraClaudeAgentPermissionRule> {
    try {
      const updatedAt = new Date();

      // Upsert on the (agentKey, resourceId, toolName) tuple. We can't rely
      // on `INSERT OR REPLACE INTO ... id` because the incoming id may differ
      // from the existing row's id for the same tuple. Delete-then-insert
      // keeps semantics simple.
      const existingId = await this.#findIdForTuple(input.agentKey, input.resourceId, input.toolName);
      if (existingId && existingId !== input.id) {
        await this.#db.delete({
          tableName: TABLE_CLAUDE_AGENT_PERMISSION_RULES,
          keys: { id: existingId },
        });
      }

      await this.#db.insert({
        tableName: TABLE_CLAUDE_AGENT_PERMISSION_RULES,
        record: {
          id: input.id,
          agentKey: input.agentKey,
          resourceId: input.resourceId ?? null,
          toolName: input.toolName,
          decision: input.decision,
          updatedAt: updatedAt.toISOString(),
        },
      });

      return {
        id: input.id,
        agentKey: input.agentKey,
        resourceId: input.resourceId,
        toolName: input.toolName,
        decision: input.decision,
        updatedAt,
      };
    } catch (error) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createStorageErrorId('LIBSQL', 'SAVE_CLAUDE_AGENT_PERMISSION_RULE', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
        },
        error,
      );
    }
  }

  async getRule(input: {
    agentKey: string;
    resourceId?: string;
    toolName: string;
  }): Promise<MastraClaudeAgentPermissionRule | null> {
    try {
      const { whereSql, args } = buildTupleWhere(input.agentKey, input.resourceId, input.toolName);
      const result = await this.#client.execute({
        sql: `SELECT ${buildSelectColumns(TABLE_CLAUDE_AGENT_PERMISSION_RULES)} FROM "${TABLE_CLAUDE_AGENT_PERMISSION_RULES}" ${whereSql} LIMIT 1`,
        args,
      });
      const row = result.rows?.[0];
      return row ? parseRow(row) : null;
    } catch (error) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createStorageErrorId('LIBSQL', 'GET_CLAUDE_AGENT_PERMISSION_RULE', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
        },
        error,
      );
    }
  }

  async listRules(input: ListClaudeAgentPermissionRulesInput): Promise<MastraClaudeAgentPermissionRule[]> {
    try {
      const where: string[] = ['"agentKey" = ?'];
      const args: InValue[] = [input.agentKey];
      if (input.resourceId !== undefined) {
        where.push('"resourceId" = ?');
        args.push(input.resourceId);
      }

      const rows = await this.#client.execute({
        sql: `SELECT ${buildSelectColumns(TABLE_CLAUDE_AGENT_PERMISSION_RULES)} FROM "${TABLE_CLAUDE_AGENT_PERMISSION_RULES}" WHERE ${where.join(' AND ')} ORDER BY "updatedAt" DESC`,
        args,
      });

      return (rows.rows ?? []).map(parseRow);
    } catch (error) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createStorageErrorId('LIBSQL', 'LIST_CLAUDE_AGENT_PERMISSION_RULES', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
        },
        error,
      );
    }
  }

  async deleteRule(id: string): Promise<void> {
    try {
      await this.#db.delete({ tableName: TABLE_CLAUDE_AGENT_PERMISSION_RULES, keys: { id } });
    } catch (error) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createStorageErrorId('LIBSQL', 'DELETE_CLAUDE_AGENT_PERMISSION_RULE', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
        },
        error,
      );
    }
  }

  async #findIdForTuple(agentKey: string, resourceId: string | undefined, toolName: string): Promise<string | null> {
    const { whereSql, args } = buildTupleWhere(agentKey, resourceId, toolName);
    const result = await this.#client.execute({
      sql: `SELECT id FROM "${TABLE_CLAUDE_AGENT_PERMISSION_RULES}" ${whereSql} LIMIT 1`,
      args,
    });
    const row = result.rows?.[0];
    return row ? String(row.id) : null;
  }
}

function buildTupleWhere(
  agentKey: string,
  resourceId: string | undefined,
  toolName: string,
): { whereSql: string; args: InValue[] } {
  // resourceId is nullable and "= NULL" never matches in SQL, so branch on IS
  // NULL when the caller didn't supply a resource.
  if (resourceId === undefined || resourceId === null) {
    return {
      whereSql: 'WHERE "agentKey" = ? AND "resourceId" IS NULL AND "toolName" = ?',
      args: [agentKey, toolName],
    };
  }
  return {
    whereSql: 'WHERE "agentKey" = ? AND "resourceId" = ? AND "toolName" = ?',
    args: [agentKey, resourceId, toolName],
  };
}

function parseRow(row: Record<string, unknown>): MastraClaudeAgentPermissionRule {
  return {
    id: String(row.id),
    agentKey: String(row.agentKey),
    resourceId: row.resourceId == null ? undefined : String(row.resourceId),
    toolName: String(row.toolName),
    decision: String(row.decision) as ClaudeAgentPermissionDecision,
    updatedAt: new Date(String(row.updatedAt)),
  };
}
