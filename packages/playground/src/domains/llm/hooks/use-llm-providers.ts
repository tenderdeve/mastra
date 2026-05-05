import type { Provider } from '@mastra/client-js';
import { useMastraClient } from '@mastra/react';
import { useQuery } from '@tanstack/react-query';

type LLMProvidersResponse = { providers: Provider[] };

export const useLLMProviders = () => {
  const client = useMastraClient();

  return useQuery<LLMProvidersResponse>({
    queryKey: ['llm-providers'],
    queryFn: async () => client.listAgentsModelProviders() as unknown as LLMProvidersResponse,
    retry: false,
  });
};
