import { createHash } from 'node:crypto';

import type { MastraServerCache } from '../cache';

/**
 * Lightweight cache interface for processors that use LLM-based detection.
 *
 * When `cache: true` is set on an LLM-based processor, the Mastra instance's
 * server cache (MastraServerCache) is automatically adapted to this interface.
 *
 * You can also provide a custom implementation directly.
 *
 * @example
 * ```typescript
 * // Simplest: use the Mastra server cache
 * const moderation = new ModerationProcessor({
 *   model: 'openai/gpt-4o-mini',
 *   cache: true, // uses mastra.getServerCache()
 * });
 *
 * // Custom implementation
 * const moderation = new ModerationProcessor({
 *   model: 'openai/gpt-4o-mini',
 *   cache: myCustomCacheImpl,
 * });
 * ```
 */
export interface ProcessorCache {
  /**
   * Retrieve a cached value by key.
   * @returns The cached value, or undefined if not found or expired.
   */
  get<T>(key: string): Promise<T | undefined>;

  /**
   * Store a value in the cache.
   * @param key - Cache key
   * @param value - Value to cache (must be JSON-serializable)
   * @param ttlSeconds - Optional TTL override in seconds
   */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
}

/**
 * Generate a deterministic cache key for a processor detection call.
 *
 * The key incorporates:
 * - The processor ID (e.g., 'moderation', 'pii-detector')
 * - A hash of the content being analyzed
 * - A hash of the processor config that affects detection results
 *
 * This ensures cache invalidation when processor settings change.
 */
export function createProcessorCacheKey(
  processorId: string,
  content: string,
  configValues: Record<string, unknown> = {},
): string {
  const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const configHash = createHash('sha256')
    .update(JSON.stringify(configValues, Object.keys(configValues).sort()))
    .digest('hex')
    .slice(0, 8);
  return `processor:${processorId}:${configHash}:${contentHash}`;
}

/**
 * Create a ProcessorCache adapter from a MastraServerCache instance.
 * This bridges the generic server cache to the processor-specific cache interface.
 */
export function createProcessorCacheFromServerCache(serverCache: MastraServerCache): ProcessorCache {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const value = await serverCache.get(key);
      return value as T | undefined;
    },
    async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      await serverCache.set(key, value, ttlSeconds !== undefined ? ttlSeconds * 1000 : undefined);
    },
  };
}
