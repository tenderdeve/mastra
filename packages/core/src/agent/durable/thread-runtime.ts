import { randomUUID } from 'node:crypto';

import type { DurableAgentSignal, SendDurableAgentSignalOptions } from './types';
import type { UnixSocketDurableRunClient } from './unix-socket-client';

export type DurableThreadRuntimeCompletion = 'complete' | 'suspended' | 'aborted' | 'error';

export interface DurableThreadRuntimeAgent {
  sendSignal(signal: DurableAgentSignal, target: SendDurableAgentSignalOptions): { accepted: true; runId: string };
}

export interface DurableThreadRuntimeOptions {
  agent: DurableThreadRuntimeAgent;
  client: UnixSocketDurableRunClient;
  resourceId: string;
  threadId: string;
  runIdFactory?: () => string;
}

export interface DurableThreadSignalInput {
  signal: DurableAgentSignal;
  streamOptions?: Record<string, unknown>;
  renderSignalEvent?: unknown;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
}

export interface DurableThreadObservationInput {
  abortSignal?: AbortSignal;
}

export interface ObservedDurableThreadRun {
  runId: string;
  fullStream: AsyncIterable<any>;
  cleanup: () => void;
  completion: Promise<DurableThreadRuntimeCompletion>;
}

export interface DurableThreadSignalResult {
  runId: string;
  observed?: ObservedDurableThreadRun;
}

export class DurableThreadRuntime {
  readonly #agent: DurableThreadRuntimeAgent;
  readonly #client: UnixSocketDurableRunClient;
  readonly #resourceId: string;
  readonly #threadId: string;
  readonly #runIdFactory: () => string;
  readonly #ownedRunIds = new Set<string>();

  constructor(options: DurableThreadRuntimeOptions) {
    this.#agent = options.agent;
    this.#client = options.client;
    this.#resourceId = options.resourceId;
    this.#threadId = options.threadId;
    this.#runIdFactory = options.runIdFactory ?? randomUUID;
  }

