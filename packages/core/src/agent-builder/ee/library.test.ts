import { describe, it, expect } from 'vitest';
import { resolveLibraryVisibility } from './library';

describe('resolveLibraryVisibility', () => {
  const registeredAgentIds = ['weather', 'support', 'researcher'] as const;

  it('returns unrestricted when config is undefined', () => {
    const result = resolveLibraryVisibility({ config: undefined, registeredAgentIds });
    expect(result).toEqual({ visibleAgents: [], unrestricted: true, warnings: [] });
  });

  it('returns unrestricted when visibleAgents is undefined', () => {
    const result = resolveLibraryVisibility({ config: {}, registeredAgentIds });
    expect(result).toEqual({ visibleAgents: [], unrestricted: true, warnings: [] });
  });

  it('returns empty restricted list when visibleAgents is []', () => {
    const result = resolveLibraryVisibility({ config: { visibleAgents: [] }, registeredAgentIds });
    expect(result).toEqual({ visibleAgents: [], unrestricted: false, warnings: [] });
  });

  it('filters to listed known IDs and preserves admin order', () => {
    const result = resolveLibraryVisibility({
      config: { visibleAgents: ['support', 'weather'] },
      registeredAgentIds,
    });
    expect(result.visibleAgents).toEqual(['support', 'weather']);
    expect(result.unrestricted).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('drops unknown IDs and emits a warning for each', () => {
    const result = resolveLibraryVisibility({
      config: { visibleAgents: ['weather', 'ghost', 'support', 'phantom'] },
      registeredAgentIds,
    });
    expect(result.visibleAgents).toEqual(['weather', 'support']);
    expect(result.unrestricted).toBe(false);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain('"ghost"');
    expect(result.warnings[1]).toContain('"phantom"');
  });

  it('de-duplicates repeated IDs without double-warning', () => {
    const result = resolveLibraryVisibility({
      config: { visibleAgents: ['weather', 'weather', 'ghost', 'ghost'] },
      registeredAgentIds,
    });
    expect(result.visibleAgents).toEqual(['weather']);
    expect(result.warnings).toHaveLength(1);
  });
});
