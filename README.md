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
              ├── Skill Evolution       技能自主进化（自动提取 + 版本管理）
              ├── MCP Runtime           Model Context Protocol（stdio / SSE / 内置）
              ├── Smart Routing         智能模型路由（简单→便宜模型，复杂→强模型）
              ├── Context Compressor    上下文自动压缩（5 阶段裁剪 + 摘要）
              ├── Prompt Cache          冻结快照缓存（session 级 prompt 冻结）
              ├── Injection Scanner     注入安全扫描（60+ 威胁模式 + 信任矩阵）
              ├── PTC Runtime           编程式工具调用（JS 脚本批量调工具）
              ├── Delegation Engine     子 Agent 委派（深度控制 + 工具隔离 + 并发）
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
| **工具并发调度** | 只读工具 `Promise.allSettled` 并行执行，写操作自动串行，多工具调用 2-3x 提速 |
| **AbortController** | 客户端断开连接即停止 LLM 调用和工具执行，避免无效 token 消耗 |
| **工具结果截断** | 30K 字符上限，超大结果保留首尾各半 + 截断提示，防止撑爆上下文窗口 |
| **Store 内存缓存** | 内存缓存 + 50ms debounce 写入合并，磁盘 IO 减少 ~80%，进程退出自动刷盘 |
| **Anthropic 原生 tool_use** | 默认使用 Anthropic 原生 tool_use API（参考 Claude Code 架构），结构化解析更可靠，system prompt 减少 500-2000 tokens。支持原生 SSE 流式 tool_use。可通过 `xmlToolProtocol: true` 回退到 XML 模式兼容 API 代理 |
| **代理兼容工具调用** | XML tool protocol 回退模式，兼容 API 代理/中转服务 |
| **Agent Graph** | DAG 工作流编排，上游输出自动流转下游、多源聚合、同层并行执行、条件分支 |
| **记忆回溯** | 每次资源变更自动拍快照，支持回溯到任意历史版本，恢复操作本身也可撤销。快照数量可配置（3-200，默认 10），可关闭。Genesis Agent 内置回溯工具，Web 面板可视化时间线 + 设置面板 |
| **文件快照** | MCP 文件操作（创建/覆写/移动/删除）自动备份文件内容（≤10MB），每个文件独立保留版本，支持一键恢复。操作标签清晰区分：Agent 创建/覆写/删除/移动文件、恢复前自动备份 |
| **CRON 定时任务** | cron 表达式绑定 Agent 自动执行 |
| **EvoMap 协作网络** | GEP-A2A 协议注册节点、心跳保活、积分同步 |
| **飞书渠道** | WebSocket 长连接，流式卡片回复，白名单 + 配对码访问控制 |
| **飞书大文件传输** | ≤30MB IM 直传，>30MB 自动走云空间分片上传（4MB 分片）+ 上传后自动授权用户查看权限 |
| **渠道上下文感知** | Agent 自动识别当前用户渠道（Web / 飞书），选择正确的文件发送工具 |
| **模型直配 API Key** | 模型可直接配置 API Key，不再强制使用环境变量，支持每模型独立密钥 |
| **Prompt Caching** | Anthropic 自动启用 prompt caching（system prompt + 对话前缀），多轮 tool loop 节省 ~90% input token；Deepseek 自动前缀缓存 |
| **响应去重缓存** | 相同请求 5 分钟内命中内存缓存直接返回，跳过 API 调用，缓存统计暴露到 /api/status |
| **Skill 导入** | 支持文件上传（zip / tar.gz / md）和 URL 链接导入 |
| **MCP 导入** | JSON 批量导入 + 本地自动发现（Claude Desktop / Cursor 等） |
| **ClawHub 商店** | 搜索安装 OpenClaw 生态技能 |
| **任务追踪** | LangSmith 风格嵌套调用链，waterfall timeline 可视化 |
| **Web 控制台** | React 19 + Tailwind CSS 4 暗色主题 — Chat / Agents / Models / Skills / MCPs / Graphs / Cron / Channels |
| **CLI** | `nmclaw` 命令行完整管理 |

### Changelog

#### v2.2.0 — 多渠道接入 + 记忆系统修复（参考 [OpenClaw](https://github.com/openclaw/openclaw)）

