# NMClaw 开发变更日志

## 2026-03-20 — Phase 2: Genesis 路由 + 多 Provider 预配置 + Chat 重构

### 新增

- **Genesis Agent 路由机制** — 对话统一入口，用户只与创世 Agent 对话，Genesis 自动路由到最合适的 Worker Agent
- **预配置 Seed 系统** (`seed.ts`) — 首次启动自动初始化默认模型和 Agent
  - Anthropic: `Claude-Opus-4-6-Agentic` (baseUrl: localhost:8991)
  - DeepSeek: `deepseek-chat` (baseUrl: api.deepseek.com/v1)
  - 创世 Agent (Genesis) — 平台内核调度
  - 时间助手 — 使用 DeepSeek 模型
  - 天气助手 — 使用 Anthropic 模型
- **`.env` 环境变量** — API Key 通过 `.env` 文件管理，服务器启动时自动加载
- **Anthropic baseURL 支持** — executor 现在正确传递 `baseURL` 给 Anthropic SDK

### 变更

- **Chat 页面重构** — 移除 Agent 选择器，统一通过 Genesis Agent 入口对话
- **Chat API 简化** — `/api/chat` 不再需要 `agentId`，服务端自动路由
- **Genesis matchAgent** — 排除 Genesis 自身，只匹配 Worker Agent
- **路由提示** — 当请求被路由到 Worker Agent 时，响应前缀显示 `[Agent名称 处理中]`

### 文件变更

| 文件 | 操作 |
|------|------|
| `src/seed.ts` | 新增 — 默认数据初始化 |
| `.env` | 新增 — 环境变量配置 |
| `src/executor.ts` | 修改 — Anthropic baseURL 支持 |
| `src/server.ts` | 修改 — env 加载 + seed 调用 + Genesis 路由 |
| `src/genesis.ts` | 修改 — matchAgent 排除 Genesis |
| `web/src/pages/Chat.tsx` | 重写 — Genesis-only 对话界面 |
| `web/src/api.ts` | 修改 — chat 函数移除 agentId 参数 |
| `.gitignore` | 修改 — 添加 `.env` |

---

## 2026-03-20 — Phase 1 MVP + Web 管理界面

### 已实现功能

#### 核心引擎 (src/)
- **创世Agent调度内核** (`genesis.ts`) — 需求匹配、任务派发、系统状态总览
- **Worker Agent生命周期管理** (`agent-manager.ts`) — 创建/销毁/TTL/idle超时/自动sweep
- **模型库** (`model-registry.ts`) — 多provider支持 (Anthropic/OpenAI/DeepSeek/Ollama/自定义)
- **技能库** (`skill-registry.ts`) — Prompt模板 + MCP依赖声明 + 模型兼容性
- **MCP库** (`mcp-registry.ts`) — stdio/sse/streamable-http 三种传输方式
- **LLM执行适配器** (`executor.ts`) — Anthropic原生SDK + OpenAI兼容API双通道
- **用户权限系统** (`permission.ts`) — 确认流程 + Bypass规则引擎
- **执行追踪** (`tracker.ts`) — Task + TraceSpan 全链路追踪
- **持久化** (`store.ts`) — JSON文件存储 (~/.nmclaw/store.json)

#### CLI 命令行 (src/cli.ts)
```
nmclaw model add/list/remove        模型库管理
nmclaw skill add/list/remove        技能库管理
nmclaw mcp add/list/remove          MCP库管理
nmclaw agent create/list/info/destroy   Agent生命周期管理
nmclaw task run/list/trace           任务派发与追踪
nmclaw bypass enable/disable/status  Bypass模式
nmclaw status                        控制面板总览
```

#### API 服务器 (src/server.ts)
- Hono + @hono/node-server
- RESTful API 覆盖所有 CRUD 操作
- CORS 支持
- 生产模式下同时提供静态前端文件

