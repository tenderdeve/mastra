export type DurableAgentRunStatus = 'active' | 'suspended' | 'completed' | 'error';

export interface DurableAgentActiveRun {
  resourceId: string;
  threadId: string;
  runId: string;
  ownerId?: string;
  status: DurableAgentRunStatus;
}

export interface DurableAgentClaimThreadOptions {
  resourceId: string;
  threadId: string;
  runId: string;
  ownerId?: string;
}

export type DurableAgentClaimThreadResult =
  | { claimed: true; activeRun: DurableAgentActiveRun }
  | { claimed: false; activeRun: DurableAgentActiveRun };
