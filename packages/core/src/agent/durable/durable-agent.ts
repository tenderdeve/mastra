import type { MastraServerCache } from '../../cache/base';
import { InMemoryServerCache } from '../../cache/inmemory';
import { CachingPubSub } from '../../events/caching-pubsub';
import { EventEmitterPubSub } from '../../events/event-emitter';
import type { PubSub } from '../../events/pubsub';
import type { Mastra } from '../../mastra';
import type { MastraMemory } from '../../memory/memory';
import type { MastraModelOutput } from '../../stream/base/output';
import type { ChunkType } from '../../stream/types';
import type { DynamicArgument } from '../../types';
import type { AnyWorkspace } from '../../workspace';
import { Agent } from '../agent';
import type { AgentExecutionOptions } from '../agent.types';
import type { MessageListInput } from '../message-list';
import type { ToolsInput } from '../types';

import { AGENT_STREAM_TOPIC, AGENT_THREAD_STREAM_TOPIC } from './constants';
import { runDurableStreamUntilIdle } from './durable-stream-until-idle';
import { prepareForDurableExecution } from './preparation';
import { ExtendedRunRegistry, globalRunRegistry } from './run-registry';
import { signalToMessage } from './signal-message';
import { createDurableAgentStream, emitErrorEvent } from './stream-adapter';
import type {
  AgentFinishEventData,
  AgentStepFinishEventData,
  AgentSuspendedEventData,
  DurableAgentActiveRun,
  DurableAgentClaimThreadOptions,
  DurableAgentClaimThreadResult,
  DurableAgenticWorkflowInput,
  DurableAgentSignal,
  SendDurableAgentSignalOptions,
} from './types';
import { createDurableAgenticWorkflow } from './workflows';

function createAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Options for DurableAgent.stream()
 */
export interface DurableAgentStreamOptions<OUTPUT = undefined> {
  /** Custom instructions that override the agent's default instructions for this execution */
  instructions?: AgentExecutionOptions<OUTPUT>['instructions'];
  /** Additional context messages to provide to the agent */
  context?: AgentExecutionOptions<OUTPUT>['context'];
  /** Memory configuration for conversation persistence and retrieval */
  memory?: AgentExecutionOptions<OUTPUT>['memory'];
  /** Unique identifier for this execution run */
  runId?: string;
  /** Request Context containing dynamic configuration and state */
  requestContext?: AgentExecutionOptions<OUTPUT>['requestContext'];
  /** Abort signal for canceling local durable execution */
  abortSignal?: AbortSignal;
  /** Maximum number of steps to run */
  maxSteps?: number;
  /** Additional tool sets that can be used for this execution */
  toolsets?: AgentExecutionOptions<OUTPUT>['toolsets'];
  /** Client-side tools available during execution */
  clientTools?: AgentExecutionOptions<OUTPUT>['clientTools'];
  /** Tool selection strategy */
  toolChoice?: AgentExecutionOptions<OUTPUT>['toolChoice'];
  /** Model-specific settings like temperature */
  modelSettings?: AgentExecutionOptions<OUTPUT>['modelSettings'];
  /** Require approval for all tool calls */
  requireToolApproval?: boolean;
  /** Automatically resume suspended tools */
  autoResumeSuspendedTools?: boolean;
  /** Maximum number of tool calls to execute concurrently */
  toolCallConcurrency?: number;
  /** Whether to include raw chunks in the stream output */
  includeRawChunks?: boolean;
  /** Maximum processor retries */
  maxProcessorRetries?: number;
  /** Structured output configuration */
  structuredOutput?: AgentExecutionOptions<OUTPUT>['structuredOutput'];
  /** Version overrides for sub-agent delegation */
  versions?: AgentExecutionOptions<OUTPUT>['versions'];
  /** Callback when chunk is received */
  onChunk?: (chunk: ChunkType<OUTPUT>) => void | Promise<void>;
  /** Callback when step finishes */
  onStepFinish?: (result: AgentStepFinishEventData) => void | Promise<void>;
  /** Callback when execution finishes */
  onFinish?: (result: AgentFinishEventData) => void | Promise<void>;
  /** Callback on error */
  onError?: (error: Error) => void | Promise<void>;
  /** Callback when workflow suspends (e.g., for tool approval) */
  onSuspended?: (data: AgentSuspendedEventData) => void | Promise<void>;
  /** When true, the in-loop background task check step skips waiting (streamUntilIdle sets this) */
  _skipBgTaskWait?: boolean;
}

/**
 * Result from DurableAgent.stream()
 */
export interface DurableAgentStreamResult<OUTPUT = undefined> {
  /** The streaming output */
  output: MastraModelOutput<OUTPUT>;
  /** The full stream - delegates to output.fullStream for server compatibility */
  readonly fullStream: ReadableStream<any>;
  /** The unique run ID for this execution */
  runId: string;
  /** Thread ID if using memory */
  threadId?: string;
  /** Resource ID if using memory */
  resourceId?: string;
  /** Cleanup function to call when done (unsubscribes from pubsub) */
  cleanup: () => void;
}

