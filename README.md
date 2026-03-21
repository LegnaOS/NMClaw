# NMClaw

**Agent orchestration platform — Genesis Agent as kernel scheduler, not God Agent.**

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

NMClaw is a multi-agent orchestration platform. A Genesis Agent acts as the kernel scheduler — it parses user requests, matches the best Worker Agent, delegates execution, and streams results back in real time. Users never talk to Workers directly; Genesis handles all routing.

### Architecture

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
              └── ClawHub               Skill marketplace
              │
              ├── Worker A (Model X, Skills [...], MCPs [...])
              ├── Worker B (Model Y, Skills [...], MCPs [...])
              └── Worker C (Model Z, Skills [...], MCPs [...])
```

### Features

| Category | Details |
|----------|---------|
| **Genesis Dispatch** | Users talk to Genesis only. It auto-delegates to the best Worker Agent and streams execution (text + tool calls) back via `[DISPATCH_START]`/`[DISPATCH_END]` markers |
| **Multi-Agent Lifecycle** | Create, edit, activate/deactivate Workers. TTL + idle timeout auto-sweep. Destroyed agents are garbage-collected |
| **Multi-Model** | Anthropic Claude · OpenAI GPT · DeepSeek — independently configured per Agent |
| **MCP Tool Integration** | stdio / SSE transport + built-in tools (time, weather, filesystem, shell, platform mgmt). Per-Agent tool isolation |
| **SSE Streaming Chat** | Real-time token stream, tool call visualization, embedded Worker sub-sessions (collapsible DispatchBlock) |
| **Agent Graph** | DAG workflow editor — chain agents into pipelines, conditional edges, SSE real-time execution events |
| **CRON Scheduler** | Cron expressions bound to Agents for automatic periodic execution |
| **Feishu Channel** | WebSocket long connection via `@larksuiteoapi/node-sdk`, streaming card replies (Card Kit API), `requireMention`, allowlist + pairing code access control |
| **ClawHub Marketplace** | Search & install skills from the OpenClaw ecosystem |
| **Local MCP Scanner** | Auto-discover MCP configs from Claude Desktop / Cursor / etc., one-click import |
| **Task Tracing** | LangSmith-style nested spans with waterfall timeline visualization |
| **Skill Upload** | Upload skills as zip / tar.gz / markdown files |
| **MCP JSON Import** | Batch import MCP server configs from JSON |
| **Web Dashboard** | React 19 + Tailwind CSS 4 dark-theme console — Chat, Agents, Models, Skills, MCPs, Graphs, Cron, Channels |
| **CLI** | Full management via `nmclaw` command — models, skills, mcps, agents, tasks, bypass, status |

### Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Fill in your API keys

# Development mode (hot reload)
pnpm dev

# Production build & start
pnpm build
pnpm start
```

Open `http://localhost:3000` for the Web console.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_AUTH_TOKEN` | Yes | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | Custom Anthropic API endpoint |
| `OPENAI_API_KEY` | No | OpenAI API key |
| `DEEPSEEK_API_KEY` | No | DeepSeek API key |
| `PORT` | No | Server port (default: 3000) |

### Project Structure

```
src/
  server.ts            Hono HTTP + SSE streaming endpoints
  executor.ts          LLM engine (Anthropic/OpenAI + tool use + dispatch)
  genesis.ts           Genesis Agent kernel (matching + routing)
  agent-manager.ts     Agent lifecycle (create/destroy/TTL/sweep)
  mcp-runtime.ts       MCP runtime (stdio/SSE/built-in + per-Agent isolation)
  model-registry.ts    Model CRUD + provider config
  skill-registry.ts    Skill CRUD + templates
  mcp-registry.ts      MCP server CRUD
  graph.ts             DAG workflow engine
  cron.ts              CRON scheduler
  tracker.ts           Task tracing (spans + timeline)
  store.ts             JSON persistence (~/.nmclaw/store.json)
  seed.ts              First-run default data
  clawhub.ts           ClawHub marketplace client
  local-mcp-scanner.ts Auto-discover local MCP configs
  permission.ts        User permission + bypass rules
  channels/
    feishu.ts          Feishu (WebSocket + streaming cards + pairing)
web/
  src/pages/           React frontend (Chat / Dashboard / Agents / Models /
                       Skills / Mcps / Graphs / Cron / Channels / ClawHub / Tasks)
```

### Tech Stack

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

### License

MIT

---

<a id="中文"></a>

## 中文

NMClaw 是一个多 Agent 编排平台。Genesis Agent 作为内核调度器 —— 解析用户请求、匹配最合适的 Worker Agent、委派执行、实时流式回传结果。用户不直接与 Worker 对话，一切由 Genesis 路由。

### 核心特性

| 分类 | 说明 |
|------|------|
| **Genesis 调度** | 用户只与 Genesis 对话，自动委派到最合适的 Worker，执行过程通过 `[DISPATCH_START]`/`[DISPATCH_END]` 实时流回 |
| **多 Agent 生命周期** | 创建、编辑、激活/停用，TTL + 空闲超时自动回收 |
| **多模型支持** | Anthropic Claude · OpenAI GPT · DeepSeek，按 Agent 独立配置 |
| **MCP 工具集成** | stdio / SSE 传输 + 内置工具 (时间、天气、文件系统、Shell、平台管理)，Agent 级工具隔离 |
| **SSE 流式对话** | 实时 token 流 + 工具调用可视化 + Worker 子会话折叠展示 |
| **Agent Graph** | DAG 工作流编排，条件分支，SSE 实时执行事件 |
| **CRON 定时任务** | cron 表达式绑定 Agent 自动执行 |
| **飞书渠道** | WebSocket 长连接，流式卡片回复，`requireMention`，白名单 + 配对码访问控制 |
| **ClawHub 商店** | 搜索安装 OpenClaw 生态技能 |
| **本地 MCP 扫描** | 自动发现 Claude Desktop / Cursor 的 MCP 配置，一键导入 |
| **任务追踪** | LangSmith 风格嵌套调用链，waterfall timeline 可视化 |
| **Skill 上传** | 支持 zip / tar.gz / markdown 格式上传 |
| **MCP JSON 导入** | 批量导入 MCP 服务器配置 |
| **Web 控制台** | React 19 + Tailwind CSS 4 暗色主题 — Chat / Agents / Models / Skills / MCPs / Graphs / Cron / Channels |
| **CLI** | `nmclaw` 命令行完整管理 — 模型、技能、MCP、Agent、任务、Bypass |

### 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 API Key
pnpm dev               # 开发模式
pnpm build && pnpm start  # 生产模式
```

访问 `http://localhost:3000`

### License

MIT
