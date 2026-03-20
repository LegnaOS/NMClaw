# NMClaw

Agent 编排平台 — Genesis Agent 作为内核调度器，不是上帝 Agent。

## 架构

```
Genesis Agent (内核)
  ├── Agent Manager (生命周期管理)
  ├── Model Registry (多模型支持: Anthropic / OpenAI)
  ├── Skill Registry (技能注册)
  ├── MCP Runtime (Model Context Protocol, stdio/SSE)
  ├── Task Tracker (任务追踪 + LangSmith 风格调用链)
  ├── CRON Scheduler (定时任务)
  ├── Graph Engine (Agent 工作流编排)
  └── ClawHub Integration (技能商店)
```

## 快速开始

```bash
# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 API Key

# 开发模式
pnpm dev

# 构建
pnpm build

# 启动
pnpm start
```

访问 `http://localhost:3000` 打开 Web 控制台。

## 环境变量

```env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
PORT=3000
```

## 功能

- **多 Agent 管理** — 创建、销毁、生命周期自动回收 (TTL / 空闲超时)
- **Genesis 调度** — 根据 prompt 自动匹配最佳 Agent
- **多模型支持** — Anthropic Claude / OpenAI GPT，按 Agent 独立配置
- **MCP 工具集成** — stdio / SSE 传输，JSON-RPC 2.0 协议
- **任务追踪** — LangSmith 风格的嵌套调用链可视化 (waterfall timeline)
- **Agent Graph** — 可视化工作流编排，节点串联执行
- **ClawHub 商店** — 一键安装 OpenClaw 生态技能
- **CRON 定时任务** — cron 表达式调度，自动派发任务
- **本地 MCP 扫描** — 自动发现 Claude/Cursor 等工具的 MCP 配置
- **SSE 流式对话** — 实时 token 流 + 工具调用过程展示
- **CLI 工具** — 命令行管理 Agent、Model、Skill、MCP

## 项目结构

```
src/
  server.ts          # Hono HTTP 服务
  genesis.ts         # Genesis Agent 调度内核
  executor.ts        # LLM 执行引擎 (Anthropic/OpenAI + tool use)
  agent-manager.ts   # Agent 生命周期管理
  model-registry.ts  # 模型注册表
  skill-registry.ts  # 技能注册表
  mcp-registry.ts    # MCP 注册表
  mcp-runtime.ts     # MCP 运行时 (stdio/SSE JSON-RPC)
  tracker.ts         # 任务 & 追踪存储
  graph.ts           # Agent Graph 引擎
  clawhub.ts         # ClawHub 商店集成 (Convex API)
  cron.ts            # CRON 定时调度
  store.ts           # 持久化存储
  cli.ts             # CLI 入口
  types.ts           # 类型定义
web/
  src/pages/         # React 前端页面
```

## License

MIT
