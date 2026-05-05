---
'@mastra/observability': minor
---

Renamed two built-in observability exporters to clearer names. The originals are still exported (now deprecated) and continue to work unchanged, including their existing exporter `name` strings and error IDs, so monitoring rules and dashboards keep matching until you migrate.

- `CloudExporter` → `MastraObserveExporter`
- `DefaultExporter` → `MastraStorageExporter`

```ts
// Before
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

// After
import { Observability, MastraStorageExporter, MastraObserveExporter, SensitiveDataFilter } from '@mastra/observability';

new Observability({
  configs: {
    default: {
      serviceName: 'my-app',
      exporters: [new MastraStorageExporter(), new MastraObserveExporter()],
      spanOutputProcessors: [new SensitiveDataFilter()],
    },
  },
});
```

Constructor signatures and environment variables (`MASTRA_CLOUD_ACCESS_TOKEN`, `MASTRA_PROJECT_ID`, `MASTRA_CLOUD_TRACES_ENDPOINT`) are unchanged. The renamed classes use updated identifiers internally:

- `MastraObserveExporter` uses error IDs prefixed `MASTRA_OBSERVE_EXPORTER_*` and exporter `name` `mastra-observe-exporter`.
- `MastraStorageExporter` uses exporter `name` `mastra-storage-exporter`.

The deprecated `CloudExporter` and `DefaultExporter` keep their original `CLOUD_EXPORTER_*` IDs, `mastra-cloud-observability-exporter` name, and `mastra-default-observability-exporter` name respectively.
