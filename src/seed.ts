import { nanoid } from 'nanoid'
import { loadStore, updateStore } from './store.js'
import { DEFAULT_TTL, DEFAULT_IDLE_TIMEOUT } from './types.js'
import type { ModelConfig, AgentConfig, McpConfig } from './types.js'

export function seedDefaults(): void {
  const store = loadStore()
  if (store.agents.some((a) => a.id === 'genesis')) return

  const now = Date.now()

  // ─── Models ───

  const anthropicModel: ModelConfig = {
    id: nanoid(12),
    name: 'Claude-Opus-4-6-Agentic',
    provider: 'anthropic',
    capabilities: ['chat', 'reasoning', 'code', 'tool_use'],
    costTier: 'high',
    config: {
      apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN',
      baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
    },
    createdAt: now,
  }

  const deepseekModel: ModelConfig = {
    id: nanoid(12),
    name: 'deepseek-chat',
    provider: 'deepseek',
    capabilities: ['chat', 'reasoning', 'code', 'tool_use'],
    costTier: 'low',
    config: {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseUrl: 'https://api.deepseek.com/v1',
    },
    createdAt: now,
  }

  // ─── Built-in MCPs ───

  const timeMcp: McpConfig = {
    id: nanoid(12),
    name: 'time',
    description: '获取当前时间、日期、星期、时区信息',
    transport: 'builtin',
    createdAt: now,
  }

  const weatherMcp: McpConfig = {
    id: nanoid(12),
    name: 'weather',
    description: '查询全球城市实时天气（温度、湿度、风速等）',
    transport: 'builtin',
    createdAt: now,
  }

  const filesystemMcp: McpConfig = {
    id: nanoid(12),
    name: 'filesystem',
    description: '读写本地文件系统（读取文件、列出目录、写入文件）',
    transport: 'builtin',
    createdAt: now,
  }

  const shellMcp: McpConfig = {
    id: 'shell_builtin',
    name: 'shell',
    description: '执行系统 shell 命令（zsh/macOS），可用于系统控制、安装软件、运行脚本等。注意：macOS 的 grep 不支持 -P 选项，请用 grep -E 代替',
    transport: 'builtin',
    createdAt: now,
  }

  const platformMcp: McpConfig = {
    id: 'platform_builtin',
    name: 'platform',
    description: '平台管理工具：创建/修改/销毁 Agent，查看模型/技能/MCP，管理定时任务',
    transport: 'builtin',
    createdAt: now,
  }

  const webMcp: McpConfig = {
    id: 'web_builtin',
    name: 'web',
    description: '互联网搜索与网页抓取：web_search（DuckDuckGo 搜索）、fetch_url（轻量抓取）、scrape_page（增强型智能抓取）',
    transport: 'builtin',
    createdAt: now,
  }

  // ─── Agents ───

  const genesisAgent: AgentConfig = {
    id: 'genesis',
    name: '创世 Agent',
    description: '平台内核，负责调度和路由用户请求到合适的 Worker Agent',
    modelId: anthropicModel.id,
    skillIds: [],
    mcpIds: [timeMcp.id, weatherMcp.id, filesystemMcp.id, shellMcp.id, platformMcp.id, webMcp.id],
    systemPrompt: GENESIS_SYSTEM_PROMPT,
    lifecycle: { ttl: DEFAULT_TTL * 100, idleTimeout: DEFAULT_IDLE_TIMEOUT * 100, autoRenew: true },
    state: 'active',
    createdAt: now,
    lastActiveAt: now,
  }

  const timeAgent: AgentConfig = {
    id: nanoid(12),
    name: '时间助手',
    description: '回答时间、日期、时区、日历相关问题',
    modelId: deepseekModel.id,
    skillIds: [],
    mcpIds: [timeMcp.id],
    systemPrompt: [
      '你是一个时间助手，专门回答关于时间、日期、时区、日历、倒计时等相关问题。',
      '你拥有 get_current_time 工具，可以获取任意时区的当前时间。请主动使用工具获取准确时间，不要猜测。',
      '请用中文回答。',
    ].join('\n'),
    lifecycle: { ttl: DEFAULT_TTL, idleTimeout: DEFAULT_IDLE_TIMEOUT, autoRenew: false },
    state: 'active',
    createdAt: now,
    lastActiveAt: now,
  }

  const weatherAgent: AgentConfig = {
    id: nanoid(12),
    name: '天气助手',
    description: '回答天气、气候、气象相关问题',
    modelId: anthropicModel.id,
    skillIds: [],
    mcpIds: [weatherMcp.id],
    systemPrompt: [
      '你是一个天气助手，专门回答关于天气预报、气候变化、气象知识等相关问题。',
      '你拥有 get_weather 工具，可以查询全球城市的实时天气。请主动使用工具获取准确天气数据，不要猜测。',
      '城市名称请使用英文，如 Beijing, Shanghai, Tokyo, London。',
      '请用中文回答。',
    ].join('\n'),
    lifecycle: { ttl: DEFAULT_TTL, idleTimeout: DEFAULT_IDLE_TIMEOUT, autoRenew: false },
    state: 'active',
    createdAt: now,
    lastActiveAt: now,
  }

  updateStore((s) => {
    s.models.push(anthropicModel, deepseekModel)
    s.mcps.push(timeMcp, weatherMcp, filesystemMcp, shellMcp, platformMcp, webMcp)
    s.agents.push(genesisAgent, timeAgent, weatherAgent)
  })

  console.log('✓ 已初始化默认配置（2 模型 + 6 MCP + 3 Agent）')
}

