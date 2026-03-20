# NMClaw

[English](#english) | [中文](#中文)

---

<a id="中文"></a>

## 中文

NMClaw 是一个 Agent 编排平台 — Genesis Agent 作为内核调度器，自动将用户请求路由到最合适的 Worker Agent。

### 架构

```
Genesis Agent (内核调度)
  ├── Agent Manager        生命周期管理 (TTL / 空闲超时 / 自动回收)
  ├── Model Registry       多模型支持 (Anthropic / OpenAI / DeepSeek)
  ├── Skill Registry       技能注册与模板
  ├── MCP Runtime          Model Context Protocol (stdio / SSE / 内置工具)
  ├── Task Tracker         任务追踪 + 调用链可视化
  ├── CRON Scheduler       定时任务调度
  ├── Graph Engine          Agent 工作流 DAG 编排
  ├── Channel Manager      IM 渠道集成 (飞书 WebSocket)
  └── ClawHub Integration  技能商店
```

### 核心特性

- **Genesis 调度内核** — 用户只与 Genesis Agent 对话，Genesis 自动判断并委派任务到 Worker Agent，Worker 执行过程实时流式回传
- **多 Agent 管理** — 创建、编辑、激活/停用、自动生命周期回收
- **多模型支持** — Anthropic Claude / OpenAI GPT / DeepSeek，按 Agent 独立配置
- **MCP 工具集成** — stdio / SSE 传输 + 内置工具 (时间、天气、文件系统、Shell、平台管理)，每个 Agent 独立绑定工具集
- **飞书渠道集成** — WebSocket 长连接模式，流式卡片回复，支持 `requireMention` 和白名单访问控制 + 配对码审批
- **SSE 流式对话** — 实时 token 流 + 工具调用过程展示 + Worker Agent 子会话内嵌显示
- **Agent Graph** — 可视化工作流编排，节点串联执行，SSE 实时事件流
- **CRON 定时任务** — cron 表达式调度，绑定 Agent 自动执行
- **ClawHub 商店** — 搜索安装 OpenClaw 生态技能
- **本地 MCP 扫描** — 自动发现 Claude / Cursor 等工具的 MCP 配置，一键导入
- **任务追踪** — LangSmith 风格嵌套调用链，waterfall timeline 可视化

### 快速开始

```bash
# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 API Key

# 开发模式
pnpm dev

# 构建 & 启动
pnpm build
pnpm start
```

访问 `http://localhost:3000` 打开 Web 控制台。

### 环境变量

```env
ANTHROPIC_AUTH_TOKEN=sk-ant-...   # Anthropic API Key
ANTHROPIC_BASE_URL=               # 自定义 API 地址 (可选)
DEEPSEEK_API_KEY=sk-...           # DeepSeek API Key (可选)
OPENAI_API_KEY=sk-...             # OpenAI API Key (可选)
PORT=3000                         # 服务端口
```

### 项目结构

```
src/
  server.ts          Hono HTTP 服务 + SSE 流式端点
  executor.ts        LLM 执行引擎 (Anthropic/OpenAI + tool use + dispatch)
  mcp-runtime.ts     MCP 运行时 (stdio/SSE/内置工具 + Agent 工具隔离)
  seed.ts            首次启动默认数据初始化
  types.ts           核心类型定义
  store.ts           JSON 持久化 (~/.nmclaw/store.json)
  cron.ts            CRON 定时调度
  graph.ts           Agent Graph DAG 引擎
  channels/
    feishu.ts        飞书渠道 (WebSocket + 流式卡片 + 配对码)
web/
  src/pages/         React 前端 (Chat / Models / Skills / Mcps / Graphs / Cron / Channels)
```

### v1.0.1 更新日志

**新特性**
- Genesis Agent 委派优先：收到请求时优先查找并委派给合适的 Worker Agent，而非自己处理
- Worker Agent 实时流式回传：Genesis 委派任务后，Worker 的执行过程（文本 + 工具调用）通过 `[DISPATCH_START]`/`[DISPATCH_END]` 标记实时流回 Chat UI
- Chat UI 子会话展示：DispatchBlock 组件内嵌显示 Worker Agent 的执行过程，可折叠
- Agent 工具隔离：每个 Agent 只能使用自己绑定的 MCP 工具，不再共享全局工具集
- 飞书 WebSocket 长连接：使用 `@larksuiteoapi/node-sdk` 实现，无需公网 URL
- 飞书流式卡片回复：Card Kit API 实时打字效果
- 飞书访问控制：`groupPolicy` 白名单模式 + 配对码审批机制，`requireMention` 群聊 @机器人 才回复
- WebSocket 连接预检：启动前直接调用飞书 endpoint 获取真实错误信息，解决 SDK 吞错误的问题
- 消息去重修复：使用 `message_id` 替代 `event_id` 做去重，修复 WebSocket 模式下重复回复
- Agent 编辑与状态切换：支持在 Web UI 编辑 Agent 配置、激活/停用
- Graph 执行 SSE 流式事件
- MCP JSON 批量导入
- 本地 MCP 扫描与一键导入
- Skill 上传 (zip/tar.gz/md)
- CRON 定时任务管理 UI
- 渠道管理 UI (连接状态、启停控制、配对管理)

**修复**
- Skill upload 路由 404 (路由顺序修复)
- Chat 消息 token 计数和耗时显示
- 飞书 WebSocket 错误码 1000040345 诊断提示

### License

MIT

---

<a id="english"></a>

## English

NMClaw is an Agent orchestration platform — Genesis Agent serves as the kernel scheduler, automatically routing user requests to the most suitable Worker Agent.

### Architecture

```
Genesis Agent (Kernel Scheduler)
  ├── Agent Manager        Lifecycle management (TTL / idle timeout / auto-sweep)
  ├── Model Registry       Multi-model support (Anthropic / OpenAI / DeepSeek)
  ├── Skill Registry       Skill registration & templates
  ├── MCP Runtime          Model Context Protocol (stdio / SSE / built-in tools)
  ├── Task Tracker         Task tracking + call chain visualization
  ├── CRON Scheduler       Scheduled task execution
  ├── Graph Engine         Agent workflow DAG orchestration
  ├── Channel Manager      IM channel integration (Feishu WebSocket)
  └── ClawHub Integration  Skill marketplace
```

### Key Features

- **Genesis Dispatch Kernel** — Users interact only with Genesis Agent, which automatically delegates tasks to Worker Agents with real-time streaming of Worker execution
- **Multi-Agent Management** — Create, edit, activate/deactivate, automatic lifecycle management
- **Multi-Model Support** — Anthropic Claude / OpenAI GPT / DeepSeek, independently configured per Agent
- **MCP Tool Integration** — stdio / SSE transport + built-in tools (time, weather, filesystem, shell, platform management), each Agent has isolated tool bindings
- **Feishu Channel Integration** — WebSocket long connection, streaming card replies, `requireMention` and allowlist access control with pairing code approval
- **SSE Streaming Chat** — Real-time token stream + tool call visualization + embedded Worker Agent sub-sessions
- **Agent Graph** — Visual workflow orchestration, sequential node execution, SSE real-time events
- **CRON Scheduled Tasks** — Cron expression scheduling, bound to Agents for automatic execution
- **ClawHub Marketplace** — Search and install skills from the OpenClaw ecosystem
- **Local MCP Scanner** — Auto-discover MCP configs from Claude / Cursor and other tools, one-click import
- **Task Tracing** — LangSmith-style nested call chains with waterfall timeline visualization

### Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment variables
cp .env.example .env
# Edit .env with your API keys

# Development mode
pnpm dev

# Build & start
pnpm build
pnpm start
```

Visit `http://localhost:3000` to open the Web console.

### Environment Variables

```env
ANTHROPIC_AUTH_TOKEN=sk-ant-...   # Anthropic API Key
ANTHROPIC_BASE_URL=               # Custom API endpoint (optional)
DEEPSEEK_API_KEY=sk-...           # DeepSeek API Key (optional)
OPENAI_API_KEY=sk-...             # OpenAI API Key (optional)
PORT=3000                         # Server port
```

### Project Structure

```
src/
  server.ts          Hono HTTP server + SSE streaming endpoints
  executor.ts        LLM execution engine (Anthropic/OpenAI + tool use + dispatch)
  mcp-runtime.ts     MCP runtime (stdio/SSE/built-in tools + per-Agent tool isolation)
  seed.ts            First-run default data initialization
  types.ts           Core type definitions
  store.ts           JSON persistence (~/.nmclaw/store.json)
  cron.ts            CRON scheduler
  graph.ts           Agent Graph DAG engine
  channels/
    feishu.ts        Feishu channel (WebSocket + streaming cards + pairing codes)
web/
  src/pages/         React frontend (Chat / Models / Skills / Mcps / Graphs / Cron / Channels)
```

### v1.0.1 Changelog

**New Features**
- Genesis Agent delegation priority: prioritizes finding and delegating to suitable Worker Agents instead of handling requests directly
- Worker Agent real-time streaming: after Genesis delegates, Worker execution (text + tool calls) streams back to Chat UI via `[DISPATCH_START]`/`[DISPATCH_END]` markers
- Chat UI sub-session display: DispatchBlock component shows embedded Worker Agent execution, collapsible
- Agent tool isolation: each Agent can only use its bound MCP tools, no longer sharing the global toolset
- Feishu WebSocket long connection: implemented with `@larksuiteoapi/node-sdk`, no public URL required
- Feishu streaming card replies: Card Kit API with real-time typing effect
- Feishu access control: `groupPolicy` allowlist mode + pairing code approval, `requireMention` for group chat @-mention requirement
- WebSocket connection pre-flight check: directly calls Feishu endpoint before starting to get real error messages, solving SDK error swallowing
- Message dedup fix: uses `message_id` instead of `event_id` for deduplication, fixing duplicate replies in WebSocket mode
- Agent editing and state toggle: edit Agent config, activate/deactivate in Web UI
- Graph execution SSE streaming events
- MCP JSON batch import
- Local MCP scanner with one-click import
- Skill upload (zip/tar.gz/md)
- CRON task management UI
- Channel management UI (connection status, start/stop control, pairing management)

**Fixes**
- Skill upload route 404 (route ordering fix)
- Chat message token count and duration display
- Feishu WebSocket error code 1000040345 diagnostic hints

### License

MIT
