import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows/evented';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import { RedisStreamsPubSub } from '../src/index.js';

export const inputSchema = z.object({ name: z.string() });
export const outputSchema = z.object({ greeting: z.string() });

const greet = createStep({
  id: 'greet',
  inputSchema,
  outputSchema,
  execute: async ({ inputData }) => {
    return { greeting: `hello, ${inputData.name}` };
  },
});

export function buildWorkflow() {
  const wf = createWorkflow({
    id: 'cross-process-greet',
    inputSchema,
    outputSchema,
  });
  wf.then(greet).commit();
  return wf;
}

const pipelineInput = z.object({ name: z.string() });
const pipelineOutput = z.object({ shouted: z.string() });

const normalize = createStep({
  id: 'normalize',
  inputSchema: pipelineInput,
  outputSchema: z.object({ name: z.string() }),
  execute: async ({ inputData }) => {
    return { name: inputData.name.trim().toLowerCase() };
  },
});

const greetPipeline = createStep({
  id: 'greet-pipeline',
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
  execute: async ({ inputData }) => {
    return { greeting: `hello, ${inputData.name}` };
  },
});

const shout = createStep({
  id: 'shout',
  inputSchema: z.object({ greeting: z.string() }),
  outputSchema: pipelineOutput,
  execute: async ({ inputData }) => {
    return { shouted: `${inputData.greeting.toUpperCase()}!` };
  },
});

export function buildPipelineWorkflow() {
  const wf = createWorkflow({
    id: 'cross-process-pipeline',
    inputSchema: pipelineInput,
    outputSchema: pipelineOutput,
  });
  wf.then(normalize).then(greetPipeline).then(shout).commit();
  return wf;
}

export function buildMastra(opts: { storageUrl: string; redisUrl: string }) {
  return new Mastra({
    workflows: {
      'cross-process-greet': buildWorkflow(),
      'cross-process-pipeline': buildPipelineWorkflow(),
    },
    storage: new LibSQLStore({ id: 'mastra-storage', url: opts.storageUrl }),
    pubsub: new RedisStreamsPubSub({ url: opts.redisUrl }),
    logger: false,
    server: {
      middleware: [
        async (c, next) => {
          if (c.req.path.includes('/steps/execute')) {
            // Marker line for cross-process.test.ts to assert that the
            // standalone worker actually called back to the server.
            console.info(`step-execute-hit path=${c.req.path}`);
          }
          await next();
        },
      ],
    },
  });
}
