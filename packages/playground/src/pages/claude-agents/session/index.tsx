import { AgentIcon, ErrorState, NoDataPageLayout } from '@mastra/playground-ui';
import { Loader2 } from 'lucide-react';
import { useParams } from 'react-router';
import { ClaudeAgentChat } from '@/domains/claude-agents/components/claude-agent-chat';
import { useClaudeAgent } from '@/domains/claude-agents/hooks/use-claude-agents';

export function ClaudeAgentSessionPage() {
  const { agentId, sessionId } = useParams<{ agentId: string; sessionId: string }>();
  const { data: agent, isLoading, error } = useClaudeAgent(agentId);

  if (error) {
    return (
      <NoDataPageLayout title="Claude Agent" icon={<AgentIcon />}>
        <ErrorState title="Failed to load Claude agent" message={error.message} />
      </NoDataPageLayout>
    );
  }

  if (isLoading || !agent) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-icon3" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border1 px-4 py-3">
        <h1 className="flex items-center gap-2 text-sm font-medium">
          <AgentIcon /> {agent.name ?? agent.id}
        </h1>
        {agent.model ? <p className="text-xs text-icon3">{agent.model}</p> : null}
      </header>
      <div className="flex-1 overflow-hidden">
        <ClaudeAgentChat
          key={`${agent.id}:${sessionId ?? 'new'}`}
          agent={agent}
          sessionId={sessionId ?? 'new'}
        />
      </div>
    </div>
  );
}

export default ClaudeAgentSessionPage;
