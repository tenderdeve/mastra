/**
 * Unified in-memory registry for "pending user interactions" on a Claude Agent
 * stream: tool-use approvals and `AskUserQuestion` prompts.
 *
 * Why one registry instead of two
 * --------------------------------
 * Both flows share the same shape: the SDK blocks on a promise while the UI
 * renders a card; when the user acts, the HTTP resolve endpoint settles the
 * promise and the SDK unblocks. Putting both in one registry means:
 *   - One `cancelAll(sessionId)` sweeps both when a stream dies.
 *   - One keying scheme `(sessionId, correlationId)`.
 *   - Callers can't accidentally resolve an approval with a question answer
 *     because the handle carries its kind at the type level.
 *
 * The registry is process-local on purpose. Approval/question cards are
 * attached to an in-flight HTTP stream, so a user who reloads mid-approval
 * naturally loses the prompt and has to redo the turn — that is the same
 * behaviour the SDK itself exhibits and trying to persist cross-process
 * continuations is out of scope for this integration.
 *
 * Return-as-promise contract
 * --------------------------
 * `registerApproval` and `registerQuestion` return a bare Promise. The SDK's
 * `canUseTool` callback must `return` that promise directly (not `await` it)
 * so the SDK awaits it on its own timeline. Re-awaiting inside `canUseTool`
 * is a known landmine — it prevents the SDK from cleanly cancelling the
 * callback when the session tears down.
 */

export type ApprovalDecision = 'allow' | 'deny';

export interface ApprovalResolution {
  decision: ApprovalDecision;
  /** Optional JSON payload from "approve with changes". */
  updatedInput?: Record<string, unknown>;
  /** Optional message returned on deny (shown back to the model). */
  message?: string;
  /** When true, the resolver wants the decision persisted as a permission rule. */
  remember?: boolean;
}

export interface ApprovalRequest {
  kind: 'approval';
  sessionId: string;
  correlationId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionPrompt {
  /** Stable id for the question within the batch (SDK-supplied). */
  id: string;
  /** Human-readable question shown to the user. */
  question: string;
  /** Pre-baked multiple-choice options (2–4 per spec). */
  options: QuestionOption[];
  /** When true, the user may supply a free-text answer alongside (or instead of) the options. */
  allowOther?: boolean;
  /** When true, the user may select multiple options. */
  multiSelect?: boolean;
}

export interface QuestionRequest {
  kind: 'question';
  sessionId: string;
  correlationId: string;
  questions: QuestionPrompt[];
}

export interface QuestionResolution {
  /** Map of question id → selected labels (and/or free-text answer). */
  answers: Record<string, { selected: string[]; other?: string }>;
}

export type PendingRequest = ApprovalRequest | QuestionRequest;

interface PendingApprovalEntry {
  kind: 'approval';
  request: ApprovalRequest;
  resolve: (resolution: ApprovalResolution) => void;
  reject: (err: Error) => void;
}

interface PendingQuestionEntry {
  kind: 'question';
  request: QuestionRequest;
  resolve: (resolution: QuestionResolution) => void;
  reject: (err: Error) => void;
}

type PendingEntry = PendingApprovalEntry | PendingQuestionEntry;

/** Error thrown when `resolveApproval` / `resolveQuestion` cannot find an entry. */
export class PendingRequestNotFoundError extends Error {
  readonly kind: 'approval' | 'question';
  readonly sessionId: string;
  readonly correlationId: string;

