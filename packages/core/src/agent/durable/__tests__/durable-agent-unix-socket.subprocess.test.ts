import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UnixSocketDurableRunClient } from '../unix-socket-client';
import { UnixSocketDurableRunCoordinator } from '../unix-socket-coordinator';

const rootDir = fileURLToPath(new URL('../../../../../..', import.meta.url));
const durableImportPath = fileURLToPath(new URL('../index.ts', import.meta.url));
const clientImportPath = fileURLToPath(new URL('../unix-socket-client.ts', import.meta.url));
const agentImportPath = fileURLToPath(new URL('../../agent.ts', import.meta.url));
const eventEmitterPubSubPath = fileURLToPath(new URL('../../../events/event-emitter.ts', import.meta.url));
const toolsImportPath = fileURLToPath(new URL('../../../tools/index.ts', import.meta.url));

function createTempDir() {
  const dir = join(
    tmpdir(),
    `mastra-durable-agent-socket-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createOwnerProcess(socketPath: string, dir: string): ChildProcessWithoutNullStreams {
  const scriptPath = join(dir, 'owner.ts');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    scriptPath,
    `import type { LanguageModelV2 } from '@ai-sdk/provider-v5';\n` +
      `import { Agent } from ${JSON.stringify(agentImportPath)};\n` +
      `import { EventEmitterPubSub } from ${JSON.stringify(eventEmitterPubSubPath)};\n` +
      `import { createTool } from ${JSON.stringify(toolsImportPath)};\n` +
      `import { createDurableAgent } from ${JSON.stringify(durableImportPath)};\n` +
      `import { UnixSocketDurableRunClient } from ${JSON.stringify(clientImportPath)};\n` +
      `const emit = (event: string, payload: unknown = {}) => process.stdout.write(JSON.stringify({ event, ...payload }) + '\\n');\n` +
      `const convertArrayToReadableStream = (items: unknown[]) => new ReadableStream({ start(controller) { for (const item of items) controller.enqueue(item); controller.close(); } });\n` +
      `async function main() {\n` +
      `  const prompts: unknown[] = [];\n` +
      `  let callCount = 0;\n` +
      `  let releaseTool: (() => void) | undefined;\n` +
      `  const signalArrived = new Promise<void>(resolve => { releaseTool = resolve; });\n` +
      `  const model: LanguageModelV2 = {\n` +
      `    specificationVersion: 'v2',\n` +
      `    provider: 'mock-provider',\n` +
      `    modelId: 'mock-model-id',\n` +
      `    supportedUrls: {},\n` +
      `    doGenerate: async () => { throw new Error('doGenerate not implemented'); },\n` +
      `    doStream: async options => {\n` +
      `      prompts.push(options.prompt);\n` +
      `      callCount++;\n` +
      `      if (callCount === 1) {\n` +
      `        return {\n` +
      `          stream: convertArrayToReadableStream([\n` +
      `            { type: 'stream-start', warnings: [] },\n` +
      `            { type: 'response-metadata', id: 'id-0', modelId: 'mock-model-id', timestamp: new Date(0) },\n` +
      `            { type: 'tool-call', toolCallType: 'function', toolCallId: 'call-1', toolName: 'waitForSignal', input: JSON.stringify({}), providerExecuted: false },\n` +
      `            { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },\n` +
      `          ]),\n` +
      `          rawCall: { rawPrompt: null, rawSettings: {} },\n` +
      `          warnings: [],\n` +
      `        };\n` +
      `      }\n` +
      `      return {\n` +
      `        stream: convertArrayToReadableStream([\n` +
      `          { type: 'stream-start', warnings: [] },\n` +
      `          { type: 'response-metadata', id: 'id-1', modelId: 'mock-model-id', timestamp: new Date(0) },\n` +
      `          { type: 'text-start', id: 'text-1' },\n` +
      `          { type: 'text-delta', id: 'text-1', delta: 'done' },\n` +
      `          { type: 'text-end', id: 'text-1' },\n` +
      `          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },\n` +
      `        ]),\n` +
      `        rawCall: { rawPrompt: null, rawSettings: {} },\n` +
      `        warnings: [],\n` +
      `      };\n` +
      `    },\n` +
      `  };\n` +
      `  const waitForSignal = createTool({ id: 'waitForSignal', description: 'waits', execute: async () => { emit('readyForSignal'); await signalArrived; return 'ok'; } });\n` +
      `  const agent = new Agent({ id: 'owner-agent', name: 'Owner Agent', instructions: 'Use tools', model: model as LanguageModelV2, tools: { waitForSignal } });\n` +
      `  const durableAgent = createDurableAgent({ agent, pubsub: new EventEmitterPubSub(), cleanupTimeoutMs: 0 });\n` +
      `  const client = new UnixSocketDurableRunClient({ socketPath: ${JSON.stringify(socketPath)}, clientId: 'owner', autoStartCoordinator: true });\n` +
      `  await client.connect();\n` +
      `  await client.claimThread({ resourceId: 'resource-1', threadId: 'thread-1', runId: 'run-owner' });\n` +
      `  await client.onSignal('run-owner', signal => { durableAgent.sendSignal(signal as any, { runId: 'run-owner' }); releaseTool?.(); });\n` +
      `  const result = await durableAgent.stream('start', { runId: 'run-owner', memory: { resource: 'resource-1', thread: 'thread-1' } });\n` +
      `  const text = await result.output.text;\n` +
      `  emit('done', { text, prompts });\n` +
      `  await client.completeRun('run-owner');\n` +
      `  result.cleanup();\n` +
      `  await client.close();\n` +
      `}\n` +
      `main().catch(error => { emit('error', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }); process.exit(1); });\n`,
  );

  return spawn('pnpm', ['exec', 'tsx', scriptPath], {
    cwd: rootDir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function waitForEvent(child: ChildProcessWithoutNullStreams, predicate: (event: any) => boolean): Promise<any> {
  let buffer = '';
  const seen: any[] = [];
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        seen.push(event);
        if (predicate(event)) {
          cleanup();
          resolve(event);
        }
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`owner exited with code ${code}; seen=${JSON.stringify(seen)}`));
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

describe('DurableAgent Unix socket subprocess integration', () => {
  let tempDir: string;
  let coordinator: UnixSocketDurableRunCoordinator | undefined;
  let owner: ChildProcessWithoutNullStreams | undefined;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(async () => {
    owner?.kill('SIGTERM');
    await coordinator?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('routes a signal from another process into the owner process next LLM request', async () => {
    const socketPath = join(tempDir, 'coordinator.sock');
    coordinator = new UnixSocketDurableRunCoordinator({ socketPath });
    await coordinator.start();

    owner = createOwnerProcess(socketPath, tempDir);
    const stderr: string[] = [];
    owner.stderr.on('data', chunk => stderr.push(chunk.toString()));

    await waitForEvent(owner, event => event.event === 'readyForSignal').catch(error => {
      error.message += ` stderr=${stderr.join('')}`;
      throw error;
    });

    const signaler = new UnixSocketDurableRunClient({ socketPath, clientId: 'signaler' });
    await signaler.connect();
    await expect(
      signaler.sendSignal(
        { type: 'user-message', contents: 'signal from another process' },
        { resourceId: 'resource-1', threadId: 'thread-1' },
      ),
    ).resolves.toEqual({ accepted: true, runId: 'run-owner' });

    const done = await waitForEvent(owner, event => event.event === 'done').catch(error => {
      error.message += ` stderr=${stderr.join('')}`;
      throw error;
    });
    await signaler.close();

    expect(done.text).toBe('done');
    expect(JSON.stringify(done.prompts[1])).toContain('signal from another process');
  });
});
