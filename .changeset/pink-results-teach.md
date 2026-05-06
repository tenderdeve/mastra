---
'@mastra/observability': patch
'@mastra/core': patch
---

Added `availableTools` attribute to `MODEL_STEP` spans, mirroring the existing attribute on `AGENT_RUN` spans. The per-step list reflects the tools the model could actually call on that step, including any narrowing from `activeTools`, input processors, or `prepareStep` overrides. This makes per-step tool mutations visible in traces, which the `AGENT_RUN`-level attribute can't represent.

The new attribute appears alongside `stepIndex`, `usage`, `finishReason`, etc. on `MODEL_STEP` spans. Existing exporters (Langfuse, Datadog, Arize, etc.) will surface it without code changes.
