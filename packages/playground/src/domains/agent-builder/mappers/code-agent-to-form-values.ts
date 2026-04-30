import type { GetAgentResponse } from '@mastra/client-js';
import type { AgentBuilderEditFormValues, AgentBuilderModel } from '../schemas';

function toRecord(input: Record<string, unknown> | undefined): Record<string, true> {
  if (!input) return {};
  return Object.fromEntries(Object.keys(input).map(k => [k, true as const]));
}

function staticModel(agent: GetAgentResponse): AgentBuilderModel | undefined {
  if (typeof agent.provider === 'string' && agent.provider && typeof agent.modelId === 'string' && agent.modelId) {
    return { provider: agent.provider, name: agent.modelId };
  }
  return undefined;
}

/**
 * Hydrate form defaults for a code-defined agent fetched via `/agents`.
 *
 * Code agents are read-only in the builder; this mapper exists so the same
 * view component can render them when no stored override has been created.
 */
export function codeAgentToFormValues(agent: GetAgentResponse | null | undefined): AgentBuilderEditFormValues {
  return {
    name: agent?.name ?? '',
    description: agent?.description ?? '',
    instructions: typeof agent?.instructions === 'string' ? agent.instructions : '',
    tools: toRecord(agent?.tools),
    agents: toRecord(agent?.agents),
    workflows: toRecord(agent?.workflows),
    skills: Object.fromEntries((agent?.skills ?? []).map(s => [s.name, true as const])),
    workspaceId: agent?.workspaceId,
    browserEnabled: Boolean(agent?.browserTools && agent.browserTools.length > 0),
    visibility: 'public',
    avatarUrl: undefined,
    model: agent ? staticModel(agent) : undefined,
  };
}
