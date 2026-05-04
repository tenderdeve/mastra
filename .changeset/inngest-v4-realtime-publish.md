---
'@mastra/inngest': patch
'@mastra/core': patch
---

Finish the Inngest SDK v4 migration for `@mastra/inngest` realtime and fix duplicate durable step IDs:

- `@mastra/inngest`: `InngestPubSub` now publishes via `inngest.realtime.publish()` (the v4 client API) instead of the function-context `publish` argument that no longer exists in v4. This restores realtime workflow events (`watch` topic on `workflow:{workflowId}:{runId}`) and agent stream events (`agent-stream` topic on `agent:{runId}`) when running on Inngest v4.
- `@mastra/core`: `persistStepUpdate` now includes the workflow status and the last step's status in its durable operation ID. Without this, multiple `persistStepUpdate` calls for the same execution path (e.g. a pre-step "running" snapshot and a post-step "running" snapshot) collided on the same Inngest step ID, triggering the v4 `AUTOMATIC_PARALLEL_INDEXING` warning.
