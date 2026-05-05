# Agent Builder Demo — `demo/agent-builder-brandon`

This branch (`demo/agent-builder-brandon`) is a snapshot of `yj/magnificent-marquess` with the latest Agent Builder features. Here's what's on this branch and how to get it running.

---

## What's on This Branch

### Skills

Agents can now have **skills** — reusable capabilities you create and attach to agents. Skills have their own list page at `/agent-builder/skills`, support visibility (Private/Public), and can be starred. You can create skills from the Skills page and then attach them to any agent from the agent's configure panel.

### Stars & Favorites

Agents and skills can be **starred** (bookmarked). The star icon appears on cards in the list views. Starred items show up in the **Favorites** page in the sidebar.

### Library

Public agents and skills appear in the **Library** page — a shared catalog of agents and skills visible to the whole team.

### Model Allowlist & Default

The model dropdown is now **admin-controlled**. The config defines which providers/models are allowed (currently all OpenAI models + `claude-opus-4-7` from Anthropic) and which model is selected by default for new agents. Users only see allowed models in the picker.

### Visibility & Ownership

Agents and skills have **visibility** (Private or Public) and an **authorId** tied to the logged-in user. Private entities are only visible to their creator; Public ones are visible to everyone in the org.

### Preview as Role (Admin Only)

Admins can **preview the Studio as another role** (member, operator, viewer, etc.) without logging out. Click your avatar in the top-left → "Preview as role" → pick a role. A banner shows at the top while previewing. This is UI-only — API calls still use your real admin permissions. Useful for seeing what a member or operator would experience.

### Browser Toggle

Agents can have a **browser capability** toggled on. This gives the agent Stagehand browser tools (navigate, click, extract, etc.). Runs locally in headless mode — no extra API keys needed beyond `OPENAI_API_KEY` (Stagehand uses OpenAI for its AI operations).

### Sandbox (Daytona)

