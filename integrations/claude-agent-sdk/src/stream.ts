/**
 * `ClaudeAgent.stream()` implementation.
 *
 * Responsibilities (in order of the loop):
 *
 * 1. Resolve/create a session record. Brand-new sessions are kept in memory
 *    until the SDK emits `system(init)` with its minted session id; only then
 *    do we persist a row (landmine #8: no placeholder persistence).
 *
 * 2. Build the full SDK options bundle (MCP bridge, delegation tools,
 *    canUseTool callback, permission mode, env vars, resume/fork plumbing).
 *
 * 3. Iterate the SDK's `AsyncGenerator<SDKMessage>` and push a
 *    {@link ShellStreamEvent} onto an in-memory queue for each message.
 *    A parallel consumer (the generator returned from this function)
 *    drains the queue through {@link shellStreamToMastraChunks} so the
 *    caller sees plain Mastra `ChunkType` values — identical to
 *    `Agent.stream()` output.
 *
 * 4. Splice in non-message stream events as they happen (real session id on
 *    `system(init)`, approval/question prompts from `canUseTool`, resolved
 *    events when the user settles a pending prompt). These ride as
 *    `ShellStreamEvent` entries too so the translator handles them uniformly.
 *
 * 5. On completion (success, error, or abort), merge the accumulated SDK
 *    messages into storage. Landmine #10: prepend a synthetic `user` message
 *    for brand-new sessions so the UI can render the prompt that kicked the
 *    turn off without the SDK having emitted one. Landmine #13: drop
 *    `stream_event` / `partial` envelopes before persisting.
 */

import type {
  Options,
  PermissionMode,
  Query,
  SDKMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  ClaudeAgentPermissionRulesStorage,
  ClaudeAgentSessionsStorage,
} from '@mastra/core/storage';
import type { ChunkType } from '@mastra/core/stream';

import { buildCanUseTool } from './can-use-tool';
import type { ClaudeAgent } from './claude-agent';
import { mergeDelegationTools } from './delegation';
import type { MastraToolExecutionContext } from './mcp-bridge';
import { buildMastraToolsMcpServer } from './mcp-bridge';
import type { PendingRegistry } from './pending-registry';
import { buildQueryOptions } from './query-options';
import type { ShellStreamEvent } from './stream-events';
import { shellStreamToMastraChunks } from './stream-translate';

// ---------------------------------------------------------------------------
// Public input/output
// ---------------------------------------------------------------------------

/**
 * Options for `ClaudeAgent.stream()`. Only `prompt` is required; everything
 * else has a sensible default. The shape is intentionally flat so it can be
 * marshalled across the HTTP boundary without ceremony.
 */
export interface ClaudeAgentStreamOptions {
  /** Prompt text for this turn. Required. */
  readonly prompt: string;
  /**
   * Existing session id. When provided and a session with this id exists in
   * storage we resume the SDK session; otherwise we let the SDK mint a new
   * session id (this is also the code path for brand-new sessions).
   */
  readonly sessionId?: string;
  /** Resource scope (user / org) for session lookups and permission rules. */
  readonly resourceId?: string;
  /**
   * Fork the resumed session instead of continuing it. Ignored when no
   * `sessionId` is provided.
   */
  readonly forkSession?: boolean;
  /** Per-turn permission mode override. Wins over `ClaudeAgent.permissionMode`. */
  readonly permissionMode?: PermissionMode;
  /**
   * Additional env vars merged on top of the base env (after cache-warmup
   * suppression). Used by the OTLP bridge to inject exporter wiring.
   */
  readonly extraEnv?: Record<string, string | undefined>;
  /** Abort controller for the turn. Propagated to the SDK subprocess. */
  readonly abortController?: AbortController;
  /**
   * Title for the session. Applied when first persisting a brand-new session
   * so the Studio sidebar renders something nicer than "Untitled".
   */
  readonly title?: string;
  /**
   * Mastra `RequestContext` used inside tool handlers. Required by
   * `buildMastraToolsMcpServer` — callers are expected to pass in whatever
   * context they have (server handlers fabricate one per request).
   */
  readonly requestContext: MastraToolExecutionContext['requestContext'];
  /** Mastra instance handed to tool handlers. Defaults to the one registered on the agent. */
  readonly mastra?: MastraToolExecutionContext['mastra'];
  /** Correlation-id minter. Defaults to `crypto.randomUUID`. Tests override. */
  readonly newCorrelationId?: () => string;
  /** New-session id minter. Defaults to `crypto.randomUUID`. Tests override. */
  readonly newSessionId?: () => string;
}

