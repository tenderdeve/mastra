---
'@mastra/datadog': patch
---

Fixed double-encoded JSON on `llm: <model_name>` span input in Datadog. Mastra wraps MODEL_GENERATION input as `{ messages, schema? }`; the exporter now unwraps that (and Gemini's `{ contents }` request body) into a proper Datadog `{role, content}[]` message array instead of stringifying the whole wrapper into a single user message. Also avoids the same problem on tool-call-only outputs by summarizing tool calls instead of stringifying the full `{text, object, toolCalls, ...}` AI SDK output.
