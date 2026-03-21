# NMClaw

**Agent orchestration platform — Genesis Agent as kernel scheduler, not God Agent.**

[中文](./README.md)

---

NMClaw is a multi-agent orchestration platform. A Genesis Agent acts as the kernel scheduler — it parses user requests, matches the best Worker Agent, delegates execution, and streams results back in real time. Users never talk to Workers directly; Genesis handles all routing.

All resource mutations (create / modify / destroy Agents, cron jobs) require explicit user confirmation. Web UI uses popup buttons; other channels use text-based confirmation.

## Architecture

```
User ──→ Genesis Agent (Kernel Scheduler)
              │
              ├── Agent Manager         Lifecycle (TTL / idle timeout / auto-sweep)
              ├── Model Registry        Multi-provider (Anthropic / OpenAI / DeepSeek)
              ├── Skill Registry        Prompt templates + dependencies
              ├── MCP Runtime           Model Context Protocol (stdio / SSE / built-in)
              ├── Task Tracker          Nested call chains + waterfall timeline
              ├── CRON Scheduler        Cron-expression scheduled tasks
              ├── Graph Engine          DAG workflow orchestration
              ├── Channel Manager       IM integration (Feishu WebSocket)
              ├── EvoMap               GEP-A2A collaborative evolution network
              └── ClawHub               Skill marketplace
              │
              ├── Worker A (Model X, Skills [...], MCPs [...])
              ├── Worker B (Model Y, Skills [...], MCPs [...])
              └── Worker C (Model Z, Skills [...], MCPs [...])
```

## Features

| Category | Details |
|----------|---------|
| **Genesis Dispatch** | Users talk to Genesis only. It auto-delegates to the best Worker and streams execution back |
| **User-Authorized CRUD** | All resource mutations require user confirmation. Web UI: popup buttons. Other channels: text reply |
| **Genesis Auto-Binding** | New Skills / MCPs are automatically bound to Genesis, ensuring the kernel always has highest privileges |
| **Multi-Agent Lifecycle** | Create, edit, activate/deactivate Workers. TTL + idle timeout auto-sweep |
| **Multi-Model** | Anthropic Claude · OpenAI GPT · DeepSeek — independently configured per Agent |
| **MCP Tool Integration** | stdio / SSE transport + built-in tools (time, weather, filesystem, shell, platform, web). Per-Agent isolation |
| **File System Management** | copy / move / delete (two-phase confirmation) + send_file (clickable download in Web) + send_file_to_channel (cross-channel delivery) |
| **Browser-less Scraping** | Pure HTTP + HTML parsing, random UA rotation, auto-retry, 4-layer content extraction. Zero binary deps |
| **SSE Streaming Chat** | Real-time token stream, tool call visualization, collapsible Worker sub-sessions |
| **Agent Graph** | DAG workflow editor — chain agents into pipelines, conditional edges, SSE execution events |
| **CRON Scheduler** | Cron expressions bound to Agents for automatic periodic execution |
| **EvoMap Network** | GEP-A2A protocol — node registration, heartbeat keep-alive, credit sync |
| **Feishu Channel** | WebSocket long connection, streaming card replies, allowlist + pairing code access control |
| **Feishu Large File Transfer** | ≤30MB via IM direct upload; >30MB auto-routes to Drive chunked upload (4MB blocks) + auto-grants viewer permission |
| **Channel Context Awareness** | Agent auto-detects current channel (Web / Feishu) and selects the correct file-sending tool |
| **Per-Model API Key** | Models can be configured with a direct API key — no longer forced to use env vars. Supports independent keys per model |
| **Skill Import** | File upload (zip / tar.gz / md) and URL import |
| **MCP Import** | JSON batch import + local auto-discovery (Claude Desktop / Cursor / etc.) |
| **ClawHub Marketplace** | Search & install skills from the OpenClaw ecosystem |
| **Task Tracing** | LangSmith-style nested spans with waterfall timeline visualization |
| **Web Dashboard** | React 19 + Tailwind CSS 4 dark-theme console |
| **CLI** | Full management via `nmclaw` command |

## Quick Start

```bash
pnpm install
cp .env.example .env   # Fill in API keys
pnpm dev               # Development mode (hot reload)
pnpm build && pnpm start  # Production
```

Open `http://localhost:3000` for the Web console.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_AUTH_TOKEN` | Yes | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | Custom Anthropic API endpoint |
| `OPENAI_API_KEY` | No | OpenAI API key |
| `DEEPSEEK_API_KEY` | No | DeepSeek API key |
| `PORT` | No | Server port (default: 3000) |

## Project Structure

```
src/
  server.ts            Hono HTTP + SSE streaming endpoints
  executor.ts          LLM engine (Anthropic/OpenAI + tool use + dispatch)
  genesis.ts           Genesis Agent kernel (matching + routing)
  agent-manager.ts     Agent lifecycle (create/destroy/TTL/sweep)
  mcp-runtime.ts       MCP runtime (stdio/SSE/built-in + per-Agent isolation)
  model-registry.ts    Model CRUD + provider config
  skill-registry.ts    Skill CRUD + templates (auto-binds to Genesis)
  mcp-registry.ts      MCP server CRUD (auto-binds to Genesis)
  skill-upload.ts      Skill upload + URL import
  ext/
    evomap.ts          EvoMap GEP-A2A protocol (register / heartbeat / credits)
    clawhub.ts         ClawHub marketplace client
  graph.ts             DAG workflow engine
  cron.ts              CRON scheduler
  tracker.ts           Task tracing (spans + timeline)
  store.ts             JSON persistence (~/.nmclaw/store.json)
  seed.ts              First-run defaults + incremental migration
  local-mcp-scanner.ts Auto-discover local MCP configs
  permission.ts        User permission + bypass rules
  channels/
    feishu.ts          Feishu (WebSocket + streaming cards + pairing + chunked upload + Drive permissions)
web/
  src/pages/           React frontend (Chat / Dashboard / Agents / Models /
                       Skills / Mcps / Graphs / Cron / Channels / ClawHub / Tasks)
```

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js ≥ 20 + TypeScript 5.9 |
| Package Manager | pnpm (workspace) |
| Build | tsup (server) + Vite (web) |
| HTTP | Hono |
| Frontend | React 19 + Tailwind CSS 4 |
| LLM SDKs | `@anthropic-ai/sdk` + `openai` |
| CLI | `commander` + `@inquirer/prompts` |
| IM | `@larksuiteoapi/node-sdk` |

## License

MIT

