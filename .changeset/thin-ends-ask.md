---
'@mastra/core': minor
'@mastra/redis': patch
---

Added per-key TTL support to MastraServerCache.set() method and optional processor caching via cacheLLMResponse option on LLM-based processors (ModerationProcessor, PIIDetector, PromptInjectionDetector, LanguageDetector, SystemPromptScrubber). When cacheLLMResponse: true is set and a MastraServerCache is configured on the Mastra instance, processor detection results are cached to avoid redundant LLM calls. Includes default content normalization (trim + collapse whitespace) for cache keys and a configurable cacheKeyNormalizer option. Also supports custom ProcessorCache implementations.
