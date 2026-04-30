# Custom working memory processor example

This Mastra project implements the custom processor pattern from the working memory vnext guide.

It does **not** enable built-in working memory. Instead, it:

1. Creates `new Memory()` only for normal thread/resource context.
2. Reads custom memory from thread metadata in an input processor.
3. Adds that memory to the model as `<working_memory>` system context.
4. Writes the next full memory value back to thread metadata in an output processor.
5. Mirrors the value to `custom-working-memory.json` for local debugging.

## Run it

```bash
cd examples/custom-working-memory-processor
pnpm install --ignore-workspace
cp .env.example .env
# Add OPENAI_API_KEY to .env
pnpm demo
```

The demo sends two messages to the same `thread` and `resource`, then prints the debug JSON mirror of the stored custom working memory.

## Try it in Studio

```bash
pnpm dev
```

Open the Studio URL printed by the CLI, select `supportAgent`, and send messages like:

```text
My name is Sam. I prefer concise answers.
```

Then ask:

```text
What do you remember about me?
```

The canonical custom memory is stored in thread metadata under `customWorkingMemory`. For debugging, this example also writes the same value to `custom-working-memory.json`.

## Files

- `src/mastra/processors/custom-working-memory.ts` - processor from the guide.
- `src/mastra/storage/custom-working-memory-store.ts` - thread metadata store with a JSON debug mirror.
- `src/mastra/agents/support-agent.ts` - agent with built-in working memory disabled.
- `src/demo.ts` - CLI demo runner.
