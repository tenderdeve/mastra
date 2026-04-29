import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';

import type { DurableAgentActiveRun, DurableAgentClaimThreadOptions, DurableAgentClaimThreadResult } from './types';
import { UnixSocketDurableRunCoordinator } from './unix-socket-coordinator';

export interface UnixSocketDurableRunClientOptions {
  socketPath: string;
  clientId?: string;
  autoStartCoordinator?: boolean;
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

type ClientResponse = {
  id?: string | number;
  ok?: boolean;
  result?: any;
  error?: string;
};

export class UnixSocketDurableRunClient {
  readonly socketPath: string;
  readonly clientId: string;
  readonly autoStartCoordinator: boolean;

  #socket?: Socket;
  #hostedCoordinator?: UnixSocketDurableRunCoordinator;
  #buffer = '';
  #nextRequestId = 0;
  #pending = new Map<number, PendingRequest>();
  #signalHandlers = new Map<string, Set<(signal: unknown) => void>>();
  #runEventHandlers = new Map<string, Set<(event: unknown) => void>>();
  #threadEventHandlers = new Map<string, Set<(activeRun: DurableAgentActiveRun) => void>>();

  constructor(options: UnixSocketDurableRunClientOptions) {
    this.socketPath = options.socketPath;
    this.clientId = options.clientId ?? randomUUID();
    this.autoStartCoordinator = options.autoStartCoordinator ?? false;
  }

  async connect(): Promise<void> {
    if (this.#socket) return;

    try {
      await this.#connectSocket();
    } catch (error) {
      if (!this.autoStartCoordinator) throw error;
      await this.#startCoordinator();
      await this.#connectSocket();
    }

    await this.#request('ping');
  }

  async reconnect(): Promise<void> {
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.destroy();
    this.#rejectPending(new Error('Unix socket durable run client reconnecting'));
    await this.connect();
    await this.#restoreRegistrations();
  }

  async #connectSocket(): Promise<void> {
    const socket = createConnection(this.socketPath);
    this.#socket = socket;

    socket.on('data', chunk => this.#handleData(chunk));
    socket.on('close', () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
      }
      this.#rejectPending(new Error('Unix socket durable run client disconnected'));
    });
    socket.on('error', error => this.#rejectPending(error));

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        socket.off('connect', onConnect);
        if (this.#socket === socket) {
          this.#socket = undefined;
        }
        reject(error);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
  }

  async #startCoordinator(): Promise<void> {
    if (this.#hostedCoordinator) return;
    const coordinator = new UnixSocketDurableRunCoordinator({ socketPath: this.socketPath });
    try {
      await coordinator.start();
      this.#hostedCoordinator = coordinator;
    } catch (error: any) {
      await coordinator.close().catch(() => undefined);
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }

  async #restoreRegistrations(): Promise<void> {
    for (const runId of this.#runEventHandlers.keys()) {
      await this.#request('subscribeRun', { runId });
    }
    for (const key of this.#threadEventHandlers.keys()) {
      const [resourceId, threadId] = key.split('\0');
      if (resourceId && threadId) {
        await this.#request('subscribeThread', { resourceId, threadId });
      }
    }
    for (const runId of this.#signalHandlers.keys()) {
      await this.#request('registerSignalHandler', { runId });
    }
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      await new Promise<void>(resolve => {
        socket.end(() => resolve());
      });
    }
    const hostedCoordinator = this.#hostedCoordinator;
    this.#hostedCoordinator = undefined;
    await hostedCoordinator?.close();
  }

  claimThread(
    options: Omit<DurableAgentClaimThreadOptions, 'ownerId'> & { ownerId?: string },
  ): Promise<DurableAgentClaimThreadResult> {
    return this.#request('claimThread', { ...options, ownerId: options.ownerId ?? this.clientId });
  }

  getActiveRun(options: { resourceId: string; threadId: string }): Promise<DurableAgentActiveRun | undefined> {
    return this.#request('getActiveRun', options);
  }

