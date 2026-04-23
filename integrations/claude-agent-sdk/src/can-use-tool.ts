/**
 * `canUseTool` callback factory.
 *
 * The SDK calls this callback before every tool invocation that isn't in the
 * pre-allowed list. We use it as the single chokepoint for three policies:
 *
 * 1. **Remembered rules.** If the user has previously approved/denied this
 *    tool (via a checkbox on the approval card), a rule is stored in the
 *    `claudeAgentPermissionRules` storage domain and we short-circuit the
 *    prompt.
 *
 * 2. **`AskUserQuestion` interception.** `AskUserQuestion` is an SDK built-in
 *    whose "execution" is meant to be driven by the host: the SDK calls
 *    `canUseTool`, we show a question card, collect answers, and return
 *    `{ behavior: 'allow', updatedInput: { ...input, answers } }`. The
 *    built-in then echoes those answers back to the model as its tool output.
 *
 * 3. **Approval prompts for everything else.** We park a promise in the
 *    {@link PendingRegistry}, emit an `approval-request` event onto the
 *    stream so Studio can render a card, and await resolution via the HTTP
 *    resolve endpoint. On resolution we translate {@link ApprovalResolution}
 *    into the SDK's {@link PermissionResult} shape.
 *
 * Landmine: `canUseTool` receives the **already-qualified** MCP tool name
 * (e.g. `mcp__mastra__writeNote`), so lookups against the Mastra tool
 * registry must use {@link unqualifyMastraToolName}. Rule lookups on the
 * other hand store the qualified name, because that's what users see and
 * what the SDK asks about.
 */

import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeAgentPermissionRulesStorage } from '@mastra/core/storage';

import type { PendingRegistry, QuestionOption, QuestionPrompt, QuestionResolution } from './pending-registry';
import type { ShellStreamEvent } from './stream-events';

/** SDK built-in tool name used to ask the user a clarifying question. */
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

