import type { GetAgentResponse, StoredSkillResponse } from '@mastra/client-js';
import { Button, Spinner } from '@mastra/playground-ui';
import { useEffect, useMemo, useState } from 'react';
import { FormProvider, useForm, useFormContext, useWatch } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router';
import { useBuilderAgentFeatures } from '@/domains/agent-builder';
import {
  AgentChatPanelChat,
  AgentChatPanelProvider,
} from '@/domains/agent-builder/components/agent-builder-edit/agent-chat-panel';
import type { ActiveDetail } from '@/domains/agent-builder/components/agent-builder-edit/agent-configure-panel';
import { ConfigurePanelConnected } from '@/domains/agent-builder/components/agent-builder-edit/configure-panel-connected';
import { useStreamRunning } from '@/domains/agent-builder/components/agent-builder-edit/stream-chat-context';
import { VisibilitySelect } from '@/domains/agent-builder/components/agent-builder-edit/visibility-select';
import { WorkspaceLayout } from '@/domains/agent-builder/components/agent-builder-edit/workspace-layout';
import { useAvailableAgentTools } from '@/domains/agent-builder/hooks/use-available-agent-tools';
import { codeAgentToAgentConfig } from '@/domains/agent-builder/mappers/code-agent-to-agent-config';
import { codeAgentToFormValues } from '@/domains/agent-builder/mappers/code-agent-to-form-values';
import { storedAgentToAgentConfig } from '@/domains/agent-builder/mappers/stored-agent-to-agent-config';
import { storedAgentToFormValues } from '@/domains/agent-builder/mappers/stored-agent-to-form-values';
import type { AgentBuilderEditFormValues } from '@/domains/agent-builder/schemas';
import { BrowserViewPanel } from '@/domains/agents/components/browser-view';
import { BrowserSessionProvider } from '@/domains/agents/context/browser-session-context';
import { BrowserToolCallsProvider } from '@/domains/agents/context/browser-tool-calls-context';
import { useAgents } from '@/domains/agents/hooks/use-agents';
import type { StoredAgent } from '@/domains/agents/hooks/use-stored-agents';
import { useStoredAgent } from '@/domains/agents/hooks/use-stored-agents';
import { useStoredSkills } from '@/domains/agents/hooks/use-stored-skills';
import { useCurrentUser } from '@/domains/auth/hooks/use-current-user';
import { useTools } from '@/domains/tools/hooks/use-all-tools';
import { useWorkflows } from '@/domains/workflows/hooks/use-workflows';

type ToolsData = NonNullable<ReturnType<typeof useTools>['data']>;
type AgentsData = NonNullable<ReturnType<typeof useAgents>['data']>;
type WorkflowsData = NonNullable<ReturnType<typeof useWorkflows>['data']>;

export default function AgentBuilderAgentView() {
  const { id } = useParams<{ id: string }>();
  const features = useBuilderAgentFeatures();
  const { data: storedAgent, isLoading: isStoredAgentLoading } = useStoredAgent(id, { status: 'draft' });
  const { data: toolsData, isPending: isToolsPending } = useTools({ enabled: features.tools });
  const { data: agentsData, isPending: isAgentsPending } = useAgents({ enabled: features.agents });
  const { data: workflowsData, isPending: isWorkflowsPending } = useWorkflows({ enabled: features.workflows });
  const { data: storedSkillsResponse, isPending: isSkillsPending } = useStoredSkills({ enabled: features.skills });

  // Stored fetch returns null on 404. For code-defined agents (no stored override),
  // fall back to the /agents response so the Library can route to this view.
  const shouldLookUpCodeAgent = !isStoredAgentLoading && storedAgent == null && Boolean(id);
  const { data: allAgentsData, isPending: isAllAgentsPending } = useAgents({ enabled: shouldLookUpCodeAgent });
  const codeAgent =
    shouldLookUpCodeAgent && id && allAgentsData && allAgentsData[id]?.source === 'code'
      ? allAgentsData[id]
      : undefined;

  const isReady =
    Boolean(id) &&
    !isStoredAgentLoading &&
    (!features.tools || !isToolsPending) &&
    (!features.skills || !isSkillsPending) &&
    (!features.agents || !isAgentsPending) &&
    (!features.workflows || !isWorkflowsPending) &&
    (!shouldLookUpCodeAgent || !isAllAgentsPending);

  if (!isReady) return <AgentBuilderAgentViewSkeleton />;

  return (
    <AgentBuilderAgentViewPage
      id={id}
      storedAgent={storedAgent}
      codeAgent={codeAgent}
      toolsData={toolsData}
      agentsData={agentsData}
      workflowsData={workflowsData}
      storedSkillsResponse={storedSkillsResponse}
    />
  );
}

interface PageProps {
  id: string | undefined;
  storedAgent: StoredAgent | null | undefined;
  codeAgent: GetAgentResponse | undefined;
  toolsData: ToolsData | undefined;
  agentsData: AgentsData | undefined;
  workflowsData: WorkflowsData | undefined;
  storedSkillsResponse: ReturnType<typeof useStoredSkills>['data'];
}