The builder workspace is configured with a **Daytona sandbox** for remote code execution. Requires `DAYTONA_API_KEY` env var. Sign up at [daytona.io](https://www.daytona.io) to get one.

### Workspace Auto-Reconciliation

The builder workspace is now **auto-persisted and reconciled** on server startup. If the config changes (e.g., different filesystem path), the DB record updates automatically. If a workspace is removed from config, it gets archived. No manual setup needed.

### AI-Powered Agent Creation

Agent creation is **AI-driven**. You describe what you want to build (or pick a preset), and the builder agent creates an agent with an appropriate name, instructions, and model. You can then chat with the builder agent to add tools, create skills, and refine the configuration.

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
# Required — server won't start without this (OpenAIVoice needs it at startup)
OPENAI_API_KEY=sk-...

# Optional — only needed if you pick claude-opus-4-7 from the model dropdown
ANTHROPIC_API_KEY=sk-ant-...

# Sandbox (Daytona) — needed for workspace sandbox execution
# Sign up at https://www.daytona.io to get an API key
DAYTONA_API_KEY=<your-daytona-api-key>

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

## Demo Walkthrough

### 1. Landing Page

Navigate to **http://localhost:4111/agent-builder**.

You'll see the **Create** page with:
- A text box: "Describe the agent you want to build…"
- Four preset buttons: **Support triage**, **Standup bot**, **PR reviewer**, **Onboarding tutor**
- A **Start building** button

### 2. Create an Agent

Click a preset or type a custom description, then click **Start building**.

The AI builder will:
1. Create the agent with an auto-generated name and instructions
2. Select an appropriate model
3. Suggest tools and skills to add
4. Offer next steps (you can chat with it to refine)

### 3. Configuration Panel

Click **Show configuration** to see:
- **Name** and **Description** (AI-generated, editable)
- **Provider / Model** dropdowns (constrained by model policy)
- **Instructions** (AI-generated, editable)
- **Browser** toggle — "Allow your agent to browse the web"
- **Visibility** dropdown (Private / Public)
- **Tools** button (shows count, e.g., "7/43")
- **Skills** button (shows count, e.g., "1/2")
- **Avatar** upload

### 4. Model Policy in Action

- Switch provider to **OpenAI** → all 44 models available
- Switch provider to **Anthropic** → only `claude-opus-4-7` shown

### 5. Save and Chat

Click **Save**. The view page shows:
- Chat panel with "Message your agent…" input
- Suggested actions: "What can you do?", "Show available tools", "Suggest a task", "Run a self-check"
- The "Run a self-check" action is great for demos — the agent audits its own configuration

### 6. Sidebar Navigation

- **My agents** — Agents you've created
- **Skills** — Reusable skill definitions
- **Favorites** — Starred agents and skills
- **Library** — Public agents and skills shared with the team

### 7. Visibility, Stars, Library

- Edit an agent → change visibility from Private → Public → Save
- Public agents appear in **Library**
- Click the star icon on any card → starred items appear in **Favorites**

### 8. Skills

Navigate to **Skills** in the sidebar:
- View existing skills with name, description, visibility badge
- Create new skills from the page
- Or ask the builder agent to create a skill for you (it has a `createSkillTool`)

### 9. Browser

Toggle the **Browser** switch on an agent to enable web browsing capability. Runs locally in headless Chrome — no extra setup needed. The agent gets browser tools (navigate, click, extract, observe) when this is on.

### 10. Preview as Role

Click your avatar (top-right) → **Preview as Role** → pick Member, Operator, Viewer, or Auditor to see the UI from their perspective.

---

## Quick Demo Flow (5 minutes)

1. Open `http://localhost:4111/agent-builder`
2. Sign in (if auth enabled)
3. Click "Support triage" preset → "Start building"
4. Watch the AI create and configure the agent
5. Open the config panel — show model dropdown (model policy), tools, skills
6. Toggle browser on
7. Save → chat with the agent ("Run a self-check")
8. Go to Skills → show skills list
9. Toggle visibility Private → Public → show it appears in Library
10. Star the agent → show it appears in Favorites
11. (If showing RBAC) Avatar → "Preview as role" → "viewer"

---

## Key URLs

| Page              | URL                                           |
| ----------------- | --------------------------------------------- |
| Agent Builder     | `http://localhost:4111/agent-builder`          |
| My Agents         | `http://localhost:4111/agent-builder/agents`   |
| Skills            | `http://localhost:4111/agent-builder/skills`   |
| Favorites         | `http://localhost:4111/agent-builder/favorite`  |
| Library           | `http://localhost:4111/agent-builder/library`  |
| Studio (standard) | `http://localhost:4111/agents`                 |
| API               | `http://localhost:4111/api`                    |

---

## Auth & Roles

With `AUTH_PROVIDER=workos`, login is via Google SSO. The current role mapping:

| Role         | Access                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------ |
| **admin**    | Full access to everything                                                                        |
| **member**   | Can create/manage own agents and skills in the builder. No access to the main Studio agents tab. |
| **operator** | Can view and run agents only (no builder access)                                                 |
| **viewer**   | Read-only, no resources                                                                          |
| **auditor**  | Observability/logs only                                                                          |

---

## Workspaces

Workspaces provide filesystem and sandbox infrastructure for agents. The builder workspace is configured in code and auto-managed:

- Auto-created on startup with `runtimeRegistered: true`
- Auto-updated if the config changes (e.g., different basePath)
- Auto-archived if removed from config

This is admin/platform infrastructure — end users don't interact with it directly. Brandon doesn't need to worry about workspace setup; it just works out of the box.

---

## Resetting Demo State

To wipe everything and start fresh:

```bash
cd examples/agent-builder
pnpm clean
rm -f mastra.db   # pnpm clean doesn't remove this
pnpm mastra:dev
```

---

## Known Rough Edges

1. **Viewer role can still see "Create" buttons** — RBAC UI enforcement not fully wired for all roles
2. **"My agents" list doesn't show visibility badges** — Only Library shows Public/Private badges on cards
3. **`pnpm clean` doesn't remove `mastra.db`** — Delete it manually for a true fresh start

---

## Troubleshooting

| Problem                         | Fix                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------- |
| Server crashes at startup       | Set `OPENAI_API_KEY` — `OpenAIVoice` module requires it                          |
| Port 4111 already in use        | `lsof -i :4111 \| grep LISTEN \| awk '{print $2}' \| xargs kill -9`             |
| "Cannot find module" errors     | Run `pnpm build` from the repo root                                             |
| Chat not responding             | Check `OPENAI_API_KEY` is set. If using Claude, check `ANTHROPIC_API_KEY`        |
| Auth redirect loop              | Verify WorkOS redirect URI is exactly `http://localhost:4111/api/auth/callback`   |
| Can't find Agent Builder        | Navigate directly to `http://localhost:4111/agent-builder`                        |
| "No session" errors on restart  | Browser's `/auth/refresh` polling during restart. Just restart the server.       |
