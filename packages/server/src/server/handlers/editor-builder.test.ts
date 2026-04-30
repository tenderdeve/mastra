import type { IAgentBuilder } from '@mastra/core/agent-builder/ee';
import type { IMastraEditor } from '@mastra/core/editor';
import { describe, it, expect, vi } from 'vitest';

import { GET_EDITOR_BUILDER_SETTINGS_ROUTE } from './editor-builder';

// Minimal mock mastra for handler testing
const createMockMastra = (
  editor?: Partial<IMastraEditor>,
  agents: Record<string, { id?: string; source?: string }> = {},
) =>
  ({
    getEditor: () => editor,
    listAgents: () => agents,
  }) as any;

describe('GET /editor/builder/settings', () => {
  it('returns enabled: false + inactive modelPolicy when no editor configured', async () => {
    const mastra = createMockMastra();
    const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

    expect(result).toEqual({ enabled: false, modelPolicy: { active: false } });
  });

  it('returns enabled: false + inactive modelPolicy when editor lacks resolveBuilder', async () => {
    const mastra = createMockMastra({});
    const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

    expect(result).toEqual({ enabled: false, modelPolicy: { active: false } });
  });

  it('returns enabled: false + inactive modelPolicy when hasEnabledBuilderConfig returns false', async () => {
    const resolveBuilder = vi.fn();
    const mastra = createMockMastra({
      hasEnabledBuilderConfig: () => false,
      resolveBuilder,
    });
    const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

    expect(result).toEqual({ enabled: false, modelPolicy: { active: false } });
    expect(resolveBuilder).not.toHaveBeenCalled();
  });

  it('returns enabled: false + inactive modelPolicy when resolveBuilder returns undefined', async () => {
    const mastra = createMockMastra({
      hasEnabledBuilderConfig: () => true,
      resolveBuilder: vi.fn().mockResolvedValue(undefined),
    });
    const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

    expect(result).toEqual({ enabled: false, modelPolicy: { active: false } });
  });

  it('returns builder settings + derived modelPolicy when builder is enabled (no model slice)', async () => {
    const mockBuilder: IAgentBuilder = {
      enabled: true,
      getFeatures: () => ({ agent: { tools: true, memory: true } }),
      getConfiguration: () => ({ agent: { maxTokens: 4096 } }),
    };
    const mastra = createMockMastra({
      hasEnabledBuilderConfig: () => true,
      resolveBuilder: vi.fn().mockResolvedValue(mockBuilder),
    });
    const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

    expect(result).toEqual({
      enabled: true,
      features: { agent: { tools: true, memory: true } },
      configuration: { agent: { maxTokens: 4096 } },
      modelPolicy: { active: false },
      library: { visibleAgents: [], unrestricted: true },
    });
  });

  it('returns active modelPolicy with allowed + default when configured', async () => {
    const mockBuilder: IAgentBuilder = {
      enabled: true,
      getFeatures: () => ({ agent: { model: true } }),
      getConfiguration: () => ({
        agent: {
          models: {
            allowed: [{ provider: 'openai' }],
            default: { provider: 'openai', modelId: 'gpt-4o-mini' },
          },
        },
      }),
    };
    const mastra = createMockMastra({
      hasEnabledBuilderConfig: () => true,
      resolveBuilder: vi.fn().mockResolvedValue(mockBuilder),
    });
    const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

    expect(result).toMatchObject({
      enabled: true,
      modelPolicy: {
        active: true,
        pickerVisible: true,
        allowed: [{ provider: 'openai' }],
        default: { provider: 'openai', modelId: 'gpt-4o-mini' },
      },
    });
  });

  it('returns enabled: false + inactive modelPolicy when builder.enabled is false', async () => {
    const mockBuilder: IAgentBuilder = {
      enabled: false,
      getFeatures: () => ({ agent: { tools: true } }),
      getConfiguration: () => ({ agent: { maxTokens: 4096 } }),
    };
    const mastra = createMockMastra({
      hasEnabledBuilderConfig: () => true,
      resolveBuilder: vi.fn().mockResolvedValue(mockBuilder),
    });
    const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

    // Should NOT expose features/config when disabled
    expect(result).toEqual({ enabled: false, modelPolicy: { active: false } });
  });

  it('throws HTTPException when resolveBuilder throws', async () => {
    const mastra = createMockMastra({
      hasEnabledBuilderConfig: () => true,
      resolveBuilder: vi.fn().mockRejectedValue(new Error('License check failed')),
    });

    await expect(GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any)).rejects.toThrow('License check failed');
  });

  describe('library visibility', () => {
    it('returns unrestricted: true when no library config is set', async () => {
      const mockBuilder: IAgentBuilder = {
        enabled: true,
        getFeatures: () => ({ agent: { tools: true } }),
        getConfiguration: () => ({ agent: {} }),
      };
      const mastra = createMockMastra(
        {
          hasEnabledBuilderConfig: () => true,
          resolveBuilder: vi.fn().mockResolvedValue(mockBuilder),
        },
        { weather: { source: 'code' }, support: { source: 'code' } },
      );
      const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

      expect(result).toMatchObject({
        library: { visibleAgents: [], unrestricted: true },
      });
      expect((result as any).modelPolicyWarnings).toBeUndefined();
    });

    it('returns the resolved allowlist when visibleAgents is set', async () => {
      const mockBuilder: IAgentBuilder = {
        enabled: true,
        getFeatures: () => ({ agent: { tools: true } }),
        getConfiguration: () => ({
          agent: {},
          library: { visibleAgents: ['weather'] },
        }),
      };
      const mastra = createMockMastra(
        {
          hasEnabledBuilderConfig: () => true,
          resolveBuilder: vi.fn().mockResolvedValue(mockBuilder),
        },
        { weather: { source: 'code' }, support: { source: 'code' } },
      );
      const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

      expect(result).toMatchObject({
        library: { visibleAgents: ['weather'], unrestricted: false },
      });
    });

    it('drops unknown IDs and surfaces them via modelPolicyWarnings', async () => {
      const mockBuilder: IAgentBuilder = {
        enabled: true,
        getFeatures: () => ({ agent: { tools: true } }),
        getConfiguration: () => ({
          agent: {},
          library: { visibleAgents: ['weather', 'ghost'] },
        }),
      };
      const mastra = createMockMastra(
        {
          hasEnabledBuilderConfig: () => true,
          resolveBuilder: vi.fn().mockResolvedValue(mockBuilder),
        },
        { weather: { source: 'code' } },
      );
      const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

      expect(result).toMatchObject({
        library: { visibleAgents: ['weather'], unrestricted: false },
      });
      expect((result as any).modelPolicyWarnings).toHaveLength(1);
      expect((result as any).modelPolicyWarnings[0]).toContain('"ghost"');
    });

    it('matches admin allowlist against agent.id, not the registration map key', async () => {
      // Admins reference agents by their canonical `id` (e.g. 'test-agent'),
      // even when registered under a different map key (e.g. `agents: { testAgent }`).
      const mockBuilder: IAgentBuilder = {
        enabled: true,
        getFeatures: () => ({ agent: { tools: true } }),
        getConfiguration: () => ({
          agent: {},
          library: { visibleAgents: ['test-agent'] },
        }),
      };
      const mastra = createMockMastra(
        {
          hasEnabledBuilderConfig: () => true,
          resolveBuilder: vi.fn().mockResolvedValue(mockBuilder),
        },
        { testAgent: { id: 'test-agent', source: 'code' } },
      );
      const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

      expect(result).toMatchObject({
        library: { visibleAgents: ['test-agent'], unrestricted: false },
      });
      expect((result as any).modelPolicyWarnings).toBeUndefined();
    });

    it('returns empty allowlist (lockdown) when visibleAgents is []', async () => {
      const mockBuilder: IAgentBuilder = {
        enabled: true,
        getFeatures: () => ({ agent: { tools: true } }),
        getConfiguration: () => ({
          agent: {},
          library: { visibleAgents: [] },
        }),
      };
      const mastra = createMockMastra(
        {
          hasEnabledBuilderConfig: () => true,
          resolveBuilder: vi.fn().mockResolvedValue(mockBuilder),
        },
        { weather: { source: 'code' } },
      );
      const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

      expect(result).toMatchObject({
        library: { visibleAgents: [], unrestricted: false },
      });
    });

    it('excludes stored-source agents from registered IDs', async () => {
      const mockBuilder: IAgentBuilder = {
        enabled: true,
        getFeatures: () => ({ agent: { tools: true } }),
        getConfiguration: () => ({
          agent: {},
          library: { visibleAgents: ['stored-only'] },
        }),
      };
      const mastra = createMockMastra(
        {
          hasEnabledBuilderConfig: () => true,
          resolveBuilder: vi.fn().mockResolvedValue(mockBuilder),
        },
        { 'stored-only': { source: 'stored' }, weather: { source: 'code' } },
      );
      const result = await GET_EDITOR_BUILDER_SETTINGS_ROUTE.handler({ mastra } as any);

      expect(result).toMatchObject({
        library: { visibleAgents: [], unrestricted: false },
      });
      expect((result as any).modelPolicyWarnings[0]).toContain('"stored-only"');
    });
  });
});

describe('GET /editor/builder/settings route metadata', () => {
  it('has correct path and method', () => {
    expect(GET_EDITOR_BUILDER_SETTINGS_ROUTE.path).toBe('/editor/builder/settings');
    expect(GET_EDITOR_BUILDER_SETTINGS_ROUTE.method).toBe('GET');
  });

  it('requires agents:read permission', () => {
    expect(GET_EDITOR_BUILDER_SETTINGS_ROUTE.requiresPermission).toBe('agents:read');
  });

  it('requires authentication', () => {
    expect(GET_EDITOR_BUILDER_SETTINGS_ROUTE.requiresAuth).toBe(true);
  });
});
