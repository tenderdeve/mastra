import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDB } from '../inmemory-db';
import { ClaudeAgentPermissionRulesInMemory } from './inmemory';

describe('ClaudeAgentPermissionRulesInMemory', () => {
  let db: InMemoryDB;
  let store: ClaudeAgentPermissionRulesInMemory;

  beforeEach(() => {
    db = new InMemoryDB();
    store = new ClaudeAgentPermissionRulesInMemory({ db });
  });

  it('upserts a rule and retrieves it by the (agent, resource, tool) tuple', async () => {
    const saved = await store.saveRule({
      id: 'rule-1',
      agentKey: 'claudeDemoAgent',
      resourceId: 'user-1',
      toolName: 'mcp__mastra__writeNote',
      decision: 'allow',
    });
    expect(saved.decision).toBe('allow');

    const got = await store.getRule({
      agentKey: 'claudeDemoAgent',
      resourceId: 'user-1',
      toolName: 'mcp__mastra__writeNote',
    });
    expect(got?.id).toBe('rule-1');
  });

  it('scopes rules by resourceId', async () => {
    await store.saveRule({
      id: 'u1',
      agentKey: 'a',
      resourceId: 'user-1',
      toolName: 't',
      decision: 'allow',
    });
    await store.saveRule({
      id: 'u2',
      agentKey: 'a',
      resourceId: 'user-2',
      toolName: 't',
      decision: 'deny',
    });

    const u1 = await store.getRule({ agentKey: 'a', resourceId: 'user-1', toolName: 't' });
    const u2 = await store.getRule({ agentKey: 'a', resourceId: 'user-2', toolName: 't' });
    expect(u1?.decision).toBe('allow');
    expect(u2?.decision).toBe('deny');
  });

  it('overwrites an existing rule for the same tuple', async () => {
    await store.saveRule({ id: 'r1', agentKey: 'a', toolName: 't', decision: 'allow' });
    await store.saveRule({ id: 'r2', agentKey: 'a', toolName: 't', decision: 'deny' });

    const got = await store.getRule({ agentKey: 'a', toolName: 't' });
    expect(got?.id).toBe('r2');
    expect(got?.decision).toBe('deny');
  });

  it('getRule returns null for unknown tuple', async () => {
    expect(await store.getRule({ agentKey: 'a', toolName: 'missing' })).toBeNull();
  });

  it('listRules returns all matching rules', async () => {
    await store.saveRule({ id: 'r1', agentKey: 'a', toolName: 't1', decision: 'allow' });
    await store.saveRule({ id: 'r2', agentKey: 'a', toolName: 't2', decision: 'deny' });
    await store.saveRule({ id: 'r3', agentKey: 'b', toolName: 't1', decision: 'allow' });

    const rules = await store.listRules({ agentKey: 'a' });
    expect(rules.map(r => r.id).sort()).toEqual(['r1', 'r2']);
  });

  it('listRules filters by resourceId when provided', async () => {
    await store.saveRule({
      id: 'r1',
      agentKey: 'a',
      resourceId: 'u1',
      toolName: 't',
      decision: 'allow',
    });
    await store.saveRule({
      id: 'r2',
      agentKey: 'a',
      resourceId: 'u2',
      toolName: 't',
      decision: 'allow',
    });
    const u1 = await store.listRules({ agentKey: 'a', resourceId: 'u1' });
    expect(u1.map(r => r.id)).toEqual(['r1']);
  });

  it('deleteRule removes the record', async () => {
    await store.saveRule({ id: 'r1', agentKey: 'a', toolName: 't', decision: 'allow' });
    await store.deleteRule('r1');
    expect(await store.getRule({ agentKey: 'a', toolName: 't' })).toBeNull();
  });

  it('deleteRule is a no-op for unknown id', async () => {
    await expect(store.deleteRule('ghost')).resolves.toBeUndefined();
  });

  it('dangerouslyClearAll wipes rules', async () => {
    await store.saveRule({ id: 'r1', agentKey: 'a', toolName: 't', decision: 'allow' });
    await store.dangerouslyClearAll();
    expect(await store.listRules({ agentKey: 'a' })).toEqual([]);
  });
});
