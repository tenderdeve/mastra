---
'@mastra/core': minor
'@mastra/redis': patch
---

Added per-key TTL support to MastraServerCache.set() method and optional processor caching via cache: true option on LLM-based processors (ModerationProcessor, PIIDetector, PromptInjectionDetector, LanguageDetector, SystemPromptScrubber). When cache: true is set and a MastraServerCache is configured on the Mastra instance, processor detection results are cached to avoid redundant LLM calls. Also supports custom ProcessorCache implementations.
