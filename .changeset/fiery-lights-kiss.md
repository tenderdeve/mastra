---
'@mastra/server': minor
---

Added in-memory A2A push notification support for task updates.

Clients can now register push notification configs with `message/send`, `message/stream`, or the `tasks/pushNotificationConfig/*` methods. The server advertises push notification support in the agent card and sends the current task snapshot to registered webhooks when a task reaches `completed`, `failed`, `canceled`, or `input-required`.

```ts
await a2a.setTaskPushNotificationConfig({
  taskId: 'task-123',
  pushNotificationConfig: {
    url: 'https://example.com/a2a-webhook',
    token: 'session-token',
  },
});
```
