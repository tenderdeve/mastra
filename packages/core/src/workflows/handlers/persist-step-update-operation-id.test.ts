import { describe, expect, it } from 'vitest';
import { RequestContext } from '../../di';
import { DefaultExecutionEngine } from '../default';
import type { ExecutionContext, StepResult } from '../types';
import { persistStepUpdate } from './entry';

/**
 * Regression tests for the AUTOMATIC_PARALLEL_INDEXING warning emitted by
 * Inngest SDK v4 when the same durable step ID is used twice in one run.
 *
 * Before the fix, persistStepUpdate produced an operationId that only varied
 * by workflowId, runId, and executionPath, so the pre-step "running" snapshot
 * (from handlers/step.ts) and the post-step "running" snapshot (from
 * handlers/entry.ts) collided on the same operationId for a linear workflow.
 *
 * The fix folds workflowStatus and the last step's status into the
 * operationId so each persist gets a distinct durable step ID.
 */

class CapturingEngine extends DefaultExecutionEngine {
  operationIds: string[] = [];

  async wrapDurableOperation<T>(operationId: string, operationFn: () => Promise<T>): Promise<T> {
    this.operationIds.push(operationId);
    return operationFn();
  }
}

function makeExecutionContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    workflowId: 'wf',
    runId: 'run-1',
    executionPath: [0],
    stepExecutionPath: ['step-a'],
    activeStepsPath: {},
    suspendedPaths: {},
    resumeLabels: {},
    retryConfig: { attempts: 0, delay: 0 },
    state: {},
    ...overrides,
  };
}

function runningResult(): StepResult<any, any, any, any> {
  return {
    status: 'running',
    payload: {},
    startedAt: 0,
  } as StepResult<any, any, any, any>;
}

function successResult(): StepResult<any, any, any, any> {
  return {
    status: 'success',
    payload: {},
    output: {},
    startedAt: 0,
    endedAt: 1,
  } as StepResult<any, any, any, any>;
}

describe('persistStepUpdate operationId', () => {
  it('produces distinct operationIds for the pre-step and post-step "running" persists on the same executionPath', async () => {
    const engine = new CapturingEngine({ mastra: undefined });
    const executionContext = makeExecutionContext();
    const requestContext = new RequestContext();

    // Pre-step persist (mirrors handlers/step.ts:183): step has not yet
    // produced a result, so stepResults does not contain the step id.
    await persistStepUpdate(engine, {
      workflowId: 'wf',
      runId: 'run-1',
      stepResults: {},
      serializedStepGraph: [],
      executionContext,
      workflowStatus: 'running',
      requestContext,
    });

    // Post-step persist (mirrors handlers/entry.ts:687): the step has just
    // emitted a "running" snapshot into stepResults.
    await persistStepUpdate(engine, {
      workflowId: 'wf',
      runId: 'run-1',
      stepResults: { 'step-a': runningResult() },
      serializedStepGraph: [],
      executionContext,
      workflowStatus: 'running',
      requestContext,
    });

    expect(engine.operationIds).toHaveLength(2);
    expect(engine.operationIds[0]).not.toBe(engine.operationIds[1]);
  });

  it('produces distinct operationIds for "waiting" vs "running" workflowStatus on the same executionPath', async () => {
    const engine = new CapturingEngine({ mastra: undefined });
    const executionContext = makeExecutionContext();
    const requestContext = new RequestContext();

    await persistStepUpdate(engine, {
      workflowId: 'wf',
      runId: 'run-1',
      stepResults: {},
      serializedStepGraph: [],
      executionContext,
      workflowStatus: 'waiting',
      requestContext,
    });

    await persistStepUpdate(engine, {
      workflowId: 'wf',
      runId: 'run-1',
      stepResults: {},
      serializedStepGraph: [],
      executionContext,
      workflowStatus: 'running',
      requestContext,
    });

    expect(engine.operationIds[0]).not.toBe(engine.operationIds[1]);
  });

  it('produces distinct operationIds for the "running" snapshot vs the final "success" snapshot of the same step', async () => {
    const engine = new CapturingEngine({ mastra: undefined });
    const executionContext = makeExecutionContext();
    const requestContext = new RequestContext();

    await persistStepUpdate(engine, {
      workflowId: 'wf',
      runId: 'run-1',
      stepResults: { 'step-a': runningResult() },
      serializedStepGraph: [],
      executionContext,
      workflowStatus: 'running',
      requestContext,
    });

    await persistStepUpdate(engine, {
      workflowId: 'wf',
      runId: 'run-1',
      stepResults: { 'step-a': successResult() },
      serializedStepGraph: [],
      executionContext,
      workflowStatus: 'success',
      requestContext,
    });

    expect(engine.operationIds[0]).not.toBe(engine.operationIds[1]);
  });

  it('produces stable operationIds across replays with identical inputs', async () => {
    const engine = new CapturingEngine({ mastra: undefined });
    const executionContext = makeExecutionContext();
    const requestContext = new RequestContext();

    const params = {
      workflowId: 'wf',
      runId: 'run-1',
      stepResults: { 'step-a': runningResult() },
      serializedStepGraph: [],
      executionContext,
      workflowStatus: 'running' as const,
      requestContext,
    };

    await persistStepUpdate(engine, params);
    await persistStepUpdate(engine, params);

    expect(engine.operationIds[0]).toBe(engine.operationIds[1]);
  });

  it('keeps operationIds distinct across different executionPaths', async () => {
    const engine = new CapturingEngine({ mastra: undefined });
    const requestContext = new RequestContext();

    await persistStepUpdate(engine, {
      workflowId: 'wf',
      runId: 'run-1',
      stepResults: { 'step-a': runningResult() },
      serializedStepGraph: [],
      executionContext: makeExecutionContext({ executionPath: [0], stepExecutionPath: ['step-a'] }),
      workflowStatus: 'running',
      requestContext,
    });

    await persistStepUpdate(engine, {
      workflowId: 'wf',
      runId: 'run-1',
      stepResults: { 'step-a': runningResult() },
      serializedStepGraph: [],
      executionContext: makeExecutionContext({ executionPath: [1], stepExecutionPath: ['step-a'] }),
      workflowStatus: 'running',
      requestContext,
    });

    expect(engine.operationIds[0]).not.toBe(engine.operationIds[1]);
  });
});