- **渠道抽象层** — 统一 ChannelAdapter 接口 + IncomingMessage 标准化消息格式 + 对话历史缓存 + processIncomingMessage 统一入口
- **Telegram 适配器** — grammy Long Polling，私聊+群聊（@bot），Markdown 回复，智能分片（换行/空格优先断开），"思考中"提示
- **Discord 适配器** — discord.js WebSocket Gateway，DM+服务器频道（@bot），2000 字符分片，线程回复
- **Slack 适配器** — @slack/bolt Socket Mode（无需公网 URL），DM+频道（@bot），线程回复，4000 字符分片
- **企业微信适配器** — WebSocket 长连接（BotId 模式，无需公网 URL），Markdown 卡片回复
- **钉钉适配器** — Stream 模式长连接（无需公网 URL），自动重连，sessionWebhook 回复
- **微信公众号适配器** — 被动回复 + 客服消息异步回复（突破 5 秒限制），XML 解析/签名验证
- **中文分词器重写** — 正向最大匹配替代 naive bigram，内置 ~500 高频词词典（技术/日常/情感），中英文混合分词
- **实体提取增强** — 中文人名识别（80+ 常见姓氏）、引号/书名号内容提取、中英混合术语（Docker部署/Redis缓存）
- **记忆分类中文标记扩充** — 5 类各增加 10+ 中文关键词（踩坑/搞定了/喜欢用/太棒了 等）
- **情感词汇扩充** — 从 14 个扩充到 50+ 个中文情感信号词（烦/无语/崩溃/牛/佩服/纠结/释然 等）

#### v2.1.0 — 记忆宫殿（融合 [MemPalace](https://github.com/milla-jovovich/mempalace)）

- **4 层记忆栈** — L0 身份（~100 tokens）→ L1 核心故事（~800）→ L2 按需加载（工具触发）→ L3 深度语义搜索。唤醒成本 ~600-900 tokens，95%+ 上下文留给任务。drawers 为空时无缝回退原始记忆
- **时序知识图谱** — SQLite 实体-关系三元组，valid_from/valid_to 时间窗口，事实过期不删除保留历史。与 Zep Neo4j 方案等价，完全本地免费
- **5 类记忆自动提取** — 每轮对话自动提取 DECISIONS / PREFERENCES / MILESTONES / PROBLEMS / EMOTIONAL。纯正则分类器（60+ 中英文标记），情感消歧，代码行过滤
- **AAAK 结构化摘要** — 实体/话题/情感提取，30+ 情感标签 + 中英文信号词，压缩为符号格式 `E:Riley/person T:memory EM:excite/3`
- **宫殿结构** — Wing（领域）→ Room（话题）→ Drawer（记忆条目），自动分类（技术/个人/Agent 专属），importance 排序 + 访问计数
- **TF-IDF 语义搜索** — 中文 bigram + 英文分词 → TF-IDF → 余弦相似度，零外部依赖，IDF 缓存 120s，>1000 条先 FTS5 粗筛再精排
- **近似去重** — Jaccard 相似度 0.85 阈值，保存前自动检查，保留更丰富版本
- **Agent 日记** — `diary_write` 工具，自动存入 wing_{agentName}/diary，跨会话持久化
- **知识图谱工具** — 6 个内置工具：kg_add_entity / kg_add_fact / kg_expire_fact / kg_query / kg_timeline / kg_stats
- **记忆宫殿工具** — 6 个内置工具：palace_status / palace_list_wings / palace_list_rooms / recall_memory / palace_add_drawer / palace_semantic_search

#### v2.0.0 — 进化引擎（融合 [Hermes Agent](https://github.com/NousResearch/hermes-agent)）

- **技能自主进化** — 5+ 工具调用后自动提取方法论保存为 SKILL.md，渐进式披露，版本管理，存储于 `~/.nmclaw/skills/`
- **上下文自动压缩** — 5 阶段压缩（裁剪旧 tool_result → 保护头尾 → 摘要中间 → 验证配对），支持 Anthropic/XML/OpenAI 三路径，600s 冷却
- **冻结快照缓存** — Session 级 system prompt 冻结，保证 Anthropic prompt cache 不失效，30 分钟 TTL + LRU 淘汰
- **跨会话搜索** — FTS5 全文检索所有 Agent 历史对话，unicode61 tokenizer，triggers 自动同步，`search_memory` 工具 + API
- **智能模型路由** — 简单消息（≤200 字符、无代码块/URL/复杂关键词）路由到便宜模型，ALL-must-pass 保守策略
- **编程式工具调用** — JS 脚本 HTTP 回调批量调工具，安全沙箱（环境变量过滤、工具白名单、5 分钟超时、50 次上限）
- **注入安全扫描** — 60+ 正则威胁模式，4 级信任矩阵（builtin → trusted → community → agent-created），技能保存前原子扫描
- **子 Agent 委派增强** — MAX_DEPTH=2 + MAX_CONCURRENT=3，聚焦 system prompt，自动阻止危险工具

