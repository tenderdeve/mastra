---
'@mastra/observability': minor
---

Added `MastraObserveExporter` as the renamed replacement for `CloudExporter`. The new class better reflects that it ships data to Mastra's observability backend rather than a generic "cloud".

The original `CloudExporter` class is preserved unchanged and re-exported from `@mastra/observability`, so existing imports, error IDs (`CLOUD_EXPORTER_*`), and the exporter `name` (`mastra-cloud-observability-exporter`) keep working without modification. `CloudExporter` is now marked `@deprecated` and will be removed in a future major version. New code should use `MastraObserveExporter`.

`MastraObserveExporter` uses updated identifiers internally:

- Error IDs use the `MASTRA_OBSERVE_EXPORTER_*` prefix (instead of `CLOUD_EXPORTER_*`)
- The exporter `name` is `mastra-observe-exporter` (instead of `mastra-cloud-observability-exporter`)

If you have monitoring or alert rules that match on the old `CLOUD_EXPORTER_*` error IDs or the `mastra-cloud-observability-exporter` exporter name, those rules will keep firing for the deprecated `CloudExporter` but will not match `MastraObserveExporter`. Update your rules when you migrate.

**Before**

```ts
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';

new Observability({
  configs: {
    default: {
      serviceName: 'my-app',
      exporters: [new DefaultExporter(), new CloudExporter()],
      spanOutputProcessors: [new SensitiveDataFilter()],
    },
  },
});
```

**After**

```ts
import { Observability, DefaultExporter, MastraObserveExporter, SensitiveDataFilter } from '@mastra/observability';

new Observability({
  configs: {
    default: {
      serviceName: 'my-app',
      exporters: [new DefaultExporter(), new MastraObserveExporter()],
      spanOutputProcessors: [new SensitiveDataFilter()],
    },
  },
});
```
