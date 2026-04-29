import { createHash } from 'node:crypto';

/**
 * Cache interface for processors that use LLM-based detection.
 *
 * Implementations can use any backend (Redis, Memcached, etc.) to cache
 * detection results and avoid redundant LLM calls for identical content.
 *
 * @example
 * ```typescript
 * import { RedisProcessorCache } from '@mastra/redis';
 *
 * const cache = new RedisProcessorCache({
 *   connectionString: 'redis://localhost:6379',
 *   ttlSeconds: 3600,
 *   maxEntries: 10000,
 * });
 *
 * const moderation = new ModerationProcessor({
 *   model: 'openai/gpt-4o-mini',
 *   cache,
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