const AgentBuilderAgentViewPage = ({
  id,
  storedAgent,
  codeAgent,
  toolsData,
  agentsData,
  workflowsData,
  storedSkillsResponse,
}: PageProps) => {
  const defaultValues = useMemo(
    () => (codeAgent ? codeAgentToFormValues(codeAgent) : storedAgentToFormValues(storedAgent)),
    [codeAgent, storedAgent],
  );
  const formMethods = useForm<AgentBuilderEditFormValues>({ defaultValues });

  useEffect(() => {
    formMethods.reset(defaultValues);
  }, [defaultValues, formMethods]);

  return (
    <FormProvider {...formMethods}>
      <AgentBuilderAgentViewReady
        id={id!}
        storedAgent={storedAgent}
        codeAgent={codeAgent}
        toolsData={toolsData ?? {}}
        agentsData={agentsData ?? {}}
        workflowsData={workflowsData ?? {}}
        storedSkillsResponse={storedSkillsResponse}
      />
    </FormProvider>
  );
};

const AgentBuilderAgentViewSkeleton = () => (
  <div className="h-screen w-screen flex items-center justify-center">
    <Spinner />
  </div>
);

interface AgentBuilderAgentViewReadyProps {
  id: string;
  storedAgent: StoredAgent | null | undefined;
  codeAgent: GetAgentResponse | undefined;
  toolsData: ToolsData;
  agentsData: AgentsData;
  workflowsData: WorkflowsData;
  storedSkillsResponse: ReturnType<typeof useStoredSkills>['data'];
}

const AgentBuilderAgentViewReady = ({
  id,
  storedAgent,
  codeAgent,
  toolsData,
  agentsData,
  workflowsData,
  storedSkillsResponse,
}: AgentBuilderAgentViewReadyProps) => {
  const navigate = useNavigate();
  const [activeDetail, setActiveDetail] = useState<ActiveDetail>(null);
  const formMethods = useFormContext<AgentBuilderEditFormValues>();
  const selectedTools = useWatch({ control: formMethods.control, name: 'tools' });
  const selectedAgents = useWatch({ control: formMethods.control, name: 'agents' });
  const selectedWorkflows = useWatch({ control: formMethods.control, name: 'workflows' });
  const { data: currentUser } = useCurrentUser();
  const isCodeAgent = codeAgent != null;
  const isOwner = !isCodeAgent && (!storedAgent?.authorId || currentUser?.id === storedAgent?.authorId);

  const availableAgentTools = useAvailableAgentTools({
    toolsData,
    agentsData,
    workflowsData,
    selectedTools,
    selectedAgents,
    selectedWorkflows,
    excludeAgentId: id,
  });

  const agent = useMemo(
    () => (codeAgent ? codeAgentToAgentConfig(codeAgent, id) : storedAgentToAgentConfig(storedAgent, id ?? '')),
    [codeAgent, storedAgent, id],
  );

  const availableSkills = useMemo<StoredSkillResponse[]>(
    () => storedSkillsResponse?.skills ?? [],
    [storedSkillsResponse],
  );

  const features = useBuilderAgentFeatures();
  const hasBrowser = features.browser && storedAgent?.browser != null;

  const content = (
    <AgentChatPanelProvider
      agentId={id}
      agentName={agent.name}
      agentDescription={agent.description}
      agentAvatarUrl={agent.avatarUrl}
    >
      <WorkspaceLayout
        isLoading={false}
        mode="test"
        defaultExpanded={false}
        detailOpen={activeDetail !== null}
        modeAction={isCodeAgent ? null : <VisibilitySelect disabled />}
        primaryAction={
          isOwner ? (
            <ViewHeaderActions onEdit={() => navigate(`/agent-builder/agents/${id}/edit`, { viewTransition: true })} />
          ) : undefined
        }
        chat={<AgentChatPanelChat hasBrowser={hasBrowser} hideBrowserSidebar />}
        configure={
          <ConfigurePanelConnected
            editable={false}
            agent={agent}
            availableAgentTools={availableAgentTools}
            availableSkills={availableSkills}
            activeDetail={activeDetail}
            onActiveDetailChange={setActiveDetail}
          />
        }
        browserOverlay={hasBrowser ? <BrowserViewPanel hideSidebar /> : undefined}
      />
    </AgentChatPanelProvider>
  );

  if (!hasBrowser) return content;

  return (
    <BrowserToolCallsProvider>
      <BrowserSessionProvider agentId={id} threadId={id}>
        {content}
      </BrowserSessionProvider>
    </BrowserToolCallsProvider>
  );
};

const ViewHeaderActions = ({ onEdit }: { onEdit: () => void }) => {
  const isRunning = useStreamRunning();
  return (
    <Button size="sm" variant="default" onClick={onEdit} disabled={isRunning} data-testid="agent-builder-view-edit">
      Edit configuration
    </Button>
  );
};
