---
'@mastra/core': patch
'mastracode': patch
---

Route MastraCode active-stream submissions through durable agent signals. Signal-capable runs accept editor submissions immediately, keep pending user messages pinned until confirmed by the stream, and move them into chat history at the correct response boundary.
