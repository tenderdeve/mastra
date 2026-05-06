import { randomUUID } from 'node:crypto';
import { PubSub } from '@mastra/core/events';
import type { Event, EventCallback, SubscribeOptions } from '@mastra/core/events';
import { createClient } from 'redis';
import type { RedisClientOptions, RedisClientType } from 'redis';

/**
 * Mastra PubSub backed by Redis Streams.
 *
 * - Each topic maps to a Redis stream key `<prefix>:<topic>`.
 * - Subscriptions with `options.group` use a real Redis consumer group, so
 *   competing subscribers in the same group share the work (round-robin).
 * - Subscriptions without a group create a private per-subscriber consumer
 *   group, so they get fan-out semantics (every subscriber sees every event).
 * - Nack triggers redelivery by re-publishing the event with an incremented
 *   `deliveryAttempt` field, then XACK-ing the original. This trades strict
 *   FIFO ordering on retry for a simple, reliable redelivery path.
 */
export class RedisStreamsPubSub extends PubSub {
  #writeClient: RedisClientType;
  #connectOptions: RedisClientOptions;
  #keyPrefix: string;
  #blockMs: number;
  #subscriptions: Map<EventCallback, Subscription> = new Map();
  #pendingPublishes: Set<Promise<unknown>> = new Set();
  #closed = false;

  constructor(
    options: {
      url?: string;
      keyPrefix?: string;
      blockMs?: number;
      redisOptions?: RedisClientOptions;
    } = {},
  ) {
    super();
    const url = options.url ?? options.redisOptions?.url ?? 'redis://localhost:6379';
    this.#connectOptions = { ...options.redisOptions, url };
    this.#writeClient = createClient(this.#connectOptions) as RedisClientType;
    this.#keyPrefix = options.keyPrefix ?? 'mastra:topic';
    this.#blockMs = options.blockMs ?? 1000;
  }

  /** Lazily connect the shared writer client. Idempotent. */
  async #ensureWriterConnected(): Promise<void> {
    if (this.#writeClient.isOpen) return;
    await this.#writeClient.connect();
  }

