import { describe, expect, it } from 'vitest';
import {
  PendingRegistry,
  PendingRequestKindMismatchError,
  PendingRequestNotFoundError,
} from './pending-registry';
import type { ApprovalRequest, QuestionRequest } from './pending-registry';

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    kind: 'approval',
    sessionId: 'sess-1',
    correlationId: 'corr-1',
    toolName: 'writeNote',
    input: { title: 'hi' },
    ...overrides,
  };
}

function question(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    kind: 'question',
    sessionId: 'sess-1',
    correlationId: 'q-1',
    questions: [
      {
        id: 'q1',
        question: 'Which path?',
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
    ...overrides,
  };
}

describe('PendingRegistry — approvals', () => {
  it('resolves the registered promise when the correct (sessionId, correlationId) is resolved', async () => {
    const r = new PendingRegistry();
    const req = approval();
    const pending = r.registerApproval(req);

    r.resolveApproval(req.sessionId, req.correlationId, { decision: 'allow' });

    await expect(pending).resolves.toEqual({ decision: 'allow' });
    expect(r.size).toBe(0);
  });

  it('passes through updatedInput and message fields', async () => {
    const r = new PendingRegistry();
    const req = approval();
    const pending = r.registerApproval(req);

    r.resolveApproval(req.sessionId, req.correlationId, {
      decision: 'deny',
      message: 'Please use a different file',
      remember: true,
    });

    await expect(pending).resolves.toMatchObject({
      decision: 'deny',
      message: 'Please use a different file',
      remember: true,
    });
  });

  it('throws PendingRequestNotFoundError when resolving an unknown pair', () => {
    const r = new PendingRegistry();
    expect(() => r.resolveApproval('sess-x', 'corr-x', { decision: 'allow' })).toThrow(PendingRequestNotFoundError);
  });

  it('rejects duplicate registration under the same key', async () => {
    const r = new PendingRegistry();
    r.registerApproval(approval());
    await expect(r.registerApproval(approval())).rejects.toThrow(/Duplicate pending approval/);
  });

  it('returns a promise that can be passed straight back through canUseTool (no await)', async () => {
    // Landmine guard: canUseTool must `return promise` directly, not `return
    // await promise`. This test simulates that contract — we hand the promise
    // to a fake "SDK caller" that awaits it itself.
    const r = new PendingRegistry();
    const req = approval();
    const promise = r.registerApproval(req);

    const sdkResult = (async () => {
      return promise; // not awaited here — the caller (fake SDK) awaits
    })();

    setTimeout(() => r.resolveApproval(req.sessionId, req.correlationId, { decision: 'allow' }), 0);

    await expect(sdkResult).resolves.toEqual({ decision: 'allow' });
  });
});

describe('PendingRegistry — questions', () => {
  it('resolves the registered promise with the answer map', async () => {
    const r = new PendingRegistry();
    const req = question();
    const pending = r.registerQuestion(req);

    r.resolveQuestion(req.sessionId, req.correlationId, {
      answers: { q1: { selected: ['A'] } },
    });

    await expect(pending).resolves.toEqual({ answers: { q1: { selected: ['A'] } } });
    expect(r.size).toBe(0);
  });

  it('throws when resolving an unknown question', () => {
    const r = new PendingRegistry();
    expect(() => r.resolveQuestion('sess-x', 'q-x', { answers: {} })).toThrow(PendingRequestNotFoundError);
  });
});

describe('PendingRegistry — kind mismatch', () => {
  it('refuses to resolve an approval as a question', () => {
    const r = new PendingRegistry();
    const req = approval();
    r.registerApproval(req);
    expect(() => r.resolveQuestion(req.sessionId, req.correlationId, { answers: {} })).toThrow(
      PendingRequestKindMismatchError,
    );
  });

  it('refuses to resolve a question as an approval', () => {
    const r = new PendingRegistry();
    const req = question();
    r.registerQuestion(req);
    expect(() => r.resolveApproval(req.sessionId, req.correlationId, { decision: 'allow' })).toThrow(
      PendingRequestKindMismatchError,
    );
  });
});

describe('PendingRegistry — cancelAll', () => {
  it('rejects every pending entry for the given session', async () => {
    const r = new PendingRegistry();
    const a = r.registerApproval(approval({ correlationId: 'a1' }));
    const q = r.registerQuestion(question({ correlationId: 'q1' }));
    const other = r.registerApproval(approval({ sessionId: 'sess-2', correlationId: 'a2' }));

    r.cancelAll('sess-1', 'stream torn down');

    await expect(a).rejects.toThrow(/stream torn down/);
    await expect(q).rejects.toThrow(/stream torn down/);
    // Other-session entry survives.
    expect(r.size).toBe(1);

    // Clean up the survivor so the test doesn't leave a dangling promise.
    r.resolveApproval('sess-2', 'a2', { decision: 'allow' });
    await expect(other).resolves.toEqual({ decision: 'allow' });
  });

  it('is a no-op for a session with no pending entries', () => {
    const r = new PendingRegistry();
    expect(() => r.cancelAll('sess-unknown')).not.toThrow();
  });
});

describe('PendingRegistry — listPending', () => {
  it('returns all pending requests scoped to a session', () => {
    const r = new PendingRegistry();
    // Attach swallow-handlers up front so the cancelAll() rejections at the
    // end of the test don't surface as "unhandled rejection" warnings.
    const swallow = () => {};
    r.registerApproval(approval({ correlationId: 'a1' })).catch(swallow);
    r.registerQuestion(question({ correlationId: 'q1' })).catch(swallow);
    r.registerApproval(approval({ sessionId: 'sess-2', correlationId: 'a2' })).catch(swallow);

    const pending = r.listPending('sess-1');
    expect(pending).toHaveLength(2);
    expect(pending.map(p => p.kind).sort()).toEqual(['approval', 'question']);
    expect(r.listPending('sess-unknown')).toEqual([]);

    r.cancelAll('sess-1');
    r.cancelAll('sess-2');
  });
});