export interface ClaudeAgentStreamDeps {
  /** Storage for sessions. Required — without it the stream cannot persist. */
  readonly sessionsStore: ClaudeAgentSessionsStorage;
  /** Optional storage for remembered approval decisions. */
  readonly permissionRulesStore?: ClaudeAgentPermissionRulesStorage;
  /** Shared pending registry from the agent. */
  readonly registry: PendingRegistry;
  /** Agent registration key used to scope sessions + rules. */
  readonly agentKey: string;
  /** Logger. Optional. */
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void; error: (msg: string, meta?: Record<string, unknown>) => void };
  /**
   * Escape hatch so tests can stub the SDK's `query()` call without patching
   * globals. Defaults to the real SDK query.
   */
  readonly queryImpl?: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
}

// ---------------------------------------------------------------------------
// Event queue
// ---------------------------------------------------------------------------

/**
 * Tiny async iterator queue used to bridge the producer (`for await (msg of
 * sdkQuery(...))`) and the consumer (the translator). Allows multiple writers
 * (message pump + `canUseTool` event emitter) to drop events in without
 * coordinating locking.
 */
class EventQueue {
  readonly #buffer: ShellStreamEvent[] = [];
  #waiters: Array<(ev: IteratorResult<ShellStreamEvent>) => void> = [];
  #closed = false;

