// Shell stream event union emitted by `ClaudeAgent.stream()`. The actual
// `stream()` implementation lands in commit 5f; defining the wire contract here
// lets the v5 translator (commit 5d) be written + tested in isolation.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ApprovalRequest, QuestionRequest } from './pending-registry';

/** Real SDK session id minted on `system(init)`. */
export type ShellSessionEvent = {
  type: 'session';
  sessionId: string;
};

/** Raw SDK message envelope (assistant/user/result/system/etc). */
export type ShellMessageEvent = {
  type: 'message';
  message: SDKMessage;
};

/** Approval prompt waiting on user decision. */
export type ShellApprovalRequestEvent = {
  type: 'approval-request';
  request: ApprovalRequest;
};

/** Approval was resolved (decision recorded), tool can proceed. */
export type ShellApprovalResolvedEvent = {
  type: 'approval-resolved';
  approvalId: string;
  decision: 'approve' | 'deny';
};

/** AskUserQuestion prompt waiting on user answer(s). */
export type ShellQuestionRequestEvent = {
  type: 'question-request';
  request: QuestionRequest;
};

/** Question was resolved with an answer payload. */
export type ShellQuestionResolvedEvent = {
  type: 'question-resolved';
  questionId: string;
};

/** Final aggregates from SDK `result` envelope (cost, tokens, turns). */
export type ShellFinishEvent = {
  type: 'finish';
  isError: boolean;
  totalCostUsd?: number;
  numTurns?: number;
  durationMs?: number;
};

/** Unrecoverable error during the stream. */
export type ShellErrorEvent = {
  type: 'error';
  error: { name?: string; message: string };
};

export type ShellStreamEvent =
  | ShellSessionEvent
  | ShellMessageEvent
  | ShellApprovalRequestEvent
  | ShellApprovalResolvedEvent
  | ShellQuestionRequestEvent
  | ShellQuestionResolvedEvent
  | ShellFinishEvent
  | ShellErrorEvent;
