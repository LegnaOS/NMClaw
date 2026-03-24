// ============================================================
// NMClaw — Core Type Definitions
// ============================================================

// --- Model Library ---

export type CostTier = 'high' | 'medium' | 'low' | 'free'

export interface ModelConfig {
  id: string
  name: string
  provider: string // anthropic, openai, deepseek, ollama, etc.
  capabilities: string[]
  costTier: CostTier
  enabled?: boolean  // 全局启用/禁用，默认 true
  config: {
    apiKey?: string    // 直接填写 API Key（优先级高于 apiKeyEnv）
    apiKeyEnv?: string // env var name, e.g. "ANTHROPIC_API_KEY"
    baseUrl?: string
    defaultParams?: Record<string, unknown>
  }
  createdAt: number
}

// --- Skill Library ---

export interface SkillConfig {
  id: string
  name: string
  description: string
  promptTemplate: string
  requiredMcps: string[]
  compatibleModels: string[] // ['*'] = all
  inputSchema?: Record<string, unknown>
  enabled?: boolean  // 全局启用/禁用，默认 true
  createdAt: number
}

// --- MCP Library ---

export type McpTransport = 'stdio' | 'sse' | 'streamable-http' | 'builtin'

export interface McpConfig {
  id: string
  name: string
  description: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  enabled?: boolean  // 全局启用/禁用，默认 true
  createdAt: number
}

// --- Agent ---

export type AgentState = 'active' | 'idle' | 'pending_destroy' | 'destroyed'

export interface AgentConfig {
  id: string
  name: string
  description: string
  modelId: string
  skillIds: string[]
  mcpIds: string[]
  systemPrompt: string
  lifecycle: {
    ttl: number        // ms, default 7 days
    idleTimeout: number // ms, default 24h
    autoRenew: boolean
  }
  state: AgentState
  enabled?: boolean  // 全局启用/禁用，默认 true
  createdAt: number
  lastActiveAt: number
}

// --- Task ---

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface Task {
  id: string
  agentId: string
  prompt: string
  status: TaskStatus
  output?: string
  error?: string
  tokensUsed?: number
  createdAt: number
  completedAt?: number
}

// --- Trace ---

export interface TraceSpan {
  spanId: string
  taskId: string
  parentSpanId?: string
  agentId: string
  action: string
  type?: 'llm' | 'tool' | 'chain' | 'dispatch'
  name?: string
  input?: string
  output?: string
  tokensUsed?: number
  durationMs: number
  timestamp: number
  status?: 'success' | 'error'
}

// --- Bypass ---

export interface BypassConfig {
  enabled: boolean
  rules: {
    autoCreateMaxCostTier?: CostTier
    autoDestroyIdleHours?: number
    autoDispatchReadOnly?: boolean
  }
  neverBypass: string[]
}

// --- EvoMap ---

export interface EvoMapState {
  nodeId: string           // your_node_id from /a2a/hello
  nodeSecret: string       // Bearer token for all mutating endpoints
  hubNodeId: string        // Hub's identity (never use as sender_id)
  claimCode: string        // e.g. "REEF-4X7K"
  claimUrl: string         // e.g. "https://evomap.ai/claim/REEF-4X7K"
  creditBalance: number
  heartbeatIntervalMs: number  // default 900000 (15 min)
  registeredAt: number
  lastHeartbeatAt: number
}

// --- Store ---

export interface SnapshotConfig {
  enabled: boolean       // false = 不备份
  maxVersions: number    // 保留版本数，3-200，默认 10
}

export interface StoreData {
  models: ModelConfig[]
  skills: SkillConfig[]
  mcps: McpConfig[]
  agents: AgentConfig[]
  tasks: Task[]
  traces: TraceSpan[]
  bypass: BypassConfig
  graphs: GraphConfig[]
  channels: ChannelConfig[]
  pairings: PairingRecord[]
  evomap?: EvoMapState
  snapshot?: SnapshotConfig
}

// --- LLM Adapter ---

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResponse {
  content: string
  tokensUsed: number
}

// --- Agent Graph ---

export interface GraphNode {
  id: string
  type?: 'agent' | 'code'  // default 'agent' for backward compat
  agentId?: string          // required for type='agent'
  label: string
  code?: string             // JS code body for type='code'; input variable is upstream output, must return
}

export interface GraphEdge {
  id: string
  from: string
  to: string
  condition?: string   // simple keyword match on previous output
  dataMapping?: Record<string, string>
}

export interface GraphConfig {
  id: string
  name: string
  description: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  createdAt: number
}

export interface GraphExecutionEvent {
  type: 'node_start' | 'node_complete' | 'node_error' | 'graph_complete'
  nodeId?: string
  nodeLabel?: string
  agentId?: string
  output?: string
  error?: string
  tokensUsed?: number
}

// --- Permission ---

export type PermissionAction =
  | 'agent:create'
  | 'agent:destroy'
  | 'agent:modify'
  | 'model:add'
  | 'model:remove'
  | 'skill:add'
  | 'skill:remove'
  | 'mcp:add'
  | 'mcp:remove'
  | 'task:dispatch'

// --- Channel (IM Bot Integration) ---

export type ChannelType = 'feishu' | 'wecom' | 'dingtalk'

export interface ChannelConfig {
  id: string
  name: string
  type: ChannelType
  enabled: boolean
  agentId: string          // which agent handles messages from this channel
  config: FeishuChannelConfig | Record<string, unknown>
  createdAt: number
}

export interface FeishuChannelConfig {
  mode: 'websocket' | 'webhook'
  // WebSocket mode (推荐): 通过飞书 SDK 长连接收发消息，无需公网 URL
  appId?: string
  appSecret?: string
  domain?: 'feishu' | 'lark'   // feishu=国内, lark=国际版
  streaming?: boolean           // 流式卡片回复 (default true)
  // Access control
  requireMention?: boolean      // 群聊中是否需要 @机器人 才回复 (default false)
  groupPolicy?: 'open' | 'allowlist'  // open=所有人可用, allowlist=仅白名单用户
  allowedUsers?: string[]       // 白名单用户 open_id 列表
  // Drive (云空间) — 大文件分片上传目标文件夹
  driveFolderToken?: string        // 云空间文件夹 token，大文件上传到此处
  // Webhook mode: 仅发送
  webhookUrl?: string
  webhookSecret?: string
  // Legacy fields (backward compat)
  encryptKey?: string
  verificationToken?: string
}

// --- Channel Pairing (Access Control) ---

export interface PairingRecord {
  code: string            // 6-digit pairing code
  channelId: string
  userId: string          // feishu open_id
  userName?: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
  approvedAt?: number
}

// --- Constants ---

export const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000       // 7 days
export const DEFAULT_IDLE_TIMEOUT = 24 * 60 * 60 * 1000   // 24 hours
