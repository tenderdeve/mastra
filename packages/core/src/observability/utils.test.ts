import { describe, expect, it } from 'vitest';

import { SpanType } from './types';
import { getEntityTypeForSpan, getStepAvailableToolNames } from './utils';

describe('getEntityTypeForSpan', () => {
  it('maps rag ingestion spans to the rag_ingestion entity type', () => {
    expect(getEntityTypeForSpan({ spanType: SpanType.RAG_INGESTION })).toBe('rag_ingestion');
  });

  it('prefers an explicit entity type when present', () => {
    expect(
      getEntityTypeForSpan({
        entityType: 'rag_ingestion',
        spanType: SpanType.GENERIC,
      }),
    ).toBe('rag_ingestion');
  });
});

describe('getStepAvailableToolNames', () => {
  it('returns activeTools when present, ignoring tools', () => {
    expect(getStepAvailableToolNames({ a: {}, b: {}, c: {} }, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('falls back to tool keys when activeTools is undefined', () => {
    expect(getStepAvailableToolNames({ a: {}, b: {} })).toEqual(['a', 'b']);
  });

  it('falls back to tool keys when activeTools is empty', () => {
    expect(getStepAvailableToolNames({ a: {} }, [])).toEqual(['a']);
  });

  it('returns undefined when neither tools nor activeTools have entries', () => {
    expect(getStepAvailableToolNames(undefined, undefined)).toBeUndefined();
    expect(getStepAvailableToolNames({}, undefined)).toBeUndefined();
    expect(getStepAvailableToolNames({}, [])).toBeUndefined();
  });
});
