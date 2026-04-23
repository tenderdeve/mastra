import type {
  ClaudeAgentPermissionRulesStorage,
  ListClaudeAgentPermissionRulesInput,
  MastraClaudeAgentPermissionRule,
  SaveClaudeAgentPermissionRuleInput,
} from '@mastra/core/storage';
import { describe, expect, it, vi } from 'vitest';

import { ASK_USER_QUESTION_TOOL_NAME, buildCanUseTool } from './can-use-tool';
import { PendingRegistry } from './pending-registry';
import type { ShellStreamEvent } from './stream-events';

// ---------------------------------------------------------------------------
// Minimal in-memory permission-rules stub.
//
// We could reach for InMemoryStore from @mastra/core, but wiring a whole
// composite store through vitest slows tests 10× and couples us to core's
// initialization contract. A focused stub keeps the tests honest about what
// `buildCanUseTool` actually needs from the rules domain.
// ---------------------------------------------------------------------------
class StubRules implements Pick<ClaudeAgentPermissionRulesStorage, 'getRule' | 'saveRule' | 'listRules' | 'deleteRule'> {
  readonly saved: Array<SaveClaudeAgentPermissionRuleInput> = [];
  readonly rules = new Map<string, MastraClaudeAgentPermissionRule>();
  getRuleError: Error | undefined;
  saveRuleError: Error | undefined;

  async getRule(input: { agentKey: string; resourceId?: string; toolName: string }) {
    if (this.getRuleError) throw this.getRuleError;
    return this.rules.get(`${input.agentKey}::${input.resourceId ?? ''}::${input.toolName}`) ?? null;
  }
  async saveRule(input: SaveClaudeAgentPermissionRuleInput) {
    if (this.saveRuleError) throw this.saveRuleError;
    this.saved.push(input);
    const rec: MastraClaudeAgentPermissionRule = {
      id: input.id,
      agentKey: input.agentKey,
      resourceId: input.resourceId,
      toolName: input.toolName,
      decision: input.decision,
      updatedAt: new Date(),
    };
    this.rules.set(`${input.agentKey}::${input.resourceId ?? ''}::${input.toolName}`, rec);
    return rec;
  }
  async listRules(_input: ListClaudeAgentPermissionRulesInput) {
    return Array.from(this.rules.values());
  }
  async deleteRule(_id: string) {
    /* unused in these tests */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeOptions(overrides: Partial<Parameters<ReturnType<typeof buildCanUseTool>>[2]> = {}) {
  const controller = new AbortController();
  return {
    controller,
    options: {
      signal: controller.signal,
      toolUseID: 'tu_1',
      ...overrides,
    } as Parameters<ReturnType<typeof buildCanUseTool>>[2],
  };
}

function makeBuilder(overrides: Partial<Parameters<typeof buildCanUseTool>[0]> = {}) {
  const events: ShellStreamEvent[] = [];
  const registry = new PendingRegistry();
  const rules = (overrides.permissionRulesStore as unknown as StubRules) ?? new StubRules();

  let counter = 0;

  const canUseTool = buildCanUseTool({
    getSessionId: () => 'sess-1',
    placeholderSessionId: 'placeholder',
    agentKey: 'myAgent',
    resourceId: 'user-1',
    registry,
    permissionRulesStore: rules as unknown as ClaudeAgentPermissionRulesStorage,
    emit: e => events.push(e),
    newCorrelationId: () => `cid-${++counter}`,
    ...overrides,
  });

  return { canUseTool, events, registry, rules };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('buildCanUseTool – remembered rules short-circuit', () => {
  it('auto-allows when a saved rule says allow', async () => {
    const { canUseTool, rules, events } = makeBuilder();
    await rules.saveRule({
      id: 'r1',
      agentKey: 'myAgent',
      resourceId: 'user-1',
      toolName: 'mcp__mastra__echo',
      decision: 'allow',
    });

    const { options } = makeOptions();
    const result = await canUseTool('mcp__mastra__echo', { x: 1 }, options);

    expect(result).toEqual({ behavior: 'allow', updatedInput: { x: 1 } });
    expect(events).toEqual([]);
  });

  it('auto-denies when a saved rule says deny', async () => {
    const { canUseTool, rules, events } = makeBuilder();
    await rules.saveRule({
      id: 'r1',
      agentKey: 'myAgent',
      resourceId: 'user-1',
      toolName: 'mcp__mastra__echo',
      decision: 'deny',
    });

    const { options } = makeOptions();
    const result = await canUseTool('mcp__mastra__echo', { x: 1 }, options);

    expect(result).toEqual({ behavior: 'deny', message: expect.stringContaining('remembered rule') });
    expect(events).toEqual([]);
  });

  it('falls through to a prompt when the rules store throws on lookup', async () => {
    const rules = new StubRules();
    rules.getRuleError = new Error('rules store is down');
    const warn = vi.fn();
    const { canUseTool, events, registry } = makeBuilder({
      permissionRulesStore: rules as unknown as ClaudeAgentPermissionRulesStorage,
      logger: { warn, error: vi.fn() },
    });

    const { options } = makeOptions();
    const promise = canUseTool('mcp__mastra__echo', { x: 1 }, options);

    // Wait a microtask for the approval to register and the event to emit.
    await Promise.resolve();
    await Promise.resolve();

    expect(events[0]?.type).toBe('approval-request');
    expect(warn).toHaveBeenCalled();

    // Resolve so the promise settles.
    registry.resolveApproval('sess-1', 'cid-1', { decision: 'allow' });
    await expect(promise).resolves.toEqual({ behavior: 'allow', updatedInput: { x: 1 } });
  });
});

describe('buildCanUseTool – approval flow', () => {
  it('emits an approval-request, parks, and resolves with user input on allow', async () => {
    const { canUseTool, events, registry } = makeBuilder();

    const { options } = makeOptions();
    const promise = canUseTool('mcp__mastra__writeNote', { title: 'a', body: 'b' }, options);

    await Promise.resolve();

    expect(events).toEqual([
      {
        type: 'approval-request',
        request: {
          kind: 'approval',
          sessionId: 'sess-1',
          correlationId: 'cid-1',
          toolName: 'mcp__mastra__writeNote',
          input: { title: 'a', body: 'b' },
        },
      },
    ]);
    expect(registry.size).toBe(1);

    registry.resolveApproval('sess-1', 'cid-1', { decision: 'allow' });

    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { title: 'a', body: 'b' },
    });
    expect(events.at(-1)).toEqual({ type: 'approval-resolved', approvalId: 'cid-1', decision: 'approve' });
  });

  it('applies updatedInput from approve-with-changes', async () => {
    const { canUseTool, registry } = makeBuilder();
    const { options } = makeOptions();
    const promise = canUseTool('mcp__mastra__writeNote', { title: 'a', body: 'b' }, options);
    await Promise.resolve();

    registry.resolveApproval('sess-1', 'cid-1', {
      decision: 'allow',
      updatedInput: { title: 'edited', body: 'edited' },
    });

    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { title: 'edited', body: 'edited' },
    });
  });