  async sendSignalAndObserve(input: DurableThreadSignalInput): Promise<DurableThreadSignalResult> {
    const activeRun = await this.#getActiveRun();
    if (activeRun) {
      if (await this.#sendSignalToExistingRun(activeRun, input)) {
        return { runId: activeRun.runId };
      }
      return this.sendSignalAndObserve(input);
    }

    const runId = this.#runIdFactory();
    const claim = await this.#client.claimThread({
      resourceId: this.#resourceId,
      threadId: this.#threadId,
      runId,
    });

    if (!claim.claimed) {
      if (await this.#sendSignalToExistingRun(claim.activeRun, input)) {
        return { runId: claim.activeRun.runId };
      }
      return this.sendSignalAndObserve(input);
    }

    this.#ownedRunIds.add(runId);

    let terminalError: Error | undefined;
    let sawSuspended = false;
    const publishChunk = (chunk: unknown) => this.#client.publishRunEvent(runId, chunk).catch(() => undefined);
    const signalStreamOptions = {
      ...input.streamOptions,
      runId,
      onChunk: publishChunk,
      onFinish: async (result: any) => {
        await publishChunk({
          type: 'finish',
          payload: {
            output: result.output,
            stepResult: result.stepResult,
          },
        });
      },
      onError: async (error: Error) => {
        terminalError = error;
        await publishChunk({
          type: 'error',
          payload: { error: { name: error.name, message: error.message, stack: error.stack } },
        });
      },
      onSuspended: async () => {
        sawSuspended = true;
      },
    };

    let startedRun = false;
    let stopSignalHandler: (() => void) | undefined;
    let stopAbortHandler: (() => void) | undefined;
    const ownedCleanup = () => {
      stopSignalHandler?.();
      stopAbortHandler?.();
      this.#ownedRunIds.delete(runId);
    };

    stopSignalHandler = await this.#client.onSignal(runId, signal => {
      const target = startedRun
        ? { runId }
        : {
            runId,
            resourceId: this.#resourceId,
            threadId: this.#threadId,
            streamOptions: signalStreamOptions,
          };
      startedRun = true;
      this.#agent.sendSignal(signal as DurableAgentSignal, target);
    });

    stopAbortHandler = await this.#client.subscribeRun(runId, event => {
      const error = (event as any)?.payload?.error;
      if ((event as any)?.type === 'error' && error?.name === 'AbortError') {
        input.onAbort?.();
      }
    });

    const observed = await this.#observeRun(runId, {
      abortSignal: input.abortSignal,
      owned: true,
      cleanup: ownedCleanup,
      getCompletionHint: () => {
        if (sawSuspended) return 'suspended';
        if (terminalError?.name === 'AbortError') return 'aborted';
        if (terminalError) return 'error';
        return undefined;
      },
    });

    await this.#publishRenderSignal(runId, input.renderSignalEvent);
    await this.#client.sendSignal(input.signal, { runId });
    return { runId, observed };
  }

  async observeThread(input: DurableThreadObservationInput = {}): Promise<ObservedDurableThreadRun | undefined> {
    const activeRun = await this.#getActiveRun();
    if (!activeRun) return undefined;
    return this.#observeRun(activeRun.runId, { abortSignal: input.abortSignal });
  }

  async abortThread(reason = 'Durable run aborted'): Promise<void> {
    const activeRun = await this.#getActiveRun();
    if (!activeRun) return;
    await this.#client.abortRun(activeRun.runId, reason).catch(() => undefined);
  }

  async abortRun(runId: string, reason = 'Durable run aborted'): Promise<void> {
    await this.#client.abortRun(runId, reason).catch(() => undefined);
  }

  async #getActiveRun() {
    return this.#client.getActiveRun({ resourceId: this.#resourceId, threadId: this.#threadId });
  }

  async #sendSignalToExistingRun(
    run: { runId: string; ownerId?: string },
    input: DurableThreadSignalInput,
  ): Promise<boolean> {
    try {
      await this.#client.sendSignal(input.signal, { runId: run.runId });
      return true;
    } catch (error) {
      if (
        run.ownerId === this.#client.clientId &&
        error instanceof Error &&
        error.message.includes('No signal handler')
      ) {
        await this.#client.failRun(run.runId).catch(() => undefined);
        return false;
      }
      throw error;
    }
  }

  async #publishRenderSignal(runId: string, event: unknown): Promise<void> {
    if (!event) return;
    await this.#client.publishRunEvent(runId, event).catch(() => undefined);
  }

  async #observeRun(
    runId: string,
    options: {
      abortSignal?: AbortSignal;
      owned?: boolean;
      cleanup?: () => void;
      getCompletionHint?: () => DurableThreadRuntimeCompletion | undefined;
    } = {},
  ): Promise<ObservedDurableThreadRun> {
    const raw = this.#createRunEventStream(runId, options.abortSignal);
    await raw.ready;

    let resolveCompletion!: (completion: DurableThreadRuntimeCompletion) => void;
    const completion = new Promise<DurableThreadRuntimeCompletion>(resolve => {
      resolveCompletion = resolve;
    });

    let settled = false;
    const settle = async (completion: DurableThreadRuntimeCompletion) => {
      if (settled) return;
      settled = true;
      if (options.owned) {
        await this.#setRunCompletion(runId, completion);
      }
      options.cleanup?.();
      resolveCompletion(completion);
    };

    const fullStream = this.#monitorRunStream(raw.fullStream, {
      abortSignal: options.abortSignal,
      getCompletionHint: options.getCompletionHint,
      settle,
    });

    return {
      runId,
      fullStream,
      cleanup: () => {
        raw.cleanup();
        options.cleanup?.();
      },
      completion,
    };
  }

  async *#monitorRunStream(
    fullStream: AsyncIterable<any>,
    options: {
      abortSignal?: AbortSignal;
      getCompletionHint?: () => DurableThreadRuntimeCompletion | undefined;
      settle: (completion: DurableThreadRuntimeCompletion) => Promise<void>;
    },
  ): AsyncIterable<any> {
    let completion: DurableThreadRuntimeCompletion | undefined;
    try {
      for await (const chunk of fullStream) {
        completion = this.#completionFromChunk(chunk) ?? completion;
        yield chunk;
      }
      completion ??= options.getCompletionHint?.();
      if (!completion && options.abortSignal?.aborted) completion = 'aborted';
      completion ??= 'complete';
      await options.settle(completion);
    } catch (error) {
      completion = error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'error';
      await options.settle(completion);
      throw error;
    }
  }

  #completionFromChunk(chunk: any): DurableThreadRuntimeCompletion | undefined {
    if (chunk?.type === 'finish') return 'complete';
    if (chunk?.type === 'tool-call-suspended' || chunk?.type === 'suspended') return 'suspended';
    if (chunk?.type !== 'error') return undefined;
    const error = chunk.payload?.error;
    return error?.name === 'AbortError' ? 'aborted' : 'error';
  }

  async #setRunCompletion(runId: string, completion: DurableThreadRuntimeCompletion): Promise<void> {
    switch (completion) {
      case 'suspended':
        await this.#client.suspendRun(runId).catch(() => undefined);
        break;
      case 'aborted':
        await this.#client.abortRun(runId).catch(() => undefined);
        break;
      case 'error':
        await this.#client.failRun(runId).catch(() => undefined);
        break;
      case 'complete':
        await this.#client.completeRun(runId).catch(() => undefined);
        break;
    }
  }

  #createRunEventStream(
    runId: string,
    abortSignal?: AbortSignal,
  ): {
    fullStream: AsyncIterable<any>;
    ready: Promise<void>;
    cleanup: () => void;
  } {
    const queue: any[] = [];
    let notify: (() => void) | undefined;
    let done = false;
    let unsubscribe: (() => void) | undefined;
    let removeAbortListener: (() => void) | undefined;

    const cleanup = () => {
      done = true;
      unsubscribe?.();
      removeAbortListener?.();
      notify?.();
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        done = true;
      } else {
        const onAbort = () => {
          queue.push({ type: 'error', payload: { error: { name: 'AbortError', message: 'aborted' } } });
          cleanup();
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => abortSignal.removeEventListener('abort', onAbort);
      }
    }

    const fullStream = (async function* () {
      try {
        while (!done || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>(resolve => {
              notify = resolve;
            });
            notify = undefined;
            continue;
          }
          const chunk = queue.shift();
          if (chunk) yield chunk;
        }
      } finally {
        cleanup();
      }
    })();

    const ready = this.#client
      .subscribeRun(runId, event => {
        queue.push(event);
        if ((event as any)?.type === 'finish' || (event as any)?.type === 'error') {
          done = true;
        }
        notify?.();
      })
      .then(fn => {
        unsubscribe = fn;
      });

    return { fullStream, ready, cleanup };
  }
}
