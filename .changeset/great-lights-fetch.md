---
'@mastra/core': minor
'@mastra/client-js': patch
'@mastra/observability': patch
'@mastra/inngest': patch
'@mastra/server': patch
'@mastra/upstash': patch
'@mastra/redis': patch
'mastracode': patch
---

Added experimental durable agent signals that can be routed to active local runs and through a Unix socket coordinator. Mastra Code now opts into durable multiplayer streams for project threads.
