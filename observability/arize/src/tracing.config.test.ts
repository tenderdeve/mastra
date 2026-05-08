import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARIZE_AX_ENDPOINT, ArizeExporter } from './tracing';

// Mock OtelExporter to spy on its constructor
vi.mock('@mastra/otel-exporter', () => ({
  OtelExporter: vi.fn().mockImplementation(function () {
    return {
      exportTracingEvent: vi.fn(),
      shutdown: vi.fn(),
    };
  }),
}));

describe('ArizeExporterConfig', () => {
  afterEach(() => {
    delete process.env.PHOENIX_COLLECTOR_ENDPOINT;
    delete process.env.PHOENIX_ENDPOINT;
  });

  it('uses ARIZE_AX_ENDPOINT as fallback when spaceId is provided but no endpoint', async () => {
    const { OtelExporter } = await import('@mastra/otel-exporter');
    const otelExporterSpy = vi.mocked(OtelExporter);

    new ArizeExporter({
      spaceId: 'test-space-id',
      apiKey: 'test-api-key',
      projectName: 'test-project',
    });

    // Verify OtelExporter was called with the correct config
    expect(otelExporterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: {
          custom: {
            endpoint: ARIZE_AX_ENDPOINT,
            headers: {
              space_id: 'test-space-id',
              api_key: 'test-api-key',
            },
            protocol: 'http/protobuf',
          },
        },
        resourceAttributes: {
          'openinference.project.name': 'test-project',
        },
      }),
    );
  });
  it('uses the provided endpoint when provided', async () => {
    const { OtelExporter } = await import('@mastra/otel-exporter');
    const otelExporterSpy = vi.mocked(OtelExporter);

    new ArizeExporter({
      endpoint: 'https://test-endpoint.com/v1/traces',
      spaceId: 'test-space-id',
      apiKey: 'test-api-key',
    });

    expect(otelExporterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://test-endpoint.com/v1/traces',
        spaceId: 'test-space-id',
        apiKey: 'test-api-key',
      }),
    );
  });
  it('merges headers when provided', async () => {
    const { OtelExporter } = await import('@mastra/otel-exporter');
    const otelExporterSpy = vi.mocked(OtelExporter);

    new ArizeExporter({
      endpoint: 'https://test-endpoint.com/v1/traces',
      spaceId: 'test-space-id',
      apiKey: 'test-api-key',
      headers: {
        'x-custom-header': 'value',
      },
    });

    expect(otelExporterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          'x-custom-header': 'value',
        },
      }),
    );
  });
  it('reads endpoint from PHOENIX_COLLECTOR_ENDPOINT env var', async () => {
    process.env.PHOENIX_COLLECTOR_ENDPOINT = 'http://phoenix:6006/v1/traces';
    const { OtelExporter } = await import('@mastra/otel-exporter');
    const otelExporterSpy = vi.mocked(OtelExporter);

    new ArizeExporter({
      apiKey: 'test-api-key',
    });

    expect(otelExporterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: {
          custom: {
            endpoint: 'http://phoenix:6006/v1/traces',
            headers: {
              Authorization: 'Bearer test-api-key',
            },
            protocol: 'http/protobuf',
          },
        },
      }),
    );
  });
  it('prefers PHOENIX_COLLECTOR_ENDPOINT over PHOENIX_ENDPOINT', async () => {
    process.env.PHOENIX_COLLECTOR_ENDPOINT = 'http://collector-endpoint/v1/traces';
    process.env.PHOENIX_ENDPOINT = 'http://legacy-endpoint/v1/traces';
    const { OtelExporter } = await import('@mastra/otel-exporter');
    const otelExporterSpy = vi.mocked(OtelExporter);

    new ArizeExporter({
      apiKey: 'test-api-key',
    });

    expect(otelExporterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: {
          custom: {
            endpoint: 'http://collector-endpoint/v1/traces',
            headers: {
              Authorization: 'Bearer test-api-key',
            },
            protocol: 'http/protobuf',
          },
        },
      }),
    );
  });
  it('falls back to PHOENIX_ENDPOINT when PHOENIX_COLLECTOR_ENDPOINT is not set', async () => {
    process.env.PHOENIX_ENDPOINT = 'http://legacy-endpoint/v1/traces';
    const { OtelExporter } = await import('@mastra/otel-exporter');
    const otelExporterSpy = vi.mocked(OtelExporter);

    new ArizeExporter({
      apiKey: 'test-api-key',
    });

    expect(otelExporterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: {
          custom: {
            endpoint: 'http://legacy-endpoint/v1/traces',
            headers: {
              Authorization: 'Bearer test-api-key',
            },
            protocol: 'http/protobuf',
          },
        },
      }),
    );
  });
  it('merges resource attributes when provided', async () => {
    const { OtelExporter } = await import('@mastra/otel-exporter');
    const otelExporterSpy = vi.mocked(OtelExporter);

    new ArizeExporter({
      endpoint: 'https://test-endpoint.com/v1/traces',
      spaceId: 'test-space-id',
      apiKey: 'test-api-key',
      projectName: 'test-project',
      resourceAttributes: {
        'custom.attribute': 'value',
      },
    });

    expect(otelExporterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceAttributes: {
          'openinference.project.name': 'test-project',
          'custom.attribute': 'value',
        },
      }),
    );
  });
});
