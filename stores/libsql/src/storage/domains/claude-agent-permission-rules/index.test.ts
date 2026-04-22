import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClaudeAgentPermissionRulesStorage } from '@mastra/core/storage';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibSQLStore } from '../../index';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const TMP_ROOT = mkdtempSync(path.join(tmpdir(), 'libsql-claude-rules-'));

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

async function newRules(): Promise<ClaudeAgentPermissionRulesStorage> {
  const url = `file:${path.join(TMP_ROOT, `${Math.random().toString(36).slice(2)}.db`)}`;
  const store = new LibSQLStore({ id: 'libsql-claude-agent-rules-test', url });
  await store.init();
  const rules = (await store.getStore('claudeAgentPermissionRules')) as ClaudeAgentPermissionRulesStorage;
  await rules.dangerouslyClearAll();
  return rules;
}

describe('ClaudeAgentPermissionRulesLibSQL', () => {
  let rules: ClaudeAgentPermissionRulesStorage;

  beforeEach(async () => {
    rules = await newRules();
  });

  it('saves and reads a rule', async () => {
    await rules.saveRule({
      id: 'r1',
      agentKey: 'a',
      resourceId: 'u1',
      toolName: 'mcp__mastra__writeNote',
      decision: 'allow',
    });

    const found = await rules.getRule({ agentKey: 'a', resourceId: 'u1', toolName: 'mcp__mastra__writeNote' });
    expect(found).not.toBeNull();
    expect(found!.decision).toBe('allow');
    expect(found!.resourceId).toBe('u1');
  });

  it('upserts decisions for the same (agentKey, resourceId, toolName) tuple', async () => {
    await rules.saveRule({
      id: 'r1',
      agentKey: 'a',
      resourceId: 'u1',
      toolName: 'tool',
      decision: 'allow',
    });
    await rules.saveRule({
      id: 'r2',
      agentKey: 'a',
      resourceId: 'u1',
      toolName: 'tool',
      decision: 'deny',
    });

    const listed = await rules.listRules({ agentKey: 'a', resourceId: 'u1' });
    expect(listed).toHaveLength(1);
    expect(listed[0].decision).toBe('deny');
  });

  it('treats NULL resourceId as a distinct (global) scope', async () => {
    await rules.saveRule({ id: 'r1', agentKey: 'a', toolName: 'tool', decision: 'allow' });
    await rules.saveRule({ id: 'r2', agentKey: 'a', resourceId: 'u1', toolName: 'tool', decision: 'deny' });

    const global = await rules.getRule({ agentKey: 'a', toolName: 'tool' });
    expect(global?.decision).toBe('allow');

    const scoped = await rules.getRule({ agentKey: 'a', resourceId: 'u1', toolName: 'tool' });
    expect(scoped?.decision).toBe('deny');
  });

  it('listRules filters by agentKey and optional resourceId', async () => {
    await rules.saveRule({ id: 'r1', agentKey: 'a', resourceId: 'u1', toolName: 't1', decision: 'allow' });
    await rules.saveRule({ id: 'r2', agentKey: 'a', resourceId: 'u2', toolName: 't2', decision: 'allow' });
    await rules.saveRule({ id: 'r3', agentKey: 'b', resourceId: 'u1', toolName: 't3', decision: 'allow' });

    const a = await rules.listRules({ agentKey: 'a' });
    expect(a.map(r => r.id).sort()).toEqual(['r1', 'r2']);

    const aU1 = await rules.listRules({ agentKey: 'a', resourceId: 'u1' });
    expect(aU1.map(r => r.id)).toEqual(['r1']);
  });

  it('deleteRule removes a rule', async () => {
    await rules.saveRule({ id: 'r1', agentKey: 'a', toolName: 'tool', decision: 'allow' });
    await rules.deleteRule('r1');
    expect(await rules.getRule({ agentKey: 'a', toolName: 'tool' })).toBeNull();
  });
});