所有特性默认启用，可通过 `store.json` 的 `features` 字段独立开关：

```json
{
  "features": {
    "injectionScanner": true,
    "smartRouting": true,
    "skillEvolution": true,
    "frozenPromptCache": true,
    "contextCompressor": true,
    "crossSessionSearch": true,
    "programmaticToolCalling": true,
    "enhancedDelegation": true
  }
}
```

#### v1.0.0 — 初始版本

Genesis 内核调度 + 多 Agent 生命周期 + Anthropic 原生 tool_use + SSE 流式 + 工具并发调度 + Agent 长期记忆 + DAG 工作流 + 记忆回溯 + 文件快照 + CRON 定时 + 飞书渠道 + EvoMap + ClawHub

## NMClaw vs OpenClaw 对比

NMClaw 和 [OpenClaw](https://github.com/openclaw/openclaw) 都是开源 AI 助手平台，但设计哲学完全不同：OpenClaw 是面向个人的全渠道消息助手（单 Agent + 多渠道），NMClaw 是面向团队/企业的多 Agent 编排内核（多 Agent + 智能调度）。

| 维度 | NMClaw | OpenClaw |
|------|--------|----------|
| **定位** | 多 Agent 编排平台（内核调度器） | 个人 AI 助手（全渠道收件箱） |
| **Agent 架构** | Genesis 内核 + 动态 Worker 池，按需创建/销毁/路由 | 单 Agent（Pi runtime），per-session 隔离 |
| **Agent 生命周期** | TTL + 空闲超时自动回收，热创建/编辑/停用 | 固定 Agent，session 级管理 |
| **Agent 间协作** | Genesis 自动委派 + 子 Agent 嵌套（深度控制 + 工具隔离） | sessions_send 跨 session 消息传递 |
| **模型支持** | Anthropic + OpenAI + DeepSeek，per-Agent 独立配置 | 多供应商（OpenAI/Anthropic/Google 等），OAuth + API Key |
| **智能模型路由** | ✅ 简单消息→便宜模型，复杂任务→强模型 | ❌ 手动选模型，failover 回退 |
| **工具调用协议** | Anthropic 原生 tool_use + XML 回退双路径 | Pi agent RPC + tool streaming |
| **工具并发** | ✅ 只读工具 Promise.allSettled 并行，写操作串行 | ❌ 顺序执行 |
| **编程式工具调用** | ✅ JS 脚本 HTTP 回调批量调工具（一次推理 = 10 轮工具） | ❌ |
| **DAG 工作流** | ✅ 多源聚合 + 同层并行 + 条件分支 | ❌ |
| **技能系统** | 技能注册 + 模板 + 自动绑定 Genesis + ClawHub 商店 | Skills 平台（bundled/managed/workspace） |
| **技能自主进化** | ✅ 5+ 工具调用后自动提取 SKILL.md，版本管理 | ❌ |
| **MCP 工具** | stdio / SSE + 内置 20+ 工具 + Agent 级隔离 | 内置工具（browser/canvas/nodes/cron/sessions） |
| **记忆系统** | 4 层记忆栈 + 5 类自动提取 + 宫殿结构 + 语义搜索 | Session pruning（上下文裁剪） |
| **知识图谱** | ✅ 时序实体-关系三元组，valid_from/valid_to 时间窗口 | ❌ |
| **跨会话搜索** | ✅ FTS5 全文 + TF-IDF 语义搜索 | ❌ |
| **上下文压缩** | ✅ 5 阶段自动压缩（裁剪→保护→摘要→验证） | Session compact（手动 /compact） |
| **Prompt Cache** | ✅ 冻结快照缓存 + Anthropic 自动 cache | ❌ |
| **注入安全** | ✅ 60+ 威胁模式 + 4 级信任矩阵 | DM pairing + allowlist |
| **记忆回溯** | ✅ 操作快照 + 任意版本恢复 + 文件快照 | ❌ |
| **IM 渠道** | 飞书（WebSocket + 流式卡片 + 大文件分片） | 24 个渠道（WhatsApp/Telegram/Slack/Discord/Signal/iMessage/Teams/Matrix/微信 等） |
| **语音** | ❌ | ✅ Voice Wake + Talk Mode（macOS/iOS/Android） |
| **Canvas** | ❌ | ✅ A2UI agent 驱动的可视化工作区 |
| **浏览器控制** | 无浏览器网页抓取（纯 HTTP + HTML 解析） | ✅ 专用 Chrome/Chromium CDP 控制 |
| **移动端** | ❌ | ✅ iOS + Android 原生 App |
| **桌面端** | ❌ | ✅ macOS 菜单栏 App |
| **Web 控制台** | ✅ React 19 + Tailwind 暗色主题（12 个页面） | ✅ Control UI + WebChat + Dashboard |
| **CLI** | ✅ commander + inquirer 完整管理 | ✅ openclaw CLI（gateway/agent/send/onboard/doctor） |
| **定时任务** | ✅ CRON 表达式绑定 Agent | ✅ Cron + wakeups + webhooks + Gmail Pub/Sub |
| **协作网络** | ✅ EvoMap GEP-A2A 协议（节点注册/心跳/积分） | ❌ |
| **部署** | Node.js 单进程，pnpm workspace | Node.js + launchd/systemd daemon，Docker/Nix/Tailscale |
| **沙箱** | PTC 安全沙箱（环境变量过滤 + 工具白名单） | Docker per-session 沙箱（非 main session） |
| **技术栈** | TypeScript + Hono + React 19 + better-sqlite3 | TypeScript + Gateway WS + Pi agent RPC |
| **存储** | SQLite（本地，零依赖） | 文件系统 + SQLite |
| **开源协议** | MIT | MIT |

**总结：** OpenClaw 的优势在渠道覆盖（24 个 IM）、语音交互、移动端 App、浏览器控制；NMClaw 的优势在多 Agent 编排、智能记忆系统、工具并发、技能进化、知识图谱、安全扫描。选 OpenClaw 做个人全渠道助手，选 NMClaw 做多 Agent 协作平台。

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
  executor.ts          LLM 引擎（并发工具调度 + AbortController + 结果截断 + Prompt Caching）
  genesis.ts           Genesis 内核（匹配 + 路由）
  agent-manager.ts     Agent 生命周期（创建/销毁/TTL/回收）
  mcp-runtime.ts       MCP 运行时（stdio/SSE/内置 + Agent 级隔离）
  model-registry.ts    模型 CRUD + 多供应商配置
  skill-registry.ts    技能 CRUD + 模板（新增自动绑定 Genesis）
  mcp-registry.ts      MCP 服务 CRUD（新增自动绑定 Genesis）
  skill-upload.ts      技能上传 + URL 导入
  memory.ts            Agent 长期记忆（跨会话持久化 + 自动摘要 + FTS5 全文检索 + Palace drawers）
  memory-layers.ts     4 层记忆栈（L0 身份 → L1 核心 → L2 按需 → L3 搜索）
  memory-extractor.ts  5 类记忆提取（decision/preference/milestone/problem/emotional）+ 去重
  aaak-dialect.ts      AAAK 结构化摘要方言（实体/话题/情感提取）
  knowledge-graph.ts   时序知识图谱（entities/triples/attributes + 时间窗口）
  semantic-search.ts   TF-IDF 语义搜索（中文 bigram + 余弦相似度）
  injection-scanner.ts 注入安全扫描（60+ 威胁模式 + 信任矩阵）
  smart-routing.ts     智能模型路由（简单→便宜模型，复杂→强模型）
  skill-evolution.ts   技能自主进化（自动提取 + SKILL.md + 版本管理）
  prompt-cache.ts      冻结快照缓存（session 级 system prompt 冻结）
  context-compressor.ts 上下文自动压缩（5 阶段裁剪 + 摘要）
  ptc-runtime.ts       编程式工具调用（JS 脚本 + HTTP 回调 + 安全沙箱）
  delegation.ts        子 Agent 委派增强（深度控制 + 工具隔离 + 并发管理）
  ext/
    evomap.ts          EvoMap GEP-A2A 协议（注册/心跳/积分）
    clawhub.ts         ClawHub 商店客户端
  graph.ts             DAG 工作流引擎
  cron.ts              CRON 定时调度
  tracker.ts           任务追踪（嵌套 span + 时间轴）
  snapshot.ts          记忆回溯（操作快照 + 版本恢复）
  store.ts             JSON 持久化（内存缓存 + debounce 写入合并 + 进程退出保护）
  seed.ts              首次运行默认数据 + 增量迁移
  local-mcp-scanner.ts 本地 MCP 配置自动发现
  permission.ts        用户权限 + Bypass 规则
  channels/
    feishu.ts          飞书渠道（WebSocket + 流式卡片 + 配对码 + 大文件分片上传 + 云空间授权）
web/
  src/pages/           React 前端（Chat / Dashboard / Agents / Models /
                       Skills / Mcps / Graphs / Cron / Channels / Snapshots / ClawHub / Tasks）
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
