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

### v2.0 进化特性（融合 Hermes Agent）

| 特性 | 说明 |
|------|------|
| **技能自主进化** | Agent 完成复杂任务（5+ 工具调用）后，自动提取方法论保存为 `SKILL.md`。下次遇到类似任务直接加载技能，发现过时自动修补。渐进式披露：索引注入 system prompt，完整内容按需加载。存储于 `~/.nmclaw/skills/` |
| **上下文自动压缩** | token 超阈值（~20K tokens）时自动触发 5 阶段压缩：裁剪旧 tool_result → 保护头部消息 → 找尾部边界 → 确定性摘要中间轮次 → 验证 tool_call/tool_result 配对完整性。支持 Anthropic 原生格式 / XML / OpenAI 三条路径。600 秒冷却防止频繁压缩 |
| **冻结快照缓存** | Session 级 system prompt 冻结。Memory / Skill 写入只更新磁盘，不更新当前 session 的 system prompt，保证整个会话的 Anthropic prompt cache 不失效。30 分钟 TTL，LRU 淘汰 |
| **跨会话搜索** | FTS5 全文检索所有 Agent 的历史对话。unicode61 tokenizer 支持中英文混合搜索。通过 triggers 自动同步索引。内置 `search_memory` 工具 + `GET /api/memory/search` API |
| **智能模型路由** | 简单消息（≤200 字符、无代码块、无 URL、无复杂关键词）自动路由到便宜模型，复杂任务保持主模型。保守策略：ALL-must-pass，任何判断失败回退主模型。支持中英文复杂关键词检测 |
| **编程式工具调用** | LLM 写一段 JS 脚本通过 HTTP 回调批量调用工具，中间结果不进入上下文。一次推理完成原本需要 10 轮的工作。安全沙箱：过滤 API Key 环境变量、工具白名单、5 分钟超时、50 次调用上限、50KB 输出上限 |
| **注入安全扫描** | 60+ 正则威胁模式，覆盖 prompt injection / 数据外泄 / 破坏性命令 / 持久化 / 混淆 / 凭证暴露 / 零宽 Unicode。信任矩阵：builtin 全放行 → trusted 仅阻止 critical → community 阻止 critical+high → agent-created 阻止 critical+high+medium。技能保存前自动扫描，危险内容原子回滚 |
| **子 Agent 委派增强** | 隔离的子 Agent 实例，独立工具集和迭代预算。MAX_DEPTH=2 防止无限递归，MAX_CONCURRENT=3 并发控制。子 Agent 使用聚焦 system prompt（仅目标+上下文），自动阻止危险工具（dispatch_to_agent / destroy_agent / execute_script 等） |

所有进化特性默认启用，可通过 `store.json` 的 `features` 字段独立开关：

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

### v2.1 记忆宫殿（融合 MemPalace）

| 特性 | 说明 |
|------|------|
| **4 层记忆栈** | L0 身份（~100 tokens）→ L1 核心故事（~800）→ L2 按需加载（工具触发）→ L3 深度语义搜索。唤醒成本 ~600-900 tokens，95%+ 上下文留给任务。自动替代原始 loadMemoryContext()，drawers 为空时无缝回退 |
| **时序知识图谱** | SQLite 实体-关系三元组，带 valid_from/valid_to 时间窗口。支持实体添加、关系建立、事实过期（不删除保留历史）、时间线查询。与 Zep 的 Neo4j 方案等价，但完全本地免费 |
| **5 类记忆提取** | 每轮对话自动提取 DECISIONS / PREFERENCES / MILESTONES / PROBLEMS / EMOTIONAL 五类记忆。纯正则分类器（60+ 中英文标记），情感消歧（已解决的问题 → 里程碑），代码行自动过滤 |
| **AAAK 结构化摘要** | 从文本提取实体（人/项目/工具/概念/地点）、话题（TF 频率 top-5）、关键句、情感标签（30+ 情感 + 中英文信号词）。压缩为符号格式：`E:Riley/person T:memory,search EM:excite/3` |
| **宫殿结构** | Wing（领域）→ Room（话题）→ Drawer（记忆条目）。自动分类：技术内容 → technical，个人情感 → personal，其他 → wing_{agentName}。按 importance 排序，访问计数衰减 |
| **TF-IDF 语义搜索** | 零外部依赖的语义搜索。中文 bigram + 英文空格分词 → TF-IDF 向量化 → 余弦相似度。IDF 缓存 120 秒，>1000 条时先 FTS5 粗筛再精排 |
| **近似去重** | 保存记忆前 Jaccard 相似度检查（阈值 0.85），防止重复挖掘。同 wing 内去重，保留更长/更丰富版本 |
| **Agent 日记** | Agent 可写个人日记（diary_write 工具），自动存入 wing_{agentName}/diary。观察、想法、工作记录，跨会话持久化 |
| **知识图谱工具** | 6 个内置工具：kg_add_entity / kg_add_fact / kg_expire_fact / kg_query / kg_timeline / kg_stats。Agent 可主动构建和查询知识图谱 |
| **记忆宫殿工具** | 6 个内置工具：palace_status / palace_list_wings / palace_list_rooms / recall_memory / palace_add_drawer / palace_semantic_search |

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
