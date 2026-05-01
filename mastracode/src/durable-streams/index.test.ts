import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UnixSocketPubSub } from './index.js';

const clients: UnixSocketPubSub[] = [];

function createClient(socketPath: string) {
  const client = new UnixSocketPubSub({ socketPath, autoStartCoordinator: true });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined)));
});

describe('UnixSocketPubSub', () => {
  it('publishes events between processes over the socket', async () => {
    const socketPath = path.join(os.tmpdir(), `mastracode-pubsub-${randomUUID()}.sock`);
    const publisher = createClient(socketPath);
    const subscriber = createClient(socketPath);

    const received = new Promise<any>(resolve => {
      void subscriber.subscribe('durable:test', event => resolve(event));
    });

    await publisher.publish('durable:test', { type: 'message', runId: 'run-1', data: { value: 1 } });

    await expect(received).resolves.toMatchObject({
      type: 'message',
      runId: 'run-1',
      data: { value: 1 },
    });
  });

  it('returns topic history for late subscribers', async () => {
    const socketPath = path.join(os.tmpdir(), `mastracode-pubsub-${randomUUID()}.sock`);
    const publisher = createClient(socketPath);
    const subscriber = createClient(socketPath);

    await publisher.publish('durable:history', { type: 'message', runId: 'run-1', data: { value: 1 } });
    await publisher.publish('durable:history', { type: 'message', runId: 'run-2', data: { value: 2 } });

    await expect(subscriber.getHistory('durable:history', 1)).resolves.toMatchObject([
      { type: 'message', runId: 'run-2', data: { value: 2 } },
    ]);
  });
});
