import type { PubSub } from '../../events/pubsub';
import type { EventCallback } from '../../events/types';
import type { EventRouter, WorkerTransport } from './transport';

const TOPIC_WORKFLOWS = 'workflows';

export class PullTransport implements WorkerTransport {
  #pubsub: PubSub;
  #group: string;
  #callbacks: Array<{ topic: string; cb: EventCallback }> = [];

  constructor({ pubsub, group }: { pubsub: PubSub; group: string }) {
    this.#pubsub = pubsub;
    this.#group = group;
  }

  async start(router: EventRouter): Promise<void> {
    const workflowCb: EventCallback = (event, ack, nack) => {
      void router.route(event, ack, nack);
    };
    await this.#pubsub.subscribe(TOPIC_WORKFLOWS, workflowCb, { group: this.#group });
    this.#callbacks.push({ topic: TOPIC_WORKFLOWS, cb: workflowCb });
  }

  async stop(): Promise<void> {
    for (const { topic, cb } of this.#callbacks) {
      await this.#pubsub.unsubscribe(topic, cb);
    }
    this.#callbacks = [];
    await this.#pubsub.flush();
  }
}
