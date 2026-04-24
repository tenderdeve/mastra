import type {
  ClaudeAgentSessionResponse,
  ClaudeAgentSummary,
  CreateClaudeAgentSessionParams,
  ListClaudeAgentSessionsParams,
  ListClaudeAgentSessionsResponse,
  ResolveClaudeAgentApprovalParams,
  ResolveClaudeAgentQuestionParams,
  StreamClaudeAgentTurnParams,
  UpdateClaudeAgentSessionParams,
} from '@mastra/client-js';
import { useMastraClient } from '@mastra/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const agentsKey = ['claude-agents'] as const;
const agentKey = (agentId: string) => ['claude-agents', agentId] as const;
const sessionsKey = (agentId: string, params?: ListClaudeAgentSessionsParams) =>
  ['claude-agents', agentId, 'sessions', params ?? null] as const;
const sessionKey = (agentId: string, sessionId: string) =>
  ['claude-agents', agentId, 'sessions', sessionId] as const;

export const useClaudeAgents = () => {
  const client = useMastraClient();
  return useQuery<ClaudeAgentSummary[]>({
    queryKey: agentsKey,
    queryFn: async () => {
      const result = await client.listClaudeAgents();
      return result.agents;
    },
  });
};

export const useClaudeAgent = (agentId: string | undefined) => {
  const client = useMastraClient();
  return useQuery<ClaudeAgentSummary>({
    queryKey: agentKey(agentId ?? ''),
    queryFn: () => client.getClaudeAgent(agentId!).details(),
    enabled: Boolean(agentId),
  });
};

export const useClaudeAgentSessions = (agentId: string | undefined, params?: ListClaudeAgentSessionsParams) => {
  const client = useMastraClient();
  return useQuery<ListClaudeAgentSessionsResponse>({
    queryKey: sessionsKey(agentId ?? '', params),
    queryFn: () => client.getClaudeAgent(agentId!).listSessions(params),
    enabled: Boolean(agentId),
  });
};

export const useClaudeAgentSession = (agentId: string | undefined, sessionId: string | undefined) => {
  const client = useMastraClient();
  return useQuery<ClaudeAgentSessionResponse>({
    queryKey: sessionKey(agentId ?? '', sessionId ?? ''),
    queryFn: () => client.getClaudeAgent(agentId!).getSession(sessionId!),
    enabled: Boolean(agentId && sessionId && sessionId !== 'new'),
  });
};

export const useCreateClaudeAgentSession = (agentId: string) => {
  const client = useMastraClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: CreateClaudeAgentSessionParams) => client.getClaudeAgent(agentId).createSession(params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['claude-agents', agentId, 'sessions'] });
    },
  });
};

export const useUpdateClaudeAgentSession = (agentId: string, sessionId: string) => {
  const client = useMastraClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: UpdateClaudeAgentSessionParams) =>
      client.getClaudeAgent(agentId).updateSession(sessionId, params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKey(agentId, sessionId) });
      void queryClient.invalidateQueries({ queryKey: ['claude-agents', agentId, 'sessions'] });
    },
  });
};

export const useDeleteClaudeAgentSession = (agentId: string) => {
  const client = useMastraClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => client.getClaudeAgent(agentId).deleteSession(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['claude-agents', agentId, 'sessions'] });
    },
  });
};

export const useResolveClaudeAgentApproval = (agentId: string, sessionId: string) => {
  const client = useMastraClient();
  return useMutation({
    mutationFn: ({ approvalId, params }: { approvalId: string; params: ResolveClaudeAgentApprovalParams }) =>
      client.getClaudeAgent(agentId).resolveApproval(sessionId, approvalId, params),
  });
};

export const useResolveClaudeAgentQuestion = (agentId: string, sessionId: string) => {
  const client = useMastraClient();
  return useMutation({
    mutationFn: ({ questionId, params }: { questionId: string; params: ResolveClaudeAgentQuestionParams }) =>
      client.getClaudeAgent(agentId).resolveQuestion(sessionId, questionId, params),
  });
};

export type ClaudeAgentStreamHandle = {
  response: Response;
  cancel: () => void;
};

export const useStreamClaudeAgentTurn = (agentId: string) => {
  const client = useMastraClient();
  return async (sessionId: string, params: StreamClaudeAgentTurnParams): Promise<Response> => {
    return client.getClaudeAgent(agentId).streamTurn(sessionId, params);
  };
};
