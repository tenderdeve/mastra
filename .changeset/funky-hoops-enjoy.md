---
'@mastra/inngest': patch
'@mastra/core': patch
---

Fixed duplicate durable step IDs in workflow `persistStepUpdate` calls. The operation ID now includes the workflow status and the last step's status so that multiple `persistStepUpdate` calls for the same execution path get distinct durable step IDs. Previously these calls collided on the same Inngest step ID and triggered the `AUTOMATIC_PARALLEL_INDEXING` warning when running on Inngest SDK v4.