  it('returns deny with the user-supplied message', async () => {
    const { canUseTool, events, registry } = makeBuilder();
    const { options } = makeOptions();
    const promise = canUseTool('mcp__mastra__writeNote', {}, options);
    await Promise.resolve();

    registry.resolveApproval('sess-1', 'cid-1', { decision: 'deny', message: 'nope, try X instead' });

    await expect(promise).resolves.toEqual({ behavior: 'deny', message: 'nope, try X instead' });
    expect(events.at(-1)).toEqual({ type: 'approval-resolved', approvalId: 'cid-1', decision: 'deny' });
  });

  it('falls back to a default message on deny without text', async () => {
    const { canUseTool, registry } = makeBuilder();
    const { options } = makeOptions();
    const promise = canUseTool('mcp__mastra__writeNote', {}, options);
    await Promise.resolve();
    registry.resolveApproval('sess-1', 'cid-1', { decision: 'deny' });
    await expect(promise).resolves.toEqual({ behavior: 'deny', message: 'Denied by user.' });
  });

  it('persists a rule when the user opts to remember the decision', async () => {
    const { canUseTool, registry, rules } = makeBuilder();
    const { options } = makeOptions();
    const promise = canUseTool('mcp__mastra__writeNote', {}, options);
    await Promise.resolve();

    registry.resolveApproval('sess-1', 'cid-1', { decision: 'allow', remember: true });
    await promise;

    expect(rules.saved).toEqual([
      {
        id: 'myAgent:user-1:mcp__mastra__writeNote',
        agentKey: 'myAgent',
        resourceId: 'user-1',
        toolName: 'mcp__mastra__writeNote',
        decision: 'allow',
      },
    ]);
  });

