# Agent Builder Demo Instructions

Demo branch for the new Agent Builder features. This runs the full builder experience: create agents, skills, workspaces, model selection, browser/sandbox config, and more.

## Prerequisites

- **Node.js** >= 18
- **pnpm** >= 10.18 (`npm install -g pnpm` if needed)
- **OpenAI API key** (required for LLM calls)

## Quick Start

### 1. Clone and checkout

```bash
git clone https://github.com/mastra-ai/mastra.git
cd mastra
git checkout demo/agent-builder-brandon
```

### 2. Install dependencies

```bash
pnpm install
```

This takes a few minutes on first run (monorepo with many packages).

### 3. Set up environment variables

```bash
cp examples/agent/.env.example examples/agent/.env
```

Edit `examples/agent/.env`:

```bash
# Required — LLM calls
OPENAI_API_KEY=sk-...

# Required — Auth (WorkOS)
AUTH_PROVIDER=workos
WORKOS_API_KEY=<your-workos-api-key>
WORKOS_CLIENT_ID=<your-workos-client-id>
WORKOS_ORGANIZATION_ID=<your-workos-org-id>

# Optional — defaults to http://localhost:4111/api/auth/callback
# WORKOS_REDIRECT_URI=http://localhost:4111/api/auth/callback
```

> **Note:** Ask Nik for the WorkOS credentials if you don't have them.

### 4. Build the monorepo

```bash
pnpm build
```

This builds all packages (~2-3 minutes). You only need to do this once.

### 5. Start the dev server

```bash
cd examples/agent
pnpm mastra:dev
```

Wait for the server to start. It'll be ready at **http://localhost:4111**.

## What to Demo

### Agent Builder (`/agent-builder`)

The main attraction. Shows:

- **Create agents** — Click "New Agent", give it a name, pick a model, write instructions
- **Model dropdown** — Shows allowed models from the config (all OpenAI models + `claude-opus-4-7`)
- **Skills** — Create skills, attach them to agents
- **Visibility** — Toggle agents/skills between Private and Public
- **Stars** — Star favorite agents/skills
- **Workspaces** — Builder workspace auto-configured with filesystem + sandbox

### Key Pages

| Page | URL |
|------|-----|
| Agent Builder (agents list) | `http://localhost:4111/agent-builder` |
| Skills list | `http://localhost:4111/agent-builder/skills` |
| Studio (tools, workflows, traces) | `http://localhost:4111` |

### Demo Flow (suggested)

1. Open `http://localhost:4111/agent-builder`
2. Click **"New Agent"** — show the creation form
3. Pick a model from the dropdown (note it only shows allowed providers)
4. Write some instructions (e.g., "You are a helpful research assistant")
5. Save the agent → it appears in the list
6. Go to **Skills** → create a skill → attach it to the agent
7. Open the agent → show the chat panel on the right, send a message
8. Show **visibility toggle** (Private → Public badge change)

## Auth

Auth is enabled via WorkOS (Google SSO). When you open the app, you'll be prompted to sign in with Google.

If you need to **disable auth** for a quicker demo (no login screen):

1. Remove or comment out `AUTH_PROVIDER=workos` in `examples/agent/.env`
2. Restart the server

Everything works the same without auth — you just won't have user identity (no `authorId` on created entities).

## Troubleshooting

**Server won't start / build errors**

```bash
# Clean and rebuild
pnpm clean
pnpm install
pnpm build
cd examples/agent
pnpm mastra:dev
```

**Port 4111 already in use**

```bash
lsof -i :4111 | grep LISTEN | awk '{print $2}' | xargs kill -9
```

**"Cannot find module" errors**

Run `pnpm build` again from the repo root. The packages need to be built before the example can import them.

**Chat not responding**

- Check that `OPENAI_API_KEY` is set correctly in `examples/agent/.env`
- Check the terminal for error messages

## Known Rough Edges

- **Create Skill button** may appear disabled initially — click into the name field, type something, and it should enable
- **Daytona sandbox** features won't work without a Daytona API key (fine to ignore for demos)
- **Browserbase** features need `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` (fine to skip)
- The **Agent Builder AI assistant** (the `builderAgent` in chat) works best with `gpt-4o` or better

## Resetting Demo State

To wipe all created agents/skills and start fresh:

```bash
cd examples/agent
pnpm clean
pnpm mastra:dev
```

This deletes the local SQLite database and starts with a clean slate.
