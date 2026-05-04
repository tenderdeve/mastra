# PR Summary: Optimize listTraces and listBranches with scalar prefilter and fast-path pagination

PR: https://github.com/mastra-ai/mastra/pull/16165
Branch: `claude/optimize-duckdb-traces-uoKN6` → `main`
Author: @epinzur
Status: open, mergeable_state=blocked (CI pending)
Diff: +606 / −67 across 3 files

## Overview

Optimizes `listTraces` and `listBranches` on the DuckDB observability store. Both methods previously reconstructed every span (via `arg_max(...) FILTER (...)` GROUP BY across `span_events`) before applying any filters/ordering/pagination — paying full reconstruction cost for the entire table on every list call. This PR introduces a two-stage filter strategy that pushes scalar predicates down to the raw `span_events` start rows and reconstructs at most the rows that will actually be returned. Public return shapes and filter semantics are unchanged.

## How It Works

Filters are partitioned by `partitionAnchorFilters()` into three buckets:

1. **prefilter** — scalar columns from `PREFILTER_KEYS` (entity*, *Id, environment, serviceName, name, spanType, source, ...) plus `startedAt` (mapped to start-row `timestamp`) and a safe over-approximation of `endedAt.end` (a span that started after `endedAt.end` cannot have ended before it).
2. **postAgg** — anything that depends on reconstructed values: `endedAt`, `status`, `tags`, `metadata`, `scope`, etc.
3. **hasChildError** — pulled out separately; now evaluated as `EXISTS / NOT EXISTS` against raw `span_events` instead of the previously-required `reconstructed_spans` CTE.

Two execution paths:

- **Fast path** — taken when `postAgg` is empty, `hasChildError` is unset, and `orderBy.field ∈ SAFE_PREFILTER_ORDER_FIELDS` (`{ 'startedAt' }`). Counts, orders, and paginates directly on raw start rows in `span_events`; reconstruction touches at most `perPage` rows. `startedAt` is mapped to the start-row `timestamp` column.
- **Slow path** — narrows candidate `(traceId, spanId)` tuples in a CTE, reconstructs only those, then applies post-agg `WHERE`, `ORDER BY`, and pagination on the reconstructed result.

`buildHasChildErrorClause` was changed to take a `rootAlias` parameter and run against `span_events` directly. Because `error` is reconstructed via `arg_max(error, timestamp) FILTER (WHERE error IS NOT NULL)`, an `error IS NOT NULL` predicate on raw rows is observation-equivalent to the same check on the reconstructed view (a once-set error always survives reconstruction).

## Key Changes

### `stores/duckdb/src/storage/domains/observability/tracing.ts`

- `tracing.ts:188-192` — `buildHasChildErrorClause(hasChildError, rootAlias)` now reads `span_events` directly via correlated EXISTS, removing dependency on a `reconstructed_spans` CTE.
- `tracing.ts:194-260` — New helper module:
  - `PREFILTER_KEYS` set of pushable scalar columns.
  - `SAFE_PREFILTER_ORDER_FIELDS = { 'startedAt' }` — gates the fast path. `endedAt` is excluded because start rows have NULL `endedAt`.
  - `intersectTimestampRange(existing, incoming)` — takes `max(start)` / `min(end)` with exclusive flags ORed on ties. Required because both `startedAt` and `endedAt.end` can produce upper bounds on the start-row `timestamp`; without intersection, processing order would matter and the looser bound could leak rows.
  - `partitionAnchorFilters(filters)` — splits filters into `prefilter` / `postAgg` / `hasChildError`.
- `tracing.ts:594-690` — Refactored `listTraces`:
  - Always pushes `eventType = 'start' AND parentSpanId IS NULL` plus prefilter scalar predicates.
  - Validates `orderBy.direction` (throws on invalid).
  - Fast path: `WITH page_roots AS (… LIMIT ? OFFSET ?)` then `SPAN_RECONSTRUCT_SELECT` joined via `(traceId, spanId) IN (SELECT … FROM page_roots)`.
  - Slow path: `WITH candidate_roots AS (…), root_spans AS (SPAN_RECONSTRUCT_SELECT WHERE (traceId, spanId) IN candidate_roots GROUP BY traceId, spanId)` then post-agg `WHERE` (including `EXISTS … FROM span_events` for `hasChildError`).
