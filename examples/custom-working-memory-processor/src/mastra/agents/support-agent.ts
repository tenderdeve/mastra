import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { CustomWorkingMemoryProcessor } from '../processors/custom-working-memory.js';
import { createCustomWorkingMemoryStore } from '../storage/custom-working-memory-store.js';
import { mastraStorage } from '../storage/mastra-storage.js';

export const memory = new Memory({
  storage: mastraStorage,
  options: {
    workingMemory: {
      enabled: true,
      version: 'vnext',
    },
  },
});
const customWorkingMemoryStore = createCustomWorkingMemoryStore(memory);

const customWorkingMemoryProcessor = new CustomWorkingMemoryProcessor({
  store: customWorkingMemoryStore,
  buildNextMemory: async ({ currentMemory, messages, responseText }) => {
    const nextMemory = mergeUserFacts(currentMemory, messages);

    if (nextMemory === currentMemory) {
      return currentMemory;
    }

    console.log('\n[custom-working-memory] Updated memory after response:');
    console.log(nextMemory);
    console.log(`[custom-working-memory] Response length: ${responseText.length} characters\n`);

    return nextMemory;
  },
});

export const supportAgent = new Agent({
  id: 'support-agent',
  name: 'Support Agent',
  instructions: `You are a concise support assistant.

If <working_memory> context is present, use it to personalize the answer. Do not mention the XML tags.`,
  model: 'openai/gpt-5-mini',
  memory,
  inputProcessors: [customWorkingMemoryProcessor],
  outputProcessors: [customWorkingMemoryProcessor],
});

function mergeUserFacts(currentMemory: string, messages: unknown[]) {
  const facts = parseMemory(currentMemory);
  const text = messages.map(extractText).join('\n');

  const name = text.match(/\bmy name is ([A-Z][a-zA-Z'-]*)/i)?.[1];
  if (name) {
    facts.set('Name', name);
  }

  const preference = text.match(/\bi prefer ([^.!?\n]+)/i)?.[1]?.trim();
  if (preference) {
    facts.set('Preference', preference);
  }

  const goal = text.match(/\bmy current goal is ([^.!?\n]+)/i)?.[1]?.trim();
  if (goal) {
    facts.set('Current goal', goal);
  }

  const supportTier = text.match(/\bmy support tier is ([^.!?\n]+)/i)?.[1]?.trim();
  if (supportTier) {
    facts.set('Support tier', supportTier);
  }

  return formatMemory(facts);
}

function parseMemory(memory: string) {
  const facts = new Map<string, string>();

  for (const line of memory.split('\n')) {
    const match = line.match(/^- ([^:]+):\s*(.*)$/);
    if (match?.[1] && match[2]) {
      facts.set(match[1], match[2]);
    }
  }

  return facts;
}

function formatMemory(facts: Map<string, string>) {
  if (facts.size === 0) {
    return '';
  }

  const lines = ['# User Profile'];

  for (const key of ['Name', 'Preference', 'Current goal', 'Support tier']) {
    const value = facts.get(key);
    if (value) {
      lines.push(`- ${key}: ${value}`);
    }
  }

  return lines.join('\n');
}

function extractTextPart(part: unknown): string {
  return typeof part === 'object' && part && 'text' in part && typeof part.text === 'string' ? part.text : '';
}

function extractText(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return '';
  }

  const content = 'content' in message ? message.content : undefined;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(extractTextPart).join('\n');
  }

  if (content && typeof content === 'object' && 'parts' in content && Array.isArray(content.parts)) {
    return content.parts.map(extractTextPart).join('\n');
  }

  return '';
}
