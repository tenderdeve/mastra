import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../agent';
import { InMemoryStore } from '../storage/mock';
import { Harness } from './harness';
import type { HarnessDurableThreadCoordinator, HarnessEvent } from './types';

async function* finishStream() {
  yield {
    type: 'finish',
    runId: 'run-1',
    from: 'AGENT',
    payload: {
      stepResult: { reason: 'stop' },
      output: {},
      metadata: {},
    },
  };
}

function createHarness(coordinator: HarnessDurableThreadCoordinator) {
  const agent = new Agent({
    name: 'test-agent',
    instructions: 'You are a test agent.',
    model: { provider: 'openai', name: 'gpt-4o', toolChoice: 'auto' },
  });

  return new Harness({
    id: 'test-harness',
    storage: new InMemoryStore(),
    durableStreams: { coordinator, attachToActiveThread: true },
    modes: [{ id: 'default', name: 'Default', default: true, agent }],
  });
}

describe('durable thread stream observation', () => {
  it('follows an active durable stream for the current thread through the configured coordinator', async () => {
    const cleanup = vi.fn();
    const coordinator: HarnessDurableThreadCoordinator = {
      observeThread: vi.fn(async () => ({ runId: 'run-1', fullStream: finishStream(), cleanup })),
    };
    const harness = createHarness(coordinator);
    const thread = await harness.createThread();
    const events: HarnessEvent[] = [];
    const ended = new Promise<void>(resolve => {
      harness.subscribe(event => {
        events.push(event);
        if (event.type === 'agent_end') resolve();
      });
    });

    await expect(harness.followActiveThreadRun()).resolves.toBe(true);
    await ended;

    expect(coordinator.observeThread).toHaveBeenCalledWith({
      resourceId: 'test-harness',
      threadId: thread.id,
      abortSignal: expect.any(AbortSignal),
    });
    expect(events.some(event => event.type === 'agent_start')).toBe(true);
    expect(events).toContainEqual({ type: 'agent_end', reason: 'complete' });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
