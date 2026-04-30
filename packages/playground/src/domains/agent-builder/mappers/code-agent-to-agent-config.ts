import type { GetAgentResponse } from '@mastra/client-js';
import type { AgentConfig } from '../components/agent-builder-edit/agent-configure-panel';

/**
 * Build a read-only `AgentConfig` for a code-defined agent fetched via `/agents`.
 *
 * Code agents have no `visibility` or `authorId` — those are stored-agent concepts.
 */
export function codeAgentToAgentConfig(agent: GetAgentResponse | null | undefined, fallbackId: string): AgentConfig {
  return {
    id: agent?.id ?? fallbackId,
    name: agent?.name ?? '',
    description: agent?.description ?? '',
    avatarUrl: undefined,
    systemPrompt: typeof agent?.instructions === 'string' ? agent.instructions : '',
    visibility: 'public',
    authorId: null,
  };
}
