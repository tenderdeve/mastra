import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventEmitterPubSub } from '../../../events/event-emitter';
import { AGENT_STREAM_TOPIC, AgentStreamEventTypes } from '../constants';
import { GLOBAL_RUN_REGISTRY_TTL_MS, globalRunRegistry } from '../run-registry';
import type { RunRegistryEntry } from '../types';

function createEntry(options: { cleanup?: () => void; pubsub?: EventEmitterPubSub } = {}): RunRegistryEntry {
  return {
    tools: {},
    model: {} as RunRegistryEntry['model'],
    cleanup: options.cleanup ?? vi.fn(),
    pubsub: options.pubsub,
  };
}

describe('globalRunRegistry', () => {
  beforeEach(() => {
    globalRunRegistry.clear();
  });

  afterEach(() => {
    globalRunRegistry.clear();
  });

  it('keeps entries alive for two hours and refreshes TTL when accessed', () => {
    const entry = createEntry();

    globalRunRegistry.set('run-1', entry);

    expect(globalRunRegistry.getRemainingTTL('run-1')).toBeGreaterThan(GLOBAL_RUN_REGISTRY_TTL_MS - 1000);
    expect(globalRunRegistry.get('run-1')).toBe(entry);
    expect(globalRunRegistry.getRemainingTTL('run-1')).toBeGreaterThan(GLOBAL_RUN_REGISTRY_TTL_MS - 1000);
  });

  it('does not crash if dispose receives a missing entry', () => {
    const cleanup = vi.fn();
    globalRunRegistry.set('run-1', createEntry({ cleanup }));
    (globalRunRegistry as any).data.delete('run-1');

    expect(() => globalRunRegistry.delete('run-1')).not.toThrow();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('publishes an abort when a registry entry expires', async () => {
    const pubsub = new EventEmitterPubSub();
    const cleanup = vi.fn();
    const events: any[] = [];
    await pubsub.subscribe(AGENT_STREAM_TOPIC('run-1'), event => {
      events.push(event);
    });

    globalRunRegistry.set('run-1', createEntry({ cleanup, pubsub }), { ttl: 1 });
    await new Promise(resolve => setTimeout(resolve, 10));
    globalRunRegistry.purgeStale();

    expect(events).toMatchObject([
      {
        type: AgentStreamEventTypes.ERROR,
        runId: 'run-1',
        data: {
          error: {
            name: 'AbortError',
          },
        },
      },
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
    await pubsub.close();
  });
});
