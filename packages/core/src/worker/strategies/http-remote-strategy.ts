import type { StepResult } from '../../workflows/types';
import type { StepExecutionParams, StepExecutionStrategy } from '../types';

/**
 * Executes workflow steps by calling a remote server endpoint over HTTP.
 * Used in standalone worker deployments where the worker runs orchestration
 * logic but delegates actual step execution to the server.
 */
type AuthConfig = { type: 'api-key'; key: string } | { type: 'bearer'; token: string };

export class HttpRemoteStrategy implements StepExecutionStrategy {
  #serverUrl: string;
  #auth?: AuthConfig;
  #timeoutMs: number;

  constructor({ serverUrl, auth, timeoutMs }: { serverUrl: string; auth?: AuthConfig; timeoutMs?: number }) {
    this.#serverUrl = serverUrl;
    this.#auth = auth;
    this.#timeoutMs = timeoutMs ?? 30_000;
  }

  async executeStep(params: StepExecutionParams): Promise<StepResult<any, any, any, any>> {
    const url = `${this.#serverUrl}/workflows/${params.workflowId}/runs/${params.runId}/steps/execute`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.#buildAuthHeaders(),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new StepExecutionError(res.status, body);
    }

    return res.json() as Promise<StepResult<any, any, any, any>>;
  }

  #buildAuthHeaders(): Record<string, string> {
    if (!this.#auth) return {};
    if (this.#auth.type === 'api-key') {
      return { 'x-worker-api-key': this.#auth.key };
    }
    return { authorization: `Bearer ${this.#auth.token}` };
  }
}

export class StepExecutionError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Step execution failed with status ${status}: ${body}`);
    this.name = 'StepExecutionError';
    this.status = status;
    this.body = body;
  }
}
