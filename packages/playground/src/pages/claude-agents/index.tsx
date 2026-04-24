import {
  AgentIcon,
  EntityList,
  EntityListSkeleton,
  ErrorState,
  NoDataPageLayout,
  PageHeader,
  PageLayout,
  truncateString,
} from '@mastra/playground-ui';
import { useClaudeAgents } from '@/domains/claude-agents/hooks/use-claude-agents';
import { useLinkComponent } from '@/lib/framework';

export function ClaudeAgents() {
  const { data: agents, isLoading, error } = useClaudeAgents();
  const { Link, paths } = useLinkComponent();

  if (error) {
    return (
      <NoDataPageLayout title="Claude Agents" icon={<AgentIcon />}>
        <ErrorState title="Failed to load Claude agents" message={error.message} />
      </NoDataPageLayout>
    );
  }

  if (!isLoading && (!agents || agents.length === 0)) {
    return (
      <NoDataPageLayout title="Claude Agents" icon={<AgentIcon />}>
        <div className="text-center text-icon3">
          <p>No Claude agents registered.</p>
          <p className="mt-2 text-sm">
            Register a Claude agent via <code>new Mastra({'{'} claudeAgents: {'{'}...{'}'} {'}'})</code>.
          </p>
        </div>
      </NoDataPageLayout>
    );
  }

  return (
    <PageLayout>
      <PageLayout.TopArea>
        <PageLayout.Row>
          <PageLayout.Column>
            <PageHeader>
              <PageHeader.Title isLoading={isLoading}>
                <AgentIcon /> Claude Agents
              </PageHeader.Title>
            </PageHeader>
          </PageLayout.Column>
        </PageLayout.Row>
      </PageLayout.TopArea>

      {isLoading ? (
        <EntityListSkeleton columns="1fr auto auto auto auto" />
      ) : (
        <EntityList columns="1fr auto auto auto auto">
          <EntityList.Top>
            <EntityList.TopCell>Name</EntityList.TopCell>
            <EntityList.TopCell>Model</EntityList.TopCell>
            <EntityList.TopCell className="text-center">Tools</EntityList.TopCell>
            <EntityList.TopCell className="text-center">Workflows</EntityList.TopCell>
            <EntityList.TopCell className="text-center">Agents</EntityList.TopCell>
          </EntityList.Top>

          {(agents ?? []).map(agent => (
            <EntityList.RowLink
              key={agent.id}
              to={paths.claudeAgentNewSessionLink(agent.id)}
              LinkComponent={Link}
            >
              <EntityList.NameCell>{truncateString(agent.name ?? agent.id, 60)}</EntityList.NameCell>
              <EntityList.TextCell>{agent.model ?? 'default'}</EntityList.TextCell>
              <EntityList.TextCell className="text-center">{agent.toolCount || ''}</EntityList.TextCell>
              <EntityList.TextCell className="text-center">{agent.workflowCount || ''}</EntityList.TextCell>
              <EntityList.TextCell className="text-center">{agent.agentCount || ''}</EntityList.TextCell>
            </EntityList.RowLink>
          ))}
        </EntityList>
      )}
    </PageLayout>
  );
}

export default ClaudeAgents;
