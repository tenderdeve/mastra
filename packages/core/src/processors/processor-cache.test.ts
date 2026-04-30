import { describe, it, expect, vi } from 'vitest';
import {
  createProcessorCacheKey,
  createProcessorCacheFromServerCache,
  defaultCacheKeyNormalizer,
} from './processor-cache';

describe('createProcessorCacheKey', () => {
  it('should generate deterministic keys for the same input', () => {
    const key1 = createProcessorCacheKey('moderation', 'hello world', { threshold: 0.5 });
    const key2 = createProcessorCacheKey('moderation', 'hello world', { threshold: 0.5 });
    expect(key1).toBe(key2);
  });

  it('should generate different keys for different content', () => {
    const key1 = createProcessorCacheKey('moderation', 'hello world', { threshold: 0.5 });
    const key2 = createProcessorCacheKey('moderation', 'goodbye world', { threshold: 0.5 });
    expect(key1).not.toBe(key2);
  });

  it('should generate different keys for different processor IDs', () => {
    const key1 = createProcessorCacheKey('moderation', 'hello world', { threshold: 0.5 });
    const key2 = createProcessorCacheKey('pii-detector', 'hello world', { threshold: 0.5 });
    expect(key1).not.toBe(key2);
  });

  it('should generate different keys for different config values', () => {
    const key1 = createProcessorCacheKey('moderation', 'hello world', { threshold: 0.5 });
    const key2 = createProcessorCacheKey('moderation', 'hello world', { threshold: 0.8 });
    expect(key1).not.toBe(key2);
  });

  it('should generate consistent keys regardless of config property order', () => {
    const key1 = createProcessorCacheKey('moderation', 'hello world', { threshold: 0.5, categories: ['hate'] });
    const key2 = createProcessorCacheKey('moderation', 'hello world', { categories: ['hate'], threshold: 0.5 });
    expect(key1).toBe(key2);
  });

  it('should include processor ID in the key', () => {
    const key = createProcessorCacheKey('moderation', 'test', {});
    expect(key).toMatch(/^processor:moderation:/);
  });

  it('should work with empty config', () => {
    const key = createProcessorCacheKey('moderation', 'test');
    expect(key).toMatch(/^processor:moderation:/);
  });
});

describe('defaultCacheKeyNormalizer', () => {
  it('should trim leading and trailing whitespace', () => {
    expect(defaultCacheKeyNormalizer('  hello world  ')).toBe('hello world');
  });

  it('should collapse multiple spaces to a single space', () => {
    expect(defaultCacheKeyNormalizer('hello    world')).toBe('hello world');
  });

  it('should collapse tabs and newlines to a single space', () => {
    expect(defaultCacheKeyNormalizer('hello\t\n  world')).toBe('hello world');
  });

  it('should handle already-normalized content', () => {
    expect(defaultCacheKeyNormalizer('hello world')).toBe('hello world');
  });

  it('should preserve case', () => {
    expect(defaultCacheKeyNormalizer('Hello World')).toBe('Hello World');
  });

  it('should produce same cache key for content differing only in whitespace', () => {
    const normalized1 = defaultCacheKeyNormalizer('  hello   world  ');
    const normalized2 = defaultCacheKeyNormalizer('hello world');
    const key1 = createProcessorCacheKey('moderation', normalized1, { threshold: 0.5 });
    const key2 = createProcessorCacheKey('moderation', normalized2, { threshold: 0.5 });
    expect(key1).toBe(key2);
  });
});

describe('createProcessorCacheFromServerCache', () => {
  it('should delegate get() to server cache and cast the result', async () => {
    const mockServerCache = {
      get: vi.fn().mockResolvedValue({ score: 0.9 }),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = createProcessorCacheFromServerCache(mockServerCache as any);
    const result = await adapter.get<{ score: number }>('test-key');

    expect(mockServerCache.get).toHaveBeenCalledWith('test-key');
    expect(result).toEqual({ score: 0.9 });
  });

  it('should return undefined when server cache returns undefined', async () => {
    const mockServerCache = {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = createProcessorCacheFromServerCache(mockServerCache as any);
    const result = await adapter.get<string>('missing-key');

    expect(result).toBeUndefined();
  });

  it('should delegate set() to server cache with ttl converted to ms', async () => {
    const mockServerCache = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = createProcessorCacheFromServerCache(mockServerCache as any);
    await adapter.set('test-key', { data: 'value' }, 3600);

    expect(mockServerCache.set).toHaveBeenCalledWith('test-key', { data: 'value' }, 3600000);
  });

  it('should pass undefined ttlMs when no ttlSeconds provided', async () => {
    const mockServerCache = {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = createProcessorCacheFromServerCache(mockServerCache as any);
    await adapter.set('test-key', 'value');

    expect(mockServerCache.set).toHaveBeenCalledWith('test-key', 'value', undefined);
  });
});
