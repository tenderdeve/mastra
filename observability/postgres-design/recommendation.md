# Postgres Observability Storage — Recommendation

## TL;DR

**Build a single `@mastra/pg` observability domain that auto-detects TimescaleDB at init and opts into hypertables and native columnstore compression when the extension is present.** Vanilla Postgres works honestly up to roughly **20–50 sustained agent calls per second** on a default managed instance (db.m6g.large class) before IOPS, WAL, autovacuum, and index bloat make ingestion unsafe to run on the customer's primary application database. Timescale extends that ceiling to roughly **300–1,000 calls/second sustained** on similar hardware while keeping 30 days of data manageable in storage. Past that — and in particular past ~1,500 calls/sec sustained — recommend ClickHouse, loudly and in the docs. Default retention should be opinionated at 7 days; defaulting to "off" is what produced the "12 GB on my laptop" report. LibSQL/Turso should ship as **dev-only**, capped and documented, never recommended for production observability because of single-writer semantics on a shared application DB.

This recommendation is built on the volume math below. It is not "Postgres works for most users" — that framing is wrong. It is "Postgres works honestly up to a documented ceiling, and ClickHouse remains the production answer above it."

---

## 2. Volume math

### Per-call payload (1× of the getting-started example)

The brief states: 100 spans + 20 metrics + 13 logs + 3 scores ≈ **136 rows per call**. The relative weights matter for the per-row size estimate because the five tables have very different row shapes.

#### Per-row sizes in vanilla Postgres (row-oriented heap, JSONB columns)

Postgres tuple overhead is 23 B per row plus a null bitmap and 8-byte alignment padding. JSONB values store as binary; under ~2 KB they live inline, larger values spill to TOAST and queries that touch them pay a 2–10× penalty. The vNext span table has roughly 35 columns of which 8 are JSON payloads (`attributes`, `input`, `output`, `error`, `metadataRaw`, `requestContext`, `links`, `scope`).

| Row type | Fixed columns | JSONB payloads | On-disk avg | Notes |
|----------|---------------|----------------|-------------|-------|
| Span — LLM/tool | ~500 B | `input` 1 KB + `output` 1.5 KB + `attributes` 800 B + others 500 B | **~4 KB** | 20–30% of spans in a typical call |
| Span — framework/orchestration | ~500 B | `attributes` 200 B, others empty/small | **~800 B** | 70–80% of spans |
| Metric event | ~400 B | `labels` map ~150 B, `metadata` ~100 B | **~700 B** | Mostly fixed columns |
| Log event | ~400 B | `message` 200 B + `data` 500 B + `metadata` 200 B | **~1.3 KB** | Heavily message-dependent |
| Score event | ~400 B | `metadata` ~100 B + `reason` ~200 B | **~700 B** | |
| Feedback event | ~400 B | `metadata` ~100 B + `comment` ~200 B | **~700 B** | Often zero per call |

Per-call heap content (one call at 1× scale):

- 20 LLM/tool spans × 4 KB = 80 KB
- 80 framework spans × 800 B = 64 KB
- 20 metrics × 700 B = 14 KB
- 13 logs × 1.3 KB = 17 KB
- 3 scores × 700 B = 2 KB

**~177 KB raw heap content per call.**

