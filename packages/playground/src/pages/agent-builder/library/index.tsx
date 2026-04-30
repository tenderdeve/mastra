import {
  EmptyState,
  EntityListPageLayout,
  ErrorState,
  ListSearch,
  PageHeader,
  PermissionDenied,
  SessionExpired,
  is401UnauthorizedError,
  is403ForbiddenError,
} from '@mastra/playground-ui';
import { LibraryIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { codeAgentToRow } from '@/domains/agent-builder/components/agent-builder-list/adapt';
import {
  AgentBuilderList,
  AgentBuilderListSkeleton,
} from '@/domains/agent-builder/components/agent-builder-list/agent-builder-list';
import { useAgents } from '@/domains/agents/hooks/use-agents';
import { useBuilderLibraryVisibility } from '@/domains/builder';

export default function AgentBuilderLibraryPage() {
  const [search, setSearch] = useState('');

  const { data, isLoading, error } = useAgents();
  const visibility = useBuilderLibraryVisibility();

  const agents = useMemo(() => {
    const all = Object.entries(data ?? {})
      .filter(([, agent]) => (agent as { source?: 'code' | 'stored' }).source === 'code')
      .map(([id, agent]) => codeAgentToRow(id, agent));
    if (visibility.unrestricted) return all;
    return all.filter(row => visibility.visibleAgents.has(row.id));
  }, [data, visibility]);

  const body = (() => {
    if (isLoading) {
      return <AgentBuilderListSkeleton rowTestId="library-skeleton-row" />;
    }

    if (error) {
      if (is401UnauthorizedError(error)) {
        return (
          <div className="flex items-center justify-center pt-10">
            <SessionExpired />
          </div>
        );
      }
      if (is403ForbiddenError(error)) {
        return (
          <div className="flex items-center justify-center pt-10">
            <PermissionDenied resource="agents" />
          </div>
        );
      }
      return (
        <div className="flex items-center justify-center pt-10">
          <ErrorState title="Failed to load the library" message={error.message} />
        </div>
      );
    }

    if (agents.length === 0) {
      const restricted = !visibility.unrestricted;
      return (
        <div className="flex items-center justify-center pt-16">
          <EmptyState
            iconSlot={<LibraryIcon className="h-8 w-8 text-neutral3" />}
            titleSlot={restricted ? 'No agents in the library' : 'No code-defined agents'}
            descriptionSlot={
              restricted
                ? 'Ask an admin to expose code-defined agents via library.visibleAgents.'
                : 'Define agents in code (mastra.addAgent) to surface them here.'
            }
          />
        </div>
      );
    }

    return <AgentBuilderList agents={agents} search={search} rowTestId="library-agent-row" />;
  })();

  return (
    <EntityListPageLayout>
      <EntityListPageLayout.Top>
        <div className="flex items-start justify-between gap-4">
          <PageHeader>
            <PageHeader.Title>
              <LibraryIcon /> Library
            </PageHeader.Title>
            <PageHeader.Description>Code-defined agents available in this deployment.</PageHeader.Description>
          </PageHeader>
        </div>
        <div className="max-w-120">
          <ListSearch onSearch={setSearch} label="Filter library" placeholder="Filter by name or description" />
        </div>
      </EntityListPageLayout.Top>

      {body}
    </EntityListPageLayout>
  );
}
