import { describe, expect, it } from 'vitest';

import { buildOtelEnv, INGEST_ID_RESOURCE_KEY } from './env';
import { startReceiver } from './receiver';

async function postJson(endpoint: string, body: unknown): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('OTLP receiver', () => {
  it('routes batches to the handler matching the ingest id', async () => {
    const r = await startReceiver();
    try {
      const seen: string[] = [];
      r.registerIngest('ingest-1', descriptors => {
        for (const d of descriptors) seen.push(d.name);
      });

      // Ignored batch (no matching ingest id).
      await postJson(r.endpoint, {
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: INGEST_ID_RESOURCE_KEY, value: { stringValue: 'nope' } },
              ],
            },
            scopeSpans: [
              {
                spans: [
                  { traceId: 't', spanId: 's', name: 'claude_code.tool' },
                ],
              },
            ],
          },
        ],
      });

      // Matching batch.
      const res = await postJson(r.endpoint, {
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: INGEST_ID_RESOURCE_KEY, value: { stringValue: 'ingest-1' } },
              ],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 't',
                    spanId: 's1',
                    name: 'claude_code.interaction',
                  },
                  {
                    traceId: 't',
                    spanId: 's2',
                    parentSpanId: 's1',
                    name: 'claude_code.llm_request',
                  },
                ],
              },
            ],
          },
        ],
      });

      expect(res.status).toBe(200);
      expect(seen).toEqual(['claude_code.interaction', 'claude_code.llm_request']);
    } finally {
      await r.stop();
    }
  });

  it('rejects non-POST/wrong-path requests with 404', async () => {
    const r = await startReceiver();
    try {
      const res = await fetch(`${r.endpoint.replace('/v1/traces', '/not-traces')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(404);
    } finally {
      await r.stop();
    }
  });

  it('exposes an endpoint buildOtelEnv can consume', async () => {
    const r = await startReceiver();
    try {
      const env = buildOtelEnv({ endpoint: r.endpoint, ingestId: 'x' });
      expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(r.endpoint);
    } finally {
      await r.stop();
    }
  });
});