This estimate is consistent with the "12 GB DuckDB in a few days, single dev" data point from the brief. DuckDB columnar with dictionary + RLE encoding typically gets 5–10× compression on observability data with low-cardinality categorical fields ([Tiger Data](https://www.tigerdata.com/blog/how-timescaledb-outperforms-clickhouse-mongodb-logtides-observability-platform); [DEV TimescaleDB compression](https://dev.to/polliog/timescaledb-compression-from-150gb-to-15gb-90-reduction-real-production-data-bnj)). 12 GB DuckDB ≈ 60–120 GB equivalent in raw row form, which lines up with ~10 calls/min × 4 days × ~360 KB after indexes.

#### Index and WAL overhead in vanilla Postgres

The existing `stores/pg` observability domain ships **10 default indexes** on the spans table alone (`stores/pg/src/storage/domains/observability/index.ts:71-131`): trace+startedAt, parentSpan+startedAt, name, spanType+startedAt, root-spans partial, entityType+entityId, entityType+entityName, orgId+userId, GIN on metadata, GIN on tags. Each index is a B-tree (or GIN) update per insert, so a single span insert is ~11 page touches. GIN indexes specifically are slow on insert and accumulate a pending list that has to be merged on read or by autovacuum.

Empirical Postgres index overhead for write-heavy event tables typically lands in the 60–100% range of heap size, dominated by the GIN indexes on JSONB and array columns. Use **+70% multiplier** for indexed disk size.

Postgres WAL with `wal_compression=on` and frequent checkpoints adds another ~1× heap-equivalent of I/O ([Tiger Data: Boosting INSERT performance](https://www.tigerdata.com/blog/boosting-postgres-insert-performance)). Full-page images in WAL after a checkpoint can transiently double this.

| Layer | Bytes per call | Notes |
|------:|---------------:|-------|
| Heap content | 177 KB | Five tables, six row classes |
| + Page/row overhead, fillfactor | ~210 KB | ~20% |
| + Indexes (~70%) | ~360 KB | Drops to ~250 KB if you skip the GIN indexes |
| + WAL written | ~700 KB–1 MB | Including FPIs after checkpoints |

**Bottom line: ~360 KB on disk and ~800 KB of write I/O per call.**

#### Vanilla Postgres scale tiers

Assume sustained ingestion at 1×, 10×, and 100× call rates. The brief is ambiguous about whether the multipliers apply to row count per call or call rate; calls/sec is the meaningful axis for an OLTP database, so I'm using that.

| Scale | Calls/sec | Rows/sec | Bytes/sec on disk | 1 day on disk | 7 days | 30 days |
|------:|----------:|---------:|------------------:|--------------:|-------:|--------:|
| 1× | 1 | 136 | 360 KB | **30 GB** | 210 GB | **900 GB** |
| 10× | 10 | 1,360 | 3.6 MB | **300 GB** | 2.1 TB | **9 TB** |
| 100× | 100 | 13,600 | 36 MB | **3 TB** | 21 TB | **90 TB** |

(These numbers track the table size; index churn, dead-tuple bloat, and WAL retention each add 30–100% on top in a real running database.)

#### Timescale storage with native columnstore compression

Timescale's [native columnstore compression](https://www.tigerdata.com/blog/timescaledb-1000x-faster-queries-90-data-compression-and-much-more) reports **90–95% reduction** on time-series with sparse JSON-like columns. Production reports for observability data: LogTide compressed 220 GB raw (135 GB row data + 85 GB indexes) down to **25 GB — 88.6% reduction** ([Tiger Data — LogTide case study](https://www.tigerdata.com/blog/how-timescaledb-outperforms-clickhouse-mongodb-logtides-observability-platform)); a separate report cites **150 GB → 15 GB** ([DEV — TimescaleDB compression real production data](https://dev.to/polliog/timescaledb-compression-from-150gb-to-15gb-90-reduction-real-production-data-bnj)). Use **88% reduction** as a conservative working number on chunks older than the compress-after window (typically 7 days).

| Scale | 30-day raw | 30-day with Timescale compression after 7 days | Realistic on disk |
|------:|-----------:|-----------------------------------------------:|------------------:|
| 1× | 900 GB | (210 GB recent + 0.88 × 690 GB compressed) ≈ 290 GB | ~290 GB |
| 10× | 9 TB | (2.1 TB recent + 0.88 × 6.9 TB compressed) ≈ 2.9 TB | ~2.9 TB |
| 100× | 90 TB | ~29 TB | ~29 TB |

Timescale shifts the storage curve from "scary" to "manageable" at the 1× and 10× tiers and from "impossible" to "expensive" at 100×.

#### Sustained insert rate ceilings

Vanilla Postgres on commodity managed hardware:

- **db.m6g.large (2 vCPU, 8 GB RAM, gp3 baseline 3K IOPS)** — pgbench-style mixed OLTP saturates around 5–10 K simple TPS. With 6 observability tables, 10+ indexes on spans (including two GIN), and JSONB-heavy rows, sustained insert capacity is **~5–10 K rows/sec ≈ 35–75 calls/sec** before autovacuum falls behind and IOPS saturates ([AWS — RDS Postgres dedicated log volumes](https://aws.amazon.com/blogs/database/benchmark-amazon-rds-for-postgresql-with-dedicated-log-volumes/); [DBOS — Workflow execution scalability](https://www.dbos.dev/blog/benchmarking-workflow-execution-scalability-on-postgres)).
- **db.m7g.xlarge (4 vCPU, 16 GB RAM, gp3 with 10–16 K provisioned IOPS)** — sustained **15–30 K rows/sec ≈ 110–220 calls/sec**.
- **Supabase Pro (≈ 2 vCPU / 4 GB)** — closer to the smaller tier, ~30–50 calls/sec sustained.

The current `@mastra/pg` `batchInsert` (`stores/pg/src/storage/db/index.ts:1206`) loops single-row INSERTs inside a transaction — not multi-row VALUES, not COPY. A new observability domain should switch to **multi-row `INSERT ... VALUES` with `ON CONFLICT DO NOTHING`** (or per-table `COPY` for the largest batches). Multi-row VALUES alone is typically 5–10× faster than single-row in a transaction; `COPY` is another 2–3× ([Tiger Data — Benchmarking PostgreSQL Batch Ingest](https://www.tigerdata.com/blog/benchmarking-postgresql-batch-ingest)).

Timescale on the same hardware:

- Reported sustained **100–200 K rows/sec** on moderate cloud VMs ([Timescale — TimescaleDB vs Postgres](https://www.timescale.com/blog/timescaledb-vs-6a696248104e/)). With chunk-local indexes (much smaller than monolithic indexes on a 30-day flat table), GIN cost drops sharply. Realistic working number for Mastra's mix: **30–80 K rows/sec ≈ 220–600 calls/sec** on a db.m7g.xlarge equivalent.
- Timescale 2.21's "direct to columnstore" path pushes well past this in narrow scenarios but isn't a fit for the live-write path here.

### Where each option breaks

**Vanilla Postgres falls over here:**

1. **IOPS first.** gp3 baseline 3 K IOPS is eaten by FPIs and index page writes around 50 calls/sec. Provisioned io2 helps but is expensive enough that the customer asks why they aren't on ClickHouse.
2. **Index bloat second.** Two GIN indexes (JSONB, tags) plus eight B-trees on a multi-billion-row spans table; after 30 days at 10 calls/sec the table is ~1 B rows, autovacuum can't keep up, `listTraces` queries chase dead tuples.
3. **VACUUM third.** Anti-wraparound VACUUM on a TB-scale table takes hours and pins an autovacuum worker.
4. **Past ~50 calls/sec** on a shared default instance, observability writes interleave with app writes and visibly degrade the customer's product.
5. **Past ~200 calls/sec** on a tuned beefy instance, you can't keep up no matter the tuning — recommend Timescale or ClickHouse.

**Timescale falls over here:**

1. **High-cardinality `segmentby`** (e.g., `traceId`) defeats columnstore compression. Mastra's segmentation should stay coarse: `entityType` for spans, `name` for metrics, `level` for logs.
2. **GIN on JSONB still hot** on uncompressed recent chunks.
3. **Single-primary write bottleneck** at ~1–2 K calls/sec sustained. Multi-node Timescale is operationally closer to running ClickHouse than running Postgres.

---

## 3. Ceiling summary

| Option | Comfortable | Tunable ceiling | What breaks past it |
|--------|-------------|-----------------|---------------------|
| Vanilla Postgres, default managed instance | ≤ 20 calls/sec | ~50 calls/sec | IOPS, WAL FPIs, GIN bloat, autovacuum |
| Vanilla Postgres, tuned + provisioned IOPS | ≤ 100 calls/sec | ~200 calls/sec | Index/heap bloat, VACUUM blast radius |
| Postgres + Timescale, default managed | ≤ 200 calls/sec | ~600 calls/sec | GIN cost on hot chunks |
| Postgres + Timescale, tuned hardware | ≤ 800 calls/sec | ~1,500–2,000 calls/sec | Single-primary write ceiling |
| ClickHouse vNext | 10,000+ calls/sec | Practically uncapped | n/a |
| LibSQL local / Turso | ≤ 5 / ≤ 1 calls/sec | ~20 calls/sec local | Single-writer contention |

These are "would I run this for a customer" numbers, not headline benchmark numbers.

---

## 4. Proposed schema sketch

Mirror the ClickHouse vNext per-signal layout. **Six tables** — `mastra_span_events`, `mastra_trace_roots`, `mastra_metric_events`, `mastra_log_events`, `mastra_score_events`, `mastra_feedback_events` — plus the materialized view (or trigger) populating `trace_roots`. Reusing the ClickHouse table names and column shapes makes shared types and the exporter's batch-create methods drop in cleanly; it also keeps the recommendation document for ClickHouse design as the authoritative source of truth for column semantics.

Critical column/type adjustments for Postgres:

- `LowCardinality(String)` → plain `text`. Postgres has no equivalent, but column compression and toast deduplication recover most of the benefit on disk.
- `Map(LowCardinality(String), String)` (`labels`, `metadataSearch`) → `jsonb` with a `jsonb_path_ops` GIN index. Equality lookups on top-level keys remain index-eligible via `@>`.
- `Array(LowCardinality(String))` (`tags`) → `text[]` with a GIN index for contains-all semantics.
- `dedupeKey` → `text` with a unique index on `(traceId, spanId)` for spans and on the per-signal ID for the others; insert paths use `ON CONFLICT DO NOTHING` for retry-idempotency. ClickHouse leans on `ReplacingMergeTree` to merge duplicates eventually; Postgres should reject them at write time.
- `DateTime64(3, 'UTC')` → `timestamptz` (Postgres can't store sub-millisecond reliably across all builds; millisecond precision matches the existing storage layer).

### Spans table sketch (most representative)

```sql
CREATE TABLE mastra_span_events (
  -- Identity
  trace_id        text NOT NULL,
  span_id         text NOT NULL,
  parent_span_id  text,
  experiment_id   text,

  -- Entity hierarchy (flattened from vNext)
  entity_type     text,
  entity_id       text,
  entity_name     text,
  entity_version_id        text,
  parent_entity_type       text,
  parent_entity_id         text,
  parent_entity_name       text,
  parent_entity_version_id text,
  root_entity_type         text,
  root_entity_id           text,
  root_entity_name         text,
  root_entity_version_id   text,

  -- Context
  user_id         text,
  organization_id text,
  resource_id     text,
  run_id          text,
  session_id      text,
  thread_id       text,
  request_id      text,
  environment     text,
  execution_source text,
  service_name    text,

  -- Span scalars
  name            text NOT NULL,
  span_type       text NOT NULL,
  is_event        boolean NOT NULL DEFAULT false,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz NOT NULL,

  -- Query-relevant flexible
  tags             text[] NOT NULL DEFAULT '{}',
  metadata_search  jsonb  NOT NULL DEFAULT '{}'::jsonb,

  -- Information-only payloads
  attributes      jsonb,
  scope           jsonb,
  links           jsonb,
  input           jsonb,
  output          jsonb,
  error           jsonb,
  metadata_raw    jsonb,
  request_context jsonb,

  PRIMARY KEY (trace_id, span_id)
)
PARTITION BY RANGE (ended_at);   -- vanilla; Timescale skips this and calls create_hypertable() instead
```

Indexes (mirrors what `stores/pg/src/storage/domains/observability/index.ts:71-131` already declares for the legacy spans table; reused unchanged):

- `(trace_id, ended_at DESC)` — full-trace fetch
- `(parent_span_id, ended_at DESC)` — child lookup
- `(span_type, ended_at DESC)` — span-type filter on listTraces
- partial `(ended_at DESC) WHERE parent_span_id IS NULL` — root-span list
- `(entity_type, entity_id)`, `(entity_type, entity_name)` — entity filters
- `(organization_id, user_id)` — multi-tenant filter
- GIN on `tags` (`array_ops`)
- GIN on `metadata_search` (`jsonb_path_ops`)

GIN on the full `metadata_raw`/`attributes` payloads is **not** in the default set. The vNext design explicitly narrows trace-metadata search to a top-level string-string projection (`metadataSearch`), and Postgres should follow the same contract — leaving the bulky JSON payloads index-free is most of the difference between "viable" and "unviable" at scale.

### Partitioning

- **Vanilla Postgres**: Range-partition by `ended_at` / `timestamp` per day. Use `pg_partman` to create future partitions and to drop old ones. Without partitioning, retention deletes turn into table-wide `DELETE`s that destroy a primary at any non-trivial scale.
- **TimescaleDB**: `SELECT create_hypertable('mastra_span_events', 'ended_at', chunk_time_interval => INTERVAL '1 day');` with `add_compression_policy(... INTERVAL '7 days')` and `add_retention_policy(... INTERVAL '30 days')`. The base DDL stays identical — Timescale-specific calls are layered on at init time when the extension is detected.

### `trace_roots`

Implementing it as a Postgres `MATERIALIZED VIEW` is the wrong fit because materialized views in Postgres aren't incremental. Two viable options:

1. **Trigger on `mastra_span_events` insert** that copies root-span rows (`parent_span_id IS NULL`) into `mastra_trace_roots`. Cheap, eager, no staleness; pays a small per-insert cost only for root spans (1% of inserts).
2. **`listTraces` queries the spans table directly** via the partial root-span index, skipping `trace_roots` entirely. Simpler, but loses the small-table cache locality benefit of the ClickHouse design.

I'd ship option 1: trigger-driven `trace_roots`. It matches the vNext shape and keeps `listTraces` reading from a 100×-smaller table.

### Retention policies

- Timescale: `add_retention_policy('mastra_span_events', INTERVAL '%d days')` per signal.
- Vanilla Postgres: a `pg_cron` (or external) job that calls `pg_partman.run_maintenance()` daily.

---

## 5. Config surface

```ts
import { ObservabilityStoragePostgres } from '@mastra/pg/observability';

const observability = new ObservabilityStoragePostgres({
  connectionString: process.env.OBSERVABILITY_PG_URL,

  // Optional: schema isolation. Defaults to 'mastra_observability' so the
  // adapter never collides with the user's app tables.
  schemaName: 'mastra_observability',

  // Per-signal retention in days. Mastra ships an opinionated 7-day default
  // for tracing and logs because they dominate volume; metrics/scores/feedback
  // are cheap and default to 30. Set a value to override; set to 0 to disable.
  retention: {
    tracing: 7,
    logs: 7,
    metrics: 30,
    scores: 30,
    feedback: 30,
  },

  // Auto-detected from pg_extension at init. Set explicitly to skip the probe
  // or to opt out of TimescaleDB even when the extension is installed.
  timescale: 'auto', // 'auto' | 'enabled' | 'disabled'

  // Connection pool dedicated to observability writes. Defaults are
  // tuned for the assumption that this Postgres is shared with the app.
  pool: {
    max: 5,
    statementTimeoutMs: 5_000,
  },

  // Hard cap on sustained call rate. The adapter logs a warning when the
  // exporter's flush rate sustains above this; set to null to disable.
  warnAboveCallsPerSecond: 50, // raise to 500 when timescale is detected
});
```

A few decisions baked into this surface:

- **Default schema is not `public`.** Observability tables in the customer's primary schema is exactly the failure mode the docs need to discourage. Defaulting to `mastra_observability` makes the isolation visible.
- **Retention defaults are opinionated.** 7-day tracing/logs is the cheapest credible answer to "12 GB on my laptop." Customers who want more set a number; customers who want unbounded set 0 and accept the consequence.
- **Connection pool is dedicated.** The adapter never reuses the app's pool. `statement_timeout` is set per-session so a runaway listTraces query can't stall the exporter.
- **Timescale is auto-detected.** A single `SELECT 1 FROM pg_extension WHERE extname='timescaledb'` at init switches the DDL path. Users with stock Postgres lose: the columnstore compression (so storage is roughly 8× larger 30 days out), `add_retention_policy` (replaced with `pg_partman` cron), and the chunk-exclusion query speedup on time-bucketed reads. Functionally identical write/read API; quantitatively different bills.

---

## 6. Open questions for the team

1. **Is shipping a write-only-supported strategy acceptable?** ClickHouse vNext exposes `observabilityStrategy: { preferred: 'insert-only', supported: ['insert-only'] }`. Postgres can support both `insert-only` and `batch-with-updates` (the existing `stores/pg` legacy implementation does the latter). Insert-only is cheaper to operate and is the only thing that scales — but it constrains live trace visibility (no started-span rows in storage). Should the adapter declare insert-only only, or both?
2. **Default retention behavior on first install.** 7-day default reduces the "12 GB" risk but silently drops data for users who didn't read the config docs. Is that the right trade? Alternative: ship retention off by default but display a one-time `console.warn` at init when no retention is configured.
3. **Schema isolation default.** Defaulting to a non-`public` schema is opinionated and may break existing `@mastra/pg` users who have run other domains in `public`. Is that breaking change acceptable in a 1.0 release of the observability domain, or should the default match the adapter's existing convention?
4. **`pg_partman` as a hard dependency vs. soft.** Without it, vanilla Postgres can't drop old partitions cleanly. Hard-requiring `pg_partman` means the adapter fails init on any host that doesn't have it; soft-requiring means the customer has to install + cron themselves and many will not. Recommendation leans toward soft-requiring with a loud warning + retention-off if it's missing.
5. **Realtime or batch-only strategy contract for the exporter.** The current `DefaultExporter` (`observability/mastra/src/exporters/default.ts:91`) defaults to `maxBatchSize: 1000` spans / `maxBatchWaitMs: 5000`. For Postgres the right batch size is closer to **200–500 rows** per multi-row VALUES insert (parser/protocol overhead climbs past that). Should the adapter advertise a recommended batch size, or override it at init?
6. **Discovery refresh.** ClickHouse vNext uses refreshable materialized views recomputing every 1–5 minutes. Postgres can't do this natively. Options: a periodic background job inside the adapter (introduces a long-lived process inside what's normally a stateless library), an `pg_cron` extension dependency, or compute discovery on the fly with `SELECT DISTINCT` over the last N days (slow but simple). My read: compute on the fly + cache results in-memory for 60s. Confirmation needed.
7. **Are we ready to tell customers "use ClickHouse" in the docs?** Saying it loud and putting a real call-rate cutoff into the README is the load-bearing piece that turns this from "a Postgres adapter that fails customers" into "a Postgres adapter that customers use within its honest range." The team has to be willing to ship that copy.

---

## 7. LibSQL / Turso

Customers ask for libSQL because they want "everything in one SQLite file" or because they're already on Turso for the application. The honest answer is **dev-only** and the docs should say so.

**Why it doesn't survive production observability load:**

1. **Single-writer model.** SQLite (and libSQL, which inherits SQLite's WAL semantics) serializes all writes through a single writer. Turso's "concurrent writes" feature is a separate beta product built on the Rust rewrite, not regular libSQL ([Turso — Beyond the single-writer limitation](https://turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes); [Better Stack — Turso explained](https://betterstack.com/community/guides/databases/turso-explained/)).
2. **Shared with the app's writes.** If observability writes share the libSQL file with the app (the whole pitch), every flush blocks app writes and vice versa. Worse than the shared-Postgres failure mode because there's no separate write queue.
3. **Throughput.** Raw SQLite is 80–150 K inserts/sec on local NVMe; over Turso's network protocol it drops 1–2 orders of magnitude. Realistic sustained for Mastra observability:
   - **Local libSQL file**: ~5–10 K rows/sec ≈ 35–75 calls/sec, only if observability is the sole writer (it won't be).
   - **Turso remote**: ~500–2,000 rows/sec ≈ 4–15 calls/sec.
4. **No partitioning, no columnstore.** 30 days at 1 call/sec is ~10 GB with ad-hoc indexes; gets slower as it grows, no operational off-ramp.

**Recommendation:** ship libSQL observability as **dev-only**, mark it in README and `init()` logs, default retention to 3 days, document a hard cap of ~20 calls/sec, redirect production users to Postgres or ClickHouse. LibSQL is good for the dev loop where a single contributor wants traces in Studio without standing up a database — it's not a production observability backend.

---

## Sources

- [Tiger Data — How TimescaleDB Outperforms ClickHouse and MongoDB for LogTide's Observability Platform](https://www.tigerdata.com/blog/how-timescaledb-outperforms-clickhouse-mongodb-logtides-observability-platform)
- [Tiger Data — Benchmarking PostgreSQL Batch Ingest](https://www.tigerdata.com/blog/benchmarking-postgresql-batch-ingest)
- [Tiger Data — Boosting Postgres INSERT Performance by 50%](https://www.tigerdata.com/blog/boosting-postgres-insert-performance)
- [Tiger Data — PostgreSQL + TimescaleDB: 1000x Faster Queries, 90% Compression](https://www.tigerdata.com/blog/postgresql-timescaledb-1000x-faster-queries-90-data-compression-and-much-more)
- [Tiger Data — Speed Without Sacrifice: TimescaleDB 2.21](https://www.tigerdata.com/blog/speed-without-sacrifice-37x-faster-high-performance-ingestion-42x-faster-deletes-improved-cagg-updates-timescaledb-2-21)
- [Timescale — TimescaleDB vs Postgres for time-series](https://www.timescale.com/blog/timescaledb-vs-6a696248104e/)
- [DEV — TimescaleDB Compression: From 150GB to 15GB](https://dev.to/polliog/timescaledb-compression-from-150gb-to-15gb-90-reduction-real-production-data-bnj)
- [DEV — TimescaleDB Compression: A Complete Guide to 95%+ Storage Reduction](https://dev.to/philip_mcclarence_2ef9475/timescaledb-compression-a-complete-guide-to-95-storage-reduction-2mo4)
- [AWS — Benchmark Amazon RDS for PostgreSQL with Dedicated Log Volumes](https://aws.amazon.com/blogs/database/benchmark-amazon-rds-for-postgresql-with-dedicated-log-volumes/)
- [AWS — Optimized bulk loading in Amazon RDS for PostgreSQL](https://aws.amazon.com/blogs/database/optimized-bulk-loading-in-amazon-rds-for-postgresql/)
- [DBOS — Benchmarking How Workflow Execution Scales on Postgres](https://www.dbos.dev/blog/benchmarking-workflow-execution-scalability-on-postgres)
- [Snowflake Engineering — Postgres JSONB Columns and TOAST: A Performance Guide](https://www.snowflake.com/en/engineering-blog/postgres-jsonb-columns-and-toast/)
- [pganalyze — Postgres performance cliffs with large JSONB values and TOAST](https://pganalyze.com/blog/5mins-postgres-jsonb-toast)
- [PostgreSQL Documentation — TOAST](https://www.postgresql.org/docs/current/storage-toast.html)
- [Turso — Beyond the Single-Writer Limitation with Turso's Concurrent Writes](https://turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes)
- [Better Stack — How Turso Eliminates SQLite's Single-Writer Bottleneck](https://betterstack.com/community/guides/databases/turso-explained/)
