---
'@mastra/core': patch
---

Added durable agent signals so callers can send user messages, system reminders, and custom signals into running durable streams. Signals targeting an idle resource/thread start a durable run, and signals received during final text streaming continue the durable loop instead of being stranded.
