import type { HarnessDurableThreadCoordinator, HarnessDurableThreadObservation } from '@mastra/core/harness';

import { UnixSocketDurableRunClient } from './unix-socket-client.js';

export { UnixSocketDurableRunClient } from './unix-socket-client.js';
export { UnixSocketDurableRunCoordinator } from './unix-socket-coordinator.js';

function createRunEventStream(options: {
  client: UnixSocketDurableRunClient;
  runId: string;
  abortSignal?: AbortSignal;
}): HarnessDurableThreadObservation {
  const queue: unknown[] = [];
  const waiters: Array<() => void> = [];
  let done = false;
  let cleanupSubscription: (() => void) | undefined;

  const wake = () => {
    while (waiters.length) waiters.shift()?.();
  };
  const finish = () => {
    done = true;
    wake();
  };

  void options.client.subscribeRun(options.runId, event => {
    queue.push(event);
    const type = typeof event === 'object' && event !== null ? (event as { type?: string }).type : undefined;
    if (type === 'finish' || type === 'error' || type === 'suspended') {
      done = true;
    }
    wake();
  }).then(cleanup => {
    cleanupSubscription = cleanup;
    if (done) cleanupSubscription();
  });

  const onAbort = () => finish();
  options.abortSignal?.addEventListener('abort', onAbort, { once: true });

  return {
    runId: options.runId,
    cleanup: () => {
      finish();
      cleanupSubscription?.();
      options.abortSignal?.removeEventListener('abort', onAbort);
    },
    fullStream: (async function* () {
      try {
        while (!done || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>(resolve => waiters.push(resolve));
            continue;
          }
          yield queue.shift();
        }
      } finally {
        cleanupSubscription?.();
        options.abortSignal?.removeEventListener('abort', onAbort);
      }
    })(),
  };
}

export class UnixSocketDurableThreadCoordinator implements HarnessDurableThreadCoordinator {
  readonly client: UnixSocketDurableRunClient;

  constructor(options: { socketPath: string; clientId?: string; autoStartCoordinator?: boolean }) {
    this.client = new UnixSocketDurableRunClient(options);
  }

  async observeThread(input: {
    resourceId: string;
    threadId: string;
    abortSignal?: AbortSignal;
  }): Promise<HarnessDurableThreadObservation | undefined> {
    await this.client.connect();
    const activeRun = await this.client.getActiveRun({ resourceId: input.resourceId, threadId: input.threadId });
    if (!activeRun || activeRun.status !== 'active') return undefined;
    return createRunEventStream({ client: this.client, runId: activeRun.runId, abortSignal: input.abortSignal });
  }

  async sendSignal(input: {
    resourceId: string;
    threadId: string;
    runId?: string;
    signal: { type: string; contents: string; id?: string; metadata?: Record<string, unknown> };
  }): Promise<{ accepted: true; runId: string }> {
    await this.client.connect();
    const runId = input.runId ?? (await this.client.getActiveRun({ resourceId: input.resourceId, threadId: input.threadId }))?.runId;
    if (!runId) throw new Error('No active durable run found for signal target');
    return this.client.sendSignal(input.signal, { runId });
  }
}
