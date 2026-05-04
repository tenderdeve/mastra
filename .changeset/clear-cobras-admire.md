---
'@mastra/core': minor
---

Add a new `processLLMPrompt` processor hook and use it to fix the `reasoning_content` regression on Cerebras.

**New hook**: `Processor` instances may now implement `processLLMPrompt(args: { prompt, model, … })`. It runs after `MessageList` has been converted to `LanguageModelV2Prompt` and immediately before the prompt is forwarded to the provider. Mutations are scoped to a single call — they do not persist back to the message list, memory, UI, or future model swaps. This is the right place for transient, model-aware rewrites such as stripping fields a specific provider rejects, or re-shaping tool-result formats when switching providers mid-loop.

**Cerebras fix**: starting with [`@ai-sdk/openai-compatible@1.0.32`](https://github.com/vercel/ai/pull/12049) (pulled in transitively via `@ai-sdk/cerebras`), the openai-compatible language model began serializing reasoning parts as a `reasoning_content` field on outbound assistant messages. Cerebras's API rejects that field, which broke multi-turn tool calls with reasoning enabled (e.g. `cerebras/zai-glm-4.7`). `ProviderHistoryCompat` now ships a built-in `cerebras-strip-reasoning-content` rule that, when the resolved model looks like Cerebras, strips `reasoning` parts from assistant messages in the outbound prompt via `processLLMPrompt`. The persisted message list keeps the full reasoning trace, so memory, UI, and observability are unaffected, and other providers that *want* `reasoning_content` echoed back (e.g. Z.ai's coding-plan endpoint, which uses it for preserved-thinking continuity) keep working unchanged.

`ProviderHistoryCompat` is auto-injected for Cerebras-resolved models when the user hasn't already added one, so the fix applies out of the box.
