import { describe, expect, it } from 'vitest';

import {
  convertOtlpBatch,
  isZeroSpanId,
  mapSpanName,
  sanitizeAttributes,
  unixNanoToDate,
} from './converter';
import type { OtlpSpan } from './otlp-json';

describe('mapSpanName', () => {
  it('maps CLI span names to Mastra span types', () => {
    expect(mapSpanName('claude_code.interaction')).toBe('model_generation');
    expect(mapSpanName('claude_code.llm_request')).toBe('model_step');
    expect(mapSpanName('claude_code.tool')).toBe('tool_call');
    expect(mapSpanName('claude_code.tool.blocked_on_user')).toBe('generic');
    expect(mapSpanName('claude_code.tool.execution')).toBe('generic');
    expect(mapSpanName('claude_code.hook')).toBe('generic');
    expect(mapSpanName('something.else')).toBe('generic');
  });
});

describe('sanitizeAttributes', () => {
  it('strips PII keys (landmine #34)', () => {
    const out = sanitizeAttributes([
      { key: 'user.id', value: { stringValue: 'u1' } },
      { key: 'user.email', value: { stringValue: 'x@y' } },
      { key: 'organization.id', value: { stringValue: 'org' } },
      { key: 'model', value: { stringValue: 'claude-sonnet' } },
      { key: 'duration_ms', value: { intValue: 42 } },
    ]);
    expect(out).toEqual({ model: 'claude-sonnet', duration_ms: 42 });
  });

  it('tolerates missing attributes', () => {
    expect(sanitizeAttributes(undefined)).toEqual({});
  });
});

describe('isZeroSpanId', () => {
  it('detects absent + zero ids', () => {
    expect(isZeroSpanId(undefined)).toBe(true);
    expect(isZeroSpanId('')).toBe(true);
    expect(isZeroSpanId('0000000000000000')).toBe(true);
    expect(isZeroSpanId('abcd')).toBe(false);
  });
});

describe('unixNanoToDate', () => {
  it('parses nanosecond strings', () => {
    const d = unixNanoToDate('1700000000000000000');
    expect(d).toBeInstanceOf(Date);
    expect(d!.getTime()).toBe(1700000000000);
  });

  it('returns undefined for bad input', () => {
    expect(unixNanoToDate(undefined)).toBeUndefined();
    expect(unixNanoToDate('not-a-number')).toBeUndefined();
  });
});

describe('convertOtlpBatch', () => {
  const base: Partial<OtlpSpan> = {
    traceId: 't1',
    startTimeUnixNano: '1700000000000000000',
    endTimeUnixNano: '1700000001000000000',
  };

  it('reparents orphan roots while preserving in-batch parents (landmine #32)', () => {
    const spans: OtlpSpan[] = [
      {
        ...(base as OtlpSpan),
        spanId: 'root1',
        parentSpanId: '0000000000000000',
        name: 'claude_code.interaction',
      },
      {
        ...(base as OtlpSpan),
        spanId: 'child1',
        parentSpanId: 'root1',
        name: 'claude_code.llm_request',
      },
      {
        ...(base as OtlpSpan),
        spanId: 'danglingChild',
        parentSpanId: 'not-in-batch',
        name: 'claude_code.tool',
      },
    ];

    const { descriptors, orphanRootIds } = convertOtlpBatch(spans);
    expect(descriptors).toHaveLength(3);

    const byId = Object.fromEntries(descriptors.map(d => [d.spanId, d]));
    expect(byId.root1.parentSpanId).toBeUndefined();
    expect(byId.child1.parentSpanId).toBe('root1');
    expect(byId.danglingChild.parentSpanId).toBeUndefined();

    expect(orphanRootIds.has('root1')).toBe(true);
    expect(orphanRootIds.has('danglingChild')).toBe(true);
    expect(orphanRootIds.has('child1')).toBe(false);
  });

  it('extracts llm_request input/output attributes', () => {
    const [desc] = convertOtlpBatch([
      {
        ...(base as OtlpSpan),
        spanId: 's1',
        name: 'claude_code.llm_request',
        attributes: [
          { key: 'model', value: { stringValue: 'claude-sonnet-4' } },
          { key: 'duration_ms', value: { intValue: 1234 } },
          { key: 'input_tokens', value: { intValue: 100 } },
          { key: 'output_tokens', value: { intValue: 250 } },
        ],
      },
    ]).descriptors;

    expect(desc.input).toMatchObject({ model: 'claude-sonnet-4' });
    expect(desc.output).toMatchObject({
      duration_ms: 1234,
      input_tokens: 100,
      output_tokens: 250,
    });
  });

  it('marks spans with status=error', () => {
    const [desc] = convertOtlpBatch([
      {
        ...(base as OtlpSpan),
        spanId: 's1',
        name: 'claude_code.tool',
        status: { code: 2, message: 'boom' },
      },
    ]).descriptors;
    expect(desc.errorMessage).toBe('boom');
  });
});
