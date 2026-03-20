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
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'http://localhost:8991',
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

  // ─── Agents ───

  const genesisAgent: AgentConfig = {
    id: 'genesis',
    name: '创世 Agent',
    description: '平台内核，负责调度和路由用户请求到合适的 Worker Agent',
    modelId: anthropicModel.id,
    skillIds: [],
    mcpIds: [timeMcp.id, weatherMcp.id, filesystemMcp.id],
    systemPrompt: [
      '你是 NMClaw 平台的创世 Agent（Genesis Agent），你是平台的内核和调度中心。',
      '你的职责：',
      '1. 理解用户的请求意图',
      '2. 当没有合适的 Worker Agent 时，你直接回答用户',
      '3. 你拥有时间、天气、文件系统工具，需要时请主动调用',
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
    s.mcps.push(timeMcp, weatherMcp, filesystemMcp)
    s.agents.push(genesisAgent, timeAgent, weatherAgent)
  })

  console.log('✓ 已初始化默认配置（2 模型 + 3 MCP + 3 Agent）')
}
