import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UnixSocketDurableRunCoordinator } from '../unix-socket-coordinator';

const rootDir = fileURLToPath(new URL('../../../../../..', import.meta.url));
const clientImportPath = fileURLToPath(new URL('../unix-socket-client.ts', import.meta.url));

type RpcClient = {
  process: ChildProcessWithoutNullStreams;
  request: (method: string, args?: unknown) => Promise<unknown>;
  waitForEvent: (predicate: (event: any) => boolean) => Promise<any>;
  close: () => Promise<void>;
};

function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 1000) {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const tick = async () => {
      if (await predicate()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    void tick();
  });
}

function createTempDir() {
  const dir = join(
    tmpdir(),
    `mastra-durable-coordinator-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createClientProcess(socketPath: string, dir: string, name: string): RpcClient {
  const scriptPath = join(dir, `${name}.ts`);
  writeFileSync(
    scriptPath,
    `import { createInterface } from 'node:readline';\n` +
      `import { UnixSocketDurableRunClient } from ${JSON.stringify(clientImportPath)};\n` +
      `async function main() {\n` +
      `  const client = new UnixSocketDurableRunClient({ socketPath: ${JSON.stringify(socketPath)}, clientId: ${JSON.stringify(name)}, autoStartCoordinator: true });\n` +
      `  await client.connect();\n` +
      `  const rl = createInterface({ input: process.stdin });\n` +
      `  rl.on('line', async line => {\n` +
      `    const message = JSON.parse(line);\n` +
      `    try {\n` +
      `      if (message.method === 'onSignal') {\n` +
      `        const [runId] = message.args ?? [];\n` +
      `        await client.onSignal(runId, signal => {\n` +
      `          process.stdout.write(JSON.stringify({ event: 'signal', runId, signal }) + '\\n');\n` +
      `        });\n` +
      `        process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n');\n` +
      `        return;\n` +
      `      }\n` +
      `      if (message.method === 'onRunEvent') {\n` +
      `        const [runId] = message.args ?? [];\n` +
      `        await client.subscribeRun(runId, runEvent => {\n` +
      `          process.stdout.write(JSON.stringify({ event: 'runEvent', runId, runEvent }) + '\\n');\n` +
      `        });\n` +
      `        process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n');\n` +
      `        return;\n` +
      `      }\n` +
      `      const result = await client[message.method](...(message.args ?? []));\n` +
      `      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');\n` +
      `    } catch (error) {\n` +
      `      process.stdout.write(JSON.stringify({ id: message.id, error: error instanceof Error ? error.message : String(error) }) + '\\n');\n` +
      `    }\n` +
      `  });\n` +
      `  process.on('SIGTERM', async () => { await client.close(); process.exit(0); });\n` +
      `}\n` +
      `main().catch(error => { console.error(error); process.exit(1); });\n`,
  );

  const child = spawn('pnpm', ['exec', 'tsx', scriptPath], {
    cwd: rootDir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const pendingEvents: Array<{ predicate: (event: any) => boolean; resolve: (event: any) => void }> = [];
  const events: any[] = [];
  let nextId = 0;
  let stdoutBuffer = '';
  let stderrBuffer = '';

  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.event) {
        events.push(message);
        const waiterIndex = pendingEvents.findIndex(waiter => waiter.predicate(message));
        if (waiterIndex !== -1) {
          const [waiter] = pendingEvents.splice(waiterIndex, 1);
          waiter?.resolve(message);
        }
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error));
      } else {
        waiter.resolve(message.result);
      }
    }
  });

  child.stderr.on('data', chunk => {
    stderrBuffer += chunk.toString();
  });

  child.on('exit', code => {
    const error = new Error(`client ${name} exited with code ${code}: ${stderrBuffer}`);
    for (const waiter of pending.values()) {
      waiter.reject(error);
    }
    pending.clear();
  });

  return {
    process: child,
    request(method, args = []) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
      });
    },
    waitForEvent(predicate) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise(resolve => {
        pendingEvents.push({ predicate, resolve });
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
    },
  };
}

