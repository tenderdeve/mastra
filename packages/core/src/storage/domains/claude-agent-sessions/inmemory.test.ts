import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDB } from '../inmemory-db';
import { ClaudeAgentSessionsInMemory } from './inmemory';

describe('ClaudeAgentSessionsInMemory', () => {
  let db: InMemoryDB;
  let store: ClaudeAgentSessionsInMemory;

  beforeEach(() => {
    db = new InMemoryDB();
    store = new ClaudeAgentSessionsInMemory({ db });
  });

  it('saves and reads a session by id', async () => {
    const saved = await store.saveSession({
      id: 'sess-1',
      agentKey: 'claudeDemoAgent',
      resourceId: 'user-1',
      messages: [{ type: 'user', content: 'hi' }],
      title: 'first',
    });

    expect(saved.id).toBe('sess-1');
    expect(saved.agentKey).toBe('claudeDemoAgent');
    expect(saved.messages).toEqual([{ type: 'user', content: 'hi' }]);
    expect(saved.createdAt).toBeInstanceOf(Date);

    const got = await store.getSession('sess-1');
    expect(got).toEqual(saved);
  });

  it('returns null for unknown ids', async () => {
    expect(await store.getSession('nope')).toBeNull();
  });

  it('preserves createdAt on overwrite but bumps updatedAt', async () => {
    const first = await store.saveSession({
      id: 'sess-1',
      agentKey: 'claudeDemoAgent',
      messages: [],
    });
    await new Promise(r => setTimeout(r, 5));
    const second = await store.saveSession({
      id: 'sess-1',
      agentKey: 'claudeDemoAgent',
      messages: [{ type: 'user', content: 'hello' }],
    });

    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(second.messages).toHaveLength(1);
  });

  it('filters listSessions by agentKey and resourceId', async () => {
    await store.saveSession({ id: 'a', agentKey: 'agentA', resourceId: 'u1', messages: [] });
    await store.saveSession({ id: 'b', agentKey: 'agentA', resourceId: 'u2', messages: [] });
    await store.saveSession({ id: 'c', agentKey: 'agentB', resourceId: 'u1', messages: [] });

    const onlyA = await store.listSessions({ agentKey: 'agentA' });
    expect(onlyA.sessions.map(s => s.id).sort()).toEqual(['a', 'b']);
    expect(onlyA.total).toBe(2);

    const onlyAU1 = await store.listSessions({ agentKey: 'agentA', resourceId: 'u1' });
    expect(onlyAU1.sessions.map(s => s.id)).toEqual(['a']);
  });

  it('paginates listSessions', async () => {
    for (let i = 0; i < 5; i++) {
      await store.saveSession({ id: `s${i}`, agentKey: 'x', messages: [] });
      // Ensure distinct updatedAt so ordering is stable.
      await new Promise(r => setTimeout(r, 2));
    }
    const page0 = await store.listSessions({ agentKey: 'x', page: 0, perPage: 2 });
    const page1 = await store.listSessions({ agentKey: 'x', page: 1, perPage: 2 });
    const page2 = await store.listSessions({ agentKey: 'x', page: 2, perPage: 2 });

    expect(page0.sessions).toHaveLength(2);
    expect(page1.sessions).toHaveLength(2);
    expect(page2.sessions).toHaveLength(1);
    expect(page0.hasMore).toBe(true);
    expect(page2.hasMore).toBe(false);
    expect(page0.total).toBe(5);
  });

  it('lists newest-first by updatedAt', async () => {
    await store.saveSession({ id: 'old', agentKey: 'x', messages: [] });
    await new Promise(r => setTimeout(r, 5));
    await store.saveSession({ id: 'new', agentKey: 'x', messages: [] });

    const result = await store.listSessions({ agentKey: 'x' });
    expect(result.sessions.map(s => s.id)).toEqual(['new', 'old']);
  });

  it('updateSession patches provided fields only', async () => {
    await store.saveSession({
      id: 'sess-1',
      agentKey: 'x',
      title: 'original',
      messages: [{ type: 'user', content: 'hi' }],
      tags: ['a'],
    });
    const updated = await store.updateSession('sess-1', { title: 'renamed' });
    expect(updated?.title).toBe('renamed');
    expect(updated?.messages).toHaveLength(1);
    expect(updated?.tags).toEqual(['a']);
  });

  it('updateSession returns null for unknown id', async () => {
    expect(await store.updateSession('ghost', { title: 'x' })).toBeNull();
  });

  it('deleteSession removes the record', async () => {
    await store.saveSession({ id: 'sess-1', agentKey: 'x', messages: [] });
    await store.deleteSession('sess-1');
    expect(await store.getSession('sess-1')).toBeNull();
  });

  it('forkSession copies messages and records forkedFrom', async () => {
    await store.saveSession({
      id: 'src',
      agentKey: 'x',
      messages: [{ type: 'user', content: 'hi' }],
      tags: ['t'],
    });
    const fork = await store.forkSession({ sourceId: 'src', newId: 'fork-1', title: 'Forked' });
    expect(fork?.id).toBe('fork-1');
    expect(fork?.forkedFrom).toBe('src');
    expect(fork?.messages).toEqual([{ type: 'user', content: 'hi' }]);
    expect(fork?.title).toBe('Forked');
    expect(fork?.tags).toEqual(['t']);

    // Mutating the fork's messages should not affect the source (shallow copy).
    const forkStored = await store.getSession('fork-1');
    forkStored?.messages.push({ type: 'user', content: 'new' });
    const source = await store.getSession('src');
    expect(source?.messages).toHaveLength(1);
  });

  it('forkSession returns null for unknown source', async () => {
    expect(await store.forkSession({ sourceId: 'nope', newId: 'x' })).toBeNull();
  });

  it('dangerouslyClearAll wipes sessions', async () => {
    await store.saveSession({ id: 'a', agentKey: 'x', messages: [] });
    await store.dangerouslyClearAll();
    expect(await store.getSession('a')).toBeNull();
  });
});