  it('logs + survives when rule persistence fails', async () => {
    const rules = new StubRules();
    rules.saveRuleError = new Error('db exploded');
    const warn = vi.fn();
    const { canUseTool, registry } = makeBuilder({
      permissionRulesStore: rules as unknown as ClaudeAgentPermissionRulesStorage,
      logger: { warn, error: vi.fn() },
    });
    const { options } = makeOptions();
    const promise = canUseTool('mcp__mastra__writeNote', {}, options);
    await Promise.resolve();

    registry.resolveApproval('sess-1', 'cid-1', { decision: 'allow', remember: true });
    await expect(promise).resolves.toMatchObject({ behavior: 'allow' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to persist permission rule'), expect.anything());
  });

  it('propagates the SDK abort signal into the pending registry', async () => {
    const { canUseTool, registry } = makeBuilder();
    const { controller, options } = makeOptions();

    const promise = canUseTool('mcp__mastra__writeNote', {}, options);
    await Promise.resolve();
    expect(registry.size).toBe(1);

    controller.abort();

    await expect(promise).rejects.toThrow(/cancelled/);
    expect(registry.size).toBe(0);
  });

  it('uses the placeholder session id when the real id is not yet minted', async () => {
    const { canUseTool, events, registry } = makeBuilder({ getSessionId: () => undefined });
    const { options } = makeOptions();
    const promise = canUseTool('mcp__mastra__writeNote', {}, options);
    await Promise.resolve();

    expect(events[0]).toMatchObject({
      type: 'approval-request',
      request: { sessionId: 'placeholder', correlationId: 'cid-1' },
    });

    registry.resolveApproval('placeholder', 'cid-1', { decision: 'allow' });
    await promise;
  });
});

describe('buildCanUseTool – AskUserQuestion flow', () => {
  it('emits a question-request and returns updatedInput with flattened answers', async () => {
    const { canUseTool, events, registry } = makeBuilder();
    const { options } = makeOptions();

    const input = {
      questions: [
        {
          question: 'Which library should we use for date formatting?',
          header: 'Library',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'small' },
            { label: 'dayjs', description: 'small + immutable' },
          ],
        },
      ],
    };

    const promise = canUseTool(ASK_USER_QUESTION_TOOL_NAME, input, options);
    await Promise.resolve();

    expect(events[0]).toMatchObject({
      type: 'question-request',
      request: {
        sessionId: 'sess-1',
        correlationId: 'cid-1',
        questions: [
          {
            id: 'Which library should we use for date formatting?',
            question: 'Which library should we use for date formatting?',
            multiSelect: false,
            allowOther: true,
            options: [
              { label: 'date-fns', description: 'small' },
              { label: 'dayjs', description: 'small + immutable' },
            ],
          },
        ],
      },
    });

    registry.resolveQuestion('sess-1', 'cid-1', {
      answers: {
        'Which library should we use for date formatting?': { selected: ['date-fns'] },
      },
    });

    const result = await promise;
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: { 'Which library should we use for date formatting?': 'date-fns' },
      },
    });
    expect(events.at(-1)).toEqual({ type: 'question-resolved', questionId: 'cid-1' });
  });

  it('joins multi-select answers with ", " per SDK convention', async () => {
    const { canUseTool, registry } = makeBuilder();
    const { options } = makeOptions();
    const input = {
      questions: [
        {
          question: 'Which features?',
          multiSelect: true,
          options: [{ label: 'auth' }, { label: 'billing' }, { label: 'teams' }],
        },
      ],
    };

    const promise = canUseTool(ASK_USER_QUESTION_TOOL_NAME, input, options);
    await Promise.resolve();
    registry.resolveQuestion('sess-1', 'cid-1', {
      answers: { 'Which features?': { selected: ['auth', 'teams'] } },
    });

    const result = (await promise) as { behavior: 'allow'; updatedInput: { answers: Record<string, string> } };
    expect(result.updatedInput.answers).toEqual({ 'Which features?': 'auth, teams' });
  });

  it('appends free-text "Other" alongside selected options when provided', async () => {
    const { canUseTool, registry } = makeBuilder();
    const { options } = makeOptions();
    const input = {
      questions: [
        {
          question: 'Approach?',
          multiSelect: false,
          options: [{ label: 'polling' }, { label: 'websockets' }],
        },
      ],
    };
    const promise = canUseTool(ASK_USER_QUESTION_TOOL_NAME, input, options);
    await Promise.resolve();

    registry.resolveQuestion('sess-1', 'cid-1', {
      answers: { 'Approach?': { selected: ['polling'], other: 'server-sent events' } },
    });

    const result = (await promise) as { behavior: 'allow'; updatedInput: { answers: Record<string, string> } };
    expect(result.updatedInput.answers).toEqual({ 'Approach?': 'polling, server-sent events' });
  });

  it('returns only the free-text answer when no options are selected', async () => {
    const { canUseTool, registry } = makeBuilder();
    const { options } = makeOptions();
    const input = {
      questions: [
        {
          question: 'Anything else?',
          multiSelect: false,
          options: [{ label: 'yes' }, { label: 'no' }],
        },
      ],
    };
    const promise = canUseTool(ASK_USER_QUESTION_TOOL_NAME, input, options);
    await Promise.resolve();

    registry.resolveQuestion('sess-1', 'cid-1', {
      answers: { 'Anything else?': { selected: [], other: 'Please skip to the next step.' } },
    });

    const result = (await promise) as { behavior: 'allow'; updatedInput: { answers: Record<string, string> } };
    expect(result.updatedInput.answers).toEqual({ 'Anything else?': 'Please skip to the next step.' });
  });

  it('denies AskUserQuestion calls with no questions at all', async () => {
    const { canUseTool } = makeBuilder();
    const { options } = makeOptions();
    const result = await canUseTool(ASK_USER_QUESTION_TOOL_NAME, { questions: [] }, options);
    expect(result).toEqual({ behavior: 'deny', message: expect.stringContaining('no questions') });
  });

  it('propagates the SDK abort signal during a pending question', async () => {
    const { canUseTool, registry } = makeBuilder();
    const { controller, options } = makeOptions();
    const input = {
      questions: [
        { question: 'Go?', options: [{ label: 'yes' }, { label: 'no' }] },
      ],
    };
    const promise = canUseTool(ASK_USER_QUESTION_TOOL_NAME, input, options);
    await Promise.resolve();
    expect(registry.size).toBe(1);

    controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/);
    expect(registry.size).toBe(0);
  });
});

