import type { BackgroundTaskManager } from '../../background-tasks/manager';
import { MastraWorker } from '../worker';
import type { WorkerDeps } from '../worker';

export interface BackgroundTaskWorkerConfig {
  globalConcurrency?: number;
  perAgentConcurrency?: number;
  backpressure?: 'queue' | 'reject' | 'fallback-sync';
  defaultTimeoutMs?: number;
}

/**
 * Manages background tool execution for agents. Handles task queuing,
 * concurrency limits, and lifecycle. Subscribes to PubSub internally
 * via BackgroundTaskManager's own subscription mechanism.
 */
export class BackgroundTaskWorker extends MastraWorker {
  readonly name = 'backgroundTasks';

  #manager?: BackgroundTaskManager;
  #config: BackgroundTaskWorkerConfig;
  #running = false;

  constructor(config: BackgroundTaskWorkerConfig = {}) {
    super();
    this.#config = config;
  }

  async init(deps: WorkerDeps): Promise<void> {
    await super.init(deps);

    const { BackgroundTaskManager } = await import('../../background-tasks/manager');
    this.#manager = new BackgroundTaskManager({
      enabled: true,
      globalConcurrency: this.#config.globalConcurrency,
      perAgentConcurrency: this.#config.perAgentConcurrency,
      backpressure: this.#config.backpressure,
      defaultTimeoutMs: this.#config.defaultTimeoutMs,
    });

    if (deps.mastra) {
      this.#manager.__registerMastra(deps.mastra);
    }

    await this.#manager.init(deps.pubsub);
    this.#running = true;
  }

  async start(): Promise<void> {
    // Already started during init (manager self-subscribes to PubSub)
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    if (this.#manager) {
      await this.#manager.shutdown();
    }
    this.#running = false;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /** Expose the underlying manager for direct API access. */
  get manager(): BackgroundTaskManager | undefined {
    return this.#manager;
  }
}
