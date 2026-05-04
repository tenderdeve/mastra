---
'@mastra/core': patch
'@mastra/observability': patch
---

Fixed model step spans so they measure only the provider call. Input step processors, output step processors, and client-side tool execution now appear outside `MODEL_STEP`, making LLM call durations reflect actual model time.
