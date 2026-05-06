---
'@mastra/otel-exporter': patch
'@mastra/posthog': patch
'@mastra/core': patch
---

**Added** Provider-specific options are now captured on `MODEL_GENERATION` spans under a new `providerOptions` attribute (kept separate from `parameters`). Values like OpenAI `reasoningEffort` or Google `thinkingConfig` now flow through to observability backends — the Langsmith, Braintrust, and PostHog exporters surface them in metadata automatically.

**Changed** The `parameters` attribute on `MODEL_GENERATION` spans is now `Record<string, unknown>` instead of a fixed shape. Any call setting accepted by the underlying SDK flows through without a Mastra-side type update. Custom exporters that read individual params (e.g. `parameters.temperature`) will need a type guard such as `typeof params.temperature === 'number'`.

```ts
// Before — fixed shape, providerOptions invisible
attributes.parameters; // { temperature, maxOutputTokens, topP, ... }

// After — open shape, providerOptions captured separately
attributes.parameters; // Record<string, unknown> (e.g. { temperature: 0.7, maxOutputTokens: 1000 })
attributes.providerOptions; // { openai: { reasoningEffort: 'high' } }
```
