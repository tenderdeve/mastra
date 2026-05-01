---
'@mastra/core': patch
---

Fixed message part ordering in buildMessagesFromChunks to preserve stream start order instead of stream completion order. Previously, text and reasoning parts could appear out of order when their spans overlapped with other parts (e.g. tool calls), because parts were emitted when their end marker arrived rather than when they started in the stream.
