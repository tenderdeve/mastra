import { describe, it, expect } from 'vitest';
import { createProcessorCacheKey } from './processor-cache';

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