- `tracing.ts:751-910` — Refactored `listBranches` with the same shape. Caller-supplied non-branch `spanType` short-circuits to empty before any query runs. `spanType` is consumed inline (not via `PREFILTER_KEYS`) so the IN-list / equality form is always emitted.

### `stores/duckdb/src/storage/domains/observability/index.test.ts`

- New `listTraces applies scalar prefilter and tag post-filter correctly` — covers fast-path (env+startedAt) and slow-path (tags+startedAt).
- New `listTraces intersects startedAt and endedAt upper bounds on the prefilter` — regression for the `intersectTimestampRange` fix; runs the same query with reversed key order to exercise both `Object.entries` traversal paths.
- New `listBranches applies scalar prefilter and tag post-filter correctly` — same shape for branches.

### `.changeset/duckdb-list-traces-prefilter.md`

- Patch bump for `@mastra/duckdb` describing the perf improvement; explicitly notes no API/behavior change, no migration.

## Architecture Impact

Self-contained inside the DuckDB store. ClickHouse and other observability backends are not touched. The PR description notes the ClickHouse path uses an MV-filtered table; in DuckDB the start-row prefilter is what enforces "list only roots / list only branches".

## Dependencies

None added.

## Testing

- New Vitest cases noted above.
- CI status (at time of review): 3 checks success (Vercel, CodeRabbit), Full Test Suite + E2E + Combined store + Memory Tests pending.
- No unit tests exist that directly exercise the validate-direction throw or the `hasChildError` EXISTS rewrite.

## Potential Concerns

1. **PREFILTER_KEYS soundness depends on column stability across events.** Many of the columns in `PREFILTER_KEYS` (`name`, `spanType`, `source`, `entityType`, `entityId`, `entityName`, ...) are reconstructed via `arg_max(col, timestamp) FILTER (WHERE col IS NOT NULL)`. Pushing predicates on these to start rows is correct only if the start-row value matches the reconstructed value. If any event-sourced span ever updates these fields between start and end, the prefilter could miss/leak rows. The doc-comment asserts these are "stable scalar columns" — this assumption is not test-enforced. If span ingestion ever evolves to emit name/spanType updates on later events, this optimization will silently regress correctness.

2. **`hasChildError` semantics.** Switching from `reconstructed_spans` to raw `span_events` is correct given current `arg_max(... FILTER NOT NULL)` semantics, but the equivalence is subtle and undocumented in the source — only the `// Run directly against raw …` comment hints at it. Worth a sentence noting "set-once" is required.

3. **Description / code drift.** PR description says "Added `parseFieldKey` import from `@mastra/core/utils` for safe ORDER BY field handling on raw events". `parseFieldKey` is not actually imported or used in the diff — the fast path hardcodes `ORDER BY timestamp <DIR>` because `startedAt` is the only allowed field. Cosmetic only.

4. **CodeRabbit's two majors are addressed.** The allowlist (`SAFE_PREFILTER_ORDER_FIELDS`) and the timestamp-bound intersection (`intersectTimestampRange`) bugs both have fixes and regression tests. Both threads are resolved.

5. **`hasChildError` gates the fast path even when a postAgg is otherwise absent.** That's deliberate (the EXISTS predicate runs on `root_spans`, not raw rows), but it means a common UI filter ("only failed traces") never gets the fast path. Future optimization opportunity.

6. **CI not green at time of review.** The Full Test Suite, E2E Tests, Combined store Tests, and Memory Tests are still pending. Re-check before merge.

7. **Docstring coverage check at 66.67% (warn).** Pre-merge informational; not blocking.
