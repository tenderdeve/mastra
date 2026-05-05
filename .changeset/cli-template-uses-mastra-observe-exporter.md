---
'mastra': patch
'mastracode': patch
---

Updated the generated project template and runtime bootstrap to use `MastraStorageExporter` and `MastraObserveExporter` from `@mastra/observability`. Existing projects importing `DefaultExporter` or `CloudExporter` continue to work via the deprecated exports.
