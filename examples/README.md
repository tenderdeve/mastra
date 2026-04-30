## How to run the examples

Navigate to the example directory you want to run. For example:

```bash
cd examples/custom-working-memory-processor
```

Install the packages:

```bash
npm install
```

> The examples have a separate `package.json` file and are not part of the Mastra workspace.
> Most examples can use `npm install`.
> If an example links local workspace packages, use `pnpm install --ignore-workspace` from that example directory instead.

Run the appropriate CLI command in your terminal (may vary by example). For example for the custom working memory processor example:

```bash
pnpm demo
```

Or run it as a Mastra project in Studio:

```bash
pnpm dev
```
