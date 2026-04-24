/**
 * Compose the OTEL env vars that steer the Claude Code CLI's built-in
 * OTLP exporter at our receiver. Keeping this pure + isolated makes it
 * testable and lets callers inject an `ingestId` that the receiver uses to
 * match the batch to the right Mastra `AGENT_RUN` span (landmine #32 + #35).
 *
 * Landmine #3: the SDK reads `ENABLE_ENHANCED_TELEMETRY_BETA`, NOT
 * `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` — runtime disagrees with the public
 * docs, go by what the SDK actually reads.
 */

export interface BuildOtelEnvOptions {
  /** HTTP OTLP endpoint, e.g. `http://127.0.0.1:41234/v1/traces`. */
  readonly endpoint: string;
  /**
   * Opaque id the receiver uses to match this batch back to a live
   * `AGENT_RUN`. Sent as an OTEL resource attribute via
   * `OTEL_RESOURCE_ATTRIBUTES`.
   */
  readonly ingestId: string;
  /** Optional service name override. Defaults to `claude-agent-sdk`. */
  readonly serviceName?: string;
}

/**
 * Env var key that carries the ingest id on the OTEL resource. Kept public
 * so the receiver can extract it back out after deserializing.
 */
export const INGEST_ID_RESOURCE_KEY = 'mastra.claude_agent.ingest_id';

/**
 * Build the env-var record to hand to the SDK's subprocess. Caller is
 * responsible for merging this onto the base env — the returned record only
 * contains the OTEL-related keys.
 */
export function buildOtelEnv(options: BuildOtelEnvOptions): Record<string, string> {
  const { endpoint, ingestId, serviceName = 'claude-agent-sdk' } = options;

  return {
    // Turn on CLI telemetry.
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    ENABLE_ENHANCED_TELEMETRY_BETA: '1',

    // OTLP exporter wiring.
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint.replace(/\/v1\/traces\/?$/, ''),
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,

    // Service identification + ingest correlation key.
    OTEL_SERVICE_NAME: serviceName,
    OTEL_RESOURCE_ATTRIBUTES: `service.name=${serviceName},${INGEST_ID_RESOURCE_KEY}=${ingestId}`,

    // Force immediate export after every batch so turns don't stall behind
    // the default 5s batch timeout.
    OTEL_BSP_SCHEDULE_DELAY: '1000',
    OTEL_BSP_EXPORT_TIMEOUT: '5000',
  };
}