/** Minimal logger contract — matches Mastra's logger interface loosely. */
export interface CanUseToolLogger {
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface BuildCanUseToolInput {
  /**
   * Returns the current SDK session id. Called lazily because the id is
   * minted on `system(init)`, which arrives after the first `canUseTool`
   * invocation is technically possible (the SDK does not block on
   * permissions until the first tool call, which in practice always
   * happens after init, but we don't rely on ordering here). If this
   * returns `undefined`, we fall back to `placeholderSessionId` so the
   * pending entry can still be keyed.
   */
  readonly getSessionId: () => string | undefined;
  /** Pre-init placeholder used for correlation when the SDK hasn't emitted its session id yet. */
  readonly placeholderSessionId: string;
  /** Registration key of the Claude agent (for rule scoping). */
  readonly agentKey: string;
  /** Resource id of the calling user (for rule scoping). */
  readonly resourceId?: string;
  /** Shared pending registry (approval + question park). */
  readonly registry: PendingRegistry;
  /** Optional storage for remembered permission decisions. */
  readonly permissionRulesStore?: ClaudeAgentPermissionRulesStorage;
  /** Push a stream event into the outer `stream()` event queue. */
  readonly emit: (event: ShellStreamEvent) => void;
  /** Optional logger; failures to persist rules are warned, not thrown. */
  readonly logger?: CanUseToolLogger;
  /** Correlation-id minter. Defaults to `crypto.randomUUID`. Tests override. */
  readonly newCorrelationId?: () => string;
}

/**
 * Build a fresh `canUseTool` bound to one stream. Factory signature exists
 * because session id, abort signal, and event emitter are per-stream, but
 * the registry + rules store live on the {@link ClaudeAgent}.
 */
export function buildCanUseTool(params: BuildCanUseToolInput): CanUseTool {
  const { registry, emit, permissionRulesStore, agentKey, resourceId, logger } = params;
  const newId = params.newCorrelationId ?? (() => crypto.randomUUID());

  const sessionIdFor = (): string => params.getSessionId() ?? params.placeholderSessionId;

  return async (toolName, input, options) => {
    const sessionId = sessionIdFor();

    if (toolName === ASK_USER_QUESTION_TOOL_NAME) {
      return handleAskUserQuestion({ toolName, input, options, sessionId, registry, emit, newId });
    }

    // 1. Check remembered rule for non-question tools.
    if (permissionRulesStore) {
      try {
        const rule = await permissionRulesStore.getRule({ agentKey, resourceId, toolName });
        if (rule) {
          return rule.decision === 'allow'
            ? ({ behavior: 'allow', updatedInput: input } as PermissionResult)
            : ({ behavior: 'deny', message: `Blocked by remembered rule for ${toolName}.` } as PermissionResult);
        }
      } catch (err) {
        logger?.warn('[claude-agent] permission-rules lookup failed; falling through to prompt', {
          toolName,
          error: (err as Error).message,
        });
      }
    }

    // 2. Park an approval and wait on the user.
    const correlationId = newId();
    const promise = registry.registerApproval({
      kind: 'approval',
      sessionId,
      correlationId,
      toolName,
      input,
    });

    emit({
      type: 'approval-request',
      request: { kind: 'approval', sessionId, correlationId, toolName, input },
    });

    // Tie the per-call abort signal to the single pending entry. If the SDK
    // aborts this tool call (e.g. the user interrupts), reject the pending
    // promise so `canUseTool` unblocks instead of dangling.
    const onAbort = () => registry.cancelOne(sessionId, correlationId, 'aborted by SDK');
    options.signal.addEventListener('abort', onAbort, { once: true });

    let resolution;
    try {
      resolution = await promise;
    } finally {
      options.signal.removeEventListener('abort', onAbort);
    }

    // 3. Optionally persist the decision as a rule for next time.
    if (resolution.remember && permissionRulesStore) {
      try {
        await permissionRulesStore.saveRule({
          id: `${agentKey}:${resourceId ?? ''}:${toolName}`,
          agentKey,
          resourceId,
          toolName,
          decision: resolution.decision,
        });
      } catch (err) {
        logger?.warn('[claude-agent] failed to persist permission rule', {
          toolName,
          error: (err as Error).message,
        });
      }
    }

    emit({
      type: 'approval-resolved',
      approvalId: correlationId,
      decision: resolution.decision === 'allow' ? 'approve' : 'deny',
    });

    if (resolution.decision === 'allow') {
      return { behavior: 'allow', updatedInput: resolution.updatedInput ?? input };
    }
    return { behavior: 'deny', message: resolution.message ?? 'Denied by user.' };
  };
}

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

/** Minimal shape of the SDK's built-in `AskUserQuestion` input relevant to us. */
interface AskUserQuestionInputLike {
  questions?: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
  answers?: Record<string, string>;
  [extra: string]: unknown;
}

interface AskUserQuestionHandlerInput {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly options: Parameters<CanUseTool>[2];
  readonly sessionId: string;
  readonly registry: PendingRegistry;
  readonly emit: (event: ShellStreamEvent) => void;
  readonly newId: () => string;
}

async function handleAskUserQuestion(params: AskUserQuestionHandlerInput): Promise<PermissionResult> {
  const { input, options, sessionId, registry, emit, newId } = params;

  const typed = input as AskUserQuestionInputLike;
  const rawQuestions = Array.isArray(typed.questions) ? typed.questions : [];
  if (rawQuestions.length === 0) {
    return {
      behavior: 'deny',
      message: 'AskUserQuestion called with no questions; nothing to ask.',
    };
  }

  // Translate the SDK's question shape into our registry's shape. We use the
  // question text as the stable id, matching the SDK's own answers-map keying.
  const prompts: QuestionPrompt[] = rawQuestions.map(q => ({
    id: q.question,
    question: q.question,
    multiSelect: q.multiSelect === true,
    options: (q.options ?? []).map<QuestionOption>(o => ({
      label: o.label,
      description: o.description,
    })),
    allowOther: true, // the SDK auto-appends a free-text "Other…" affordance.
  }));

  const correlationId = newId();
  const promise = registry.registerQuestion({
    kind: 'question',
    sessionId,
    correlationId,
    questions: prompts,
  });

  emit({
    type: 'question-request',
    request: { kind: 'question', sessionId, correlationId, questions: prompts },
  });

  const onAbort = () => registry.cancelOne(sessionId, correlationId, 'aborted by SDK');
  options.signal.addEventListener('abort', onAbort, { once: true });

  let resolution: QuestionResolution;
  try {
    resolution = await promise;
  } finally {
    options.signal.removeEventListener('abort', onAbort);
  }

  emit({ type: 'question-resolved', questionId: correlationId });

  // Serialize answers in the shape the SDK built-in expects: one string per
  // question, multi-select comma-separated, free-text answers returned as-is.
  const answers: Record<string, string> = {};
  for (const prompt of prompts) {
    const entry = resolution.answers[prompt.id];
    if (!entry) continue;
    const parts: string[] = [];
    if (entry.selected?.length) parts.push(...entry.selected);
    if (entry.other && entry.other.trim() !== '') parts.push(entry.other);
    if (parts.length > 0) answers[prompt.question] = parts.join(', ');
  }

  return {
    behavior: 'allow',
    updatedInput: { ...typed, answers },
  };
}
