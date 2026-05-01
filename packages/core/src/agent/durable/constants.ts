/**
 * Constants for DurableAgent pubsub channels and event types
 */

/**
 * Symbol for passing run registry to workflow steps
 * This allows steps to access the actual model/tool instances
 */
export const RUN_REGISTRY_SYMBOL = Symbol('run_registry');

/**
 * Generate the pubsub topic name for agent streaming events
 * @param runId - The unique run identifier
 * @returns The topic name for subscribing/publishing agent stream events
 */
export const AGENT_STREAM_TOPIC = (runId: string): string => `agent.stream.${runId}`;

/**
 * Generate the pubsub topic name for thread-level durable stream updates.
 * @param resourceId - The resource identifier for memory scoping
 * @param threadId - The thread identifier
 * @returns The topic name for active run updates on a thread
 */
export const AGENT_THREAD_STREAM_TOPIC = (resourceId: string | undefined, threadId: string): string =>
  `agent.thread-stream.${resourceId ?? ''}.${threadId}`;

/**
 * Event type constants for agent stream events
 */
export const AgentStreamEventTypes = {
  /** Chunk of streaming data (text, tool call, etc.) */
  CHUNK: 'chunk',
  /** Start of a new step in the agentic loop */
  STEP_START: 'step-start',
  /** End of a step in the agentic loop */
  STEP_FINISH: 'step-finish',
  /** Agent execution completed successfully */
  FINISH: 'finish',
  /** Error occurred during execution */
  ERROR: 'error',
  /** Workflow suspended (e.g., for tool approval) */
  SUSPENDED: 'suspended',
} as const;

/**
 * Default values for durable agent execution
 */
export const DurableAgentDefaults = {
  /** Default maximum number of agentic loop iterations */
  MAX_STEPS: 5,
  /**
   * Default tool call concurrency.
   * NOTE: Currently unused — durable workflows run tool calls sequentially
   * (concurrency: 1) because tool approval and suspension require sequential
   * execution. The serialized toolCallConcurrency option is preserved in
   * workflow input for future use when dynamic foreach concurrency is supported.
   */
  TOOL_CALL_CONCURRENCY: 10,
} as const;

/**
 * Step IDs used in the durable agentic workflow
 */
export const DurableStepIds = {
  /** LLM execution step */
  LLM_EXECUTION: 'durable-llm-execution',
  /** Tool call step */
  TOOL_CALL: 'durable-tool-call',
  /** LLM mapping step (combines results) */
  LLM_MAPPING: 'durable-llm-mapping',
  /** Agentic execution workflow (one iteration) */
  AGENTIC_EXECUTION: 'durable-agentic-execution',
  /** Full agentic loop workflow */
  AGENTIC_LOOP: 'durable-agentic-loop',
  /** Scorer execution step */
  SCORER_EXECUTION: 'durable-scorer-execution',
} as const;
