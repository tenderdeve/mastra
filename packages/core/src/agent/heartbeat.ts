import type { AgentHeartbeatConfig, HeartbeatThreadConfig } from './agent.types';
import type { HeartbeatThreadMetadata } from '../memory/types';

/** Default heartbeat interval: 30 minutes */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_800_000;

/** Default prompt used when no heartbeat prompt is configured */
export const DEFAULT_HEARTBEAT_PROMPT =
  'This is a scheduled check-in. Review the conversation context and only respond if there is something that needs attention. If nothing needs attention, say nothing meaningful — just acknowledge briefly.';

/**
 * Merge agent-level heartbeat defaults with per-thread overrides.
 * Thread overrides take precedence over agent defaults.
 */
export function resolveHeartbeatConfig(
  agentDefaults: AgentHeartbeatConfig,
  threadOverrides?: HeartbeatThreadConfig,
): { intervalMs: number; prompt: string } {
  return {
    intervalMs: threadOverrides?.intervalMs ?? agentDefaults.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    prompt: threadOverrides?.prompt ?? agentDefaults.prompt ?? DEFAULT_HEARTBEAT_PROMPT,
  };
}

/**
 * Build HeartbeatThreadMetadata for persistence.
 * Only stores explicit per-thread overrides — agent-level defaults are NOT persisted
 * so that changes to the agent config take effect without needing to update every thread.
 */
export function buildHeartbeatMetadata(
  threadOverrides?: { intervalMs?: number; prompt?: string },
  lastRunAt?: string,
): HeartbeatThreadMetadata {
  return {
    enabled: true,
    ...(threadOverrides?.intervalMs !== undefined && { intervalMs: threadOverrides.intervalMs }),
    ...(threadOverrides?.prompt !== undefined && { prompt: threadOverrides.prompt }),
    lastRunAt,
  };
}

/**
 * Calculate the initial delay for a heartbeat timer on restart.
 * If enough time has elapsed since lastRunAt, returns 0 (fire immediately).
 * Otherwise returns the remaining time.
 */
export function calculateInitialDelay(intervalMs: number, lastRunAt?: string): number {
  if (!lastRunAt) return 0;

  const elapsed = Date.now() - new Date(lastRunAt).getTime();
  if (elapsed >= intervalMs) return 0;
  return Math.max(0, intervalMs - elapsed);
}

/**
 * Optional utility for developers who want to detect ack-like responses.
 * Checks if the model's response is effectively empty or just an acknowledgment.
 */
export function isHeartbeatAck(text: string, ackToken = 'HEARTBEAT_OK'): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed === ackToken) return true;
  // Very short responses (under 20 chars) that look like acknowledgments
  if (trimmed.length < 20 && /^(ok|nothing|all good|no updates?|all clear|acknowledged)\.?$/i.test(trimmed)) {
    return true;
  }
  return false;
}
