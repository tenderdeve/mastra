---
'@mastra/memory': patch
---

Reuse cross-thread context within an OM step in resource scope. Observational memory now caches `getOtherThreadsContext` for the duration of a single `processInputStep`, so the three internal callsites (status check, post-observation status, and turn refresh) share one fetch instead of recomputing it. The cache is invalidated at every step boundary and whenever the local OM record's generation count changes, so behavior is unchanged. In benchmarks with 50 sibling threads in the same resource, this halves per-step OM overhead (~65 ms → ~31 ms on InMemoryStore; the win scales linearly with sibling-thread message volume on real DB backends).
