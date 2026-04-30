import { readFile } from 'node:fs/promises';
import { memory, supportAgent } from './mastra/agents/support-agent.js';

const thread = 'demo-thread';
const resource = 'demo-user';

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Set OPENAI_API_KEY before running pnpm demo. You can copy .env.example to .env.');
  }

  await ask('My name is Sam. I prefer concise answers.');
  await ask('What do you remember about me? My current goal is testing custom working memory.');

  const storedThread = await memory.getThreadById({ threadId: thread });
  console.log('\nStored custom working memory from thread metadata:');
  console.log(storedThread?.metadata?.customWorkingMemory);

  console.log('\nDebug JSON mirror:');
  console.log(await readFile('./custom-working-memory.json', 'utf8'));
}

async function ask(prompt: string) {
  console.log(`\nUser: ${prompt}`);

  const response = await supportAgent.generate(prompt, {
    memory: {
      thread,
      resource,
    },
  });

  console.log(`Assistant: ${response.text}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
