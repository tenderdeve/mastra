---
'mastra': patch
---

Pinned zod to 4.3.4 in newly created Mastra projects to work around a Studio UI regression where post-tool-call assistant messages were saved to the database but never rendered when zod 4.4.0+ was used. New projects created via `npm create mastra@latest` (and the `mastra init` flow) now install `zod@4.3.4` instead of `zod@^4`.
