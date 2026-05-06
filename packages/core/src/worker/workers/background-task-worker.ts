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
      this.#wireStaticTools(deps.mastra);
    }

    await this.#manager.init(deps.pubsub);
    this.#running = true;
  }

  /**
   * Populate the manager's static executor registry from tools registered
   * on `Mastra`, so that cross-process dispatches can be resolved by tool
   * name on this worker. Mirrors the wiring Mastra does for its own
   * managed background-task manager — the worker owns a separate manager
   * instance, so it has to populate its own registry.
   */
  #wireStaticTools(mastra: NonNullable<WorkerDeps['mastra']>): void {
    const tools = (mastra as any).listTools?.() as Record<string, any> | undefined;
    if (!tools || !this.#manager) return;
    for (const [name, tool] of Object.entries(tools)) {
      if (!tool || typeof tool.execute !== 'function') continue;
      const execute = tool.execute.bind(tool);
      this.#manager.registerStaticExecutor(name, {
        execute: async (args, options) => {
          return execute(
            args as any,
            {
              toolCallId: '',
              messages: [],
              abortSignal: options?.abortSignal,
            } as any,
          );
        },
      });
    }
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
