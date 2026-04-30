import { Mastra } from '@mastra/core/mastra';
import { supportAgent } from './agents/support-agent.js';
import { mastraStorage } from './storage/mastra-storage.js';

export const mastra = new Mastra({
  agents: {
    supportAgent,
  },
  storage: mastraStorage,
});
