/**
 * Spawned by cross-process.test.ts.
 *
 * Runs a Mastra HTTP server with `MASTRA_WORKERS=false` so it does not
 * process workflow events itself. The server still serves the
 * /workflows/.../steps/execute endpoint, which the standalone worker
 * calls back to via HttpRemoteStrategy.
 *
 * Reads:
 *  - REDIS_URL
 *  - STORAGE_URL (libsql file:// URL shared with the worker)
 *  - PORT
 *
 * Logs `server-ready` to stdout once the HTTP server is listening.
 */
import { createNodeServer } from '@mastra/deployer/server';
import { buildMastra } from './shared.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6381';
const storageUrl = process.env.STORAGE_URL ?? 'file::memory:';
const port = Number(process.env.PORT ?? '4242');

// MASTRA_WORKERS=false is set by the parent test process via env.
const mastra = buildMastra({ storageUrl, redisUrl });

await createNodeServer(mastra, { tools: {}, studio: false, isDev: false });

// createNodeServer does not return a server object we can hook listening on,
// but it logs to stdout when ready. We assume readiness via the await above
// completing, then announce.
console.info(`server-ready port=${port}`);

// Graceful shutdown on SIGTERM
process.on('SIGTERM', async () => {
  try {
    await mastra.shutdown();
  } finally {
    process.exit(0);
  }
});
