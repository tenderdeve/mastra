import type { Client, InValue } from '@libsql/client';
import { ErrorCategory, ErrorDomain, MastraError } from '@mastra/core/error';
import {
  CLAUDE_AGENT_SESSIONS_SCHEMA,
  calculatePagination,
  ClaudeAgentSessionsStorage,
  createStorageErrorId,
  normalizePerPage,
  TABLE_CLAUDE_AGENT_SESSIONS,
} from '@mastra/core/storage';
import type {
  ListClaudeAgentSessionsInput,
  ListClaudeAgentSessionsOutput,
  MastraClaudeAgentSession,
  SaveClaudeAgentSessionInput,
  UpdateClaudeAgentSessionInput,
} from '@mastra/core/storage';
import { LibSQLDB, resolveClient } from '../../db';
import type { LibSQLDomainConfig } from '../../db';
import { buildSelectColumns } from '../../db/utils';

const DEFAULT_PER_PAGE = 50;

/**
 * LibSQL adapter for the `claudeAgentSessions` storage domain. Persists raw
 * SDK message envelope streams (`messages`), plus user-editable metadata
 * (`title`, `tags`, `metadata`) and fork linkage.
 */
export class ClaudeAgentSessionsLibSQL extends ClaudeAgentSessionsStorage {
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
      tableName: TABLE_CLAUDE_AGENT_SESSIONS,
      schema: CLAUDE_AGENT_SESSIONS_SCHEMA,
    });

    // Hot path: `listSessions` filters by (agentKey, resourceId) and orders by
    // updatedAt. Indexing agentKey alone covers the most common queries; the
    // composite index covers resource-scoped lookups.
    await this.#client.execute(
      `CREATE INDEX IF NOT EXISTS idx_claude_agent_sessions_agent_key ON "${TABLE_CLAUDE_AGENT_SESSIONS}" ("agentKey")`,
    );
    await this.#client.execute(
      `CREATE INDEX IF NOT EXISTS idx_claude_agent_sessions_agent_resource ON "${TABLE_CLAUDE_AGENT_SESSIONS}" ("agentKey", "resourceId")`,
    );
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.#db.deleteData({ tableName: TABLE_CLAUDE_AGENT_SESSIONS });
  }

  async saveSession(input: SaveClaudeAgentSessionInput): Promise<MastraClaudeAgentSession> {
    try {
      // Preserve createdAt on overwrite: `INSERT OR REPLACE` would blow away
      // the original timestamp, so do a read-then-write when an input row
      // already exists and the caller didn't supply createdAt explicitly.
      let createdAt = input.createdAt;
      if (!createdAt) {
        const existing = await this.getSession(input.id);
        createdAt = existing?.createdAt ?? new Date();
      }
      const updatedAt = input.updatedAt ?? new Date();

      await this.#db.insert({
        tableName: TABLE_CLAUDE_AGENT_SESSIONS,
        record: {
          id: input.id,
          agentKey: input.agentKey,
          resourceId: input.resourceId ?? null,
          title: input.title ?? null,
          messages: input.messages,
          tags: input.tags ?? null,
          metadata: input.metadata ?? null,
          forkedFrom: input.forkedFrom ?? null,
          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
        },
      });

      return {
        id: input.id,
        agentKey: input.agentKey,
        resourceId: input.resourceId,
        title: input.title,
        messages: input.messages,
        tags: input.tags,
        metadata: input.metadata,
        forkedFrom: input.forkedFrom,
        createdAt,
        updatedAt,
      };
    } catch (error) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createStorageErrorId('LIBSQL', 'SAVE_CLAUDE_AGENT_SESSION', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
        },
        error,
      );
    }
  }

  async getSession(id: string): Promise<MastraClaudeAgentSession | null> {
    try {
      const result = await this.#client.execute({
        sql: `SELECT ${buildSelectColumns(TABLE_CLAUDE_AGENT_SESSIONS)} FROM "${TABLE_CLAUDE_AGENT_SESSIONS}" WHERE id = ?`,
        args: [id],
      });
      const row = result.rows?.[0];
      return row ? this.#parseRow(row) : null;
    } catch (error) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createStorageErrorId('LIBSQL', 'GET_CLAUDE_AGENT_SESSION', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
        },
        error,
      );
    }
  }

  async listSessions(input: ListClaudeAgentSessionsInput): Promise<ListClaudeAgentSessionsOutput> {
    try {
      const page = input.page ?? 0;
      const perPage = normalizePerPage(input.perPage, DEFAULT_PER_PAGE);
      const { offset } = calculatePagination(page, input.perPage, perPage);

      const where: string[] = ['"agentKey" = ?'];
      const args: InValue[] = [input.agentKey];
      if (input.resourceId !== undefined) {
        where.push('"resourceId" = ?');
        args.push(input.resourceId);
      }
      const whereSql = `WHERE ${where.join(' AND ')}`;

      const total = await this.#db.selectTotalCount({
        tableName: TABLE_CLAUDE_AGENT_SESSIONS,
        whereClause: { sql: whereSql, args },
      });

      const rows = await this.#client.execute({
        sql: `SELECT ${buildSelectColumns(TABLE_CLAUDE_AGENT_SESSIONS)} FROM "${TABLE_CLAUDE_AGENT_SESSIONS}" ${whereSql} ORDER BY "updatedAt" DESC LIMIT ? OFFSET ?`,
        args: [...args, perPage, offset],
      });

      const sessions = (rows.rows ?? []).map(row => this.#parseRow(row));

      return {
        sessions,
        total,
        page,
        perPage,
        hasMore: total > offset + sessions.length,
      };
    } catch (error) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createStorageErrorId('LIBSQL', 'LIST_CLAUDE_AGENT_SESSIONS', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
        },
        error,
      );
    }
  }

  async updateSession(id: string, update: UpdateClaudeAgentSessionInput): Promise<MastraClaudeAgentSession | null> {
    try {
      const existing = await this.getSession(id);
      if (!existing) return null;

      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (update.title !== undefined) patch.title = update.title;
      if (update.messages !== undefined) patch.messages = update.messages;
      if (update.tags !== undefined) patch.tags = update.tags;
      if (update.metadata !== undefined) patch.metadata = update.metadata;

      await this.#db.update({
        tableName: TABLE_CLAUDE_AGENT_SESSIONS,
        keys: { id },
        data: patch,
      });

      return (await this.getSession(id))!;
    } catch (error) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createStorageErrorId('LIBSQL', 'UPDATE_CLAUDE_AGENT_SESSION', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
        },
        error,
      );
    }
  }

  async deleteSession(id: string): Promise<void> {
    try {
      await this.#db.delete({ tableName: TABLE_CLAUDE_AGENT_SESSIONS, keys: { id } });
    } catch (error) {
      if (error instanceof MastraError) throw error;
      throw new MastraError(
        {
          id: createStorageErrorId('LIBSQL', 'DELETE_CLAUDE_AGENT_SESSION', 'FAILED'),
          domain: ErrorDomain.STORAGE,
          category: ErrorCategory.THIRD_PARTY,
        },
        error,
      );
    }
  }

  async forkSession(input: {
    sourceId: string;
    newId: string;
    title?: string;
    resourceId?: string;
  }): Promise<MastraClaudeAgentSession | null> {
    const source = await this.getSession(input.sourceId);
    if (!source) return null;

    return this.saveSession({
      id: input.newId,
      agentKey: source.agentKey,
      resourceId: input.resourceId ?? source.resourceId,
      title: input.title ?? source.title,
      // Shallow copy so fork writes don't mutate the source in memory.
      messages: [...source.messages],
      tags: source.tags ? [...source.tags] : undefined,
      metadata: source.metadata ? { ...source.metadata } : undefined,
      forkedFrom: source.id,
    });
  }

  #parseRow(row: Record<string, unknown>): MastraClaudeAgentSession {
    // `json()`-wrapped jsonb columns come back as TEXT. Parse eagerly so
    // callers never see a raw JSON string.
    const parseJson = (value: unknown): unknown => {
      if (value == null) return undefined;
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    };

    return {
      id: String(row.id),
      agentKey: String(row.agentKey),
      resourceId: row.resourceId == null ? undefined : String(row.resourceId),
      title: row.title == null ? undefined : String(row.title),
      messages: (parseJson(row.messages) as unknown[]) ?? [],
      tags: parseJson(row.tags) as string[] | undefined,
      metadata: parseJson(row.metadata) as Record<string, unknown> | undefined,
      forkedFrom: row.forkedFrom == null ? undefined : String(row.forkedFrom),
      createdAt: new Date(String(row.createdAt)),
      updatedAt: new Date(String(row.updatedAt)),
    };
  }
}