/**
 * Options for subscribing to durable streams for a memory thread.
 */
export interface DurableAgentSubscribeToThreadOptions<OUTPUT = undefined> {
  /** Resource ID for the memory thread */
  resourceId?: string;
  /** Thread ID for the memory thread */
  threadId: string;
  /** Start replay from this event offset for each run stream */
  offset?: number;
  /** Callback when chunk is received */
  onChunk?: (chunk: ChunkType<OUTPUT>) => void | Promise<void>;
  /** Callback when step finishes */
  onStepFinish?: (result: AgentStepFinishEventData) => void | Promise<void>;
  /** Callback when execution finishes */
  onFinish?: (result: AgentFinishEventData) => void | Promise<void>;
  /** Callback on error */
  onError?: (error: Error) => void | Promise<void>;
  /** Callback when workflow suspends (e.g., for tool approval) */
  onSuspended?: (data: AgentSuspendedEventData) => void | Promise<void>;
}

export interface DurableAgentThreadSubscription<OUTPUT = undefined> {
  /** Streams for active runs on this thread, including future run IDs. */
  runs: AsyncIterable<DurableAgentStreamResult<OUTPUT>>;
  /** Stop watching the thread and cleanup any attached run streams. */
  cleanup: () => void;
}

type DurableAgentThreadRunStartedEvent = {
  type: 'run-started';
  runId: string;
  data: {
    runId: string;
    threadId: string;
    resourceId?: string;
  };
};

/**
 * Configuration for DurableAgent - wraps an existing Agent with durable execution
 */
export interface DurableAgentConfig<
  TAgentId extends string = string,
  TTools extends ToolsInput = ToolsInput,
  TOutput = undefined,
> {
  /**
   * The Agent to wrap with durable execution capabilities.
   * All agent methods (getModel, listTools, etc.) delegate to this agent.
   */
  agent: Agent<TAgentId, TTools, TOutput>;

  /**
   * Optional ID override. Defaults to agent.id.
   */
  id?: TAgentId;

  /**
   * Optional name override. Defaults to agent.name.
   */
  name?: string;

  /**
   * PubSub instance for streaming events.
   * Optional - if not provided, defaults to EventEmitterPubSub.
   */
  pubsub?: PubSub;

  /**
   * Cache instance for storing stream events.
   * Enables resumable streams - clients can disconnect and reconnect
   * without missing events.
   *
   * - If not provided: Inherits from Mastra instance, or uses InMemoryServerCache
   * - If provided: Uses the provided cache backend (e.g., Redis)
   * - If set to `false`: Disables caching (streams are not resumable)
   */
  cache?: MastraServerCache | false;

  /**
   * Maximum steps for the agentic loop.
   * Defaults to the workflow default if not specified.
   */
  maxSteps?: number;

  /**
   * Timeout in milliseconds before automatic cleanup of registry entries
   * after a stream finishes or errors. This provides a grace period for
   * late observers to access the stream.
   *
   * Defaults to 30000 (30 seconds).
   * Set to 0 to disable auto-cleanup (manual cleanup() required).
   */
  cleanupTimeoutMs?: number;
}

/**
 * DurableAgent wraps an existing Agent with durable execution capabilities.
 *
 * Key features:
 * 1. Resumable streams - clients can disconnect and reconnect without missing events
 * 2. Serializable workflow inputs - works with durable execution engines
 * 3. PubSub-based streaming - events flow through pubsub for distribution
 *
 * DurableAgent extends Agent, delegating most methods to the wrapped agent.
 * It overrides stream() to use durable execution with the agentic workflow.
 *
 * Subclasses (EventedAgent, InngestAgent) override executeWorkflow() to
 * customize how the workflow is executed.
 *
 * @example
 * ```typescript
 * import { Agent } from '@mastra/core/agent';
 * import { DurableAgent } from '@mastra/core/agent/durable';
 *
 * const agent = new Agent({
 *   id: 'my-agent',
 *   instructions: 'You are a helpful assistant',
 *   model: openai('gpt-4'),
 * });
 *
 * const durableAgent = new DurableAgent({ agent });
 *
 * const { output, runId, cleanup } = await durableAgent.stream('Hello!');
 * const text = await output.text;
 * cleanup();
 * ```
 */
export class DurableAgent<
  TAgentId extends string = string,
  TTools extends ToolsInput = ToolsInput,
  TOutput = undefined,
