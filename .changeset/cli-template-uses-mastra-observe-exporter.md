---
'mastra': patch
'mastracode': patch
---

Updated the generated project template and the runtime observability bootstrap to import the renamed `MastraObserveExporter` from `@mastra/observability` (replacing `CloudExporter`). Existing projects that still import `CloudExporter` continue to work via the deprecated alias.
