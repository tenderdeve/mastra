// @vitest-environment jsdom
import type * as PlaygroundUi from '@mastra/playground-ui';
import { MastraReactProvider } from '@mastra/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentBuilderLibraryPage from '..';
import { LinkComponentProvider } from '@/lib/framework';
import { server } from '@/test/msw-server';

vi.mock('@mastra/playground-ui', async () => {
  const actual = await vi.importActual<typeof PlaygroundUi>('@mastra/playground-ui');
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn() },
    usePlaygroundStore: () => ({ requestContext: undefined }),
  };
});

const BASE_URL = 'http://localhost:4111';

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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <MastraReactProvider baseUrl={BASE_URL}>
      <QueryClientProvider client={queryClient}>
        <LinkComponentProvider Link={StubLink as never} navigate={() => {}} paths={noopPaths}>
          <AgentBuilderLibraryPage />
        </LinkComponentProvider>
      </QueryClientProvider>
    </MastraReactProvider>,
  );
}

type AgentFixture = {
  id: string;
  name: string;
  description?: string;
  source: 'code' | 'stored';
};

function agentsResponse(agents: AgentFixture[]) {
  return Object.fromEntries(
    agents.map(a => [
      a.id,
      {
        id: a.id,
        name: a.name,
        description: a.description ?? '',
        source: a.source,
        instructions: '',
        tools: {},
        workflows: {},
        agents: {},
        provider: 'openai',
        modelId: 'gpt-4',
      },
    ]),
  );
}

function mockAgents(agents: AgentFixture[]) {
  server.use(http.get(`${BASE_URL}/api/agents`, () => HttpResponse.json(agentsResponse(agents))));
}

function mockBuilderSettings(library?: { visibleAgents: string[]; unrestricted: boolean }) {
  server.use(
    http.get(`${BASE_URL}/api/editor/builder/settings`, () =>
      HttpResponse.json({
        enabled: true,
        features: { agent: {} },
        configuration: { agent: {} },
        modelPolicy: { active: false },
        modelPolicyWarnings: [],
        ...(library ? { library } : {}),
      }),
    ),
  );
}

describe('AgentBuilderLibraryPage', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders code-defined agents and filters out stored-source rows', async () => {
    mockBuilderSettings();
    mockAgents([
      { id: 'c1', name: 'Code One', description: 'Defined in code', source: 'code' },
      { id: 'c2', name: 'Code Two', description: 'Also code', source: 'code' },
      { id: 's1', name: 'Stored One', description: 'Stored agent', source: 'stored' },
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Code One')).toBeTruthy();
    });
    expect(screen.getByText('Code Two')).toBeTruthy();
    expect(screen.queryByText('Stored One')).toBeNull();

    const rows = screen.getAllByTestId('library-agent-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('href')).toBe('/agent-builder/agents/c1/view');
  });

  it('respects library.visibleAgents allowlist', async () => {
    mockBuilderSettings({ visibleAgents: ['c1'], unrestricted: false });
    mockAgents([
      { id: 'c1', name: 'Allowed', description: '', source: 'code' },
      { id: 'c2', name: 'Hidden', description: '', source: 'code' },
    ]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Allowed')).toBeTruthy();
    });
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  it('shows the restricted empty state when allowlist is empty', async () => {
    mockBuilderSettings({ visibleAgents: [], unrestricted: false });
    mockAgents([{ id: 'c1', name: 'Code One', description: '', source: 'code' }]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No agents in the library')).toBeTruthy();
    });
    expect(screen.queryByTestId('library-agent-row')).toBeNull();
  });

  it('shows the unrestricted empty state when no code agents exist', async () => {
    mockBuilderSettings();
    mockAgents([{ id: 's1', name: 'Stored Only', description: '', source: 'stored' }]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No code-defined agents')).toBeTruthy();
    });
  });

  it('shows the error state when /agents returns 500', async () => {
    mockBuilderSettings();
    server.use(http.get(`${BASE_URL}/api/agents`, () => HttpResponse.json({ message: 'boom' }, { status: 500 })));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Failed to load the library')).toBeTruthy();
    });
  });

  it('shows SessionExpired when /agents returns 401', async () => {
    mockBuilderSettings();
    server.use(
      http.get(`${BASE_URL}/api/agents`, () => HttpResponse.json({ message: 'unauthorized' }, { status: 401 })),
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/session expired/i)).toBeTruthy();
    });
  });
});