// ─── Genesis 系统提示词（单一来源） ───
const GENESIS_SYSTEM_PROMPT_VERSION = 7 // bump this to force update on existing installs
const GENESIS_SYSTEM_PROMPT = [
  '你是 NMClaw 平台的内核调度器（Genesis Agent）。你不执行任务，你调度任务。',
  '',
  '═══ 核心决策流程 ═══',
  '',
  '收到用户请求时，严格按以下顺序判断：',
  '',
  '第一步：检查现有 Worker 是否匹配',
  '- 你已经知道有哪些 Worker（不需要每次 list_agents），根据请求关键词匹配 Worker 的 description',
  '- ⚠️ 匹配必须准确：问天气 → 天气助手 ✅ | 问网站分析 → 时间助手 ❌',
  '- 判断标准：请求的核心意图是否落在该 Worker 的 description 描述的能力范围内',
  '- 如果匹配到，直接 dispatch_to_agent 委派，不说废话',
  '',
  '第二步：没有合适 Worker → 向用户提议创建',
  '- 不要静默创建！你必须先向用户展示创建方案并等待确认。',
  '- 输出格式（严格遵守）：',
  '',
  '  📋 **需要创建新 Worker**',
  '  | 项目 | 内容 |',
  '  |------|------|',
  '  | 👤 名称 | {角色名，如"网页分析师"} |',
  '  | 💡 原因 | {为什么现有 Worker 无法处理，一句话} |',
  '  | 🔧 能力 | {会绑定哪些工具，如 web 搜索/抓取} |',
  '  | ⏳ 生命周期 | {建议：长期保留 / 用完即删 / 保留N天} |',
  '  ',
  '  是否创建？请回复 **确认** 或 **取消**。',
  '',
  '- 只有在用户明确同意后（回复确认/好的/可以/创建/yes 等肯定词），才执行 create_agent + dispatch_to_agent',
  '- 用户拒绝则不创建，告知已取消',
  '',
  '第三步：平台管理类请求 → 也需要用户确认',
  '- 涉及 创建/修改/销毁 Agent、管理定时任务 等资源变更操作',
  '- 查看/列出类操作（list_agents, list_models 等只读操作）可以直接执行',
  '- 变更操作必须先告知用户要做什么，等用户确认后再执行',
  '- 输出格式：',
  '',
  '  ⚠️ **需要执行以下操作**',
  '  - 操作：{具体操作，如"销毁 Worker: 网页分析师"}',
  '  - 影响：{会发生什么，如"该 Worker 的对话历史将被清除"}',
  '  ',
  '  是否执行？请回复 **确认** 或 **取消**。',
  '',
  '═══ 绝对禁止 ═══',
  '- 禁止把请求硬塞给不相关的 Worker。宁可提议创建新 Worker，也不要让时间助手去分析网站。',
  '- 禁止未经用户确认就创建、修改或销毁任何 Agent/Worker。',
  '- 禁止未经用户确认就创建或删除定时任务。',
  '- 禁止对 Worker 的回复做总结、包装或评论。Worker 的回复就是最终回复。',
  '- 禁止未经用户确认就恢复快照（记忆回溯）。',
  '',
  '═══ 记忆回溯 ═══',
  '',
  '你拥有操作回溯能力。平台每次资源变更（创建/修改/删除 Agent、模型、技能、MCP 等）都会自动拍快照。',
  '- 用户说"撤销"、"回退"、"恢复到之前"时，先用 list_snapshots 查看最近的快照',
  '- 用 diff_snapshot 对比差异，向用户展示会恢复什么',
  '- 必须经用户确认后才能执行 restore_snapshot',
  '- 恢复操作本身也会被记录，所以恢复后还可以再次回溯',
  '',
  '═══ 进化能力 ═══',
  '',
  '你拥有技能自动进化能力：',
  '- 使用 list_evolved_skills 查看已学习的技能',
  '- 使用 view_evolved_skill 查看技能详情',
  '- 使用 search_memory 搜索历史对话记录',
  '- 使用 execute_script 编写 JS 脚本批量调用工具',
  '- 复杂任务完成后，系统会自动提取方法论保存为可复用技能',
  '',
  '请用中文回答。',
].join('\n')

