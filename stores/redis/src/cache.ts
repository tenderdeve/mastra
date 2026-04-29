import { MastraServerCache } from '@mastra/core/cache';
import type { RedisClientType } from 'redis';
import { createClient } from 'redis';

/**
 * Configuration for RedisServerCache
 */
export interface RedisServerCacheConfig {
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
   * Default TTL for cached entries in milliseconds.
   * @default 300000 (5 minutes, matching InMemoryServerCache default)
   */
  defaultTtlMs?: number;

  /**
   * Maximum number of key-value entries to keep in the cache.
   * When exceeded, the least recently used entries are evicted.
   * Uses Redis sorted sets for LRU tracking.
   * Set to 0 to disable LRU eviction (rely on Redis TTL only).
   * @default 10000
   */
  maxEntries?: number;

  /**
   * Key prefix for all cache entries.
   * @default 'mastra:cache'
   */
  keyPrefix?: string;
}

type RedisClient = RedisClientType<Record<string, never>, Record<string, never>, Record<string, never>>;

const LRU_SET_KEY_SUFFIX = ':lru';

/**
 * Redis-backed server cache with configurable TTL and LRU eviction.
 *
 * Drop-in replacement for InMemoryServerCache that provides distributed caching.
 * Used by the Mastra instance for workflow stream buffering, processor detection
 * result caching, and any other temporary data.
 *
 * @example
 * ```typescript
 * import { Mastra } from '@mastra/core';
 * import { RedisServerCache } from '@mastra/redis';
 *
 * const mastra = new Mastra({
 *   cache: new RedisServerCache({
 *     connectionString: 'redis://localhost:6379',
 *     defaultTtlMs: 3600000, // 1 hour
 *     maxEntries: 10000,
 *   }),
 * });
 * ```
 */
export class RedisServerCache extends MastraServerCache {
  private client: RedisClient;
  private shouldManageConnection: boolean;
  private defaultTtlMs: number;
  private maxEntries: number;
  private keyPrefix: string;
  private connected = false;

  constructor(config: RedisServerCacheConfig) {
    super({ name: 'RedisServerCache' });
    this.defaultTtlMs = config.defaultTtlMs ?? 300_000;
    this.maxEntries = config.maxEntries ?? 10_000;
    this.keyPrefix = config.keyPrefix ?? 'mastra:cache';

    if (config.client) {
      this.client = config.client;
      this.shouldManageConnection = false;
    } else if (config.connectionString) {
      this.client = createClient({ url: config.connectionString }) as RedisClient;
      this.shouldManageConnection = true;
    } else {
      const host = config.host ?? 'localhost';
      const port = config.port ?? 6379;
      const db = config.db ?? 0;
      const password = config.password;
      const url = password
        ? `redis://:${encodeURIComponent(password)}@${host}:${port}/${db}`
        : `redis://${host}:${port}/${db}`;
      this.client = createClient({ url }) as RedisClient;
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

  /**
   * Get the underlying Redis client for advanced use or sharing with RedisStore.
   */
  getClient(): RedisClient {
    return this.client;
  }

  async get(key: string): Promise<unknown> {
    try {
      await this.ensureConnected();
      const fk = this.fullKey(key);
      const raw = await this.client.get(fk);
      if (raw === null) {
        return undefined;
      }
      if (this.maxEntries > 0) {
        await this.client.zAdd(this.lruKey(), { score: Date.now(), value: fk }).catch(() => {});
      }
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    try {
      await this.ensureConnected();
      const fk = this.fullKey(key);
      const ttl = ttlMs ?? this.defaultTtlMs;
      const ttlSeconds = Math.max(1, Math.ceil(ttl / 1000));
      await this.client.set(fk, JSON.stringify(value), { EX: ttlSeconds });
      if (this.maxEntries > 0) {
        await this.client.zAdd(this.lruKey(), { score: Date.now(), value: fk });
        await this.evictIfNeeded();
      }
    } catch {
      // Cache write failures are non-critical
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.ensureConnected();
      const fk = this.fullKey(key);
      await this.client.del(fk);
      if (this.maxEntries > 0) {
        await this.client.zRem(this.lruKey(), fk);
      }
    } catch {
      // Non-critical
    }
  }

  async clear(): Promise<void> {
    try {
      await this.ensureConnected();
      // Scan for all keys with our prefix and delete them
      const pattern = `${this.keyPrefix}:*`;
      let cursor = '0';
      do {
        const result = await this.client.scan(cursor, { MATCH: pattern, COUNT: 100 });
        cursor = result.cursor;
        if (result.keys.length > 0) {
          await this.client.del(result.keys);
        }
      } while (cursor !== '0');
      // Also clear the LRU tracking set
      await this.client.del(this.lruKey());
    } catch {
      // Non-critical
    }
  }

  async listPush(key: string, value: unknown): Promise<void> {
    try {
      await this.ensureConnected();
      const fk = this.fullKey(key);
      await this.client.rPush(fk, JSON.stringify(value));
    } catch {
      // Non-critical
    }
  }

  async listLength(key: string): Promise<number> {
    await this.ensureConnected();
    const fk = this.fullKey(key);
    return this.client.lLen(fk);
  }

  async listFromTo(key: string, from: number, to: number = -1): Promise<unknown[]> {
    try {
      await this.ensureConnected();
      const fk = this.fullKey(key);
      const items = await this.client.lRange(fk, from, to);
      return items.map(item => {
        try {
          return JSON.parse(item);
        } catch {
          return item;
        }
      });
    } catch {
      return [];
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

  private async evictIfNeeded(): Promise<void> {
    try {
      const count = await this.client.zCard(this.lruKey());
      if (count > this.maxEntries) {
        const toEvict = count - this.maxEntries;
        const entries = await this.client.zRange(this.lruKey(), 0, toEvict - 1);
        if (entries.length > 0) {
          await this.client.del(entries);
          await this.client.zRem(this.lruKey(), entries);
        }
      }
    } catch {
      // Eviction failures are non-critical
    }
  }
}
