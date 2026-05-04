---
'@mastra/inngest': minor
---

Updated `@mastra/inngest` to use Inngest SDK v4.

**Breaking:** The `@inngest/realtime` package is no longer needed — its functionality is now included in `inngest` v4. Remove it from your dependencies and import realtime helpers from `inngest/realtime` instead.

```diff
  // package.json
  "dependencies": {
-   "@inngest/realtime": "^0.x",
-   "inngest": "^3.x"
+   "inngest": "^4.0.0"
  }
```

```diff
- import { realtimeMiddleware } from '@inngest/realtime/middleware';
- import { subscribe } from '@inngest/realtime';
+ import { subscribe } from 'inngest/realtime';

  const inngest = new Inngest({
    id: 'mastra',
-   middleware: [realtimeMiddleware()],
  });
```

In v4, `subscribe()` and `realtime.publish()` are first-class methods on the
client; the standalone middleware is no longer required.

**Improved:** Workflow result polling now uses snapshot-based polling, resulting in significantly faster retrieval (~83x).
