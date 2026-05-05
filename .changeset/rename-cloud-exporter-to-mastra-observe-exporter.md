---
'@mastra/observability': minor
---

Renamed `CloudExporter` to `MastraObserveExporter` to better reflect that it ships data to Mastra's observability backend rather than a generic "cloud". The original `CloudExporter` export (and its `CloudExporterConfig` type) remains available as a deprecated alias and will be removed in a future major version.

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
