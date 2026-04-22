import { calculatePagination, normalizePerPage } from '../../base';
import type { InMemoryDB } from '../inmemory-db';
import { ClaudeAgentSessionsStorage } from './base';
import type {
  ListClaudeAgentSessionsInput,
  ListClaudeAgentSessionsOutput,
  MastraClaudeAgentSession,
  SaveClaudeAgentSessionInput,
  UpdateClaudeAgentSessionInput,
} from './base';

const DEFAULT_PER_PAGE = 50;

export class ClaudeAgentSessionsInMemory extends ClaudeAgentSessionsStorage {
  #db: InMemoryDB;

  constructor({ db }: { db: InMemoryDB }) {
    super();
    this.#db = db;
  }

  async dangerouslyClearAll(): Promise<void> {
    this.#db.claudeAgentSessions.clear();
  }

  async saveSession(input: SaveClaudeAgentSessionInput): Promise<MastraClaudeAgentSession> {
    const now = new Date();
    const existing = this.#db.claudeAgentSessions.get(input.id);
    const record: MastraClaudeAgentSession = {
      id: input.id,
      agentKey: input.agentKey,
      resourceId: input.resourceId,
      title: input.title,
      messages: input.messages,
      tags: input.tags,
      metadata: input.metadata,
      forkedFrom: input.forkedFrom,
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.#db.claudeAgentSessions.set(record.id, record);
    return record;
  }

  async getSession(id: string): Promise<MastraClaudeAgentSession | null> {
    return this.#db.claudeAgentSessions.get(id) ?? null;
  }

  async listSessions(input: ListClaudeAgentSessionsInput): Promise<ListClaudeAgentSessionsOutput> {
    const all = Array.from(this.#db.claudeAgentSessions.values()).filter(session => {
      if (session.agentKey !== input.agentKey) return false;
      if (input.resourceId !== undefined && session.resourceId !== input.resourceId) return false;
      return true;
    });
    // Newest first.
    all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    const page = input.page ?? 0;
    const perPage = normalizePerPage(input.perPage, DEFAULT_PER_PAGE);
    const { offset: start } = calculatePagination(page, input.perPage, perPage);
    const end = start + perPage;

    return {
      sessions: all.slice(start, end),
      total: all.length,
      page,
      perPage,
      hasMore: all.length > end,
    };
  }

  async updateSession(id: string, update: UpdateClaudeAgentSessionInput): Promise<MastraClaudeAgentSession | null> {
    const existing = this.#db.claudeAgentSessions.get(id);
    if (!existing) return null;
    const updated: MastraClaudeAgentSession = {
      ...existing,
      ...(update.title !== undefined ? { title: update.title } : {}),
      ...(update.messages !== undefined ? { messages: update.messages } : {}),
      ...(update.tags !== undefined ? { tags: update.tags } : {}),
      ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
      updatedAt: new Date(),
    };
    this.#db.claudeAgentSessions.set(id, updated);
    return updated;
  }

  async deleteSession(id: string): Promise<void> {
    this.#db.claudeAgentSessions.delete(id);
  }

  async forkSession(input: {
    sourceId: string;
    newId: string;
    title?: string;
    resourceId?: string;
  }): Promise<MastraClaudeAgentSession | null> {
    const source = this.#db.claudeAgentSessions.get(input.sourceId);
    if (!source) return null;
    const now = new Date();
    const record: MastraClaudeAgentSession = {
      id: input.newId,
      agentKey: source.agentKey,
      resourceId: input.resourceId ?? source.resourceId,
      title: input.title ?? source.title,
      // Shallow copy so subsequent edits to the fork don't mutate the source.
      messages: [...source.messages],
      tags: source.tags ? [...source.tags] : undefined,
      metadata: source.metadata ? { ...source.metadata } : undefined,
      forkedFrom: source.id,
      createdAt: now,
      updatedAt: now,
    };
    this.#db.claudeAgentSessions.set(record.id, record);
    return record;
  }
}
