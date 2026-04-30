import type { MastraDBMessage, MemoryRequestContext } from '@mastra/core/memory';
import type { Processor, ProcessInputArgs, ProcessOutputResultArgs } from '@mastra/core/processors';
import type { CustomWorkingMemoryStore } from '../storage/custom-working-memory-store.js';

type CustomWorkingMemoryProcessorOptions = {
  store: CustomWorkingMemoryStore;
  buildNextMemory: (args: {
    currentMemory: string;
    messages: MastraDBMessage[];
    responseText: string;
  }) => Promise<string>;
};

export class CustomWorkingMemoryProcessor implements Processor {
  id = 'custom-working-memory';

  constructor(private options: CustomWorkingMemoryProcessorOptions) {}

  async processInput({ messages, systemMessages, requestContext, state }: ProcessInputArgs) {
    const memoryContext = requestContext?.get<'MastraMemory', MemoryRequestContext>('MastraMemory');
    const threadId = memoryContext?.thread?.id;
    const resourceId = memoryContext?.resourceId;

    if (!threadId || !resourceId) {
      return { messages, systemMessages };
    }

    const currentMemory =
      (await this.options.store.get({
        threadId,
        resourceId,
      })) ?? '';

    state.currentWorkingMemory = currentMemory;
    state.currentRequestMessages = messages;

    return {
      messages,
      systemMessages: [
        ...systemMessages,
        {
          role: 'system' as const,
          content: `<working_memory>\n${currentMemory}\n</working_memory>`,
        },
      ],
    };
  }

  async processOutputResult({ messages, result, requestContext, state }: ProcessOutputResultArgs) {
    const memoryContext = requestContext?.get<'MastraMemory', MemoryRequestContext>('MastraMemory');
    const threadId = memoryContext?.thread?.id;
    const resourceId = memoryContext?.resourceId;

    if (!threadId || !resourceId) {
      return messages;
    }

    const currentMemory = typeof state.currentWorkingMemory === 'string' ? state.currentWorkingMemory : '';
    const requestMessages = Array.isArray(state.currentRequestMessages) ? state.currentRequestMessages : messages;
    const nextMemory = await this.options.buildNextMemory({
      currentMemory,
      messages: requestMessages,
      responseText: result.text,
    });

    if (nextMemory === currentMemory) {
      return messages;
    }

    await this.options.store.set({
      threadId,
      resourceId,
      workingMemory: nextMemory,
    });

    return messages;
  }
}
