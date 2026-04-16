import { useMastraClient } from '@mastra/react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const HEARTBEATS_KEY = 'heartbeats';

export function useHeartbeats(agentId: string) {
  const client = useMastraClient();

  return useQuery({
    queryKey: [HEARTBEATS_KEY, agentId],
    queryFn: () => client.getAgent(agentId).listHeartbeats(),
    enabled: Boolean(agentId),
  });
}

export function useSetHeartbeat(agentId: string) {
  const client = useMastraClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { threadId: string; enabled?: boolean; intervalMs?: number; prompt?: string }) =>
      client.getAgent(agentId).setHeartbeat(params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [HEARTBEATS_KEY, agentId] });
    },
  });
}

export function useDeleteHeartbeat(agentId: string) {
  const client = useMastraClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (threadId: string) => client.getAgent(agentId).deleteHeartbeat(threadId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [HEARTBEATS_KEY, agentId] });
    },
  });
}