> extends Agent<TAgentId, TTools, TOutput> {
  /** The wrapped agent */
  readonly #wrappedAgent: Agent<TAgentId, TTools, TOutput>;

  /** Registry for per-run non-serializable state */
  readonly #runRegistry: ExtendedRunRegistry;

  /** The durable workflow for agent execution */
  #workflow: ReturnType<typeof createDurableAgenticWorkflow> | null = null;

  /** Maximum steps for the agentic loop */
  readonly #maxSteps?: number;

  /** Inner pubsub (before CachingPubSub wrapper) */
  #innerPubsub: PubSub;

  /** Whether the user explicitly provided a pubsub (don't override with mastra.pubsub) */
  readonly #hasCustomPubsub: boolean;

  /** User-provided cache (undefined = inherit from mastra, false = disabled) */
  #cacheConfig: MastraServerCache | false | undefined;

  /** Resolved cache instance (lazily initialized) */
  #resolvedCache: MastraServerCache | null = null;

  /** CachingPubSub instance (lazily initialized) */
  #cachingPubsub: PubSub | null = null;

  /** Mastra instance (set via __setMastra when registered) */
  #mastra: Mastra | undefined;

  /** Active streamUntilIdle wrappers keyed by scope (threadId|resourceId) */
  #activeStreamUntilIdle = new Map<string, () => void>();

  /** Timeout for auto-cleanup after stream finishes (0 = disabled) */
  readonly #cleanupTimeoutMs: number;

  /**
   * Create a new DurableAgent that wraps an existing Agent
   */
  constructor(config: DurableAgentConfig<TAgentId, TTools, TOutput>) {
    const { agent, id: idOverride, name: nameOverride, pubsub, cache, maxSteps, cleanupTimeoutMs } = config;

    // Use provided id/name or fall back to agent.id/agent.name
    const agentId = idOverride ?? agent.id;
    const agentName = nameOverride ?? agent.name ?? agent.id;

    // Call Agent constructor with minimal config - we delegate to the wrapped agent
    super({
      id: agentId as TAgentId,
      name: agentName,
      // Delegate to wrapped agent's instructions
      instructions: ({ requestContext }) => agent.getInstructions({ requestContext }),
      // Provide a lazy model resolver so wrapping dynamic agents doesn't resolve the model at construction time.
      model: ({ requestContext }) => agent.getModel({ requestContext }),
    });

    this.#wrappedAgent = agent;
    this.#runRegistry = new ExtendedRunRegistry();
    this.#maxSteps = maxSteps;
    this.#hasCustomPubsub = !!pubsub;
    this.#innerPubsub = pubsub ?? new EventEmitterPubSub();
    this.#cacheConfig = cache;
    this.#cleanupTimeoutMs = cleanupTimeoutMs ?? 30_000;
  }

  // ===========================================================================
  // Lazy PubSub/Cache initialization (allows inheriting cache from Mastra)
  // ===========================================================================

  /**
   * Get the resolved cache instance.
   * Lazily initialized to allow inheriting from Mastra.
   */
  get cache(): MastraServerCache | null {
    this.#ensurePubsubInitialized();
    return this.#resolvedCache;
  }

  /**
   * Get the PubSub instance.
   * Returns CachingPubSub if caching is enabled, otherwise the inner pubsub.
   */
  get pubsub(): PubSub {
    this.#ensurePubsubInitialized();
    return this.#cachingPubsub!;
  }

  getActiveRunForThread(options: { resourceId: string; threadId: string }): DurableAgentActiveRun | undefined {
    const runId = this.#runRegistry.getRunIdForThread(options.resourceId, options.threadId);
    if (!runId) return undefined;
    const status = this.#runRegistry.getStatus(runId);
    if (status !== 'active' && status !== 'suspended') return undefined;
    return { ...options, runId, status };
  }

  claimThreadRun(options: DurableAgentClaimThreadOptions): DurableAgentClaimThreadResult {
    const activeRun = this.getActiveRunForThread({ resourceId: options.resourceId, threadId: options.threadId });
    if (activeRun) {
      return { claimed: false, activeRun };
    }
    return {
      claimed: true,
      activeRun: {
        resourceId: options.resourceId,
        threadId: options.threadId,
        runId: options.runId,
        ownerId: options.ownerId,
        status: 'active',
      },
    };
  }

  sendSignal(signal: DurableAgentSignal, target: SendDurableAgentSignalOptions): { accepted: true; runId: string } {
    let runId: string | undefined;
    if (target.resourceId && target.threadId) {
      runId = this.getActiveRunForThread({ resourceId: target.resourceId, threadId: target.threadId })?.runId;
    }
    runId ??= target.runId;

    const globalEntry = runId ? globalRunRegistry.get(runId) : undefined;
    if (runId && globalEntry) {
      this.#runRegistry.enqueueSignal(runId, signal);
      globalEntry.signalQueue ??= [];
      globalEntry.signalQueue.push(signal);
      return { accepted: true, runId };
    }

    if (!target.resourceId || !target.threadId) {
      throw new Error('No active durable agent run found for signal target');
    }

    runId ??= crypto.randomUUID();
    const streamOptions = target.streamOptions as DurableAgentStreamOptions<TOutput> | undefined;
    void this.stream([signalToMessage(signal)], {
      ...streamOptions,
      runId,
      memory: streamOptions?.memory ?? ({ resource: target.resourceId, thread: target.threadId } as any),
    } as DurableAgentStreamOptions<TOutput>).catch(error => {
      void this.emitError(runId!, error);
    });

    return { accepted: true, runId };
  }

  /**
   * Ensure pubsub and cache are initialized.
   * Called lazily on first access to allow inheriting cache from Mastra.
   */
  #ensurePubsubInitialized(): void {
    if (this.#cachingPubsub) return;

    if (this.#cacheConfig === false) {
      // Caching explicitly disabled
      this.#cachingPubsub = this.#innerPubsub;
      this.#resolvedCache = null;
    } else {
      // Resolve cache: user-provided > mastra's cache > default InMemoryServerCache
      const resolvedCache = this.#cacheConfig ?? this.#mastra?.serverCache ?? new InMemoryServerCache();
      this.#resolvedCache = resolvedCache;
      this.#cachingPubsub = new CachingPubSub(this.#innerPubsub, resolvedCache);
    }
  }

  // ===========================================================================
  // Delegate to wrapped agent
  // ===========================================================================

  /**
   * Get the wrapped agent instance.
   */
  get agent(): Agent<TAgentId, TTools, TOutput> {
    return this.#wrappedAgent;
  }

  /**
   * Get the run registry (for testing and advanced usage)
   */
  get runRegistry(): ExtendedRunRegistry {
    return this.#runRegistry;
  }

  /**
   * Get the max steps configured for this agent
   */
  get maxSteps(): number | undefined {
    return this.#maxSteps;
  }

  /**
   * Get the cleanup timeout in milliseconds.
   * Returns 0 if auto-cleanup is disabled.
   */
  get cleanupTimeoutMs(): number {
    return this.#cleanupTimeoutMs;
  }

  // Delegate Agent methods to wrapped agent
  override getModel(options?: any) {
    return this.#wrappedAgent.getModel(options);
  }

  override getInstructions(options?: any) {
    return this.#wrappedAgent.getInstructions(options);
  }

  override listTools(options?: any) {
    return this.#wrappedAgent.listTools(options);
  }

  override hasOwnMemory() {
    return this.#wrappedAgent.hasOwnMemory();
  }

  override getMemory(options?: any) {
    return this.#wrappedAgent.getMemory(options);
  }

  override __setMemory(memory: DynamicArgument<MastraMemory, any>) {
    this.#wrappedAgent.__setMemory(memory);
    super.__setMemory(memory);
  }

  override hasOwnWorkspace() {
    return this.#wrappedAgent.hasOwnWorkspace();
  }

  override getWorkspace(options?: any) {
    return this.#wrappedAgent.getWorkspace(options);
  }

  override __setWorkspace(workspace: DynamicArgument<AnyWorkspace | undefined, any>) {
    this.#wrappedAgent.__setWorkspace(workspace);
    super.__setWorkspace(workspace);
  }

  override hasOwnBrowser() {
    return this.#wrappedAgent.hasOwnBrowser();
  }

  override get browser() {
    return this.#wrappedAgent.browser;
  }

  override setBrowser(browser: Parameters<Agent['setBrowser']>[0]) {
    this.#wrappedAgent.setBrowser(browser);
    super.setBrowser(browser);
  }

  override getVoice() {
    return this.#wrappedAgent.getVoice();
  }

  // ===========================================================================
  // Protected methods for subclass overrides
  // ===========================================================================

  /**
   * Get the PubSub instance for use by subclasses.
   * @internal
   */
  protected get pubsubInternal(): PubSub {
    return this.pubsub;
  }

  /**
   * Get the run registry for use by subclasses.
   * @internal
   */
  protected get runRegistryInternal(): ExtendedRunRegistry {
    return this.#runRegistry;
  }

  /**
   * Execute the durable workflow.
   *
   * Subclasses override this method to customize how the workflow is executed:
   * - DurableAgent (this): Runs the workflow directly via createRun + start
   * - EventedAgent: Uses run.startAsync() for fire-and-forget execution
   * - InngestAgent: Uses inngest.send() to trigger Inngest function
   *
   * @param runId - The unique run ID
   * @param workflowInput - The serialized workflow input
   * @internal
   */
  protected async executeWorkflow(runId: string, workflowInput: DurableAgenticWorkflowInput): Promise<void> {
    const workflow = this.getWorkflow();
    const registryEntry = globalRunRegistry.get(runId);
    const requestContext = registryEntry?.requestContext;
    const abortSignal = registryEntry?.abortSignal;

    const run = await workflow.createRun({ runId, pubsub: this.pubsub });
    if (abortSignal?.aborted) {
      await run.cancel();
      await this.emitError(runId, createAbortError());
      return;
    }

    const abort = () => {
      void run.cancel();
      void this.emitError(runId, createAbortError());
    };
    abortSignal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await run.start({ inputData: workflowInput, requestContext });

      if (result?.status === 'failed') {
        const error = new Error((result as any).error?.message || 'Workflow execution failed');
        await this.emitError(runId, error);
      } else if ((result as any)?.status === 'canceled' || abortSignal?.aborted) {
        await this.emitError(runId, createAbortError());
      }
    } finally {
      abortSignal?.removeEventListener('abort', abort);
    }
  }

  /**
   * Create the durable workflow for this agent.
   *
   * Subclasses can override this method to use a different workflow implementation:
   * - DurableAgent (this): Uses createDurableAgenticWorkflow()
   * - InngestAgent: Uses createInngestDurableAgenticWorkflow()
   *
   * @internal
   */
  protected createWorkflow(): ReturnType<typeof createDurableAgenticWorkflow> {
    return createDurableAgenticWorkflow({
      maxSteps: this.#maxSteps,
    });
  }

  /**
   * Emit an error event to pubsub.
   *
   * @param runId - The run ID
   * @param error - The error to emit
   * @internal
   */
  protected async emitError(runId: string, error: Error): Promise<void> {
    await emitErrorEvent(this.pubsub, runId, error);
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  #attachToRunStream(
    runId: string,
    options: DurableAgentSubscribeToThreadOptions<TOutput>,
  ): Promise<DurableAgentStreamResult<TOutput> | undefined> {
    const entry = this.#runRegistry.get(runId);
    if (!entry) return Promise.resolve(undefined);

    const {
      output,
      cleanup,
      ready,
    } = createDurableAgentStream<TOutput>({
      pubsub: this.pubsub,
      runId,
      messageId: runId,
      model: {
        modelId: entry.model.modelId,
        provider: entry.model.provider,
        version: 'v3',
      },
      threadId: options.threadId,
      resourceId: options.resourceId,
      offset: options.offset,
      onChunk: options.onChunk,
      onStepFinish: options.onStepFinish,
      onFinish: options.onFinish,
      onError: options.onError,
      onSuspended: options.onSuspended,
    });

    return ready.then(() => ({
      output,
      get fullStream() {
        return output.fullStream as ReadableStream<any>;
      },
      runId,
      threadId: options.threadId,
      resourceId: options.resourceId,
      cleanup,
    }));
  }

  /**
   * Subscribe to durable streams for a memory thread, including future run IDs.
   */
  async subscribeToThread(
    options: DurableAgentSubscribeToThreadOptions<TOutput>,
  ): Promise<DurableAgentThreadSubscription<TOutput>> {
    const topic = AGENT_THREAD_STREAM_TOPIC(options.resourceId, options.threadId);
    const seenRunIds = new Set<string>();
    const pendingRuns: DurableAgentStreamResult<TOutput>[] = [];
    const runCleanups: Array<() => void> = [];
    const waiters: Array<() => void> = [];
    let done = false;

    const wake = () => {
      while (waiters.length) waiters.shift()?.();
    };

    const enqueueRun = async (runId: string) => {
      if (done || seenRunIds.has(runId)) return;
      seenRunIds.add(runId);
      const runStream = await this.#attachToRunStream(runId, options);
      if (!runStream || done) {
        runStream?.cleanup();
        return;
      }
      runCleanups.push(runStream.cleanup);
      pendingRuns.push(runStream);
      wake();
    };

    const handleThreadEvent = (event: unknown) => {
      const threadEvent = event as DurableAgentThreadRunStartedEvent;
      const runId = threadEvent.data?.runId ?? threadEvent.runId;
      if (threadEvent.type === 'run-started' && runId) {
        void enqueueRun(runId);
      }
    };

    await this.pubsub.subscribeWithReplay(topic, handleThreadEvent);

    const activeRunId = this.#runRegistry.getRunIdByThread({ resourceId: options.resourceId, threadId: options.threadId });
    if (activeRunId) {
      void enqueueRun(activeRunId);
    }

    const cleanup = () => {
      if (done) return;
      done = true;
      void this.pubsub.unsubscribe(topic, handleThreadEvent);
      for (const runCleanup of runCleanups.splice(0)) {
        runCleanup();
      }
      wake();
    };

    return {
      cleanup,
      runs: (async function* () {
        try {
          while (!done || pendingRuns.length > 0) {
            if (pendingRuns.length === 0) {
              await new Promise<void>(resolve => waiters.push(resolve));
              continue;
            }
            yield pendingRuns.shift()!;
          }
        } finally {
          cleanup();
        }
      })(),
    };
  }

  async #publishThreadRunStarted(runId: string, threadId?: string, resourceId?: string): Promise<void> {
    if (!threadId) return;
    await this.pubsub.publish(AGENT_THREAD_STREAM_TOPIC(resourceId, threadId), {
      type: 'run-started',
      runId,
      data: { runId, threadId, resourceId },
    });
  }

  /**
   * Stream a response from the agent using durable execution.
   */
  // @ts-expect-error - Intentionally different signature for durable execution
  async stream(
    messages: MessageListInput,
    options?: DurableAgentStreamOptions<TOutput>,
  ): Promise<DurableAgentStreamResult<TOutput>> {
    // 1. Prepare for durable execution (non-durable phase)
    const preparation = await prepareForDurableExecution<TOutput>({
      agent: this.#wrappedAgent as Agent<string, any, TOutput>,
      messages,
      options: options as AgentExecutionOptions<TOutput>,
      runId: options?.runId,
      requestContext: options?.requestContext,
      mastra: this.#mastra,
    });

    const { runId, messageId, workflowInput, registryEntry, messageList, threadId, resourceId } = preparation;
    const streamingPubsub = this.pubsub;
    const runRegistryEntry = { ...registryEntry, pubsub: streamingPubsub, abortSignal: options?.abortSignal };

    // 2. Register non-serializable state (both local and global registries)
    this.#runRegistry.registerWithMessageList(runId, runRegistryEntry, messageList, { threadId, resourceId });
    globalRunRegistry.set(runId, { ...runRegistryEntry, messageList });

    // Track cleanup state to avoid double cleanup
    let cleanedUp = false;
    let autoCleanupTimer: ReturnType<typeof setTimeout> | null = null;

    // Schedule automatic registry cleanup after stream ends
    const scheduleAutoCleanup = () => {
      if (autoCleanupTimer || cleanedUp || this.#cleanupTimeoutMs === 0) return;
      autoCleanupTimer = setTimeout(() => {
        if (!cleanedUp) {
          this.#runRegistry.cleanup(runId);
          globalRunRegistry.delete(runId);
          this.#clearPubsubTopic(runId);
          cleanedUp = true;
        }
      }, this.#cleanupTimeoutMs);
    };

    // 3. Create the durable agent stream (subscribes to pubsub)
    const {
      output,
      cleanup: streamCleanup,
      ready,
    } = createDurableAgentStream<TOutput>({
      pubsub: this.pubsub,
      runId,
      messageId,
      model: {
        modelId: workflowInput.modelConfig.modelId,
        provider: workflowInput.modelConfig.provider,
        version: 'v3',
      },
      threadId,
      resourceId,
      onChunk: options?.onChunk,
      onStepFinish: options?.onStepFinish,
      onFinish: async result => {
        this.#runRegistry.setStatus(runId, 'completed');
        await options?.onFinish?.(result);
        scheduleAutoCleanup();
      },
      onError: async error => {
        this.#runRegistry.setStatus(runId, 'error');
        await options?.onError?.(error);
        scheduleAutoCleanup();
      },
      onSuspended: async data => {
        this.#runRegistry.setStatus(runId, 'suspended');
        await options?.onSuspended?.(data);
      },
    });

    // 4. Wait for subscription to be ready, then execute workflow
    // This prevents race conditions where events are published before subscription
    ready
      .then(async () => {
        await this.#publishThreadRunStarted(runId, threadId, resourceId);
        await this.executeWorkflow(runId, workflowInput);
      })
      .catch(error => {
        void this.emitError(runId, error);
      });

    // 5. Create cleanup function (cancels auto-cleanup timer if called)
    const cleanup = () => {
      if (autoCleanupTimer) {
        clearTimeout(autoCleanupTimer);
        autoCleanupTimer = null;
      }
      if (!cleanedUp) {
        streamCleanup();
        this.#runRegistry.cleanup(runId);
        globalRunRegistry.delete(runId);
        this.#clearPubsubTopic(runId);
        cleanedUp = true;
      }
    };

    return {
      output,
      get fullStream() {
        return output.fullStream as ReadableStream<any>;
      },
      runId,
      threadId,
      resourceId,
      cleanup,
    };
  }

  /**
   * Resume a suspended workflow execution.
   */
  async resume(
    runId: string,
    resumeData: unknown,
    options?: {
      onChunk?: (chunk: ChunkType<TOutput>) => void | Promise<void>;
      onStepFinish?: (result: AgentStepFinishEventData) => void | Promise<void>;
      onFinish?: (result: AgentFinishEventData) => void | Promise<void>;
      onError?: (error: Error) => void | Promise<void>;
      onSuspended?: (data: AgentSuspendedEventData) => void | Promise<void>;
    },
  ): Promise<DurableAgentStreamResult<TOutput>> {
    const entry = this.#runRegistry.get(runId);
    if (!entry) {
      throw new Error(`No registry entry found for run ${runId}. Cannot resume.`);
    }

    const memoryInfo = this.#runRegistry.getMemoryInfo(runId);

    // Track cleanup state to avoid double cleanup
    let cleanedUp = false;
    let autoCleanupTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleAutoCleanup = () => {
      if (autoCleanupTimer || cleanedUp || this.#cleanupTimeoutMs === 0) return;
      autoCleanupTimer = setTimeout(() => {
        if (!cleanedUp) {
          this.#runRegistry.cleanup(runId);
          globalRunRegistry.delete(runId);
          this.#clearPubsubTopic(runId);
          cleanedUp = true;
        }
      }, this.#cleanupTimeoutMs);
    };

    const globalEntry = globalRunRegistry.get(runId);
    const resumeModel = globalEntry?.model as any;

    const {
      output,
      cleanup: streamCleanup,
      ready,
    } = createDurableAgentStream<TOutput>({
      pubsub: this.pubsub,
      runId,
      messageId: crypto.randomUUID(),
      model: {
        modelId: resumeModel?.modelId,
        provider: resumeModel?.provider,
        version: 'v3',
      },
      threadId: memoryInfo?.threadId,
      resourceId: memoryInfo?.resourceId,
      onChunk: options?.onChunk,
      onStepFinish: options?.onStepFinish,
      onFinish: async result => {
        await options?.onFinish?.(result);
        scheduleAutoCleanup();
      },
      onError: async error => {
        await options?.onError?.(error);
        scheduleAutoCleanup();
      },
      onSuspended: options?.onSuspended,
    });

    // Wait for subscription to be ready, then resume workflow
    const workflow = this.getWorkflow();
    const registryEntry = globalRunRegistry.get(runId);
    const requestContext = registryEntry?.requestContext;
    ready
      .then(async () => {
        const abortSignal = registryEntry?.abortSignal;
        const run = await workflow.createRun({ runId, pubsub: this.pubsub });
        if (abortSignal?.aborted) {
          await run.cancel();
          void this.emitError(runId, createAbortError());
          return;
        }

        const abort = () => {
          void run.cancel();
        };
        abortSignal?.addEventListener('abort', abort, { once: true });
        try {
          const result = await run.resume({ resumeData, requestContext });
          if (result?.status === 'failed') {
            const error = new Error((result as any).error?.message || 'Workflow resume failed');
            void this.emitError(runId, error);
          } else if ((result as any)?.status === 'canceled' || abortSignal?.aborted) {
            void this.emitError(runId, createAbortError());
          }
        } finally {
          abortSignal?.removeEventListener('abort', abort);
        }
      })
      .catch(error => {
        void this.emitError(runId, error);
      });

    const cleanup = () => {
      if (autoCleanupTimer) {
        clearTimeout(autoCleanupTimer);
        autoCleanupTimer = null;
      }
      if (!cleanedUp) {
        streamCleanup();
        this.#runRegistry.cleanup(runId);
        globalRunRegistry.delete(runId);
        this.#clearPubsubTopic(runId);
        cleanedUp = true;
      }
    };

    return {
      output,
      get fullStream() {
        return output.fullStream as ReadableStream<any>;
      },
      runId,
      threadId: memoryInfo?.threadId,
      resourceId: memoryInfo?.resourceId,
      cleanup,
    };
  }

  /**
   * Observe an existing stream.
   * Use this to reconnect to a stream after a network disconnection.
   *
   * **Warning:** The returned `cleanup()` function destroys the run's registry
   * entries and cached PubSub events. Only call it when you are done with the
   * run entirely. If the workflow is suspended and you intend to resume later,
   * do not call cleanup — let the auto-cleanup timer handle it after
   * FINISH/ERROR. Auto-cleanup does not fire on SUSPENDED events.
   */
  async observe(
    runId: string,
    options?: {
      offset?: number;
      onChunk?: (chunk: ChunkType<TOutput>) => void | Promise<void>;
      onStepFinish?: (result: AgentStepFinishEventData) => void | Promise<void>;
      onFinish?: (result: AgentFinishEventData) => void | Promise<void>;
      onError?: (error: Error) => void | Promise<void>;
      onSuspended?: (data: AgentSuspendedEventData) => void | Promise<void>;
    },
  ): Promise<Omit<DurableAgentStreamResult<TOutput>, 'runId'> & { runId: string }> {
    const memoryInfo = this.#runRegistry.getMemoryInfo(runId);

    // Track cleanup state to avoid double cleanup
    let cleanedUp = false;
    let autoCleanupTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleAutoCleanup = () => {
      if (autoCleanupTimer || cleanedUp || this.#cleanupTimeoutMs === 0) return;
      autoCleanupTimer = setTimeout(() => {
        if (!cleanedUp) {
          this.#runRegistry.cleanup(runId);
          globalRunRegistry.delete(runId);
          this.#clearPubsubTopic(runId);
          cleanedUp = true;
        }
      }, this.#cleanupTimeoutMs);
    };

    const {
      output,
      cleanup: streamCleanup,
      ready,
    } = createDurableAgentStream<TOutput>({
      pubsub: this.pubsub,
      runId,
      messageId: crypto.randomUUID(),
      model: {
        modelId: undefined,
        provider: undefined,
        version: 'v3',
      },
      threadId: memoryInfo?.threadId,
      resourceId: memoryInfo?.resourceId,
      offset: options?.offset,
      onChunk: options?.onChunk,
      onStepFinish: options?.onStepFinish,
      onFinish: async result => {
        await options?.onFinish?.(result);
        scheduleAutoCleanup();
      },
      onError: async error => {
        await options?.onError?.(error);
        scheduleAutoCleanup();
      },
      onSuspended: options?.onSuspended,
    });

    // Wait for subscription to be ready
    await ready;

    const cleanup = () => {
      if (autoCleanupTimer) {
        clearTimeout(autoCleanupTimer);
        autoCleanupTimer = null;
      }
      if (!cleanedUp) {
        streamCleanup();
        this.#runRegistry.cleanup(runId);
        globalRunRegistry.delete(runId);
        this.#clearPubsubTopic(runId);
        cleanedUp = true;
      }
    };

    return {
      output,
      get fullStream() {
        return output.fullStream as ReadableStream<any>;
      },
      runId,
      threadId: memoryInfo?.threadId,
      resourceId: memoryInfo?.resourceId,
      cleanup,
    };
  }

  /**
   * Clear cached pubsub events for a run's topic.
   * Only effective when pubsub supports clearTopic (e.g. CachingPubSub).
   */
  #clearPubsubTopic(runId: string): void {
    const pubsub = this.pubsub;
    if ('clearTopic' in pubsub && typeof (pubsub as any).clearTopic === 'function') {
      void (pubsub as any).clearTopic(AGENT_STREAM_TOPIC(runId));
    }
  }

  /**
   * Get the workflow instance for direct execution.
   * Lazily creates the workflow and registers Mastra on it (needed for
   * getAgentById in execution steps).
   */
  getWorkflow() {
    if (!this.#workflow) {
      this.#workflow = this.createWorkflow();
      // Register mastra on the workflow so execution steps can access agents/tools.
      // DurableAgent goes through the normal Agent registration path (not the durable wrapper
      // path that calls addWorkflow), so the workflow isn't registered in Mastra's #workflows.
      // We set mastra directly here instead.
      if (this.#mastra) {
        this.#workflow.__registerMastra(this.#mastra);
        this.#workflow.__registerPrimitives({
          logger: this.#mastra.getLogger(),
          storage: this.#mastra.getStorage(),
        });
      }
    }
    return this.#workflow;
  }

  /**
   * Stream until all background tasks complete and the agent is idle.
   * Mirrors the regular Agent's streamUntilIdle but adapted for durable execution.
   */
  // @ts-expect-error - Intentionally different return type for durable execution
  override async streamUntilIdle<OUTPUT = TOutput>(
    messages: MessageListInput,
    streamOptions?: DurableAgentStreamOptions<OUTPUT> & { maxIdleMs?: number },
  ): Promise<DurableAgentStreamResult<OUTPUT>> {
    return runDurableStreamUntilIdle<OUTPUT>(
      this as unknown as DurableAgent<any, any, OUTPUT>,
      messages,
      streamOptions,
      {
        activeStreams: this.#activeStreamUntilIdle,
        bgManager: this.#mastra?.backgroundTaskManager,
      },
    );
  }

  /**
   * Prepare for durable execution without starting it.
   */
  async prepare(messages: MessageListInput, options?: AgentExecutionOptions<TOutput>) {
    const preparation = await prepareForDurableExecution<TOutput>({
      agent: this.#wrappedAgent as Agent<string, any, TOutput>,
      messages,
      options,
      requestContext: options?.requestContext,
      mastra: this.#mastra,
    });

    this.#runRegistry.registerWithMessageList(preparation.runId, preparation.registryEntry, preparation.messageList, {
      threadId: preparation.threadId,
      resourceId: preparation.resourceId,
    });
    globalRunRegistry.set(preparation.runId, {
      ...preparation.registryEntry,
      messageList: preparation.messageList,
    });

    return {
      runId: preparation.runId,
      messageId: preparation.messageId,
      workflowInput: preparation.workflowInput,
      registryEntry: preparation.registryEntry,
      threadId: preparation.threadId,
      resourceId: preparation.resourceId,
    };
  }

  /**
   * Get the durable workflows required by this agent.
   * Called by Mastra during agent registration.
   * @internal
   */
  getDurableWorkflows() {
    return [this.getWorkflow()];
  }

  /**
   * Set the Mastra instance.
   * Called by the durable agent registration path in addAgent().
   * Delegates to __registerMastra so the pubsub wiring and agent
   * registration happen regardless of which entry point is called first.
   * @internal
   */
  __setMastra(mastra: Mastra): void {
    this.__registerMastra(mastra);
  }

  /**
   * Register the Mastra instance.
   * Called by Mastra during agent registration (normal Agent path).
   *
   * Also wires mastra.pubsub as the inner pubsub (if the user didn't provide
   * a custom one), so that the OBSERVE_AGENT_STREAM_ROUTE handler can subscribe
   * to the same PubSub instance that this agent publishes to.
   * @internal
   */
  __registerMastra(mastra: Mastra): void {
    super.__registerMastra(mastra);
    this.#mastra = mastra;
    // Also set on wrapped agent
    this.#wrappedAgent.__registerMastra(mastra);

    // Wire mastra.pubsub as the inner pubsub if user didn't provide a custom one.
    // This must happen before CachingPubSub initialization.
    if (!this.#hasCustomPubsub && !this.#cachingPubsub) {
      this.#innerPubsub = mastra.pubsub;
    }
  }
}
