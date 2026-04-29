---
"@mastra/core": minor
"@mastra/redis": minor
---

feat: add ProcessorCache interface and Redis-backed LRU cache for LLM-based processors

- Added `ProcessorCache` interface in `@mastra/core` for caching LLM detection results
- Added `cache` option to all 5 LLM-based processors: ModerationProcessor, PIIDetector, PromptInjectionDetector, LanguageDetector, SystemPromptScrubber
- Added `RedisProcessorCache` in `@mastra/redis` with configurable TTL and LRU eviction
- Cache keys incorporate processor ID, content hash, and config hash for automatic invalidation on config changes