describe('buildCanUseTool – no permissionRulesStore', () => {
  it('skips rule lookup entirely when no store is provided', async () => {
    const { canUseTool, events, registry } = makeBuilder({ permissionRulesStore: undefined });
    const { options } = makeOptions();
    const promise = canUseTool('mcp__mastra__echo', { x: 1 }, options);
    await Promise.resolve();

    expect(events[0]?.type).toBe('approval-request');
    registry.resolveApproval('sess-1', 'cid-1', { decision: 'allow' });
    await expect(promise).resolves.toEqual({ behavior: 'allow', updatedInput: { x: 1 } });
  });

  it('silently drops a remember=true flag when no store is provided', async () => {
    const { canUseTool, registry } = makeBuilder({ permissionRulesStore: undefined });
    const { options } = makeOptions();
    const promise = canUseTool('mcp__mastra__echo', {}, options);
    await Promise.resolve();
    registry.resolveApproval('sess-1', 'cid-1', { decision: 'allow', remember: true });
    await expect(promise).resolves.toMatchObject({ behavior: 'allow' });
  });
});

describe('buildCanUseTool – ordering', () => {
  it('serializes concurrent approvals into distinct pending entries', async () => {
    const { canUseTool, events, registry } = makeBuilder();
    const { options: opts1 } = makeOptions();
    const { options: opts2 } = makeOptions();

    const p1 = canUseTool('mcp__mastra__a', {}, opts1);
    const p2 = canUseTool('mcp__mastra__b', {}, opts2);

    await Promise.resolve();
    await Promise.resolve();

    expect(events.filter(e => e.type === 'approval-request')).toHaveLength(2);
    expect(registry.size).toBe(2);

    registry.resolveApproval('sess-1', 'cid-1', { decision: 'allow' });
    registry.resolveApproval('sess-1', 'cid-2', { decision: 'deny' });

    await expect(p1).resolves.toMatchObject({ behavior: 'allow' });
    await expect(p2).resolves.toMatchObject({ behavior: 'deny' });
  });
});
