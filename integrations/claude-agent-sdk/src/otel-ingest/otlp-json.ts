/**
 * Minimal OTLP/HTTP JSON types for ingest.
 *
 * This is only the subset the Claude Code CLI emits via
 * `@opentelemetry/exporter-trace-otlp-http`. Scope is intentionally small —
 * no metrics, no logs, no protobuf, no resource_spans merge semantics beyond
 * what we actually consume.
 *
 * See: https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto
 */

export interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string | number }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { kvlistValue: { values: OtlpKeyValue[] } }
  | Record<string, unknown>;

export interface OtlpResource {
  readonly attributes?: OtlpKeyValue[];
}

export interface OtlpScope {
  readonly name?: string;
  readonly version?: string;
  readonly attributes?: OtlpKeyValue[];
}

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind?: number;
  /** Nanoseconds since epoch as string (OTLP convention). */
  readonly startTimeUnixNano?: string;
  /** Nanoseconds since epoch as string (OTLP convention). */
  readonly endTimeUnixNano?: string;
  readonly attributes?: OtlpKeyValue[];
  readonly status?: { code?: number; message?: string };
  readonly events?: Array<{
    timeUnixNano?: string;
    name: string;
    attributes?: OtlpKeyValue[];
  }>;
}

export interface OtlpScopeSpans {
  readonly scope?: OtlpScope;
  readonly spans?: OtlpSpan[];
}

export interface OtlpResourceSpans {
  readonly resource?: OtlpResource;
  readonly scopeSpans?: OtlpScopeSpans[];
}

export interface OtlpTracesRequest {
  readonly resourceSpans?: OtlpResourceSpans[];
}

/** Flatten an OTLP attribute value into a JS primitive. */
export function otlpAnyValueToJs(value: OtlpAnyValue | undefined): unknown {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return (value as { stringValue: string }).stringValue;
  if ('intValue' in value) {
    const iv = (value as { intValue: string | number }).intValue;
    const n = typeof iv === 'string' ? Number(iv) : iv;
    return Number.isFinite(n) ? n : undefined;
  }
  if ('doubleValue' in value) return (value as { doubleValue: number }).doubleValue;
  if ('boolValue' in value) return (value as { boolValue: boolean }).boolValue;
  if ('arrayValue' in value) {
    const arr = (value as { arrayValue: { values: OtlpAnyValue[] } }).arrayValue?.values ?? [];
    return arr.map(otlpAnyValueToJs);
  }
  if ('kvlistValue' in value) {
    const kv = (value as { kvlistValue: { values: OtlpKeyValue[] } }).kvlistValue?.values ?? [];
    const out: Record<string, unknown> = {};
    for (const { key, value: v } of kv) out[key] = otlpAnyValueToJs(v);
    return out;
  }
  return undefined;
}

/** Flatten an OTLP attribute list into a plain `Record<string, unknown>`. */
export function otlpAttributesToRecord(attrs: OtlpKeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!attrs) return out;
  for (const { key, value } of attrs) {
    const v = otlpAnyValueToJs(value);
    if (v !== undefined) out[key] = v;
  }
  return out;
}
