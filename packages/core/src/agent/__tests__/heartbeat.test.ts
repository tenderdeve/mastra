import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '../agent';
import {
  resolveHeartbeatConfig,
  buildHeartbeatMetadata,
  calculateInitialDelay,
  isHeartbeatAck,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_PROMPT,
} from '../heartbeat';
import {
  getThreadHeartbeatMetadata,
  setThreadHeartbeatMetadata,
} from '../../memory/types';

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('heartbeat helpers', () => {
  describe('resolveHeartbeatConfig', () => {
    it('uses agent defaults when no thread overrides', () => {
      const result = resolveHeartbeatConfig({ intervalMs: 60_000, prompt: 'Check in' });
      expect(result).toEqual({ intervalMs: 60_000, prompt: 'Check in' });
    });

    it('falls back to built-in defaults when agent config is empty', () => {
      const result = resolveHeartbeatConfig({});
      expect(result).toEqual({ intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS, prompt: DEFAULT_HEARTBEAT_PROMPT });
    });

    it('thread overrides take precedence', () => {
      const result = resolveHeartbeatConfig(
        { intervalMs: 60_000, prompt: 'Agent prompt' },
        { intervalMs: 10_000, prompt: 'Thread prompt' },
      );
      expect(result).toEqual({ intervalMs: 10_000, prompt: 'Thread prompt' });
    });

    it('partial thread overrides merge with agent defaults', () => {
      const result = resolveHeartbeatConfig({ intervalMs: 60_000, prompt: 'Agent prompt' }, { intervalMs: 10_000 });
      expect(result).toEqual({ intervalMs: 10_000, prompt: 'Agent prompt' });
    });
  });

  describe('buildHeartbeatMetadata', () => {
    it('builds metadata with enabled: true and no overrides', () => {
      const meta = buildHeartbeatMetadata();
      expect(meta).toEqual({ enabled: true });
    });

    it('only includes explicit thread overrides', () => {
      const meta = buildHeartbeatMetadata({ intervalMs: 60_000, prompt: 'test' });
      expect(meta).toEqual({
        enabled: true,
        intervalMs: 60_000,
        prompt: 'test',
      });
    });

    it('omits undefined overrides', () => {
      const meta = buildHeartbeatMetadata({ intervalMs: 60_000 });
      expect(meta).toEqual({ enabled: true, intervalMs: 60_000 });
      expect(meta).not.toHaveProperty('prompt');
    });

    it('includes lastRunAt when provided', () => {
      const now = new Date().toISOString();
      const meta = buildHeartbeatMetadata({ intervalMs: 60_000 }, now);
      expect(meta.lastRunAt).toBe(now);
    });
  });

  describe('calculateInitialDelay', () => {
    it('returns 0 when no lastRunAt', () => {
      expect(calculateInitialDelay(60_000)).toBe(0);
    });

    it('returns 0 when enough time has elapsed', () => {
      const lastRunAt = new Date(Date.now() - 120_000).toISOString();
      expect(calculateInitialDelay(60_000, lastRunAt)).toBe(0);
    });

    it('returns remaining time when not enough has elapsed', () => {
      const lastRunAt = new Date(Date.now() - 30_000).toISOString();
      const delay = calculateInitialDelay(60_000, lastRunAt);
      // Should be approximately 30_000ms (allow some tolerance for test execution)
      expect(delay).toBeGreaterThan(29_000);
      expect(delay).toBeLessThanOrEqual(30_100);
    });
  });

  describe('isHeartbeatAck', () => {
    it('detects empty response', () => {
      expect(isHeartbeatAck('')).toBe(true);
      expect(isHeartbeatAck('   ')).toBe(true);
    });

    it('detects HEARTBEAT_OK token', () => {
      expect(isHeartbeatAck('HEARTBEAT_OK')).toBe(true);
    });

    it('detects common ack phrases', () => {
      expect(isHeartbeatAck('ok')).toBe(true);
      expect(isHeartbeatAck('nothing')).toBe(true);
      expect(isHeartbeatAck('all good')).toBe(true);
      expect(isHeartbeatAck('no updates')).toBe(true);
      expect(isHeartbeatAck('all clear')).toBe(true);
    });

    it('rejects substantive responses', () => {
      expect(isHeartbeatAck('The server seems to be experiencing issues with high latency.')).toBe(false);
    });

    it('supports custom ack token', () => {
      expect(isHeartbeatAck('ACK', 'ACK')).toBe(true);
      expect(isHeartbeatAck('HEARTBEAT_OK', 'ACK')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Thread metadata helpers
// ---------------------------------------------------------------------------

describe('thread heartbeat metadata', () => {
  it('get returns undefined for empty metadata', () => {
    expect(getThreadHeartbeatMetadata(undefined)).toBeUndefined();
    expect(getThreadHeartbeatMetadata({})).toBeUndefined();
  });

  it('roundtrips through set/get', () => {
    const hb = { enabled: true as const, intervalMs: 60_000, prompt: 'test' };
    const metadata = setThreadHeartbeatMetadata({}, hb);
    expect(getThreadHeartbeatMetadata(metadata)).toEqual(hb);
  });

  it('sets heartbeat_enabled at top level for filtering', () => {
    const hb = { enabled: true as const, intervalMs: 60_000, prompt: 'test' };
    const metadata = setThreadHeartbeatMetadata({}, hb);
    expect(metadata.heartbeat_enabled).toBe(true);
  });

  it('sets heartbeat_enabled to false when disabled', () => {
    const hb = { enabled: false as const };
    const metadata = setThreadHeartbeatMetadata({}, hb);
    expect(metadata.heartbeat_enabled).toBe(false);
  });

  it('preserves existing metadata', () => {
    const existing = { foo: 'bar', mastra: { om: { currentTask: 'test' } } };
    const hb = { enabled: true as const, intervalMs: 60_000, prompt: 'test' };
    const metadata = setThreadHeartbeatMetadata(existing, hb);
    expect(metadata.foo).toBe('bar');
    expect((metadata.mastra as any).om).toEqual({ currentTask: 'test' });
    expect(getThreadHeartbeatMetadata(metadata)).toEqual(hb);
  });
});

// ---------------------------------------------------------------------------
// Agent heartbeat management
// ---------------------------------------------------------------------------

describe('Agent heartbeat management', () => {
  let agent: Agent;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    agent?.stopAllHeartbeats();
    vi.useRealTimers();
  });

  it('getHeartbeatConfig returns undefined when not configured', () => {
    agent = new Agent({
      id: 'test-no-hb',
      name: 'No HB',
      instructions: 'Test',
      model: { provider: 'openai', name: 'gpt-4o' } as any,
    });
    expect(agent.getHeartbeatConfig()).toBeUndefined();
  });

  it('getHeartbeatConfig returns the config when set', () => {
    agent = new Agent({
      id: 'test-hb',
      name: 'HB Agent',
      instructions: 'Test',
      model: { provider: 'openai', name: 'gpt-4o' } as any,
      heartbeat: { intervalMs: 60_000, prompt: 'Check in' },
    });
    expect(agent.getHeartbeatConfig()).toEqual({ intervalMs: 60_000, prompt: 'Check in' });
  });

  it('setHeartbeat throws without heartbeat config on agent', async () => {
    agent = new Agent({
      id: 'test-no-hb',
      name: 'No HB',
      instructions: 'Test',
      model: { provider: 'openai', name: 'gpt-4o' } as any,
    });
    await expect(agent.setHeartbeat({ threadId: 't1' })).rejects.toThrow(
      /no heartbeat config/i,
    );
  });

  it('getHeartbeats returns empty array initially', () => {
    agent = new Agent({
      id: 'test-hb',
      name: 'HB Agent',
      instructions: 'Test',
      model: { provider: 'openai', name: 'gpt-4o' } as any,
      heartbeat: { intervalMs: 60_000 },
    });
    expect(agent.getHeartbeats()).toEqual([]);
  });

  it('stopAllHeartbeats clears timers', () => {
    agent = new Agent({
      id: 'test-hb',
      name: 'HB Agent',
      instructions: 'Test',
      model: { provider: 'openai', name: 'gpt-4o' } as any,
      heartbeat: { intervalMs: 60_000 },
    });
    agent.stopAllHeartbeats();
    expect(agent.getHeartbeats()).toEqual([]);
  });
});
