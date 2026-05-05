import type { StepResult } from '../workflows/types';

export type { WorkerDeps } from './worker';

export interface StepExecutionStrategy {
  executeStep(params: StepExecutionParams): Promise<StepResult<any, any, any, any>>;
}

export interface StepExecutionParams {
  workflowId: string;
  runId: string;
  stepId: string;
  executionPath: number[];
  stepResults: Record<string, any>;
  state: Record<string, any>;
  requestContext: Record<string, any>;
  input?: any;
  resumeData?: any;
  retryCount?: number;
  foreachIdx?: number;
  format?: 'legacy' | 'vnext';
  perStep?: boolean;
  validateInputs?: boolean;
  abortSignal?: AbortSignal;
}