  completeRun(runId: string): Promise<{ ok: true }> {
    return this.#request('completeRun', { runId });
  }

  failRun(runId: string): Promise<{ ok: true }> {
    return this.#request('failRun', { runId });
  }

  abortRun(runId: string, reason?: string): Promise<{ ok: true }> {
    return this.#request('abortRun', { runId, reason });
  }

  suspendRun(runId: string): Promise<{ ok: true }> {
    return this.#request('suspendRun', { runId });
  }

  resumeRun(runId: string): Promise<{ ok: true }> {
    return this.#request('resumeRun', { runId });
  }

  async subscribeRun(runId: string, handler: (event: unknown) => void): Promise<() => void> {
    let handlers = this.#runEventHandlers.get(runId);
    const needsRegistration = !handlers;
    if (!handlers) {
      handlers = new Set();
      this.#runEventHandlers.set(runId, handlers);
    }
    handlers.add(handler);
    if (needsRegistration) {
      await this.#request('subscribeRun', { runId }).catch(error => {
        handlers?.delete(handler);
        if (handlers?.size === 0) {
          this.#runEventHandlers.delete(runId);
        }
        throw error;
      });
    }
    return () => {
      handlers?.delete(handler);
    };
  }

  async publishRunEvent(runId: string, event: unknown): Promise<{ ok: true }> {
    return this.#request('publishRunEvent', { runId, event });
  }

  async subscribeThread(
    options: { resourceId: string; threadId: string },
    handler: (activeRun: DurableAgentActiveRun) => void,
  ): Promise<() => void> {
    const key = `${options.resourceId}\0${options.threadId}`;
    let handlers = this.#threadEventHandlers.get(key);
    if (!handlers) {
      handlers = new Set();
      this.#threadEventHandlers.set(key, handlers);
      await this.#request('subscribeThread', options);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  async sendSignal(signal: unknown, target: { runId: string }): Promise<{ accepted: true; runId: string }> {
    return this.#request('sendSignal', { signal, target });
  }

  async onSignal(runId: string, handler: (signal: unknown) => void): Promise<() => void> {
    let handlers = this.#signalHandlers.get(runId);
    if (!handlers) {
      handlers = new Set();
      this.#signalHandlers.set(runId, handlers);
      await this.#request('registerSignalHandler', { runId });
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  #request<T = unknown>(action: string, payload?: unknown): Promise<T> {
    const socket = this.#socket;
    if (!socket) {
      return Promise.reject(new Error('Unix socket durable run client is not connected'));
    }

    const id = ++this.#nextRequestId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      socket.write(JSON.stringify({ id, action, clientId: this.clientId, payload }) + '\n');
    });
  }

  #handleData(chunk: Buffer): void {
    this.#buffer += chunk.toString();
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as ClientResponse & {
        type?: string;
        runId?: string;
        signal?: unknown;
        event?: unknown;
      };
      if (message.type === 'signal' && message.runId) {
        for (const handler of this.#signalHandlers.get(message.runId) ?? []) {
          handler(message.signal);
        }
        continue;
      }
      if (message.type === 'runEvent' && message.runId) {
        for (const handler of this.#runEventHandlers.get(message.runId) ?? []) {
          handler(message.event);
        }
        continue;
      }
      if (message.type === 'threadActiveRun') {
        const activeRun = (message as any).activeRun as DurableAgentActiveRun | undefined;
        if (activeRun) {
          const key = `${activeRun.resourceId}\0${activeRun.threadId}`;
          for (const handler of this.#threadEventHandlers.get(key) ?? []) {
            handler(activeRun);
          }
        }
        continue;
      }
      if (message.id === undefined) continue;
      const requestId = Number(message.id);
      const pending = this.#pending.get(requestId);
      if (!pending) continue;
      this.#pending.delete(requestId);
      if (message.ok === false) {
        pending.reject(new Error(message.error ?? 'Unix socket durable run request failed'));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