  constructor(kind: 'approval' | 'question', sessionId: string, correlationId: string) {
    super(`No pending ${kind} for session=${sessionId} id=${correlationId}`);
    this.name = 'PendingRequestNotFoundError';
    this.kind = kind;
    this.sessionId = sessionId;
    this.correlationId = correlationId;
  }
}

/** Error thrown when a pending entry is kind-mismatched against the resolve call. */
export class PendingRequestKindMismatchError extends Error {
  constructor(expected: 'approval' | 'question', actual: 'approval' | 'question') {
    super(`Expected pending ${expected}, found ${actual}`);
    this.name = 'PendingRequestKindMismatchError';
  }
}

function compositeKey(sessionId: string, correlationId: string): string {
  // `|` is not a valid character in SDK-generated ids, so this is unambiguous.
  return `${sessionId}|${correlationId}`;
}

/**
 * Process-local registry of pending approvals + questions.
 *
 * A single instance is created per `ClaudeAgent` (so different agents don't
 * cross-contaminate). It is safe to share across concurrent streams on the
 * same agent because entries are keyed by sessionId.
 */
export class PendingRegistry {
  readonly #entries = new Map<string, PendingEntry>();

  /**
   * Register an approval request. The returned promise resolves when
   * `resolveApproval` is called with the matching (sessionId, correlationId),
   * or rejects when `cancelAll` sweeps the session.
   */
  registerApproval(request: ApprovalRequest): Promise<ApprovalResolution> {
    return new Promise<ApprovalResolution>((resolve, reject) => {
      const key = compositeKey(request.sessionId, request.correlationId);
      if (this.#entries.has(key)) {
        reject(new Error(`Duplicate pending approval for session=${request.sessionId} id=${request.correlationId}`));
        return;
      }
      this.#entries.set(key, { kind: 'approval', request, resolve, reject });
    });
  }

  /**
   * Register a question batch. The returned promise resolves when the user
   * submits answers through `resolveQuestion`.
   */
  registerQuestion(request: QuestionRequest): Promise<QuestionResolution> {
    return new Promise<QuestionResolution>((resolve, reject) => {
      const key = compositeKey(request.sessionId, request.correlationId);
      if (this.#entries.has(key)) {
        reject(new Error(`Duplicate pending question for session=${request.sessionId} id=${request.correlationId}`));
        return;
      }
      this.#entries.set(key, { kind: 'question', request, resolve, reject });
    });
  }

  /**
   * Resolve a pending approval. Throws if no entry exists or the entry is a
   * question (callers should not guess at which kind is pending — the HTTP
   * endpoints are kind-specific).
   */
  resolveApproval(sessionId: string, correlationId: string, resolution: ApprovalResolution): void {
    const key = compositeKey(sessionId, correlationId);
    const entry = this.#entries.get(key);
    if (!entry) throw new PendingRequestNotFoundError('approval', sessionId, correlationId);
    if (entry.kind !== 'approval') throw new PendingRequestKindMismatchError('approval', entry.kind);
    this.#entries.delete(key);
    entry.resolve(resolution);
  }

  /** Resolve a pending question batch. Same error contract as `resolveApproval`. */
  resolveQuestion(sessionId: string, correlationId: string, resolution: QuestionResolution): void {
    const key = compositeKey(sessionId, correlationId);
    const entry = this.#entries.get(key);
    if (!entry) throw new PendingRequestNotFoundError('question', sessionId, correlationId);
    if (entry.kind !== 'question') throw new PendingRequestKindMismatchError('question', entry.kind);
    this.#entries.delete(key);
    entry.resolve(resolution);
  }

  /**
   * Reject every pending entry for a session and remove them. Called when a
   * stream tears down (normal end, error, or cancellation) so the SDK's
   * `canUseTool` promises don't dangle forever.
   */
  cancelAll(sessionId: string, reason: string = 'session ended'): void {
    const err = new Error(`Pending request cancelled: ${reason}`);
    for (const [key, entry] of this.#entries) {
      if (entry.request.sessionId !== sessionId) continue;
      this.#entries.delete(key);
      entry.reject(err);
    }
  }

  /** Snapshot of every pending request for a session — useful for diagnostics. */
  listPending(sessionId: string): PendingRequest[] {
    const out: PendingRequest[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.request.sessionId === sessionId) out.push(entry.request);
    }
    return out;
  }

  /** Test-only: total pending count across all sessions. */
  get size(): number {
    return this.#entries.size;
  }
}
