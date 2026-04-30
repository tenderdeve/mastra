import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Memory } from '@mastra/memory';

const CUSTOM_WORKING_MEMORY_METADATA_KEY = 'customWorkingMemory';

export type CustomWorkingMemoryStore = {
  get: (args: { threadId: string; resourceId: string }) => Promise<string | null>;
  set: (args: { threadId: string; resourceId: string; workingMemory: string }) => Promise<void>;
};

type StoredWorkingMemory = Record<string, string>;

export class ThreadMetadataWorkingMemoryStore implements CustomWorkingMemoryStore {
  constructor(
    private memory: Memory,
    private options: { debugStore?: CustomWorkingMemoryStore } = {},
  ) {}

  async get({ threadId }: { threadId: string; resourceId: string }) {
    const thread = await this.memory.getThreadById({ threadId });
    const workingMemory = thread?.metadata?.[CUSTOM_WORKING_MEMORY_METADATA_KEY];

    return typeof workingMemory === 'string' ? workingMemory : null;
  }

  async set({ threadId, resourceId, workingMemory }: { threadId: string; resourceId: string; workingMemory: string }) {
    const thread = await this.memory.getThreadById({ threadId });

    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    await this.memory.updateThread({
      id: threadId,
      title: thread.title ?? threadId,
      metadata: {
        ...thread.metadata,
        [CUSTOM_WORKING_MEMORY_METADATA_KEY]: workingMemory,
      },
    });

    await this.options.debugStore?.set({
      threadId,
      resourceId,
      workingMemory,
    });
  }
}

export class JsonWorkingMemoryStore implements CustomWorkingMemoryStore {
  private path: string;

  constructor(path = './custom-working-memory.json') {
    this.path = resolve(path);
  }

  async get({ threadId, resourceId }: { threadId: string; resourceId: string }) {
    const records = await this.read();
    return records[this.key(threadId, resourceId)] ?? null;
  }

  async set({ threadId, resourceId, workingMemory }: { threadId: string; resourceId: string; workingMemory: string }) {
    const records = await this.read();
    records[this.key(threadId, resourceId)] = workingMemory;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(records, null, 2)}\n`);
  }

  private async read(): Promise<StoredWorkingMemory> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as StoredWorkingMemory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }

      throw error;
    }
  }

  private key(threadId: string, resourceId: string) {
    return `${resourceId}:${threadId}`;
  }
}

export function createCustomWorkingMemoryStore(memory: Memory) {
  return new ThreadMetadataWorkingMemoryStore(memory, {
    debugStore: new JsonWorkingMemoryStore(),
  });
}