describe('UnixSocketDurableRunCoordinator subprocess protocol', () => {
  let tempDir: string;
  let coordinator: UnixSocketDurableRunCoordinator | undefined;
  const clients: RpcClient[] = [];

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined)));
    await coordinator?.close();
    coordinator = undefined;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('lets any peer claim a thread after the active run completes', async () => {
    const socketPath = join(tempDir, 'coordinator.sock');
    coordinator = new UnixSocketDurableRunCoordinator({ socketPath });
    await coordinator.start();

    const processA = createClientProcess(socketPath, tempDir, 'process-a');
    const processB = createClientProcess(socketPath, tempDir, 'process-b');
    clients.push(processA, processB);

    const target = { resourceId: 'resource-1', threadId: 'thread-1' };

    await expect(processA.request('claimThread', [{ ...target, runId: 'run-a' }])).resolves.toEqual({
      claimed: true,
      activeRun: { ...target, runId: 'run-a', ownerId: 'process-a', status: 'active' },
    });

    await expect(processB.request('claimThread', [{ ...target, runId: 'run-b' }])).resolves.toEqual({
      claimed: false,
      activeRun: { ...target, runId: 'run-a', ownerId: 'process-a', status: 'active' },
    });

    await expect(processA.request('completeRun', ['run-a'])).resolves.toEqual({ ok: true });

    await expect(processB.request('claimThread', [{ ...target, runId: 'run-b' }])).resolves.toEqual({
      claimed: true,
      activeRun: { ...target, runId: 'run-b', ownerId: 'process-b', status: 'active' },
    });
  });

  it('fans out run events from whichever peer currently owns the active run', async () => {
    const socketPath = join(tempDir, 'coordinator.sock');
    coordinator = new UnixSocketDurableRunCoordinator({ socketPath });
    await coordinator.start();

    const processA = createClientProcess(socketPath, tempDir, 'process-a');
    const processB = createClientProcess(socketPath, tempDir, 'process-b');
    clients.push(processA, processB);

    const target = { resourceId: 'resource-1', threadId: 'thread-1' };

    await processA.request('claimThread', [{ ...target, runId: 'run-a' }]);
    await expect(processB.request('onRunEvent', ['run-a'])).resolves.toEqual({ ok: true });
    await expect(
      processA.request('publishRunEvent', ['run-a', { type: 'text-delta', payload: { text: 'from A' } }]),
    ).resolves.toEqual({ ok: true });
    await expect(
      processB.waitForEvent(event => event.event === 'runEvent' && event.runId === 'run-a'),
    ).resolves.toMatchObject({
      runEvent: { type: 'text-delta', payload: { text: 'from A' } },
    });

    await processA.request('completeRun', ['run-a']);
    await processB.request('claimThread', [{ ...target, runId: 'run-b' }]);
    await expect(processA.request('onRunEvent', ['run-b'])).resolves.toEqual({ ok: true });
    await expect(
      processB.request('publishRunEvent', ['run-b', { type: 'text-delta', payload: { text: 'from B' } }]),
    ).resolves.toEqual({ ok: true });
    await expect(
      processA.waitForEvent(event => event.event === 'runEvent' && event.runId === 'run-b'),
    ).resolves.toMatchObject({
      runEvent: { type: 'text-delta', payload: { text: 'from B' } },
    });
  });

  it('lets a peer re-elect itself as coordinator host after the host goes offline', async () => {
    const socketPath = join(tempDir, 'coordinator.sock');
    coordinator = new UnixSocketDurableRunCoordinator({ socketPath });
    await coordinator.start();

    const processA = createClientProcess(socketPath, tempDir, 'process-a');
    const processB = createClientProcess(socketPath, tempDir, 'process-b');
    clients.push(processA, processB);

    const target = { resourceId: 'resource-1', threadId: 'thread-1' };
    await expect(processA.request('claimThread', [{ ...target, runId: 'run-a' }])).resolves.toMatchObject({
      claimed: true,
    });

    await coordinator.close();
    coordinator = undefined;

    await expect(processB.request('reconnect')).resolves.toEqual(undefined);
    await expect(processB.request('claimThread', [{ ...target, runId: 'run-b' }])).resolves.toEqual({
      claimed: true,
      activeRun: { ...target, runId: 'run-b', ownerId: 'process-b', status: 'active' },
    });

    await expect(processA.request('reconnect')).resolves.toEqual(undefined);
    await expect(processA.request('getActiveRun', [target])).resolves.toEqual({
      ...target,
      runId: 'run-b',
      ownerId: 'process-b',
      status: 'active',
    });
  });

  it('clears active runs when the owning peer disconnects', async () => {
    const socketPath = join(tempDir, 'coordinator.sock');
    coordinator = new UnixSocketDurableRunCoordinator({ socketPath });
    await coordinator.start();

    const processA = createClientProcess(socketPath, tempDir, 'process-a');
    const processB = createClientProcess(socketPath, tempDir, 'process-b');
    clients.push(processA, processB);

    const target = { resourceId: 'resource-1', threadId: 'thread-1' };
    await expect(processA.request('claimThread', [{ ...target, runId: 'run-a' }])).resolves.toMatchObject({
      claimed: true,
    });

    await processA.close();
    await waitFor(async () => (await processB.request('getActiveRun', [target])) === undefined, 'owner run cleanup');

    await expect(processB.request('getActiveRun', [target])).resolves.toBeUndefined();
    await expect(processB.request('claimThread', [{ ...target, runId: 'run-b' }])).resolves.toEqual({
      claimed: true,
      activeRun: { ...target, runId: 'run-b', ownerId: 'process-b', status: 'active' },
    });
  });

  it('routes signals to whichever peer currently owns the active run', async () => {
    const socketPath = join(tempDir, 'coordinator.sock');
    coordinator = new UnixSocketDurableRunCoordinator({ socketPath });
    await coordinator.start();

    const processA = createClientProcess(socketPath, tempDir, 'process-a');
    const processB = createClientProcess(socketPath, tempDir, 'process-b');
    clients.push(processA, processB);

    const target = { resourceId: 'resource-1', threadId: 'thread-1' };

    await processA.request('claimThread', [{ ...target, runId: 'run-a' }]);
    await expect(processA.request('onSignal', ['run-a'])).resolves.toEqual({ ok: true });
    await expect(
      processB.request('sendSignal', [
        { id: 'signal-1', type: 'user-message', contents: 'from B' },
        { runId: 'run-a' },
      ]),
    ).resolves.toEqual({ accepted: true, runId: 'run-a' });
    await expect(
      processA.waitForEvent(event => event.event === 'signal' && event.runId === 'run-a'),
    ).resolves.toMatchObject({
      signal: { id: 'signal-1', type: 'user-message', contents: 'from B' },
    });

    await processA.request('completeRun', ['run-a']);
    await processB.request('claimThread', [{ ...target, runId: 'run-b' }]);
    await expect(processB.request('onSignal', ['run-b'])).resolves.toEqual({ ok: true });
    await expect(
      processA.request('sendSignal', [
        { id: 'signal-2', type: 'user-message', contents: 'from A' },
        { runId: 'run-b' },
      ]),
    ).resolves.toEqual({ accepted: true, runId: 'run-b' });
    await expect(
      processB.waitForEvent(event => event.event === 'signal' && event.runId === 'run-b'),
    ).resolves.toMatchObject({
      signal: { id: 'signal-2', type: 'user-message', contents: 'from A' },
    });
  });
});
