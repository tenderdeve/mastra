# Agent Builder Demo — `demo/agent-builder-brandon`

This branch (`demo/agent-builder-brandon`) is a snapshot of `yj/magnificent-marquess` with the latest Agent Builder features. Here's what's on this branch and how to get it running.

---

## What's on This Branch

### Skills
Agents can now have **skills** — reusable capabilities you create and attach to agents. Skills have their own list page at `/agent-builder/skills`, support visibility (Private/Public), and can be starred. You can create skills from the Skills page and then attach them to any agent from the agent's configure panel.

### Stars
Agents and skills can be **starred** (bookmarked). The star icon appears on cards in the list views.

### Model Allowlist & Default
The model dropdown is now **admin-controlled**. The config defines which providers/models are allowed (currently all OpenAI models + `claude-opus-4-7` from Anthropic) and which model is selected by default for new agents. Users only see allowed models in the picker.

### Visibility & Ownership
Agents and skills have **visibility** (Private or Public) and an **authorId** tied to the logged-in user. Private entities are only visible to their creator; Public ones are visible to everyone in the org.

### Preview as Role (Admin Only)
Admins can **preview the Studio as another role** (member, operator, viewer, etc.) without logging out. Click your avatar in the top-left → "Preview as role" → pick a role. A banner shows at the top while previewing. This is UI-only — API calls still use your real admin permissions. Useful for seeing what a member or operator would experience.

### Browser Toggle
Agents can now have a **browser capability** toggled on. This connects to Stagehand/Browserbase for web browsing. Requires `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` env vars to actually work, but the toggle is visible in the configure panel regardless.

### Workspace Auto-Reconciliation
The builder workspace is now **auto-persisted and reconciled** on server startup. If the config changes (e.g., different filesystem path), the DB record updates automatically. If a workspace is removed from config, it gets archived. No manual setup needed.

### Admin-Controlled Picker Allowlists
Beyond models, admins can also control which **tools, agents, and workflows** appear in the builder's picker dropdowns.

### Agent Avatar Upload
Agents can have a **custom avatar** uploaded by the owner.

---

## Getting to Agent Builder

Right now, the Agent Builder doesn't have its own sidebar entry for all roles. How you get there depends on your role:

- **Admin**: Go to the Agents tab in Studio → click "Create Agent" → you're in the builder flow. Or navigate directly to `http://localhost:4111/agent-builder`.
- **Member** (with current role config): Navigate directly to `http://localhost:4111/agent-builder`. The Agents tab in the main Studio requires `agents:read`/`agents:create` permissions, which members don't have by default, but the builder routes work fine.

We're still working on the best way to surface the builder entry point for non-admin roles.

---

## Setup (From Scratch)

If you need to set up from a fresh clone:

### 1. Clone and checkout

```bash
git clone https://github.com/mastra-ai/mastra.git
cd mastra
git checkout demo/agent-builder-brandon
```

### 2. Install dependencies

```bash
pnpm install
cd examples/agent-builder
pnpm install --ignore-workspace
```

### 3. Environment variables

```bash
cp .env.example .env
```

Edit `examples/agent-builder/.env`:

```bash
# Required — LLM calls (all built-in agents use OpenAI)
OPENAI_API_KEY=sk-...

# Optional — only needed if you pick claude-opus-4-7 from the model dropdown
ANTHROPIC_API_KEY=sk-ant-...

# Auth (WorkOS SSO)
AUTH_PROVIDER=workos
WORKOS_API_KEY=<your-workos-api-key>
WORKOS_CLIENT_ID=<your-workos-client-id>
WORKOS_ORGANIZATION_ID=<your-workos-org-id>
```

To run **without auth**, just don't set `AUTH_PROVIDER`. Everything works the same — you just won't have user identity or role-based access.

### 4. Build and run

```bash
# From repo root
cd ../..
pnpm build

# Start the dev server
cd examples/agent-builder
pnpm mastra:dev
```

Server runs at **http://localhost:4111**.

---

## Quick Demo Flow (Suggestion)

1. Open `http://localhost:4111/agent-builder`
2. Sign in (WorkOS Google SSO)
3. Create a new agent — pick a model, write instructions, save
4. Chat with the agent in the right panel
5. Go to Skills → create a skill → go back to the agent and attach it
6. Toggle visibility from Private → Public — show the badge change
7. Star the agent
8. (If showing auth/RBAC) Click your avatar → "Preview as role" → pick "member" → show how the experience changes → exit preview

---

## Key URLs

| Page | URL |
|------|-----|
| Agent Builder | `http://localhost:4111/agent-builder` |
| Skills | `http://localhost:4111/agent-builder/skills` |
| Studio (standard) | `http://localhost:4111` |

---

## Feature Details

### Auth & Roles

With `AUTH_PROVIDER=workos`, login is via Google SSO. The current role mapping:

| Role | Access |
|------|--------|
| **admin** | Full access to everything |
| **member** | Can create/manage own agents and skills in the builder. No access to the main Studio agents tab. |
| **operator** | Can view and run agents only (no builder access) |
| **viewer** | Read-only, no resources |
| **auditor** | Observability/logs only |

### Workspaces

Workspaces provide filesystem and sandbox infrastructure for agents. The builder workspace is configured in code and auto-managed:

- Auto-created on startup with `runtimeRegistered: true`
- Auto-updated if the config changes (e.g., different basePath)
- Auto-archived if removed from config

This is admin/platform infrastructure — end users don't interact with it directly. Brandon doesn't need to worry about workspace setup; it just works out of the box.

### Resetting Demo State

To wipe everything and start fresh:

```bash
cd examples/agent-builder
pnpm clean
pnpm mastra:dev
```

---

## Troubleshooting

**Port 4111 already in use**
```bash
lsof -i :4111 | grep LISTEN | awk '{print $2}' | xargs kill -9
```

**"Cannot find module" errors** — Run `pnpm build` from the repo root.

**Chat not responding** — Check `OPENAI_API_KEY` is set. If using a Claude model, check `ANTHROPIC_API_KEY`.

**Can't find Agent Builder** — Navigate directly to `http://localhost:4111/agent-builder`.
