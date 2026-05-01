import { PubSub } from '@mastra/core/events';
import type { Event, EventCallback, SubscribeOptions } from '@mastra/core/events';

import { UnixSocketDurableRunClient } from './unix-socket-client.js';

export { UnixSocketDurableRunClient } from './unix-socket-client.js';
export { UnixSocketDurableRunCoordinator } from './unix-socket-coordinator.js';

export class UnixSocketPubSub extends PubSub {
  readonly client: UnixSocketDurableRunClient;

  constructor(options: { socketPath: string; clientId?: string; autoStartCoordinator?: boolean }) {
    super();
    this.client = new UnixSocketDurableRunClient(options);
  }

  async publish(topic: string, event: Omit<Event, 'id' | 'createdAt'>): Promise<void> {
    await this.client.connect();
    await this.client.publishTopic(topic, event);
  }

  async subscribe(topic: string, cb: EventCallback, _options?: SubscribeOptions): Promise<void> {
    await this.client.connect();
    await this.client.subscribeTopic(topic, cb);
  }

  async unsubscribe(topic: string, cb: EventCallback): Promise<void> {
    await this.client.unsubscribeTopic(topic, cb);
  }

  async flush(): Promise<void> {}

  async getHistory(topic: string, offset?: number): Promise<Event[]> {
    await this.client.connect();
    return this.client.getTopicHistory(topic, offset);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
