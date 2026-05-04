---
'@mastra/core': patch
---

Pin `@ai-sdk/openai-compatible` to <1.0.32 to fix `reasoning_content` regression on Cerebras and other openai-compatible providers.

Starting with [`@ai-sdk/openai-compatible@1.0.32`](https://github.com/vercel/ai/pull/12049), the openai-compatible language model began serializing reasoning parts as a `reasoning_content` field on outbound assistant messages. Cerebras (and other providers built on top of `@ai-sdk/openai-compatible` such as `@ai-sdk/cerebras`, `@ai-sdk/deepinfra`, `@ai-sdk/togetherai`, `@ai-sdk/xai`) reject that field as unsupported, breaking multi-turn tool calls when reasoning is enabled (e.g. `cerebras/zai-glm-4.7`).

Pinned via three changes: `packages/core/package.json` (`@ai-sdk/openai-compatible-v5` direct dep set to 1.0.31), `pnpm.overrides` in the root `package.json` (covers transitive deps from `@ai-sdk/cerebras`, `@ai-sdk/deepinfra`, `@ai-sdk/togetherai`, `@ai-sdk/xai`, etc.), and a Renovate rule to prevent automatic re-bumps. Once [vercel/ai#11278](https://github.com/vercel/ai/pull/11278) ships an opt-out and we adopt it, the pin can be removed.
