---
'@mastra/core': patch
'mastracode': patch
---

Added durable agent signals that can start idle thread runs and fixed Mastra Code active-stream message handling. Signals received while a final response is streaming now continue the durable loop instead of being stranded. Active-stream user messages stay pinned until their response turn starts, then move into chat history before that response.
