import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClaudeAgentSessionsStorage } from '@mastra/core/storage';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibSQLStore } from '../../index';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const TMP_ROOT = mkdtempSync(path.join(tmpdir(), 'libsql-claude-sessions-'));

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

async function newSessions(): Promise<ClaudeAgentSessionsStorage> {
  const url = `file:${path.join(TMP_ROOT, `${Math.random().toString(36).slice(2)}.db`)}`;
  const store = new LibSQLStore({ id: 'libsql-claude-agent-sessions-test', url });
  await store.init();
  const sessions = (await store.getStore('claudeAgentSessions')) as ClaudeAgentSessionsStorage;
  await sessions.dangerouslyClearAll();
  return sessions;
}

describe('ClaudeAgentSessionsLibSQL', () => {
  let sessions: ClaudeAgentSessionsStorage;

  beforeEach(async () => {
    sessions = await newSessions();
  });

  it('saves and reads a session with jsonb fields', async () => {
    const now = new Date();
    const saved = await sessions.saveSession({
      id: 'sess-1',
      agentKey: 'agent-a',
      resourceId: 'user-1',
      messages: [{ type: 'user', content: 'hello' }],
      tags: ['a', 'b'],
      metadata: { source: 'studio' },
      title: 'Hello',
      createdAt: now,
      updatedAt: now,
    });

    expect(saved.id).toBe('sess-1');

    const fetched = await sessions.getSession('sess-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.messages).toEqual([{ type: 'user', content: 'hello' }]);
    expect(fetched!.tags).toEqual(['a', 'b']);
    expect(fetched!.metadata).toEqual({ source: 'studio' });
    expect(fetched!.title).toBe('Hello');
    expect(fetched!.resourceId).toBe('user-1');
  });

  it('lists sessions filtered by agentKey and resourceId', async () => {
    const now = new Date();
    await sessions.saveSession({
      id: 's1',
      agentKey: 'agent-a',
      resourceId: 'u1',
      messages: [],
      createdAt: now,
      updatedAt: now,
    });
    await sessions.saveSession({
      id: 's2',
      agentKey: 'agent-a',
      resourceId: 'u2',
      messages: [],
      createdAt: now,
      updatedAt: now,
    });
    await sessions.saveSession({
      id: 's3',
      agentKey: 'agent-b',
      resourceId: 'u1',
      messages: [],
      createdAt: now,
      updatedAt: now,
    });

    const scoped = await sessions.listSessions({ agentKey: 'agent-a', resourceId: 'u1' });
    expect(scoped.sessions.map(s => s.id)).toEqual(['s1']);

    const allForA = await sessions.listSessions({ agentKey: 'agent-a' });
    expect(allForA.sessions.map(s => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('updateSession merges fields and preserves unspecified ones', async () => {
    const now = new Date();
    await sessions.saveSession({
      id: 's1',
      agentKey: 'a',
      messages: [],
      tags: ['x'],
      metadata: { a: 1 },
      createdAt: now,
      updatedAt: now,
    });

    const updated = await sessions.updateSession('s1', {
      messages: [{ type: 'user', content: 'hi' }],
      title: 'renamed',
    });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('renamed');
    expect(updated!.messages).toEqual([{ type: 'user', content: 'hi' }]);
    expect(updated!.tags).toEqual(['x']);
    expect(updated!.metadata).toEqual({ a: 1 });
  });

  it('deletes sessions', async () => {
    const now = new Date();
    await sessions.saveSession({ id: 's1', agentKey: 'a', messages: [], createdAt: now, updatedAt: now });
    await sessions.deleteSession('s1');
    expect(await sessions.getSession('s1')).toBeNull();
  });

  it('forkSession clones messages and records forkedFrom', async () => {
    const now = new Date();
    await sessions.saveSession({
      id: 'parent',
      agentKey: 'a',
      messages: [{ type: 'user', content: 'hi' }],
      createdAt: now,
      updatedAt: now,
    });

    const child = await sessions.forkSession({ sourceId: 'parent', newId: 'child' });

    expect(child).not.toBeNull();
    expect(child!.id).toBe('child');
    expect(child!.forkedFrom).toBe('parent');
    expect(child!.messages).toEqual([{ type: 'user', content: 'hi' }]);
  });
});
