import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6381';
const PACKAGE_DIR = resolve(__dirname, '..');

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolveFn, rejectFn) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rejectFn);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr !== null) {
        const { port } = addr;
        srv.close(() => resolveFn(port));
      } else {
        srv.close();
        rejectFn(new Error('Failed to acquire free port'));
      }
    });
  });
}
const TSX_BIN = resolve(PACKAGE_DIR, 'node_modules/.bin/tsx');

const SERVER_ENTRY = resolve(PACKAGE_DIR, 'test-fixtures/server.entry.ts');
const WORKER_ENTRY = resolve(PACKAGE_DIR, 'test-fixtures/worker.entry.ts');

interface ManagedProcess {
  proc: ChildProcess;
  stdout: string;
  stderr: string;
}

function spawnFixture(entryFile: string, env: NodeJS.ProcessEnv): ManagedProcess {
  const proc = spawn(TSX_BIN, [entryFile], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const managed: ManagedProcess = { proc, stdout: '', stderr: '' };
  proc.stdout?.on('data', (chunk: Buffer) => {
    managed.stdout += chunk.toString();
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    managed.stderr += chunk.toString();
  });
  return managed;
}

async function waitForLine(managed: ManagedProcess, marker: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (managed.stdout.includes(marker)) return;
    if (managed.proc.exitCode !== null) {
      throw new Error(
        `Process exited (code=${managed.proc.exitCode}) before emitting "${marker}".\nstdout:\n${managed.stdout}\nstderr:\n${managed.stderr}`,
      );
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for "${marker}".\nstdout:\n${managed.stdout}\nstderr:\n${managed.stderr}`);
}

async function killProcess(managed: ManagedProcess | undefined): Promise<void> {
  if (!managed) return;
  if (managed.proc.exitCode !== null) return;

  managed.proc.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      try {
        managed.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve();
    }, 5000);
    managed.proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe('cross-process workflow execution via Redis Streams', () => {
  let tmpDir: string;
  let storageUrl: string;
  let serverUrl: string;
  let server: ManagedProcess | undefined;
  let worker: ManagedProcess | undefined;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mastra-redis-streams-'));
    storageUrl = `file:${join(tmpDir, 'mastra.db')}`;
    const serverPort = await getFreePort();
    serverUrl = `http://localhost:${serverPort}`;

    server = spawnFixture(SERVER_ENTRY, {
      MASTRA_WORKERS: 'false',
      REDIS_URL,
      STORAGE_URL: storageUrl,
      PORT: String(serverPort),
    });
    await waitForLine(server, 'server-ready');

    // Confirm the server is actually listening before starting the worker.
    await waitFor(async () => {
      try {
        const res = await fetch(`${serverUrl}/api`);
        return res.ok || res.status === 404;
      } catch {
        return false;
      }
    });

    worker = spawnFixture(WORKER_ENTRY, {
      MASTRA_WORKERS: '', // ensure default auto-creation in worker process
      REDIS_URL,
      STORAGE_URL: storageUrl,
      MASTRA_STEP_EXECUTION_URL: `${serverUrl}/api`,
    });
    await waitForLine(worker, 'worker-ready');
  }, 60_000);

  afterAll(async () => {
    await killProcess(worker);
    await killProcess(server);
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('runs a workflow end-to-end: server publishes, worker processes via Redis, worker calls server for step execution', async () => {
    const before = countMarker(server, 'step-execute-hit');
    const res = await fetch(`${serverUrl}/api/workflows/cross-process-greet/start-async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputData: { name: 'world' } }),
    });

    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string; result?: { greeting?: string }; error?: unknown };

    expect(body.status).toBe('success');
    expect(body.result?.greeting).toBe('hello, world');
    // Confirm the worker actually called back to the server's step-execute
    // endpoint rather than running the step inline somehow.
    expect(countMarker(server, 'step-execute-hit')).toBeGreaterThan(before);
  }, 30_000);

  it('runs a multi-step workflow end-to-end across processes', async () => {
    const before = countMarker(server, 'step-execute-hit');
    const res = await fetch(`${serverUrl}/api/workflows/cross-process-pipeline/start-async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputData: { name: '  World  ' } }),
    });

    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string; result?: { shouted?: string }; error?: unknown };

    expect(body.status).toBe('success');
    expect(body.result?.shouted).toBe('HELLO, WORLD!');
    // Multi-step pipeline should hit the step-execute endpoint at least
    // 3 times (one per step), proving each step ran on the server via
    // HttpRemoteStrategy.
    expect(countMarker(server, 'step-execute-hit') - before).toBeGreaterThanOrEqual(3);
  }, 30_000);
});

function countMarker(managed: ManagedProcess | undefined, marker: string): number {
  if (!managed) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = managed.stdout.indexOf(marker, idx)) !== -1) {
    count += 1;
    idx += marker.length;
  }
  return count;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
