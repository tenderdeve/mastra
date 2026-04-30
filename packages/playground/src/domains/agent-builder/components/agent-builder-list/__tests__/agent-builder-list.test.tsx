// @vitest-environment jsdom
import { TooltipProvider } from '@mastra/playground-ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentBuilderList, AgentBuilderListSkeleton } from '../agent-builder-list';
import type { AgentBuilderListProps, LibraryAgentRow } from '../agent-builder-list';
import { LinkComponentProvider } from '@/lib/framework';

vi.mock('@mastra/playground-ui', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

vi.mock('@/domains/agents/components/star-button', () => ({
  StarButton: () => <button type="button" aria-label="Star agent" />,
}));

const StubLink = ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
  <a {...props}>{children}</a>
);

const noopPaths = {
  agentLink: () => '',
  agentMessageLink: () => '',
  workflowLink: () => '',
  toolLink: () => '',
  scoreLink: () => '',
  scorerLink: () => '',
  toolByAgentLink: () => '',
  toolByWorkflowLink: () => '',
  promptLink: () => '',
  legacyWorkflowLink: () => '',
  policyLink: () => '',
  vNextNetworkLink: () => '',
  agentBuilderLink: () => '',
  mcpServerLink: () => '',
  mcpServerToolLink: () => '',
  workflowRunLink: () => '',
  datasetLink: () => '',
  datasetItemLink: () => '',
  datasetExperimentLink: () => '',
  experimentLink: () => '',
} as never;

function renderList({ agents, search, ...props }: AgentBuilderListProps) {
  return render(
    <TooltipProvider>
      <LinkComponentProvider Link={StubLink as never} navigate={() => {}} paths={noopPaths}>
        <AgentBuilderList agents={agents} search={search} {...props} />
      </LinkComponentProvider>
    </TooltipProvider>,
  );
}

const fixtureAgents: LibraryAgentRow[] = [
  {
    id: 'a1',
    name: 'Alpha Agent',
    description: 'First agent description',
    source: 'stored',
    visibility: 'private',
  },
  {
    id: 'a2',
    name: 'Beta Agent',
    description: 'Second agent description',
    source: 'stored',
    visibility: 'public',
  },
];

const codeAgents: LibraryAgentRow[] = [
  {
    id: 'c1',
    name: 'Code Agent',
    description: 'Defined in code',
    source: 'code',
  },
];

describe('AgentBuilderList', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows a private lock icon with tooltip copy inline with private agent titles', () => {
    renderList({ agents: fixtureAgents });

    expect(screen.getAllByTestId('agent-builder-private-visibility-icon')).toHaveLength(1);
    expect(screen.queryByText('Private')).toBeNull();
    expect(screen.queryByText('Public')).toBeNull();
    expect(screen.getByText('Only visible to you')).toBeTruthy();
  });

  it('renders agent name and description without technical metadata', () => {
    renderList({ agents: fixtureAgents });

    expect(screen.getByText('Alpha Agent')).toBeTruthy();
    expect(screen.getByText('First agent description')).toBeTruthy();
    expect(screen.getByText('Beta Agent')).toBeTruthy();
    expect(screen.queryByText('openai/gpt-4')).toBeNull();
    expect(screen.queryByText('anthropic/claude')).toBeNull();
    expect(screen.queryByText(/Updated/)).toBeNull();
  });

  it('filters by search prop', () => {
    renderList({ agents: fixtureAgents, search: 'alpha' });

    expect(screen.getByText('Alpha Agent')).toBeTruthy();
    expect(screen.queryByText('Beta Agent')).toBeNull();
  });

  it('links rows to the agent view page', () => {
    renderList({ agents: fixtureAgents, rowTestId: 'agent-row' });

    const rows = screen.getAllByTestId('agent-row');
    expect(rows).toHaveLength(fixtureAgents.length);
    for (const [i, row] of rows.entries()) {
      expect(row.getAttribute('href')).toBe(`/agent-builder/agents/${fixtureAgents[i].id}/view`);
    }
  });

  it('filters by description', () => {
    renderList({ agents: fixtureAgents, search: 'second agent' });

    expect(screen.getByText('Beta Agent')).toBeTruthy();
    expect(screen.queryByText('Alpha Agent')).toBeNull();
  });

  it('shows empty state when no rows match', () => {
    renderList({ agents: fixtureAgents, search: 'zzz', rowTestId: 'agent-row' });

    expect(screen.getByText('No agents match your search')).toBeTruthy();
    expect(screen.queryByTestId('agent-row')).toBeNull();
  });

  it('supports the library list presentation', () => {
    renderList({
      agents: fixtureAgents,
      rowTestId: 'library-agent-row',
    });

    expect(screen.getAllByTestId('library-agent-row')).toHaveLength(fixtureAgents.length);
    expect(screen.queryByText('Private')).toBeNull();
  });

  it('hides star button and lock icon for code-defined rows', () => {
    renderList({ agents: codeAgents, rowTestId: 'agent-row' });

    expect(screen.getByText('Code Agent')).toBeTruthy();
    expect(screen.queryByLabelText('Star agent')).toBeNull();
    expect(screen.queryByTestId('agent-builder-private-visibility-icon')).toBeNull();
  });

  it('shows the star button for stored rows', () => {
    renderList({ agents: fixtureAgents, rowTestId: 'agent-row' });

    expect(screen.getAllByLabelText('Star agent')).toHaveLength(fixtureAgents.length);
  });
});

describe('AgentBuilderListSkeleton', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the requested number of rows for the library presentation', () => {
    render(<AgentBuilderListSkeleton rows={6} rowTestId="library-skeleton-row" />);

    expect(screen.getAllByTestId('library-skeleton-row')).toHaveLength(6);
  });

  it('defaults to 4 rows', () => {
    render(<AgentBuilderListSkeleton rowTestId="library-skeleton-row" />);

    expect(screen.getAllByTestId('library-skeleton-row')).toHaveLength(4);
  });
});
