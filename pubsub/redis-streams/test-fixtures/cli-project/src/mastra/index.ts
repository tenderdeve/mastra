import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows/evented';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';

const greet = createStep({
  id: 'greet',
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
  execute: async ({ inputData }) => ({ greeting: `hello, ${inputData.name}` }),
});

const wf = createWorkflow({
  id: 'cli-project-greet',
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
});
wf.then(greet).commit();

export const mastra = new Mastra({
  workflows: { 'cli-project-greet': wf },
  storage: new LibSQLStore({ id: 'mastra-storage', url: process.env.STORAGE_URL ?? 'file::memory:' }),
  logger: false,
});