// ─── Builtin MCP 声明式注册表 ───
// 新增 builtin MCP 只需要在这里加一行，migrateBuiltins 会自动补到 store 和 Genesis
const BUILTIN_MCP_REGISTRY: { id: string; name: string; description: string }[] = [
  { id: 'shell_builtin', name: 'shell', description: '执行系统 shell 命令（zsh/macOS），可用于系统控制、安装软件、运行脚本等' },
  { id: 'platform_builtin', name: 'platform', description: '平台管理工具：创建/修改/销毁 Agent，查看模型/技能/MCP，管理定时任务' },
  { id: 'web_builtin', name: 'web', description: '互联网搜索与网页抓取：web_search（DuckDuckGo 搜索）、fetch_url（轻量抓取）、scrape_page（增强型智能抓取）' },
  { id: 'evomap_builtin', name: 'evomap', description: 'EvoMap 协作进化网络：evomap_register（注册节点并获取绑定链接）、evomap_status（查看节点状态和积分）' },
  { id: 'njggzy_builtin', name: 'njggzy', description: '南京公共资源交易信息：抓取招标/中标公告、解析详情、关键词查询、招标-中标关联匹配' },
  { id: 'snapshot_builtin', name: 'snapshot', description: '记忆回溯：列出操作快照、恢复到历史版本、对比差异。每次资源变更自动拍快照，最多保留 200 条' },
  // F1: 技能自动进化
  { id: 'evolution_builtin', name: 'evolution', description: '技能自动进化：列出/查看/创建/删除自动学习的技能。Agent 完成复杂任务后自动提取方法论' },
  // F6: 编程式工具调用
  { id: 'ptc_builtin', name: 'ptc', description: '编程式工具调用：执行 JavaScript 脚本批量调用工具，一次推理完成多步工作' },
  // MemPalace: 记忆宫殿 + 日记 + 知识图谱
  { id: 'palace_builtin', name: 'palace', description: '记忆宫殿：分层记忆管理、语义搜索、Agent 日记、时序知识图谱' },
  // Browser Control: Playwright 浏览器自动化
  { id: 'browser_builtin', name: 'browser', description: '浏览器控制：导航、截图、点击、输入、页面快照、标签页管理、PDF 导出' },
]

/**
 * 增量迁移：检测缺失的 builtin MCP，补充到 store 和 Genesis 的 mcpIds。
 * 每次启动都会执行，幂等操作。
 */
export function migrateBuiltins(): void {
  const store = loadStore()
  const genesis = store.agents.find((a) => a.id === 'genesis')
  if (!genesis) return // 还没初始化过，seedDefaults 会处理

  let changed = false
  const now = Date.now()

  for (const def of BUILTIN_MCP_REGISTRY) {
    // 1. store 里没有这个 MCP → 补上
    const existing = store.mcps.find((m) => m.id === def.id || (m.transport === 'builtin' && m.name === def.name))
    const mcpId = existing?.id ?? def.id

    if (!existing) {
      store.mcps.push({
        id: def.id,
        name: def.name,
        description: def.description,
        transport: 'builtin',
        createdAt: now,
      })
      changed = true
      console.log(`✓ 迁移: 补充 builtin MCP "${def.name}"`)
    }

    // 2. Genesis 的 mcpIds 里没有 → 补上
    if (!genesis.mcpIds.includes(mcpId)) {
      genesis.mcpIds.push(mcpId)
      changed = true
      console.log(`✓ 迁移: 绑定 "${def.name}" 到 Genesis Agent`)
    }
  }

  // 3. Genesis 系统提示词版本检查 → 升级
  if (genesis.systemPrompt !== GENESIS_SYSTEM_PROMPT) {
    genesis.systemPrompt = GENESIS_SYSTEM_PROMPT
    changed = true
    console.log(`✓ 迁移: 更新 Genesis 系统提示词 (v${GENESIS_SYSTEM_PROMPT_VERSION})`)
  }

  if (changed) {
    updateStore((s) => {
      s.mcps = store.mcps
      const g = s.agents.find((a) => a.id === 'genesis')
      if (g) {
        g.mcpIds = genesis.mcpIds
        g.systemPrompt = genesis.systemPrompt
      }
    })
  }
}
