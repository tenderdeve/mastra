/**
 * Map OTLP spans from the Claude Code CLI onto Mastra `SpanType` entries.
 *
 * Landmine #33: real CLI (SDK 0.2.112) emits `claude_code.*` spans. We map
 * them to Mastra span types and keep the CLI's internal sibling
 * relationships where possible, reparenting dangling roots onto the Mastra
 * `AGENT_RUN` span. Landmine #34: we strip PII attributes.
 */

import type { OtlpSpan } from './otlp-json';
import { otlpAttributesToRecord } from './otlp-json';

/** Subset of Mastra `SpanType` values we emit for CLI spans. */
export type MastraClaudeSpanType =
  | 'model_generation'
  | 'model_step'
  | 'tool_call'
  | 'generic';

/** PII / identity attributes we never forward onto Mastra spans (landmine #34). */
const PII_ATTRIBUTE_KEYS = new Set<string>([
  'user.id',
  'user.email',
  'user.account_uuid',
  'organization.id',
  'organization.uuid',
  'terminal.type',
  'span.type',
]);

/**
 * Span-name → Mastra span type mapping. Anything unrecognised falls through
 * to `generic` so we preserve ordering information without guessing semantics.
 */
export function mapSpanName(name: string): MastraClaudeSpanType {
  switch (name) {
    case 'claude_code.interaction':
      return 'model_generation';
    case 'claude_code.llm_request':
      return 'model_step';
    case 'claude_code.tool':
      return 'tool_call';
    case 'claude_code.tool.blocked_on_user':
    case 'claude_code.tool.execution':
    case 'claude_code.hook':
    default:
      return 'generic';
  }
}

/** Strip PII + flatten OTLP attribute list onto a plain record. */
export function sanitizeAttributes(otlpAttrs: OtlpSpan['attributes']): Record<string, unknown> {
  const raw = otlpAttributesToRecord(otlpAttrs);
  for (const k of Object.keys(raw)) {
    if (PII_ATTRIBUTE_KEYS.has(k)) delete raw[k];
  }
  return raw;
}

/** Zero-id predicate for parent span IDs emitted by the CLI. */
export function isZeroSpanId(id: string | undefined): boolean {
  if (!id) return true;
  if (id.length === 0) return true;
  return /^0+$/.test(id);
}

/** Parse an OTLP `*_unix_nano` string into a `Date`. */
export function unixNanoToDate(nano: string | undefined): Date | undefined {
  if (!nano) return undefined;
  const asNumber = typeof nano === 'string' ? Number(nano) : (nano as unknown as number);
  if (!Number.isFinite(asNumber)) return undefined;
  return new Date(Math.floor(asNumber / 1_000_000));
}

/**
 * Input/output extraction per CLI span type. Keeps the mapped Mastra span
 * attribute shape tight rather than dumping every CLI attribute into the
 * span record.
 */
export function extractInputOutput(
  name: string,
  attrs: Record<string, unknown>,
): { input?: Record<string, unknown>; output?: Record<string, unknown> } {
  switch (name) {
    case 'claude_code.interaction':
      return {
        input: undefinedIfEmpty({
          prompt_length: attrs.prompt_length,
        }),
        output: undefinedIfEmpty({
          response_length: attrs.response_length,
          stop_reason: attrs.stop_reason,
          model: attrs.model,
        }),
      };
    case 'claude_code.llm_request':
      return {
        input: undefinedIfEmpty({
          model: attrs.model,
          attempt: attrs.attempt,
          context: attrs['llm_request.context'],
        }),
        output: undefinedIfEmpty({
          success: attrs.success,
          duration_ms: attrs.duration_ms,
          input_tokens: attrs.input_tokens,
          output_tokens: attrs.output_tokens,
          cache_read_tokens: attrs.cache_read_tokens,
          cache_creation_tokens: attrs.cache_creation_tokens,
        }),
      };
    case 'claude_code.tool':
      return {
        input: undefinedIfEmpty({
          tool_name: attrs.tool_name,
          file_path: attrs.file_path,
        }),
        output: undefinedIfEmpty({
          duration_ms: attrs.duration_ms,
        }),
      };
    default:
      return {};
  }
}

function undefinedIfEmpty(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  let hasValue = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) {
      out[k] = v;
      hasValue = true;
    }
  }
  return hasValue ? out : undefined;
}

export interface MastraChildSpanDescriptor {
  /** Original OTLP span id — used as the child key when reparenting. */
  readonly spanId: string;
  /** Original OTLP parent id (may point outside the batch). */
  readonly parentSpanId?: string;
  readonly name: string;
  readonly mastraSpanType: MastraClaudeSpanType;
  readonly startTime?: Date;
  readonly endTime?: Date;
  readonly attributes: Record<string, unknown>;
  readonly input?: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
  readonly errorMessage?: string;
}

/**
 * Convert a batch of OTLP spans into Mastra child-span descriptors, ready to
 * be hung off an `AGENT_RUN` root. The caller owns actual span creation —
 * this function is a pure transformer so it's easy to unit-test.
 *
 * Landmine #32: collect every incoming spanId into a set. A span whose
 * `parentSpanId` is zero OR not present in the set is treated as an orphan
 * root; everything else keeps its original parent so CLI sibling
 * relationships survive.
 */
export function convertOtlpBatch(otlpSpans: OtlpSpan[]): {
  descriptors: MastraChildSpanDescriptor[];
  orphanRootIds: Set<string>;
} {
  const idSet = new Set<string>();
  for (const s of otlpSpans) idSet.add(s.spanId);

  const descriptors: MastraChildSpanDescriptor[] = [];
  const orphanRootIds = new Set<string>();

  for (const span of otlpSpans) {
    const attrs = sanitizeAttributes(span.attributes);
    const mastraSpanType = mapSpanName(span.name);
    const { input, output } = extractInputOutput(span.name, attrs);

    const parentKnown = !isZeroSpanId(span.parentSpanId) && idSet.has(span.parentSpanId!);
    if (!parentKnown) orphanRootIds.add(span.spanId);

    descriptors.push({
      spanId: span.spanId,
      parentSpanId: parentKnown ? span.parentSpanId : undefined,
      name: span.name,
      mastraSpanType,
      startTime: unixNanoToDate(span.startTimeUnixNano),
      endTime: unixNanoToDate(span.endTimeUnixNano),
      attributes: attrs,
      input,
      output,
      errorMessage: span.status?.code === 2 ? span.status.message ?? 'error' : undefined,
    });
  }

  return { descriptors, orphanRootIds };
}