```
GET/POST/DELETE  /api/models
GET/POST/DELETE  /api/skills
GET/POST/DELETE  /api/mcps
GET/POST/PATCH/DELETE  /api/agents
GET/POST         /api/tasks
GET              /api/tasks/:id/trace
GET/POST         /api/bypass
GET              /api/status
```

#### Web 管理界面 (web/)
- React 19 + Vite 8 + Tailwind CSS 4
- 暗色主题 Dashboard
- 6个页面：控制面板、Agent管理、模型库、技能库、MCP库、任务管理
- Agent 创建表单（模型选择、技能/MCP多选、生命周期配置）
- 任务派发 + 执行追踪面板
- 开发模式 Vite proxy → API 服务器

### 技术栈

| 层级 | 选型 | 版本 |
|------|------|------|
| 运行时 | Node.js + TypeScript | v22 + TS 5.9 |
| 包管理 | pnpm (workspace) | v10 |
| 构建 | tsup (server) + Vite (web) | tsup 8 + Vite 8 |
| API | Hono | v4 |
| 前端 | React + Tailwind CSS | React 19 + TW 4 |
| LLM | @anthropic-ai/sdk + openai | — |
| CLI | commander + @inquirer/prompts | — |

### 项目结构

```
NMClaw/
├── src/                    # 核心引擎 + CLI + API
│   ├── types.ts            # 核心类型定义
│   ├── store.ts            # JSON持久化
│   ├── model-registry.ts   # 模型库
│   ├── skill-registry.ts   # 技能库
│   ├── mcp-registry.ts     # MCP库
│   ├── agent-manager.ts    # Agent管理 + 生命周期
│   ├── executor.ts         # LLM执行适配器
│   ├── genesis.ts          # 创世Agent内核
│   ├── permission.ts       # 权限系统
│   ├── tracker.ts          # 执行追踪
│   ├── cli.ts              # CLI入口
│   └── server.ts           # API服务器
├── web/                    # Web管理界面
│   ├── src/
│   │   ├── App.tsx
│   │   ├── api.ts          # API客户端
│   │   ├── pages/          # Dashboard/Models/Skills/Mcps/Agents/Tasks
│   │   └── components/     # Layout
│   ├── vite.config.ts
│   └── package.json
├── docs/
│   ├── agent-platform-requirements.md   # 需求文档
│   └── changelog.md                     # 本文件
├── tsup.config.ts
├── tsconfig.json
├── pnpm-workspace.yaml
└── package.json
```

### 启动方式

```bash
# 构建全部
pnpm build

# 启动API服务器 (含Web界面)
pnpm serve
# → http://localhost:3000

# 开发模式 (前端热更新)
# 终端1: pnpm dev          (watch server)
# 终端2: cd web && pnpm dev (vite dev server → http://localhost:5173)

# CLI
pnpm start -- status
pnpm start -- model list
pnpm start -- agent create
```

### OpenClaw 参考

参考了 [OpenClaw](https://github.com/openclaw/openclaw) 的以下设计：
- **插件manifest格式** — `openclaw.plugin.json` 的 id/name/description/configSchema 结构
- **ClawHub技能系统** — slug/version/tags/origin tracking 的技能管理模式
- **模型目录** — provider/capabilities/contextWindow 的模型注册模式
- **插件发现机制** — 注册表 + 本地安装 + 版本锁定

技能库设计兼容ClawHub的文本文件包格式，后续Phase 2将实现直接从ClawHub registry搜索和安装技能。

---

### 待开发 (Phase 2+)

- [ ] ClawHub技能市场集成 (搜索/安装/版本管理)
- [ ] MCP运行时连接池 (Agent实际调用MCP工具)
- [ ] Agent Graph DAG编排引擎
- [ ] 可视化拖拽编排界面
- [ ] Token用量统计与成本分析
- [ ] Agent摘要自动生成
- [ ] SQLite持久化升级
- [ ] Docker部署方案
