# NMClaw

**Agent 内核调度平台 — Genesis Agent 是内核，不是 God Agent。**

[English](./README.en.md)

---

NMClaw 是一个多 Agent 编排平台。Genesis Agent 作为内核调度器 —— 解析用户请求、匹配最合适的 Worker Agent、委派执行、实时流式回传结果。用户不直接与 Worker 对话，一切由 Genesis 路由。

所有资源变更（创建 / 修改 / 销毁 Agent、定时任务）必须经过用户确认。Web 端使用弹窗按钮确认，其他渠道使用文字回复确认。

## 架构

```
用户 ──→ Genesis Agent（内核调度器）
              │
              ├── Agent Manager         生命周期管理（TTL / 空闲超时 / 自动回收）
              ├── Model Registry        多模型（Anthropic / OpenAI / DeepSeek）
              ├── Skill Registry        技能模板 + 依赖声明
              ├── MCP Runtime           Model Context Protocol（stdio / SSE / 内置）
              ├── Task Tracker          嵌套调用链 + 瀑布流时间轴
              ├── CRON Scheduler        定时任务调度
              ├── Graph Engine          DAG 工作流编排
              ├── Channel Manager       IM 渠道（飞书 WebSocket）
              ├── EvoMap               GEP-A2A 协作进化网络
              └── ClawHub               技能商店
              │
              ├── Worker A（模型 X, 技能 [...], 工具 [...]）
              ├── Worker B（模型 Y, 技能 [...], 工具 [...]）
              └── Worker C（模型 Z, 技能 [...], 工具 [...]）
```

## 核心特性

| 分类 | 说明 |
|------|------|
| **Genesis 调度** | 用户只与 Genesis 对话，自动委派到最合适的 Worker，执行过程实时流回 |
| **用户授权 CRUD** | 所有资源变更必须经用户确认。Web 端弹窗按钮，其他渠道文字回复 |
| **Genesis 自动绑定** | 新增 Skill / MCP 自动绑定到 Genesis，确保内核始终拥有最高权限 |
| **多 Agent 生命周期** | 创建、编辑、激活/停用，TTL + 空闲超时自动回收 |
| **多模型支持** | Anthropic Claude · OpenAI GPT · DeepSeek，按 Agent 独立配置 |
| **MCP 工具集成** | stdio / SSE 传输 + 内置工具（时间、天气、文件系统、Shell、平台管理、Web），Agent 级工具隔离 |
| **文件系统管理** | copy / move / delete（两步确认防误删）+ send_file（Web 端可点击下载）+ send_file_to_channel（跨渠道发送） |
| **无浏览器网页抓取** | 纯 HTTP + HTML 解析，随机 UA 轮换、自动重试、4 层内容提取，零二进制依赖 |
| **SSE 流式对话** | 实时 token 流 + 工具调用可视化 + Worker 子会话折叠展示 |
| **Agent 长期记忆** | 每个 Agent 独立记忆存储，跨会话保持上下文，自动摘要历史对话 |
| **飞书对话历史** | 飞书渠道自动携带最近 20 条对话上下文，支持多轮连续对话 |
| **代理兼容工具调用** | 通过 XML tool protocol 实现工具调用，兼容 API 代理/中转服务 |
| **Agent Graph** | DAG 工作流编排，条件分支，SSE 实时执行事件 |
| **CRON 定时任务** | cron 表达式绑定 Agent 自动执行 |
| **EvoMap 协作网络** | GEP-A2A 协议注册节点、心跳保活、积分同步 |
| **飞书渠道** | WebSocket 长连接，流式卡片回复，白名单 + 配对码访问控制 |
| **飞书大文件传输** | ≤30MB IM 直传，>30MB 自动走云空间分片上传（4MB 分片）+ 上传后自动授权用户查看权限 |
| **渠道上下文感知** | Agent 自动识别当前用户渠道（Web / 飞书），选择正确的文件发送工具 |
| **模型直配 API Key** | 模型可直接配置 API Key，不再强制使用环境变量，支持每模型独立密钥 |
| **Skill 导入** | 支持文件上传（zip / tar.gz / md）和 URL 链接导入 |
| **MCP 导入** | JSON 批量导入 + 本地自动发现（Claude Desktop / Cursor 等） |
| **ClawHub 商店** | 搜索安装 OpenClaw 生态技能 |
| **任务追踪** | LangSmith 风格嵌套调用链，waterfall timeline 可视化 |
| **Web 控制台** | React 19 + Tailwind CSS 4 暗色主题 — Chat / Agents / Models / Skills / MCPs / Graphs / Cron / Channels |
| **CLI** | `nmclaw` 命令行完整管理 |

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 API Key
pnpm dev               # 开发模式（热重载）
pnpm build && pnpm start  # 生产模式
```

访问 `http://localhost:3000` 打开 Web 控制台。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `ANTHROPIC_AUTH_TOKEN` | 是 | Anthropic API Key |
| `ANTHROPIC_BASE_URL` | 否 | 自定义 Anthropic API 端点 |
| `OPENAI_API_KEY` | 否 | OpenAI API Key |
| `DEEPSEEK_API_KEY` | 否 | DeepSeek API Key |
| `PORT` | 否 | 服务端口（默认 3000） |

## 项目结构

```
src/
  server.ts            Hono HTTP + SSE 流式接口
  executor.ts          LLM 引擎（raw fetch + XML tool protocol，兼容 API 代理）
  genesis.ts           Genesis 内核（匹配 + 路由）
  agent-manager.ts     Agent 生命周期（创建/销毁/TTL/回收）
  mcp-runtime.ts       MCP 运行时（stdio/SSE/内置 + Agent 级隔离）
  model-registry.ts    模型 CRUD + 多供应商配置
  skill-registry.ts    技能 CRUD + 模板（新增自动绑定 Genesis）
  mcp-registry.ts      MCP 服务 CRUD（新增自动绑定 Genesis）
  skill-upload.ts      技能上传 + URL 导入
  memory.ts            Agent 长期记忆（跨会话持久化 + 自动摘要）
  ext/
    evomap.ts          EvoMap GEP-A2A 协议（注册/心跳/积分）
    clawhub.ts         ClawHub 商店客户端
  graph.ts             DAG 工作流引擎
  cron.ts              CRON 定时调度
  tracker.ts           任务追踪（嵌套 span + 时间轴）
  store.ts             JSON 持久化（~/.nmclaw/store.json）
  seed.ts              首次运行默认数据 + 增量迁移
  local-mcp-scanner.ts 本地 MCP 配置自动发现
  permission.ts        用户权限 + Bypass 规则
  channels/
    feishu.ts          飞书渠道（WebSocket + 流式卡片 + 配对码 + 大文件分片上传 + 云空间授权）
web/
  src/pages/           React 前端（Chat / Dashboard / Agents / Models /
                       Skills / Mcps / Graphs / Cron / Channels / ClawHub / Tasks）
```

## 技术栈

| 层级 | 选型 |
|------|------|
| 运行时 | Node.js ≥ 20 + TypeScript 5.9 |
| 包管理 | pnpm (workspace) |
| 构建 | tsup (服务端) + Vite (前端) |
| HTTP | Hono |
| 前端 | React 19 + Tailwind CSS 4 |
| LLM SDK | `@anthropic-ai/sdk` + `openai` |
| CLI | `commander` + `@inquirer/prompts` |
| IM | `@larksuiteoapi/node-sdk` |

## License

MIT
