# Mastra Thread Heartbeat — Implementation Plan

## Overview

Add a **heartbeat** feature to Mastra that runs periodic agent turns on opted-in threads. Inspired by [OpenClaw's heartbeat](https://docs.openclaw.ai/gateway/heartbeat), but designed for Mastra's framework-first architecture.

A heartbeat is a scheduled `agent.generate()` on a thread, triggered by a timer instead of a user message. The agent gets full tools, memory, context — everything. If the thread is connected to a channel (Discord, Slack, etc.), the response is automatically delivered there.

### Design Philosophy

OpenClaw is a **product** — a single always-on gateway. It has explicit `target` routing for delivery, `HEARTBEAT_OK` token suppression, and interception layers between the LLM and channel output.

Mastra is a **framework** where channels work differently:
- A channel-connected thread **is** the channel — there's no separate delivery target.
- `agent.generate()` doesn't automatically post to channels — the channel adapter calls `agent.stream()` and separately handles posting via `consumeAgentStream()`.
- There's currently no way to programmatically send a message to a channel-connected thread from outside the inbound message handler pipeline.

So this plan has **two parts**:

1. **Channel outbound messaging** — `agent.channels.send()`, a general-purpose primitive for posting to a channel-connected thread. Useful for heartbeat, cron jobs, webhook reactions, anything.
2. **Thread heartbeat** — periodic `agent.generate()` on opted-in threads, with automatic channel delivery for channel-connected threads.

---

## Part 1: Channel Outbound Messaging

### The Gap

Currently, `AgentChannels` is inbound-only:
```
Platform event → webhook → handleChatMessage → agent.stream() → consumeAgentStream → sdkThread.post()
```

There's no outbound path. If you want to programmatically send a message to a Discord thread, you can't — even though the adapter has `adapter.postMessage(threadId, message)` and we know which platform a thread belongs to from `thread.metadata.channel_platform`.

### API

```ts
// Post a message to whatever channel a thread is connected to
// Looks up platform + external thread ID from thread metadata
const sent = await agent.channels.send(threadId, 'Something happened!');
// Returns true if sent, false if thread has no channel connection

// Works with any PostableMessage (string | CardElement)
await agent.channels.send(threadId, { markdown: '**Alert:** PR merged' });

// Rich card
await agent.channels.send(threadId,
  <Card title="Alert">
    <CardText>PR #42 needs review</CardText>
  </Card>
);

// Override platform + external thread (skip metadata lookup)
await agent.channels.send(threadId, 'hello', {
  platform: 'discord',
  externalThreadId: 'some-discord-channel-id',
});
```

**Signature:** `send(threadId: string, content: PostableMessage, options?: ChannelSendOptions): Promise<boolean>`

- `threadId` is always required — there's no ambient "current thread" context.
- `content` is `PostableMessage` (`string | CardElement`) — same type the adapters already accept.
- `options.platform` / `options.externalThreadId` — optional overrides to skip the metadata lookup. Useful for cross-posting, testing, or targeting a thread that doesn't have a Mastra thread yet.

### How It Works

1. If `options.platform` and `options.externalThreadId` are provided, use those directly
2. Otherwise, look up Mastra thread by `threadId` → read `channel_platform` and `channel_externalThreadId` from metadata
3. Get the adapter: `this.adapters[platform]`
4. Call `adapter.postMessage(externalThreadId, content)`
5. Return `true`. If no platform can be resolved, return `false`.

### Types

```ts
interface ChannelSendOptions {
  /** Override the platform (skip metadata lookup) */
  platform?: string;
  /** Override the external thread ID (skip metadata lookup) */
  externalThreadId?: string;
}
```

### Implementation

**File:** `packages/core/src/channels/agent-channels.ts`

Add a `send()` method to `AgentChannels`:

```ts
/**
 * Send a message to a channel-connected thread.
 * Returns true if the message was sent, false if the thread has no channel connection.
 */
async send(threadId: string, content: PostableMessage, options?: ChannelSendOptions): Promise<boolean> {
  let platform = options?.platform;
  let externalThreadId = options?.externalThreadId;

  // Look up from thread metadata if not overridden
  if (!platform || !externalThreadId) {
    const memoryStore = await this.mastra.getStorage()?.getStore('memory');
    if (!memoryStore) return false;

    const thread = await memoryStore.getThreadById(threadId);
    if (!thread) return false;

    platform ??= thread.metadata?.channel_platform as string | undefined;
    externalThreadId ??= thread.metadata?.channel_externalThreadId as string | undefined;
  }

  if (!platform || !externalThreadId) return false;

  const adapter = this.adapters[platform];
  if (!adapter) return false;

  await adapter.postMessage(externalThreadId, /* format content */);
  return true;
}
```

> **Note:** The `mastra` reference is needed for storage access. Store it during `bind()` so the public API stays clean: `agent.channels.send(threadId, content)`.

---

## Part 2: Thread Heartbeat

### How Threads Get Heartbeat

**Scenario A: Channel threads (automatic)**

1. Agent has heartbeat defaults configured
2. User DMs agent on Discord → channel adapter creates thread via `getOrCreateThread()`
3. Since the agent has heartbeat config, the thread is created with `metadata.mastra.heartbeat = { enabled: true }`
4. Heartbeat system picks it up, starts a timer
5. Every interval: `agent.generate()` → saves to memory → `agent.channels.send()` posts to Discord DM
6. The prompt controls whether the agent says something useful or stays quiet

**Scenario B: Manual control (programmatic)**

```ts
// Enable heartbeat on an existing thread (resourceId read from thread metadata)
agent.setHeartbeat({
  threadId: 'ops-thread',
  intervalMs: 60_000,
  prompt: 'Check if any alerts fired.',
});

// Or on a new thread where you need to specify resourceId
agent.setHeartbeat({
  threadId: 'ops-thread',
  resourceId: 'ops-team',  // only needed if thread doesn't exist yet
  intervalMs: 60_000,
  prompt: 'Check if any alerts fired.',
});

// Or via a Discord slash command handler
app.post('/discord/slash/heartbeat', async (req) => {
  const { interval, prompt, threadId } = parseSlashCommand(req);
  agent.setHeartbeat({ threadId, intervalMs: interval, prompt });
});

// Disable
agent.setHeartbeat({ threadId: 'ops-thread', enabled: false });
```

**Scenario C: Inline opt-in**

```ts
await agent.generate('hello', {
  memory: { thread: 'thread-123', resource: 'user-123' },
  heartbeat: true,  // opts in using agent defaults
});
```

### Agent-Level Defaults

```ts
const agent = new Agent({
  id: 'assistant',
  model: openai('gpt-4o'),
  memory: myMemory,
  tools: { checkGithub, checkEmail },

  channels: {
    discord: { adapter: discordAdapter },
  },

  // Default heartbeat config — applies to any thread that opts in
  heartbeat: {
    intervalMs: 30 * 60 * 1000,       // 30 minutes
    prompt: 'Check if anything needs the user\'s attention. If nothing needs attention, respond with a brief "all clear" or say nothing.',
    model: openai('gpt-4o-mini'),      // optional: cheaper model for heartbeats
    onHeartbeat: async ({ agent, thread, response }) => {
      // Optional lifecycle hook for side effects
      // Channel delivery happens automatically if thread is channel-connected
      // This is for: logging, metrics, push notifications, custom delivery, etc.
      console.log(`[Heartbeat] ${thread.id}: ${response.text}`);
    },
  },
});
```

### Heartbeat Delivery

Delivery is determined by the thread, not the heartbeat config:

- **Channel-connected thread** → `agent.channels.send()` posts to the platform automatically. No developer code needed.
- **Non-channel thread** → response is saved to memory only. Use `onHeartbeat` for custom delivery (push notifications, webhooks, etc.).

The developer doesn't configure delivery — it follows from the thread's nature. This avoids the OpenClaw complexity of `target`, `directPolicy`, `showOk`, etc.

The **prompt** is how the developer controls noise. Tell the agent "only respond if something needs attention" and the model handles it. No ack token machinery needed for v1.

### Merge Order

Thread config is resolved as: **agent defaults ← thread overrides**

```ts
// Agent default: intervalMs: 1800000, prompt: 'Check...'
// Thread override: intervalMs: 60000
// Resolved: intervalMs: 60000, prompt: 'Check...'
```

`onHeartbeat` only lives on agent-level config — it's not per-thread.

### Persistence

When heartbeat is enabled for a thread, the config is stored in thread metadata at `metadata.mastra.heartbeat`:

```ts
{
  metadata: {
    // ... existing channel metadata (channel_platform, etc.)
    mastra: {
      heartbeat: {
        enabled: true,
        intervalMs: 60000,
        prompt: 'Check GitHub PRs...',
        lastRunAt: '2026-04-13T19:30:00.000Z',
      }
    }
  }
}
```

`lastRunAt` is updated after each heartbeat run. This enables:
- **Restart recovery** — on startup, calculate `elapsed = now - lastRunAt`. If `elapsed >= intervalMs`, fire immediately. Otherwise, wait `intervalMs - elapsed`.
- **Observability** — "when was this thread last checked?"
- **Staleness detection** — find threads where heartbeat stopped unexpectedly.

---

## Types

```ts
/** Options for agent.channels.send() */
interface ChannelSendOptions {
  /** Override the platform (skip metadata lookup) */
  platform?: string;
  /** Override the external thread ID (skip metadata lookup) */
  externalThreadId?: string;
}

/** Agent-level heartbeat defaults (on Agent constructor) */
interface AgentHeartbeatConfig {
  /** Default interval between heartbeat runs. Default: 1800000 (30m) */
  intervalMs?: number;

  /** Default prompt for heartbeat turns */
  prompt?: string;

  /** Optional model override for heartbeat runs */
  model?: LanguageModel;

  /** Called after each heartbeat turn (lifecycle hook, not delivery) */
  onHeartbeat?: (event: HeartbeatEvent) => void | Promise<void>;

  /** Skip heartbeat if agent is already generating on this thread. Default: true */
  skipWhenBusy?: boolean;

  /** Additional execution options passed to agent.generate() */
  executionOptions?: Partial<AgentExecutionOptionsBase>;
}

/** Per-thread heartbeat overrides (on generate/stream or setHeartbeat) */
interface HeartbeatThreadConfig {
  /** Override interval for this thread */
  intervalMs?: number;

  /** Override prompt for this thread */
  prompt?: string;
}

/** Persisted in thread metadata at metadata.mastra.heartbeat */
interface HeartbeatThreadMetadata {
  enabled: boolean;
  intervalMs?: number;
  prompt?: string;
  /** ISO string — updated after each heartbeat run */
  lastRunAt?: string;
}

/** Input to agent.setHeartbeat() */
type SetHeartbeatInput =
  | { threadId: string; resourceId?: string; enabled?: true } & HeartbeatThreadConfig
  | { threadId: string; enabled: false };
// resourceId is optional — if omitted, read from thread.resourceId in storage.
// Only required when enabling heartbeat on a thread that doesn't exist yet.

/** Heartbeat option on generate/stream */
type HeartbeatOption = boolean | HeartbeatThreadConfig;

/** Event passed to onHeartbeat callback */
interface HeartbeatEvent {
  agent: Agent;
  thread: StorageThreadType;
  response: AgentGenerateResult;
  /** Whether the response was delivered to a channel */
  channelDelivered: boolean;
  timestamp: Date;
}
```

---

## Execution Flow

```
1. Thread opts in:
   - Channel thread created with agent heartbeat config → auto-enabled
   - Developer calls agent.setHeartbeat(...)
   - Developer passes heartbeat option on generate()/stream()
   ↓
2. Agent stores heartbeat config in internal Map<threadId, resolved config>
   ↓
3. Agent writes config to thread metadata (metadata.mastra.heartbeat)
   ↓
4. Agent starts a timer for this thread
   - If Harness available: harness.registerHeartbeat({ id, intervalMs, handler })
   - If standalone: setInterval + unref()
   ↓
5. Timer fires:
   a. Check skipWhenBusy — skip if agent is mid-generate on this thread
   b. Call agent.generate(heartbeatPrompt, {
        memory: { thread: threadId, resource: resourceId },
        ...executionOptions,
        ...(heartbeatModel ? { model } : {}),
      })
   c. Attempt channel delivery: agent.channels?.send(threadId, response.text)
      Note: v1 sends response.text only. Structured/rich content delivery can be added later.
   d. Update thread metadata: set lastRunAt to now
   e. Call onHeartbeat({ agent, thread, response, channelDelivered, timestamp })
   ↓
6. On agent.setHeartbeat({ threadId, enabled: false }):
   a. Clear timer
   b. Update thread metadata (enabled: false)
   c. Remove from internal map
```

### Restart Recovery

`MastraMemory.listThreads()` supports `filter.metadata` with nested key-value matching, so we can query for heartbeat-enabled threads directly.

```
Agent registered with Mastra/Harness
  ↓
During init, if agent has heartbeat config:
  Query memory.listThreads({
    filter: { metadata: { mastra: { heartbeat: { enabled: true } } } },
    perPage: false,  // fetch all — no pagination limit
  })
  ↓
  For each thread:
    resourceId = thread.resourceId  (always available — set at thread creation time)
    elapsed = now - lastRunAt
    if elapsed >= intervalMs → fire immediately, then resume interval
    else → setTimeout(intervalMs - elapsed), then resume interval
```

### Channel Thread Auto-Registration

```
getOrCreateThread() in AgentChannels
  ↓
If creating a new thread AND agent has heartbeat config:
  Set metadata.mastra.heartbeat = { enabled: true }
  ↓
  Notify agent to start heartbeat timer for this thread
  resourceId is already on the thread (thread.resourceId) — no need to pass separately
  Note: resourceId is `${platform}:${userId}` where userId is whoever created the thread.
  For group threads (Slack channels, Discord servers), it's the first user who messaged.
```

---

## Implementation Steps

### Step 1: Channel outbound — `agent.channels.send()`

**File:** `packages/core/src/channels/agent-channels.ts`

- Store `mastra` reference during `bind()` (or pass to `init()`)
- Add `send(threadId: string, content: PostableMessage, options?: ChannelSendOptions): Promise<boolean>` — public method
  - If `options.platform` / `options.externalThreadId` provided, use directly
  - Otherwise look up thread metadata for `channel_platform`, `channel_externalThreadId`
  - Get adapter, call `adapter.postMessage()`
  - Return `false` if thread has no channel connection
- Export `ChannelSendOptions` type
- Add tests for `send()` with channel-connected and non-channel threads, and with explicit overrides

### Step 2: Add heartbeat types

**File:** `packages/core/src/agent/agent.types.ts`

- Add `AgentHeartbeatConfig`, `HeartbeatThreadConfig`, `SetHeartbeatInput`, `HeartbeatOption`, `HeartbeatEvent`
- Add `heartbeat?: AgentHeartbeatConfig` to `AgentConfig`
- Add `heartbeat?: HeartbeatOption` to `AgentExecutionOptionsBase`

**File:** `packages/core/src/memory/types.ts`

- Add `HeartbeatThreadMetadata` to `ThreadMastraMetadata`

### Step 3: Add heartbeat helpers

**File:** `packages/core/src/agent/heartbeat.ts` (new)

- `DEFAULT_HEARTBEAT_PROMPT` constant
- `DEFAULT_HEARTBEAT_INTERVAL_MS` constant (1800000)
- `resolveHeartbeatConfig(agentDefaults, threadOverrides)` — merge function
- `isHeartbeatAck(text, ackToken?)` — optional utility for developers who want suppression

### Step 4: Add heartbeat management to Agent

**File:** `packages/core/src/agent/agent.ts`

- Store `#heartbeatConfig?: AgentHeartbeatConfig` from constructor
- Store `#heartbeatTimers: Map<string, { timer, config }>` for active heartbeats
- Add `setHeartbeat(input: SetHeartbeatInput)` — public method
  - Resolves config (merge agent defaults ← thread overrides)
  - Starts/stops/updates timer
  - Writes to thread metadata
  - On timer fire: generate → channels.send() → update lastRunAt → onHeartbeat callback
- Add `getHeartbeats()` — returns list of active heartbeat threads
- In `generate()`/`stream()`: if `options.heartbeat` is truthy and thread not already registered, call `setHeartbeat()` internally
- Add `#startHeartbeatTimer(threadId, resourceId, config)` — private
- Add `#stopHeartbeatTimer(threadId)` — private
- Add `stopAllHeartbeats()` — called during cleanup

### Step 5: Auto-enable heartbeat for channel threads

**File:** `packages/core/src/channels/agent-channels.ts`

- In `getOrCreateThread()`: if creating a new thread and agent has heartbeat config, set `metadata.mastra.heartbeat = { enabled: true }`
- Notify agent to start heartbeat timer for the new thread

### Step 6: Wire into Mastra/Harness lifecycle

**File:** `packages/core/src/mastra/index.ts` and `packages/core/src/harness/harness.ts`

- During agent registration: if agent has `heartbeat` config, scan for persisted heartbeat threads and re-register timers
- On `destroy()`: call `agent.stopAllHeartbeats()`
- If Harness available, delegate timer management to `harness.registerHeartbeat()`

### Step 7: Tests

- **Channel send:** `agent.channels.send()` posts to correct platform, returns false for non-channel threads
- **setHeartbeat:** enables/updates/disables correctly
- **Timer fires:** calls `agent.generate()` with correct memory context
- **Channel delivery:** heartbeat auto-posts to channel for channel-connected threads
- **Non-channel threads:** response saved to memory only, `channelDelivered: false`
- **onHeartbeat callback:** receives correct event with `channelDelivered` flag
- **heartbeat: true on generate():** auto-registers thread
- **Channel auto-enable:** new channel threads get heartbeat when agent config is set
- **Config merging:** agent defaults ← thread overrides
- **Thread metadata persistence:** write on enable, clear on disable, lastRunAt updates
- **Restart recovery:** scan and re-register with correct initial delay
- **skipWhenBusy:** skips if agent is mid-generate
- **stopAllHeartbeats():** cleanup

---

## What We're NOT Doing (v1)

These are OpenClaw features / enhancements that can be added later:

| Feature | Why not v1 | How to do it today |
|---------|-----------|-------------------|
| `HEARTBEAT_OK` suppression | Adds complexity; OpenClaw has had multiple bugs with this | Use prompt engineering: "say nothing if nothing needs attention" |
| `showOk` / `showAlerts` | No interception layer in Mastra channels | Prompt handles it; or check response in `onHeartbeat` before manual send |
| `updatedAt` preservation | Requires memory internals change | Can add a flag later |
| `isolatedSession` / `lightContext` | Cost optimization | Use `executionOptions` to limit context |
| Active hours | Application-level concern | Check time in `onHeartbeat` or custom `setHeartbeat` logic |
| `target` routing | Mastra threads ARE the channel — no routing needed | N/A |
| `includeReasoning` | Niche | Add later as option |
| Stream-based heartbeat delivery | v1 uses generate, not stream | Could add stream support later for typing indicators etc. |

---

## Comparison: OpenClaw vs Mastra

| Aspect | OpenClaw | Mastra |
|--------|---------|--------|
| **Scope** | Global/per-agent config file | Agent constructor + per-thread via `setHeartbeat()` |
| **Thread creation** | Sessions exist independently | Channel adapter creates threads on first message |
| **Delivery** | Explicit `target` routing (`last`, `none`, `<channel>`) | Automatic — channel threads deliver to channel, others use `onHeartbeat` |
| **Suppression** | `HEARTBEAT_OK` token + `showOk`/`showAlerts`/`ackMaxChars` | Prompt engineering (v1), can add suppression later |
| **Channel model** | Sessions separate from channels; explicit routing | Thread IS the channel; `channel_platform` metadata links them |
| **Outbound messaging** | Built into gateway delivery pipeline | New `agent.channels.send()` primitive (Part 1 of this plan) |
| **Config override** | Config file only | Programmatic: `setHeartbeat()`, slash commands, generate() option |
| **Lifecycle** | Always-on gateway manages everything | Agent/Harness manages timers; restart recovery via `lastRunAt` |
