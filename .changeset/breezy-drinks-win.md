---
'@mastra/core': minor
'@mastra/redis': patch
---

Added generalized cache primitive to MastraServerCache. The `cache` option in Mastra config lets you provide a custom server cache (e.g. RedisServerCache) for distributed caching. LLM-based processors (Moderation, PII Detector, Prompt Injection Detector, Language Detector, System Prompt Scrubber) now accept `cache: true` to automatically use the Mastra server cache, avoiding redundant LLM calls for identical content. Also added per-key TTL support to `MastraServerCache.set()`.
