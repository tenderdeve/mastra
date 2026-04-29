---
'@mastra/server': patch
---

Fix `GET /agents` returning 500 when an agent's dynamic `instructions` (or other dynamic config such as `getLLM`, `getModelList`, `getDefaultOptions`, `listTools`, sub-agent `listAgents`) throws under the active request context. Each per-agent dynamic getter is now isolated: failures are logged with the agent name and the agent is returned with safe defaults so the rest of the list still renders. The list handler also uses `Promise.allSettled` so a catastrophic failure in one agent's serialization can no longer reject the whole response, matching the existing behavior for stored agents.