  push(event: ShellStreamEvent): void {
    if (this.#closed) return;
    const w = this.#waiters.shift();
    if (w) {
      w({ value: event, done: false });
    } else {
      this.#buffer.push(event);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ShellStreamEvent> {
    return {
      next: (): Promise<IteratorResult<ShellStreamEvent>> => {
        const ev = this.#buffer.shift();
        if (ev !== undefined) return Promise.resolve({ value: ev, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// SDK message helpers
// ---------------------------------------------------------------------------

function isInitMessage(m: SDKMessage): m is SDKSystemMessage & { subtype: 'init' } {
  return m.type === 'system' && (m as { subtype?: string }).subtype === 'init';
}

function isResultMessage(m: SDKMessage): boolean {
  return m.type === 'result';
}

/**
 * Messages that are safe to persist alongside session history. Streaming
 * deltas (`stream_event` / `partial_assistant`) and transient status envelopes
 * are dropped — they aren't part of the canonical transcript and replaying
 * them on session reload would confuse the translator (landmine #13).
 */
function isPersistable(m: SDKMessage): boolean {
  const ty = (m as { type?: string }).type;
  if (!ty) return false;
  if (ty === 'stream_event') return false;
  if (ty === 'partial_assistant') return false;
  if (ty === 'status') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Synthetic user message (landmine #10)
// ---------------------------------------------------------------------------

/**
 * Build a synthetic `user` SDKMessage to prepend on brand-new sessions so the
 * persisted transcript includes the prompt that started the turn. The SDK
 * itself doesn't echo the initial prompt as a user message until later
 * turns, which leaves the first-turn transcript visually missing the user's
 * prompt if we don't patch it in.
 */
function syntheticUserMessage(prompt: string, sessionId: string): SDKUserMessage {
  return {
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
    // Optional fields the SDK normally populates; leave unset to signal synthetic origin.
  } as unknown as SDKUserMessage;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run one turn against the Claude Agent SDK and yield Mastra `ChunkType`
 * values. This is the workhorse function behind `ClaudeAgent.stream()`.
 *
 * The caller is responsible for owning the generator lifecycle: iterating to
 * completion is the normal path; calling `.return()` early triggers the abort
 * controller and tears down the SDK query.
 */
export async function* runClaudeAgentStream(
  agent: ClaudeAgent,
  options: ClaudeAgentStreamOptions,
  deps: ClaudeAgentStreamDeps,
): AsyncGenerator<ChunkType, void, void> {
  const {
    prompt,
    sessionId: requestedSessionId,
    resourceId,
    forkSession,
    permissionMode,
    extraEnv,
    title,
    requestContext,
  } = options;

  const newCorrelationId = options.newCorrelationId ?? (() => crypto.randomUUID());
  const newSessionId = options.newSessionId ?? (() => crypto.randomUUID());
  const queryImpl = deps.queryImpl ?? (sdkQuery as NonNullable<ClaudeAgentStreamDeps['queryImpl']>);

  // ------------------------------------------------------------------
  // Session resolution
  // ------------------------------------------------------------------
  const existing = requestedSessionId ? await deps.sessionsStore.getSession(requestedSessionId) : null;

  // Placeholder id used for canUseTool correlation before `system(init)`
  // arrives. Also serves as the in-memory id for brand-new sessions until
  // the SDK mints its real one.
  const placeholderSessionId = requestedSessionId ?? newSessionId();
  let mintedSessionId: string | undefined = existing?.id;

  // Build the MCP bridge. Tools are drawn from the agent snapshot plus
  // synthetic delegation tools for registered agents + workflows.
  const mastraRef =
    options.mastra ??
    (agent.__getMastra() as MastraToolExecutionContext['mastra'] | undefined);
  if (!mastraRef) {
    throw new Error('ClaudeAgent.stream: agent is not registered with a Mastra instance.');
  }
  const abortController = options.abortController ?? new AbortController();

  const mergedTools = mergeDelegationTools({
    tools: agent.getTools(),
    agents: agent.getAgents(),
    workflows: agent.getWorkflows(),
    selfAgentKey: deps.agentKey,
  });
  const mastraMcp = buildMastraToolsMcpServer(mergedTools, () => ({
    mastra: mastraRef,
    requestContext,
    abortSignal: abortController.signal,
  }));

  const events = new EventQueue();
  const canUseTool = buildCanUseTool({
    getSessionId: () => mintedSessionId,
    placeholderSessionId,
    agentKey: deps.agentKey,
    resourceId,
    registry: deps.registry,
    permissionRulesStore: deps.permissionRulesStore,
    emit: ev => events.push(ev),
    logger: deps.logger,
    newCorrelationId,
  });

  const queryOptions = buildQueryOptions(agent, {
    mastraMcp,
    canUseTool,
    abortController,
    resume: existing ? existing.id : undefined,
    sessionId: existing ? undefined : requestedSessionId,
    forkSession: existing ? forkSession : undefined,
    permissionMode,
    extraEnv,
  });

  // ------------------------------------------------------------------
  // Pump SDK messages into the event queue in the background
  // ------------------------------------------------------------------
  const accumulated: SDKMessage[] = [];
  let finishMeta: {
    isError: boolean;
    totalCostUsd?: number;
    numTurns?: number;
    durationMs?: number;
  } = { isError: false };
  let terminalError: Error | undefined;

  const pumpDone = (async () => {
    try {
      const q = queryImpl({ prompt, options: queryOptions });
      for await (const message of q) {
        if (isInitMessage(message) && !mintedSessionId) {
          const id = (message as { session_id?: string }).session_id;
          if (typeof id === 'string' && id.length > 0) {
            mintedSessionId = id;
            events.push({ type: 'session', sessionId: id });
          }
        }

        if (isResultMessage(message)) {
          const r = message as unknown as {
            is_error?: boolean;
            total_cost_usd?: number;
            num_turns?: number;
            duration_ms?: number;
          };
          finishMeta = {
            isError: r.is_error === true,
            ...(r.total_cost_usd !== undefined ? { totalCostUsd: r.total_cost_usd } : {}),
            ...(r.num_turns !== undefined ? { numTurns: r.num_turns } : {}),
            ...(r.duration_ms !== undefined ? { durationMs: r.duration_ms } : {}),
          };
        }

        if (isPersistable(message)) accumulated.push(message);
        events.push({ type: 'message', message });
      }
    } catch (err) {
      terminalError = err instanceof Error ? err : new Error(String(err));
      events.push({
        type: 'error',
        error: { name: terminalError.name, message: terminalError.message },
      });
    } finally {
      events.push({ type: 'finish', ...finishMeta, isError: finishMeta.isError || !!terminalError });
      events.close();
    }
  })();

  // ------------------------------------------------------------------
  // Yield translated Mastra chunks to the caller
  // ------------------------------------------------------------------
  const runId = placeholderSessionId;
  try {
    yield* shellStreamToMastraChunks(events, { runId });
  } finally {
    // Ensure the pump finishes even on early return (e.g. caller aborted).
    if (!abortController.signal.aborted) abortController.abort();
    try {
      await pumpDone;
    } catch {
      // errors were already surfaced as stream events
    }

    // Tear down pending approvals/questions tied to this session so dangling
    // `canUseTool` promises don't leak.
    deps.registry.cancelAll(mintedSessionId ?? placeholderSessionId, 'stream ended');

    // ----------------------------------------------------------------
    // Persistence
    // ----------------------------------------------------------------
    const finalSessionId = mintedSessionId ?? placeholderSessionId;
    const now = new Date();
    try {
      if (existing) {
        // Resume path: append new messages to the existing transcript.
        await deps.sessionsStore.updateSession(existing.id, {
          messages: [...(existing.messages ?? []), ...accumulated],
        });
      } else {
        // Brand-new session. Prepend a synthetic user message (landmine #10)
        // so the first turn's prompt is part of the persisted transcript.
        const synthesized = syntheticUserMessage(prompt, finalSessionId);
        await deps.sessionsStore.saveSession({
          id: finalSessionId,
          agentKey: deps.agentKey,
          resourceId,
          title,
          messages: [synthesized, ...accumulated],
          createdAt: now,
          updatedAt: now,
        });
      }
    } catch (err) {
      deps.logger?.error('[claude-agent] failed to persist session', {
        sessionId: finalSessionId,
        error: (err as Error).message,
      });
    }
  }
}
