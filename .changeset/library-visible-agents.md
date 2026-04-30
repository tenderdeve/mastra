---
'@mastra/core': patch
'@mastra/server': patch
'@mastra/client-js': patch
---

Agent Builder Library now lists code-defined agents and exposes a `configuration.library.visibleAgents` allowlist for admins. Omit the field to show all code-defined agents; pass an array of agent IDs to restrict visibility.