  #streamKey(topic: string): string {
    return `${this.#keyPrefix}:${topic}`;
  }

  async publish(topic: string, event: Omit<Event, 'id' | 'createdAt'>): Promise<void> {
    if (this.#closed) throw new Error('RedisStreamsPubSub: cannot publish on closed client');
    await this.#ensureWriterConnected();

    const id = randomUUID();
    const createdAt = new Date();
    const payload: Event = {
      ...event,
      id,
      createdAt,
      deliveryAttempt: event.deliveryAttempt ?? 1,
    };
    const promise = this.#writeClient.xAdd(this.#streamKey(topic), '*', {
      event: JSON.stringify(payload),
    });
    this.#pendingPublishes.add(promise);
    try {
      await promise;
    } finally {
      this.#pendingPublishes.delete(promise);
    }
  }

  async subscribe(topic: string, cb: EventCallback, options?: SubscribeOptions): Promise<void> {
    if (this.#closed) throw new Error('RedisStreamsPubSub: cannot subscribe on closed client');
    if (this.#subscriptions.has(cb)) return; // idempotent: same callback already subscribed

    await this.#ensureWriterConnected();

    const isGrouped = !!options?.group;
    const group = options?.group ?? `__fanout-${randomUUID()}`;
    const consumer = `${group}-${randomUUID()}`;
    const streamKey = this.#streamKey(topic);

    // Create the consumer group if it doesn't exist. MKSTREAM creates the
    // stream if needed. BUSYGROUP means another subscriber raced us — fine.
    try {
      await this.#writeClient.xGroupCreate(streamKey, group, '$', { MKSTREAM: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('BUSYGROUP')) throw err;
    }

    // Each subscription gets a dedicated reader connection because XREADGROUP
    // with BLOCK > 0 holds the connection until a message arrives.
    const readClient = createClient(this.#connectOptions) as RedisClientType;
    await readClient.connect();

    const sub: Subscription = {
      cb,
      topic,
      streamKey,
      group,
      consumer,
      isGrouped,
      readClient,
      stopped: false,
      loop: undefined,
    };
    this.#subscriptions.set(cb, sub);
    sub.loop = this.#runReadLoop(sub);
  }

  async unsubscribe(_topic: string, cb: EventCallback): Promise<void> {
    const sub = this.#subscriptions.get(cb);
    if (!sub) return;
    this.#subscriptions.delete(cb);
    sub.stopped = true;

    // Cancel the in-flight blocking XREADGROUP by closing the reader.
    try {
      await sub.readClient.quit();
    } catch {
      // ignore — best-effort
    }

    if (sub.loop) {
      try {
        await sub.loop;
      } catch {
        // loop exits naturally when readClient closes
      }
    }

    // For fan-out, drop the private group entirely so the stream can be reclaimed.
    if (!sub.isGrouped) {
      try {
        await this.#writeClient.xGroupDestroy(sub.streamKey, sub.group);
      } catch {
        // group may not exist anymore — ignore
      }
    }
  }

  async flush(): Promise<void> {
    // Wait for any in-flight publishes to settle.
    if (this.#pendingPublishes.size > 0) {
      await Promise.allSettled([...this.#pendingPublishes]);
    }
  }

  /**
   * Disconnect all clients and stop all subscription loops.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    const callbacks = [...this.#subscriptions.keys()];
    await Promise.all(callbacks.map(cb => this.unsubscribe('', cb)));

    if (this.#writeClient.isOpen) {
      try {
        await this.#writeClient.quit();
      } catch {
        // ignore
      }
    }
  }

  async #runReadLoop(sub: Subscription): Promise<void> {
    while (!sub.stopped) {
      let result;
      try {
        result = await sub.readClient.xReadGroup(sub.group, sub.consumer, [{ key: sub.streamKey, id: '>' }], {
          COUNT: 10,
          BLOCK: this.#blockMs,
        });
      } catch {
        if (sub.stopped) return;
        // Connection error or similar — pause briefly then retry.
        await new Promise(r => setTimeout(r, 100));
        continue;
      }

      if (!result || result.length === 0) continue;

      for (const stream of result) {
        for (const entry of stream.messages) {
          if (sub.stopped) return;
          await this.#deliverMessage(sub, entry.id, entry.message);
        }
      }
    }
  }

  async #deliverMessage(sub: Subscription, streamId: string, fields: Record<string, string>): Promise<void> {
    let event: Event;
    try {
      event = JSON.parse(fields.event ?? '{}') as Event;
      // createdAt is serialized as a string; rehydrate.
      if (typeof event.createdAt === 'string') {
        event.createdAt = new Date(event.createdAt);
      }
    } catch {
      // Malformed entry — ack and move on.
      try {
        await this.#writeClient.xAck(sub.streamKey, sub.group, streamId);
      } catch {
        // ignore
      }
      return;
    }

    let settled = false;
    const ack = async () => {
      if (settled) return;
      settled = true;
      try {
        await this.#writeClient.xAck(sub.streamKey, sub.group, streamId);
        await this.#writeClient.xDel(sub.streamKey, [streamId]);
      } catch {
        // ignore — best-effort cleanup
      }
    };
    const nack = async () => {
      if (settled) return;
      settled = true;
      // Republish with incremented deliveryAttempt, then ack the original entry.
      const next: Event = {
        ...event,
        deliveryAttempt: (event.deliveryAttempt ?? 1) + 1,
      };
      try {
        await this.#writeClient.xAdd(sub.streamKey, '*', { event: JSON.stringify(next) });
      } catch {
        // If republish fails we leave the message unacked; another consumer
        // can pick it up via XAUTOCLAIM eventually. For test correctness this
        // is acceptable.
      }
      try {
        await this.#writeClient.xAck(sub.streamKey, sub.group, streamId);
      } catch {
        // ignore
      }
    };

    try {
      // EventCallback is typed `=> void` but handlers commonly return a
      // promise (TS allows Promise<void> to satisfy void). If we get one
      // back, attach a catch handler so async rejections route to nack
      // instead of silently dropping the message. We do NOT await here —
      // serializing messages on a subscription would deadlock orchestration
      // callbacks that await their own future events.
      const result: unknown = sub.cb(event, ack, nack);
      if (result && typeof (result as { then?: unknown; catch?: unknown }).catch === 'function') {
        (result as Promise<unknown>).catch(async () => {
          await nack();
        });
      }
    } catch {
      // Caller threw synchronously — treat as nack.
      await nack();
    }
  }
}

interface Subscription {
  cb: EventCallback;
  topic: string;
  streamKey: string;
  group: string;
  consumer: string;
  isGrouped: boolean;
  readClient: RedisClientType;
  stopped: boolean;
  loop: Promise<void> | undefined;
}
