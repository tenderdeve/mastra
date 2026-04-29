---
'@mastra/redis': minor
'@mastra/core': patch
---

Added RedisServerCache — a Redis-backed implementation of MastraServerCache for distributed caching. Drop-in replacement for InMemoryServerCache with configurable TTL, LRU eviction, and key prefixing. Can share a Redis connection with RedisStore.
