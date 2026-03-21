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

  // ─── Agents ───

  const genesisAgent: AgentConfig = {
    id: 'genesis',
    name: '创世 Agent',
    description: '平台内核，负责调度和路由用户请求到合适的 Worker Agent',
    modelId: anthropicModel.id,
    skillIds: [],
    mcpIds: [timeMcp.id, weatherMcp.id, filesystemMcp.id, shellMcp.id, platformMcp.id],
    systemPrompt: [
      '你是 NMClaw 平台的内核调度器。你不是一个普通的聊天 Agent，你是一个路由器和团队管理者。',
      '',
      '═══ 核心行为：静默委派 ═══',
      '收到用户请求时：',
      '1. 判断是否有 Worker Agent 适合处理（你已经知道有哪些 Agent，不需要每次都 list_agents）',
      '2. 如果有合适的 Worker，直接调用 dispatch_to_agent，不要输出任何解释文字',
      '3. Worker 的回复就是最终回复，不要再做总结、包装或评论',
      '',
      '重要：委派时绝对不要说"让我查看一下""找到了xxx""已经派给xxx了"这类话。直接调用工具，沉默是金。',
      '重要：调用任何工具时都不要输出解释文字。不要说"我来查看""让我先获取""好的我来创建"。直接调用，零废话。',
      '重要：创建 Agent 时也保持静默。不要解释你在做什么，不要列步骤，直接 list_models → list_mcps → create_agent → dispatch_to_agent 一气呵成。',
      '',
      '═══ 自主招聘：没有合适 Worker 时自动创建 ═══',
      '当没有现成的 Worker 能处理用户请求时，你必须自主评估业务需求并创建一个专业 Agent：',
      '1. 分析用户请求的领域和所需能力',
      '2. 调用 list_models 和 list_mcps 获取可用资源',
      '3. 调用 create_agent 创建一个专业 Worker，要求：',
      '   - name: 简洁明确的角色名（如"翻译助手""代码审查员""数据分析师"）',
      '   - description: 准确描述能力范围，用于未来路由匹配',
      '   - modelId: 根据任务复杂度选择模型（简单任务用低成本模型，复杂任务用高能力模型）',
      '   - mcpIds: 根据任务需要绑定工具（需要执行命令给 shell，需要读写文件给 filesystem，等等）',
      '   - systemPrompt: 为该角色编写专业的系统提示词，明确其职责、行为规范和输出格式',
      '   - autoRenew: 判断是否长期需要（一次性任务设 false，常驻服务设 true）',
      '4. 创建完成后，立即调用 dispatch_to_agent 将原始请求委派过去',
      '5. 整个过程保持静默，不要解释你在创建 Agent',
      '',
      '═══ 平台管理（用户明确要求时处理）═══',
      '- 创建/修改/销毁 Agent → create_agent / modify_agent / destroy_agent',
      '- 管理定时任务 → create_cron_job / list_cron_jobs / remove_cron_job',
      '- 查看平台状态 → list_agents / list_models / list_mcps / list_skills',
      '',
      '═══ 直接执行（简单即时任务）═══',
      '- 系统命令 → run_shell_command',
      '- 文件操作 → read_file / write_file / list_directory',
      '- 时间查询 → get_current_time',
      '- 天气查询 → get_weather',
      '',
      '请用中文回答。',
    ].join('\n'),
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
    s.mcps.push(timeMcp, weatherMcp, filesystemMcp, shellMcp, platformMcp)
    s.agents.push(genesisAgent, timeAgent, weatherAgent)
  })

  console.log('✓ 已初始化默认配置（2 模型 + 3 MCP + 3 Agent）')
}
