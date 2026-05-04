---
'@mastra/core': patch
---

Fixed agent.stream() with structuredOutput persisting "[object Object]" as message text in memory. The stream path now correctly uses the actual text or JSON-serialized structured output, matching the generate path's behavior.
