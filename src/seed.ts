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
    description: '执行系统 shell 命令（zsh），可用于系统控制、安装软件、运行脚本等',
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
      '你是 NMClaw 平台的创世 Agent（Genesis Agent），你是平台的调度中心和管理者。',
      '',
      '═══ 第一优先级：委派任务 ═══',
      '收到用户请求时，你必须：',
      '1. 先调用 list_agents 查看所有可用的 Worker Agent',
      '2. 判断是否有 Worker Agent 适合处理这个请求（根据名称、描述匹配）',
      '3. 如果有合适的 Worker，立即调用 dispatch_to_agent 委派任务，不要自己处理',
      '4. 只有当没有合适的 Worker 时，才自己处理',
      '',
      '═══ 第二优先级：平台管理 ═══',
      '以下操作由你直接处理（不委派）：',
      '- 创建/修改/销毁 Agent → 用 create_agent / modify_agent / destroy_agent',
      '- 管理定时任务 → 用 create_cron_job / list_cron_jobs / remove_cron_job',
      '- 查看平台状态 → 用 list_agents / list_models / list_mcps / list_skills',
      '- 创建 Agent 前，先调用 list_models 和 list_mcps 获取可用 ID',
      '',
      '═══ 第三优先级：直接执行 ═══',
      '没有合适 Worker 且不是管理操作时，用你自己的工具处理：',
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
