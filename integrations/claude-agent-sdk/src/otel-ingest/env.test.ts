import { describe, expect, it } from 'vitest';

import { buildOtelEnv, INGEST_ID_RESOURCE_KEY } from './env';

describe('buildOtelEnv', () => {
  it('produces OTLP wiring + ingest id in resource attrs', () => {
    const env = buildOtelEnv({
      endpoint: 'http://127.0.0.1:41234/v1/traces',
      ingestId: 'ingest-abc',
    });

    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    // Landmine #3: SDK reads ENABLE_ENHANCED_TELEMETRY_BETA.
    expect(env.ENABLE_ENHANCED_TELEMETRY_BETA).toBe('1');
    expect(env.OTEL_TRACES_EXPORTER).toBe('otlp');
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/json');
    expect(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('http://127.0.0.1:41234/v1/traces');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:41234');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain(`${INGEST_ID_RESOURCE_KEY}=ingest-abc`);
  });

  it('allows overriding service name', () => {
    const env = buildOtelEnv({
      endpoint: 'http://127.0.0.1:41234/v1/traces',
      ingestId: 'ingest-abc',
      serviceName: 'custom',
    });
    expect(env.OTEL_SERVICE_NAME).toBe('custom');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toContain('service.name=custom');
  });
});
