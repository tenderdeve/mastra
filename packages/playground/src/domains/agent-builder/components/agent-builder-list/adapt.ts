import type { GetAgentResponse, StoredAgentResponse } from '@mastra/client-js';
import type { LibraryAgentRow } from './agent-builder-list';

function getAvatarUrl(metadata: Record<string, unknown> | null | undefined): string | undefined {
  if (metadata && typeof metadata === 'object' && 'avatarUrl' in metadata) {
    return metadata.avatarUrl as string | undefined;
  }
  return undefined;
}

/**
 * Adapt a `StoredAgentResponse` (from `/editor/agents`) to the normalized
 * `LibraryAgentRow` shape consumed by `AgentBuilderList`.
 */
export function storedAgentToRow(agent: StoredAgentResponse): LibraryAgentRow {
  return {
    id: agent.id,
    name: agent.name ?? '',
    description: agent.description,
    avatarUrl: getAvatarUrl(agent.metadata),
    source: 'stored',
    visibility: agent.visibility,
    isStarred: agent.isStarred,
    starCount: agent.starCount,
  };
}

/**
 * Adapt a `GetAgentResponse` entry (from `/agents`) to a `LibraryAgentRow`.
 * Used by the Library page, which surfaces code-defined agents.
 */
export function codeAgentToRow(id: string, agent: GetAgentResponse): LibraryAgentRow {
  return {
    id,
    name: agent.name ?? id,
    description: agent.description,
    source: 'code',
  };
}
