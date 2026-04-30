import { existsSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

import type {
  DurableAgentActiveRun,
  DurableAgentClaimThreadOptions,
  DurableAgentClaimThreadResult,
  DurableAgentRunStatus,
} from './types';

export interface UnixSocketDurableRunCoordinatorOptions {
  socketPath: string;
}

type CoordinatorConnection = {
  socket: Socket;
  id?: string;
  buffer: string;
};

type CoordinatorRequest = {
  id?: string | number;
  action: string;
  clientId?: string;
  payload?: any;
};

function threadKey(resourceId: string, threadId: string): string {
  return `${resourceId}\0${threadId}`;
}

function writeJson(socket: Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

export class UnixSocketDurableRunCoordinator {
  readonly socketPath: string;

  #server?: Server;
  #connections = new Set<CoordinatorConnection>();
  #connectionsById = new Map<string, CoordinatorConnection>();
  #runsByThread = new Map<string, DurableAgentActiveRun>();
  #threadKeyByRunId = new Map<string, string>();
  #signalHandlersByRunId = new Map<string, CoordinatorConnection>();
  #subscribersByRunId = new Map<string, Set<CoordinatorConnection>>();
  #subscribersByThread = new Map<string, Set<CoordinatorConnection>>();
  #eventsByRunId = new Map<string, unknown[]>();

  constructor(options: UnixSocketDurableRunCoordinatorOptions) {
    this.socketPath = options.socketPath;
  }

  async start(): Promise<void> {
    if (this.#server) return;

    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    this.#server = createServer(socket => this.#handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      const server = this.#server!;
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.socketPath);
    });
  }

  async close(): Promise<void> {
    for (const connection of this.#connections) {
      connection.socket.destroy();
    }
    this.#connections.clear();

    const server = this.#server;
    this.#server = undefined;
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }
  }

  #handleConnection(socket: Socket): void {
    const connection: CoordinatorConnection = { socket, buffer: '' };
    this.#connections.add(connection);

    socket.on('data', chunk => {
      connection.buffer += chunk.toString();
      const lines = connection.buffer.split('\n');
      connection.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        void this.#handleLine(connection, line);
      }
    });

    socket.on('close', () => {
      this.#connections.delete(connection);
      if (connection.id) {
        this.#connectionsById.delete(connection.id);
      }
      for (const [runId, handler] of this.#signalHandlersByRunId) {
        if (handler === connection) {
          this.#signalHandlersByRunId.delete(runId);
        }
      }
      for (const [runId, subscribers] of this.#subscribersByRunId) {
        subscribers.delete(connection);
        if (subscribers.size === 0) {
          this.#subscribersByRunId.delete(runId);
        }
      }
      for (const [key, subscribers] of this.#subscribersByThread) {
        subscribers.delete(connection);
        if (subscribers.size === 0) {
          this.#subscribersByThread.delete(key);
        }
      }
      if (connection.id) {
        this.#cleanupRunsForOwner(connection.id);
      }
    });
  }

  async #handleLine(connection: CoordinatorConnection, line: string): Promise<void> {
    let request: CoordinatorRequest;
    try {
      request = JSON.parse(line) as CoordinatorRequest;
    } catch (error) {
      writeJson(connection.socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (request.clientId) {
      connection.id = request.clientId;
      this.#connectionsById.set(request.clientId, connection);
    }

    try {
      const result = this.#dispatch(connection, request);
      writeJson(connection.socket, { id: request.id, ok: true, result });
    } catch (error) {
      writeJson(connection.socket, {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #dispatch(connection: CoordinatorConnection, request: CoordinatorRequest): unknown {
    switch (request.action) {
      case 'claimThread':
        return this.claimThread({
          ...request.payload,
          ownerId: request.payload?.ownerId ?? connection.id ?? request.clientId,
        });
      case 'getActiveRun':
        return this.getActiveRun(request.payload);
      case 'completeRun':
        return this.completeRun(request.payload?.runId ?? request.payload);
      case 'failRun':
        return this.failRun(request.payload?.runId ?? request.payload);
      case 'abortRun':
        return this.abortRun(request.payload?.runId ?? request.payload, request.payload?.reason);
      case 'suspendRun':
        return this.setRunStatus(request.payload?.runId ?? request.payload, 'suspended');
      case 'resumeRun':
        return this.setRunStatus(request.payload?.runId ?? request.payload, 'active');
      case 'registerSignalHandler':
        return this.registerSignalHandler(connection, request.payload?.runId ?? request.payload);
      case 'sendSignal':
        return this.sendSignal(request.payload?.signal, request.payload?.target);
      case 'subscribeRun':
        return this.subscribeRun(connection, request.payload?.runId ?? request.payload);
      case 'subscribeThread':
        return this.subscribeThread(connection, request.payload);
      case 'publishRunEvent':
        return this.publishRunEvent(request.payload?.runId, request.payload?.event);
      case 'ping':
        return { ok: true };
      default:
        throw new Error(`Unknown coordinator action: ${request.action}`);
    }
  }

  claimThread(options: DurableAgentClaimThreadOptions): DurableAgentClaimThreadResult {
    const key = threadKey(options.resourceId, options.threadId);
    const activeRun = this.#runsByThread.get(key);
    if (activeRun && !this.#isRunOwnerConnected(activeRun)) {
      this.#cleanupRun(key, activeRun);
    } else if (activeRun && (activeRun.status === 'active' || activeRun.status === 'suspended')) {
      return { claimed: false, activeRun };
    }

    const claimedRun: DurableAgentActiveRun = {
      resourceId: options.resourceId,
      threadId: options.threadId,
      runId: options.runId,
      ownerId: options.ownerId ?? 'unknown',
      status: 'active',
    };
    this.#runsByThread.set(key, claimedRun);
    this.#threadKeyByRunId.set(options.runId, key);
    this.#publishThreadActiveRun(key, claimedRun);
    return { claimed: true, activeRun: claimedRun };
  }

  getActiveRun(options: { resourceId: string; threadId: string }): DurableAgentActiveRun | undefined {
    const key = threadKey(options.resourceId, options.threadId);
    const activeRun = this.#runsByThread.get(key);
    if (
      !activeRun ||
      activeRun.status === 'completed' ||
      activeRun.status === 'error' ||
      activeRun.status === 'aborted'
    )
      return undefined;
    if (!this.#isRunOwnerConnected(activeRun)) {
      this.#cleanupRun(key, activeRun);
      return undefined;
    }
    return activeRun;
  }

  completeRun(runId: string): { ok: true } {
    return this.#finishRun(runId, 'completed');
  }

  failRun(runId: string): { ok: true } {
    return this.#finishRun(runId, 'error');
  }

  abortRun(runId: string, reason = 'Durable run aborted'): { ok: true } {
    this.publishRunEvent(runId, {
      type: 'error',
      payload: { error: { name: 'AbortError', message: reason } },
    });
    return this.#finishRun(runId, 'aborted');
  }

  subscribeRun(connection: CoordinatorConnection, runId: string): { ok: true } {
    let subscribers = this.#subscribersByRunId.get(runId);
    if (!subscribers) {
      subscribers = new Set();
      this.#subscribersByRunId.set(runId, subscribers);
    }
    subscribers.add(connection);
    for (const event of this.#eventsByRunId.get(runId) ?? []) {
      writeJson(connection.socket, { type: 'runEvent', runId, event });
    }
    return { ok: true };
  }

  subscribeThread(connection: CoordinatorConnection, options: { resourceId: string; threadId: string }): { ok: true } {
    const key = threadKey(options.resourceId, options.threadId);
    let subscribers = this.#subscribersByThread.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.#subscribersByThread.set(key, subscribers);
    }
    subscribers.add(connection);
    return { ok: true };
  }

  publishRunEvent(runId: string, event: unknown): { ok: true } {
    const events = this.#eventsByRunId.get(runId) ?? [];
    events.push(event);
    this.#eventsByRunId.set(runId, events);
    for (const subscriber of this.#subscribersByRunId.get(runId) ?? []) {
      writeJson(subscriber.socket, { type: 'runEvent', runId, event });
    }
    return { ok: true };
  }

  #cleanupRunsForOwner(ownerId: string): void {
    for (const [key, activeRun] of this.#runsByThread) {
      if (activeRun.ownerId !== ownerId) continue;
      this.#cleanupRun(key, activeRun);
    }
  }

  #isRunOwnerConnected(activeRun: DurableAgentActiveRun): boolean {
    return !activeRun.ownerId || activeRun.ownerId === 'unknown' || this.#connectionsById.has(activeRun.ownerId);
  }

  #cleanupRun(key: string, activeRun: DurableAgentActiveRun): void {
    this.publishRunEvent(activeRun.runId, {
      type: 'error',
      payload: { error: `Durable run owner ${activeRun.ownerId} disconnected` },
    });
    this.#runsByThread.delete(key);
    this.#threadKeyByRunId.delete(activeRun.runId);
    this.#signalHandlersByRunId.delete(activeRun.runId);
    this.#subscribersByRunId.delete(activeRun.runId);
    this.#eventsByRunId.delete(activeRun.runId);
  }

  #publishThreadActiveRun(key: string, activeRun: DurableAgentActiveRun): void {
    for (const subscriber of this.#subscribersByThread.get(key) ?? []) {
      writeJson(subscriber.socket, { type: 'threadActiveRun', activeRun });
    }
  }

  registerSignalHandler(connection: CoordinatorConnection, runId: string): { ok: true } {
    this.#signalHandlersByRunId.set(runId, connection);
    return { ok: true };
  }

  sendSignal(
    signal: unknown,
    target: { runId?: string; resourceId?: string; threadId?: string } | undefined,
  ): { accepted: true; runId: string } {
    let runId = target?.runId;
    if (!runId && target?.resourceId && target.threadId) {
      runId = this.getActiveRun({ resourceId: target.resourceId, threadId: target.threadId })?.runId;
    }
    if (!runId) {
      throw new Error('sendSignal requires target.runId or an active target thread');
    }

    const handler = this.#signalHandlersByRunId.get(runId);
    if (!handler) {
      throw new Error(`No signal handler registered for run ${runId}`);
    }

    writeJson(handler.socket, { type: 'signal', runId, signal });
    return { accepted: true, runId };
  }

  setRunStatus(runId: string, status: DurableAgentRunStatus): { ok: true } {
    const key = this.#threadKeyByRunId.get(runId);
    if (!key) return { ok: true };
    const activeRun = this.#runsByThread.get(key);
    if (!activeRun) return { ok: true };
    activeRun.status = status;
    if (status === 'completed' || status === 'error' || status === 'aborted') {
      this.#runsByThread.delete(key);
      this.#threadKeyByRunId.delete(runId);
      this.#signalHandlersByRunId.delete(runId);
      this.#subscribersByRunId.delete(runId);
    }
    return { ok: true };
  }

  #finishRun(runId: string, status: 'completed' | 'error' | 'aborted'): { ok: true } {
    return this.setRunStatus(runId, status);
  }
}
