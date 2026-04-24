/**
 * HTTP OTLP receiver. Accepts `POST /v1/traces` from the Claude Code CLI,
 * matches the batch to a registered ingest via the
 * `mastra.claude_agent.ingest_id` resource attribute (landmine #35), and
 * hands the converted spans to the matching handler so the caller can
 * attach them as children of the appropriate Mastra `AGENT_RUN` span.
 *
 * Scope is deliberately narrow:
 *
 * - HTTP JSON only. No gRPC, no protobuf.
 * - Listen on `127.0.0.1:<ephemeral>` so it's never reachable outside the
 *   process.
 * - Lazy per-Mastra singleton: `getReceiver(mastra)` starts the server the
 *   first time it's called for that instance.
 */

import { createServer    } from 'node:http';
import type {IncomingMessage, Server, ServerResponse} from 'node:http';
import type { AddressInfo } from 'node:net';

import { convertOtlpBatch  } from './converter';
import type {MastraChildSpanDescriptor} from './converter';
import { INGEST_ID_RESOURCE_KEY } from './env';
import { otlpAttributesToRecord  } from './otlp-json';
import type {OtlpTracesRequest} from './otlp-json';

/** Handler invoked when a batch of spans arrives for a registered ingest. */
export type IngestHandler = (descriptors: MastraChildSpanDescriptor[]) => void;

/**
 * Public receiver surface. Instances are created via {@link startReceiver}.
 */
export interface OtlpReceiverHandle {
  /** Full `http://host:port/v1/traces` endpoint callers should point the CLI at. */
  readonly endpoint: string;
  /** Register a handler for spans tagged with the given ingest id. */
  registerIngest(ingestId: string, handler: IngestHandler): void;
  /** Remove a previously registered ingest. */
  unregisterIngest(ingestId: string): void;
  /** Shut the HTTP server down. Safe to call multiple times. */
  stop(): Promise<void>;
}

/**
 * Start an OTLP HTTP receiver on `127.0.0.1:<ephemeral>`. Returns a handle
 * the caller uses to register ingest handlers.
 */
export async function startReceiver(options: {
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
} = {}): Promise<OtlpReceiverHandle> {
  const logger = options.logger;
  const handlers = new Map<string, IngestHandler>();

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, handlers, logger).catch(err => {
      logger?.warn('[claude-agent-otlp] unhandled request error', {
        error: (err as Error).message,
      });
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${addr.port}/v1/traces`;

  return {
    endpoint,
    registerIngest(ingestId, handler) {
      handlers.set(ingestId, handler);
    },
    unregisterIngest(ingestId) {
      handlers.delete(ingestId);
    },
    async stop() {
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/**
 * Module-level weak cache. Each Mastra-like holder gets a single receiver so
 * we don't burn ephemeral ports on every stream.
 */
const receiverByHost = new WeakMap<object, Promise<OtlpReceiverHandle>>();

/**
 * Lazy, per-host receiver singleton. `host` is typically the Mastra instance
 * but can be any stable object. Callers `register`/`unregister` around each
 * turn.
 */
export function getOrStartReceiver(
  host: object,
  options?: { logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void } },
): Promise<OtlpReceiverHandle> {
  const existing = receiverByHost.get(host);
  if (existing) return existing;
  const p = startReceiver(options);
  receiverByHost.set(host, p);
  return p;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: Map<string, IngestHandler>,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/v1/traces') {
    res.statusCode = 404;
    res.end();
    return;
  }

  const body = await readBody(req);
  let payload: OtlpTracesRequest;
  try {
    payload = JSON.parse(body.toString('utf8')) as OtlpTracesRequest;
  } catch (err) {
    logger?.warn('[claude-agent-otlp] bad JSON', { error: (err as Error).message });
    res.statusCode = 400;
    res.end();
    return;
  }

  for (const resourceSpans of payload.resourceSpans ?? []) {
    const resourceAttrs = otlpAttributesToRecord(resourceSpans.resource?.attributes);
    const ingestId = resourceAttrs[INGEST_ID_RESOURCE_KEY];
    if (typeof ingestId !== 'string' || ingestId.length === 0) continue;

    const handler = handlers.get(ingestId);
    if (!handler) continue;

    const otlpSpans = (resourceSpans.scopeSpans ?? []).flatMap(s => s.spans ?? []);
    if (otlpSpans.length === 0) continue;

    const { descriptors } = convertOtlpBatch(otlpSpans);
    try {
      handler(descriptors);
    } catch (err) {
      logger?.warn('[claude-agent-otlp] ingest handler threw', {
        ingestId,
        error: (err as Error).message,
      });
    }
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end('{}');
}
