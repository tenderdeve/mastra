/**
 * Assemble SDK `Options` for `query()` from a `ClaudeAgent` definition plus
 * per-turn values supplied by `.stream()`.
 *
 * This module is a pure function: it reads the agent config, per-turn inputs,
 * and the outputs of `buildMastraToolsMcpServer` + `mergeDelegationTools`, and
 * returns a ready-to-pass `Options` object. No SDK side effects, no mutation
 * of the input agent.
 *
 * What lives here (and what deliberately does not)
 * ------------------------------------------------
 * - System prompt normalization (the tagged union {@link ClaudeAgentSystemPrompt}
 *   → the SDK's `systemPrompt` shape).
 * - Cache-warmup suppression env vars when `disableNonEssentialModelCalls` is
 *   true. These live here so every call site gets them uniformly.
 * - MCP server mount (the Mastra tool bridge) + `allowedTools` merge.
 * - `AskUserQuestion` is force-kept in the effective tool surface so the
 *   `question-request` event can fire.
 * - Resume / fork / sessionId plumbing.
 *
 * What does NOT live here:
 * - `canUseTool` is injected by the caller (5f.2 builds the callback, this
 *   module only wires it through).
 * - `abortController` comes from the per-turn stream and is passed in.
 * - Observability env vars (OTEL / OTLP) — those arrive via a separate module
 *   later (commit 10) and are merged on top by the caller.
 */

import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk';

// The canonical `ASK_USER_QUESTION_TOOL_NAME` lives in `./can-use-tool` where
// the interception policy is also defined. Import + re-export here so call
// sites that reach into `query-options` for the full set of SDK-wiring knobs
// see the constant without hopping modules.
import { ASK_USER_QUESTION_TOOL_NAME } from './can-use-tool';
import type { ClaudeAgent, ClaudeAgentSystemPrompt } from './claude-agent';
import type { MastraToolsMcpServer } from './mcp-bridge';

export { ASK_USER_QUESTION_TOOL_NAME } from './can-use-tool';

/**
 * Env vars injected when `disableNonEssentialModelCalls` is true. Each one
 * suppresses a different non-essential CLI feature that produces extra
 * `llm_request` spans per turn (cache-warmup pings on the full model ladder,
 * auto-updater checks, miscellaneous traffic).
 *
 * Exported as a constant so tests can assert exact values.
 */
