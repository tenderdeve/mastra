---
'@mastra/observability': minor
---

Added `MastraObserveExporter`, the renamed replacement for `CloudExporter`. The original `CloudExporter` is still exported and works unchanged, but is now deprecated and will be removed in a future major version.

```ts
// Before
import { CloudExporter } from '@mastra/observability';
new CloudExporter();

// After
import { MastraObserveExporter } from '@mastra/observability';
new MastraObserveExporter();
```

The constructor signature and environment variables (`MASTRA_CLOUD_ACCESS_TOKEN`, `MASTRA_PROJECT_ID`, `MASTRA_CLOUD_TRACES_ENDPOINT`) are identical. The new class uses updated error IDs (`MASTRA_OBSERVE_EXPORTER_*`) and exporter name (`mastra-observe-exporter`); the deprecated `CloudExporter` keeps its original strings so existing monitoring rules continue to match.
