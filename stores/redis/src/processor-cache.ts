import type { ProcessorCache } from '@mastra/core/processors';
import type { RedisClientType } from 'redis';
import { createClient } from 'redis';

/**
 * Configuration for RedisProcessorCache
 */
export interface RedisProcessorCacheConfig {
  /**
   * Pre-configured redis client. If provided, the cache will not manage the connection.
   */
  client?: RedisClientType<Record<string, never>, Record<string, never>, Record<string, never>>;

  /**
   * Redis connection string (used if client is not provided).
   * @example 'redis://localhost:6379'
   */
  connectionString?: string;

  /**
   * Redis host (used if neither client nor connectionString is provided).
   * @default 'localhost'
   */
  host?: string;

  /**
   * Redis port.
   * @default 6379
   */
  port?: number;

  /**
   * Redis password.
   */
  password?: string;

  /**
   * Redis database number.
   * @default 0
   */
  db?: number;

  /**
   * Default TTL for cached entries in seconds.
   * @default 3600 (1 hour)
   */
  ttlSeconds?: number;

  /**
   * Maximum number of entries to keep in the cache.
   * When exceeded, the least recently used entries are evicted.
   * Uses Redis sorted sets for LRU tracking.
   * @default 10000
   */
  maxEntries?: number;

  /**
   * Key prefix for all cache entries.
   * @default 'mastra:processor-cache'
   */
  keyPrefix?: string;
}

const LRU_SET_KEY_SUFFIX = ':lru';

/**
 * Redis-backed processor cache with configurable TTL and LRU eviction.
 *
 * Stores LLM detection results to avoid redundant calls for identical content.
 * Uses Redis sorted sets for LRU tracking when maxEntries is configured.
 *
 * @example
 * ```typescript
 * import { RedisProcessorCache } from '@mastra/redis';
 * import { ModerationProcessor } from '@mastra/core/processors';
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
export class RedisProcessorCache implements ProcessorCache {
  private client: RedisClientType<Record<string, never>, Record<string, never>, Record<string, never>>;
  private shouldManageConnection: boolean;
  private ttlSeconds: number;
  private maxEntries: number;
  private keyPrefix: string;
  private connected = false;

  constructor(config: RedisProcessorCacheConfig) {
    this.ttlSeconds = config.ttlSeconds ?? 3600;
    this.maxEntries = config.maxEntries ?? 10000;
    this.keyPrefix = config.keyPrefix ?? 'mastra:processor-cache';

    if (config.client) {
      this.client = config.client;
      this.shouldManageConnection = false;
    } else if (config.connectionString) {
      this.client = createClient({ url: config.connectionString }) as typeof this.client;
      this.shouldManageConnection = true;
    } else {
      const host = config.host ?? 'localhost';
      const port = config.port ?? 6379;
      const db = config.db ?? 0;
      const password = config.password;
      const url = password
        ? `redis://:${encodeURIComponent(password)}@${host}:${port}/${db}`
        : `redis://${host}:${port}/${db}`;
      this.client = createClient({ url }) as typeof this.client;
      this.shouldManageConnection = true;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.shouldManageConnection && !this.connected && !this.client.isOpen) {
      await this.client.connect();
      this.connected = true;
    }
  }

  private fullKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  private lruKey(): string {
    return `${this.keyPrefix}${LRU_SET_KEY_SUFFIX}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      await this.ensureConnected();
      const fullKey = this.fullKey(key);
      const raw = await this.client.get(fullKey);
      if (raw === null) {
        return undefined;
      }
      // Update LRU score (access time)
      await this.client.zAdd(this.lruKey(), { score: Date.now(), value: fullKey }).catch(() => {});
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      await this.ensureConnected();
      const fullKey = this.fullKey(key);
      const ttl = ttlSeconds ?? this.ttlSeconds;
      await this.client.set(fullKey, JSON.stringify(value), { EX: ttl });
      // Update LRU tracking
      await this.client.zAdd(this.lruKey(), { score: Date.now(), value: fullKey });
      // Evict if over maxEntries
      await this.evictIfNeeded();
    } catch {
      // Cache write failures are non-critical
    }
  }

  private async evictIfNeeded(): Promise<void> {
    try {
      const count = await this.client.zCard(this.lruKey());
      if (count > this.maxEntries) {
        const toEvict = count - this.maxEntries;
        // Get the oldest entries (lowest scores = oldest access times)
        const entries = await this.client.zRange(this.lruKey(), 0, toEvict - 1);
        if (entries.length > 0) {
          // Delete the cache entries
          await this.client.del(entries);
          // Remove from LRU set
          await this.client.zRem(this.lruKey(), entries);
        }
      }
    } catch {
      // Eviction failures are non-critical
    }
  }

  /**
   * Close the Redis connection if managed by this cache instance.
   */
  async close(): Promise<void> {
    if (this.shouldManageConnection && this.client.isOpen) {
      await this.client.quit();
      this.connected = false;
    }
  }
}