export const NON_ESSENTIAL_SUPPRESSION_ENV: Record<string, string> = {
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
  DISABLE_PROMPT_CACHING_WARMUP: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

/** Per-turn inputs fed into {@link buildQueryOptions}. */
export interface BuildQueryOptionsInput {
  /** Mastra MCP bridge built by `buildMastraToolsMcpServer`. */
  mastraMcp: MastraToolsMcpServer;
  /** Permission callback. `undefined` is legal but disables approval gating. */
  canUseTool?: CanUseTool;
  /** AbortController for this turn's stream. */
  abortController?: AbortController;
  /** SDK session to resume. Mutually exclusive with `continueRecent`. */
  resume?: string;
  /** Custom session id (UUID) — only used when starting a fresh session. */
  sessionId?: string;
  /** Continue the most recent session in this cwd. */
  continueRecent?: boolean;
  /** Fork a resumed session instead of continuing it. */
  forkSession?: boolean;
  /**
   * Per-turn permission-mode override. When unset, the agent-level default is
   * used; when explicitly passed (including from a saved session) it wins.
   */
  permissionMode?: Options['permissionMode'];
  /** Base environment. Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Extra env vars merged on top (e.g. OTLP wiring from commit 10). */
  extraEnv?: Record<string, string | undefined>;
  /** Emit partial assistant messages. Defaults to true so Studio streams tokens. */
  includePartialMessages?: boolean;
}

/**
 * Normalize {@link ClaudeAgentSystemPrompt} to the SDK's `systemPrompt` shape.
 *
 * - `undefined` → returns `undefined` so the SDK uses its built-in default.
 * - `string` → `{ type: 'preset', preset: 'claude_code', append: <string> }`
 *   to keep the default preset's tools + safety prompt intact (this is the
 *   most common user intent: "add to the default prompt").
 * - Tagged objects pass through as-is; callers opting into `{ type: 'string' }`
 *   get the literal verbatim, replacing the preset entirely.
 */
export function normalizeSystemPrompt(prompt?: ClaudeAgentSystemPrompt): Options['systemPrompt'] {
  if (prompt === undefined) return undefined;
  if (typeof prompt === 'string') {
    return { type: 'preset', preset: 'claude_code', append: prompt };
  }
  if (prompt.type === 'preset') {
    return { type: 'preset', preset: 'claude_code', ...(prompt.append ? { append: prompt.append } : {}) };
  }
  // prompt.type === 'string'
  return prompt.value;
}

/**
 * Ensure `AskUserQuestion` is present on the effective tool surface. Users
 * can narrow `tools` to a specific list and we must not silently drop the
 * question tool; and if anyone wires `disallowedTools` we add AskUserQuestion
 * back in only on the allow-list (we don't fight explicit disallows).
 */
function keepAskUserQuestion(allowed: string[]): string[] {
  if (allowed.includes(ASK_USER_QUESTION_TOOL_NAME)) return allowed;
  return [...allowed, ASK_USER_QUESTION_TOOL_NAME];
}

/**
 * Build the SDK `Options` object for one `query()` call.
 *
 * The returned object is safe to pass directly to `query({ prompt, options })`.
 * Callers should not mutate it — it is intended to be a per-turn immutable
 * snapshot that can be echoed into traces or logs.
 */
export function buildQueryOptions(agent: ClaudeAgent, input: BuildQueryOptionsInput): Options {
  const {
    mastraMcp,
    canUseTool,
    abortController,
    resume,
    sessionId,
    continueRecent,
    forkSession,
    permissionMode,
    baseEnv,
    extraEnv,
    includePartialMessages,
  } = input;

  const effectivePermissionMode: Options['permissionMode'] = permissionMode ?? agent.permissionMode;

  // Cache-warmup suppression + any caller-supplied vars merged on top of base env.
  const mergedEnv: Record<string, string | undefined> = { ...(baseEnv ?? process.env) };
  if (agent.disableNonEssentialModelCalls) {
    Object.assign(mergedEnv, NON_ESSENTIAL_SUPPRESSION_ENV);
  }
  if (extraEnv) {
    // `undefined` explicitly unsets — spreading with `undefined` preserves that semantics.
    for (const [k, v] of Object.entries(extraEnv)) {
      mergedEnv[k] = v;
    }
  }

  const allowedTools = keepAskUserQuestion([...mastraMcp.allowedTools]);

  // Only one of resume / continue wins. The SDK enforces this but we surface
  // the decision at construction so the options object is self-describing.
  const resumeOptions: Pick<Options, 'resume' | 'continue' | 'forkSession' | 'sessionId'> = {};
  if (resume) {
    resumeOptions.resume = resume;
    if (forkSession) resumeOptions.forkSession = true;
  } else if (continueRecent) {
    resumeOptions.continue = true;
  } else if (sessionId) {
    resumeOptions.sessionId = sessionId;
  }

  const systemPrompt = normalizeSystemPrompt(agent.systemPrompt);

  const options: Options = {
    // Model + working directory are nullable at the SDK layer; omit keys we
    // don't have a value for so the SDK's own defaults apply.
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.cwd ? { cwd: agent.cwd } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(effectivePermissionMode ? { permissionMode: effectivePermissionMode } : {}),

    // MCP bridge: always mount under the Mastra server name. The SDK will
    // advertise every tool in `mastraMcp.server.tools` to the model.
    mcpServers: {
      mastra: mastraMcp.server,
    },

    // Tool surface control. The SDK defaults to the `claude_code` preset
    // (full built-in tool list) unless the user restricts it elsewhere.
    allowedTools,

    // Subagents forwarded to the SDK so delegation shows up in the Agent tool.
    ...(Object.keys(agent.getSubagents()).length > 0 ? { agents: agent.getSubagents() } : {}),

    // Approval hook.
    ...(canUseTool ? { canUseTool } : {}),

    // Stream plumbing.
    ...(abortController ? { abortController } : {}),
    includePartialMessages: includePartialMessages ?? true,

    // Env.
    env: mergedEnv,

    // Session lifecycle.
    ...resumeOptions,
  };

  return options;
}
