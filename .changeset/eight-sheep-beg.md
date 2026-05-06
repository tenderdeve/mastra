---
'@mastra/memory': patch
---

Improved observational memory performance for agents using resource-scoped memory across many threads.

When an agent runs in resource scope, sibling threads' message context is now reused within a single agent step instead of being recomputed multiple times. This cuts per-step OM overhead roughly in half once a resource has more than a handful of threads, with the win growing as sibling-thread message volume grows. Behavior is unchanged.
