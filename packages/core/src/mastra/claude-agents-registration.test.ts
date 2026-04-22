import { describe, it, expect } from 'vitest';
import type { ClaudeAgentLike } from '../claude-agents';
import { Mastra } from './index';

function fakeAgent(partial: Partial<ClaudeAgentLike> & { id: string }): ClaudeAgentLike {
  return {
    name: partial.name,
    description: partial.description,
    id: partial.id,
  };
}

describe('Mastra.claudeAgents registration', () => {
  it('registers claude agents under their config key', () => {
    const agent = fakeAgent({ id: 'claude-demo', name: 'Claude Demo' });
    const mastra = new Mastra({
      claudeAgents: { claudeDemoAgent: agent },
    });

    expect(mastra.getClaudeAgent('claudeDemoAgent')).toBe(agent);
    expect(Object.keys(mastra.getClaudeAgents())).toEqual(['claudeDemoAgent']);
  });

  it('getClaudeAgentById finds agents by their id field', () => {
    const agent = fakeAgent({ id: 'claude-demo', name: 'Claude Demo' });
    const mastra = new Mastra({
      claudeAgents: { claudeDemoAgent: agent },
    });

    expect(mastra.getClaudeAgentById('claude-demo')).toBe(agent);
  });

  it('getClaudeAgentById falls back to key lookup when id does not match', () => {
    const agent = fakeAgent({ id: 'claude-demo' });
    const mastra = new Mastra({
      claudeAgents: { claudeDemoAgent: agent },
    });

    // Key lookup fallback: asking by key should still succeed.
    expect(mastra.getClaudeAgentById('claudeDemoAgent')).toBe(agent);
  });

  it('resolveClaudeAgentKey returns the registration key for either id or key', () => {
    const agent = fakeAgent({ id: 'claude-demo' });
    const mastra = new Mastra({
      claudeAgents: { claudeDemoAgent: agent },
    });

    expect(mastra.resolveClaudeAgentKey('claudeDemoAgent')).toBe('claudeDemoAgent');
    expect(mastra.resolveClaudeAgentKey('claude-demo')).toBe('claudeDemoAgent');
  });

  it('invokes __registerMastra on each registered agent', () => {
    let captured: unknown = null;
    const agent: ClaudeAgentLike = {
      id: 'claude-demo',
      __registerMastra(host) {
        captured = host;
      },
    };
    const mastra = new Mastra({ claudeAgents: { claudeDemoAgent: agent } });

    expect(captured).toBe(mastra);
  });

  it('throws MASTRA_GET_CLAUDE_AGENT_BY_KEY_NOT_FOUND for unknown key', () => {
    const mastra = new Mastra({ claudeAgents: {} });
    expect(() => mastra.getClaudeAgent('nope' as never)).toThrow(/not found/);
  });

  it('throws MASTRA_RESOLVE_CLAUDE_AGENT_KEY_NOT_FOUND for unknown idOrKey', () => {
    const mastra = new Mastra({ claudeAgents: {} });
    expect(() => mastra.resolveClaudeAgentKey('ghost')).toThrow(/not found/);
  });
});
