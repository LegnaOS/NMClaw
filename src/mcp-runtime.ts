import { spawn, type ChildProcess } from 'node:child_process'
import { getMcp, listMcps } from './mcp-registry.js'
import { listModels } from './model-registry.js'
import { listSkills } from './skill-registry.js'
import { createAgent, listAgents, destroyAgent, modifyAgent } from './agent-manager.js'
import { addCronJob, listCronJobs, removeCronJob } from './cron.js'
import type { McpConfig } from './types.js'

// ─── Types ───

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mcpId: string
}

export interface ToolResult {
  content: string
  isError?: boolean
}

// ─── Built-in tool handlers ───

async function builtinTime(_name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const tz = (input.timezone as string) || 'Asia/Shanghai'
  try {
    const now = new Date()
    const formatted = now.toLocaleString('zh-CN', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' })
    const weekday = now.toLocaleDateString('zh-CN', { timeZone: tz, weekday: 'long' })
    return {
      content: JSON.stringify({ timezone: tz, formatted, weekday, iso: now.toISOString(), timestamp: now.getTime() }),
    }
  } catch (e) {
    return { content: `时区错误: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}

async function builtinWeather(_name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const city = (input.city as string) || 'Beijing'
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
      headers: { 'User-Agent': 'nmclaw/0.1' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return { content: `天气查询失败: HTTP ${res.status}`, isError: true }
    const raw = (await res.json()) as any
    const data = raw.data ?? raw
    const cur = data.current_condition?.[0]
    if (!cur) return { content: '无法获取天气数据', isError: true }
    return {
      content: JSON.stringify({
        city,
        temperature: `${cur.temp_C}°C`,
        feelsLike: `${cur.FeelsLikeC}°C`,
        humidity: `${cur.humidity}%`,
        description: cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '',
        windSpeed: `${cur.windspeedKmph} km/h`,
        windDir: cur.winddir16Point,
        visibility: `${cur.visibility} km`,
        uvIndex: cur.uvIndex,
      }),
    }
  } catch (e) {
    return { content: `天气查询错误: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}

async function builtinFilesystem(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const { readFileSync, readdirSync, statSync, writeFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  try {
    if (name === 'read_file') {
      const p = resolve(input.path as string)
      const content = readFileSync(p, 'utf-8')
      return { content: content.length > 10000 ? content.slice(0, 10000) + '\n...[truncated]' : content }
    }
    if (name === 'list_directory') {
      const p = resolve(input.path as string)
      const entries = readdirSync(p, { withFileTypes: true })
      const list = entries.map((e) => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`)
      return { content: list.join('\n') }
    }
    if (name === 'write_file') {
      const p = resolve(input.path as string)
      writeFileSync(p, input.content as string, 'utf-8')
      return { content: `已写入: ${p}` }
    }
    if (name === 'get_file_info') {
      const p = resolve(input.path as string)
      const s = statSync(p)
      return {
        content: JSON.stringify({
          path: p, size: s.size, isDirectory: s.isDirectory(),
          modified: s.mtime.toISOString(), created: s.birthtime.toISOString(),
        }),
      }
    }
    return { content: `未知文件操作: ${name}`, isError: true }
  } catch (e) {
    return { content: `文件操作错误: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}

async function builtinShell(_name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const { execSync } = await import('node:child_process')
  const command = input.command as string
  if (!command) return { content: '缺少 command 参数', isError: true }
  const timeout = (input.timeout as number) || 30000
  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 1024 * 1024,
      shell: '/bin/zsh',
    })
    return { content: output || '(命令执行成功，无输出)' }
  } catch (e: any) {
    const stderr = e.stderr?.toString() || ''
    const stdout = e.stdout?.toString() || ''
    return { content: `退出码: ${e.status ?? 'unknown'}\nstdout: ${stdout}\nstderr: ${stderr}`.trim(), isError: true }
  }
}

async function builtinPlatform(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    if (name === 'dispatch_to_agent') {
      const agentId = input.agentId as string
      const prompt = input.prompt as string
      if (!agentId || !prompt) return { content: '缺少 agentId 或 prompt', isError: true }
      const agent = listAgents().find(a => a.id === agentId)
      if (!agent) return { content: `Agent ${agentId} 不存在`, isError: true }
      // Dynamic import to avoid circular dependency
      const { streamTask } = await import('./executor.js')
      let output = ''
      for await (const chunk of streamTask(agentId, [{ role: 'user' as const, content: prompt }])) {
        // Skip internal markers
        if (chunk.startsWith('[TOOL_CALL:') || chunk.startsWith('[TOOL_RESULT:') ||
            chunk.startsWith('[STREAM_META:') || chunk.startsWith('[FILE_OUTPUT:') ||
            chunk.startsWith('[AGENT_INFO:')) continue
        output += chunk
      }
      output = output.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
      return { content: `[${agent.name} 的回复]\n\n${output || '(无回复)'}` }
    }
    if (name === 'list_agents') {
      const agents = listAgents().map(a => ({ id: a.id, name: a.name, description: a.description, state: a.state, modelId: a.modelId }))
      return { content: JSON.stringify(agents, null, 2) }
    }
    if (name === 'list_models') {
      const models = listModels().map(m => ({ id: m.id, name: m.name, provider: m.provider, capabilities: m.capabilities }))
      return { content: JSON.stringify(models, null, 2) }
    }
    if (name === 'list_skills') {
      const skills = listSkills().map(s => ({ id: s.id, name: s.name, description: s.description }))
      return { content: JSON.stringify(skills, null, 2) }
    }
    if (name === 'list_mcps') {
      const mcps = listMcps().map(m => ({ id: m.id, name: m.name, description: m.description, transport: m.transport }))
      return { content: JSON.stringify(mcps, null, 2) }
    }
    if (name === 'create_agent') {
      const agent = createAgent({
        name: input.name as string,
        description: input.description as string || '',
        modelId: input.modelId as string,
        skillIds: (input.skillIds as string[]) ?? [],
        mcpIds: (input.mcpIds as string[]) ?? [],
        systemPrompt: (input.systemPrompt as string) ?? '',
        ttl: input.ttl as number | undefined,
        idleTimeout: input.idleTimeout as number | undefined,
        autoRenew: input.autoRenew as boolean | undefined,
      })
      return { content: `Agent 创建成功:\n${JSON.stringify(agent, null, 2)}` }
    }
    if (name === 'modify_agent') {
      const id = input.agentId as string
      const { agentId: _, ...patch } = input as any
      const ok = modifyAgent(id, patch)
      return ok ? { content: `Agent ${id} 已更新` } : { content: `Agent ${id} 不存在`, isError: true }
    }
    if (name === 'destroy_agent') {
      const ok = destroyAgent(input.agentId as string)
      return ok ? { content: `Agent ${input.agentId} 已销毁` } : { content: `Agent ${input.agentId} 不存在`, isError: true }
    }
    if (name === 'create_cron_job') {
      const job = addCronJob({
        schedule: input.cron as string,
        agentId: input.agentId as string,
        prompt: input.prompt as string,
        name: (input.name as string) || '',
        enabled: true,
      })
      return { content: `定时任务创建成功:\n${JSON.stringify(job, null, 2)}` }
    }
    if (name === 'list_cron_jobs') {
      return { content: JSON.stringify(listCronJobs(), null, 2) }
    }
    if (name === 'remove_cron_job') {
      const ok = removeCronJob(input.jobId as string)
      return ok ? { content: `定时任务 ${input.jobId} 已删除` } : { content: `定时任务 ${input.jobId} 不存在`, isError: true }
    }
    return { content: `未知平台操作: ${name}`, isError: true }
  } catch (e) {
    return { content: `平台操作错误: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}

// ─── Built-in MCP registry ───

interface BuiltinMcp {
  tools: Omit<ToolDef, 'mcpId'>[]
  call: (name: string, input: Record<string, unknown>) => Promise<ToolResult>
}

const BUILTIN_REGISTRY: Record<string, BuiltinMcp> = {
  time: {
    tools: [{
      name: 'get_current_time',
      description: '获取当前时间、日期、星期、时区信息',
      inputSchema: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: '时区名称，如 Asia/Shanghai, UTC, America/New_York。默认 Asia/Shanghai' },
        },
      },
    }],
    call: builtinTime,
  },
  weather: {
    tools: [{
      name: 'get_weather',
      description: '获取指定城市的实时天气信息（温度、湿度、风速、天气描述等）',
      inputSchema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名称（英文），如 Beijing, Shanghai, Tokyo, London, New_York' },
        },
        required: ['city'],
      },
    }],
    call: builtinWeather,
  },
  filesystem: {
    tools: [
      {
        name: 'read_file',
        description: '读取文件内容',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: '文件绝对路径' } },
          required: ['path'],
        },
      },
      {
        name: 'list_directory',
        description: '列出目录内容',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: '目录绝对路径' } },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: '写入文件内容',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件绝对路径' },
            content: { type: 'string', description: '要写入的内容' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'get_file_info',
        description: '获取文件或目录的元信息（大小、修改时间等）',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: '文件或目录的绝对路径' } },
          required: ['path'],
        },
      },
    ],
    call: builtinFilesystem,
  },
  shell: {
    tools: [{
      name: 'run_shell_command',
      description: '在系统 shell 中执行命令（zsh），可用于系统控制、安装软件、运行脚本等',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
        },
        required: ['command'],
      },
    }],
    call: builtinShell,
  },
  platform: {
    tools: [
      {
        name: 'dispatch_to_agent',
        description: '将任务委派给指定的 Worker Agent 执行。这是你最重要的工具——当用户的请求匹配某个 Worker Agent 的能力时，必须优先使用此工具委派，而不是自己处理。',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: '目标 Agent 的 ID（先用 list_agents 查看）' },
            prompt: { type: 'string', description: '发送给该 Agent 的完整提示词' },
          },
          required: ['agentId', 'prompt'],
        },
      },
      {
        name: 'list_agents',
        description: '列出平台上所有 Agent（包括名称、状态、模型等信息）',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_models',
        description: '列出平台上所有可用的 AI 模型',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_skills',
        description: '列出平台上所有可用的技能',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'list_mcps',
        description: '列出平台上所有可用的 MCP 工具',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'create_agent',
        description: '创建一个新的 Worker Agent。需要指定名称、描述、模型ID，可选技能ID列表、MCP ID列表、系统提示词',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Agent 名称' },
            description: { type: 'string', description: 'Agent 描述，用于路由匹配' },
            modelId: { type: 'string', description: '使用的模型 ID（先用 list_models 查看可用模型）' },
            skillIds: { type: 'array', items: { type: 'string' }, description: '技能 ID 列表（可选）' },
            mcpIds: { type: 'array', items: { type: 'string' }, description: 'MCP 工具 ID 列表（可选，先用 list_mcps 查看）' },
            systemPrompt: { type: 'string', description: 'Agent 的系统提示词，定义其行为和角色' },
            autoRenew: { type: 'boolean', description: '是否自动续期（默认 false）' },
          },
          required: ['name', 'description', 'modelId'],
        },
      },
      {
        name: 'modify_agent',
        description: '修改已有 Agent 的配置（名称、描述、模型、技能、MCP、系统提示词、状态等）',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: '要修改的 Agent ID' },
            name: { type: 'string' },
            description: { type: 'string' },
            modelId: { type: 'string' },
            skillIds: { type: 'array', items: { type: 'string' } },
            mcpIds: { type: 'array', items: { type: 'string' } },
            systemPrompt: { type: 'string' },
            state: { type: 'string', enum: ['active', 'idle'], description: '激活或停用' },
          },
          required: ['agentId'],
        },
      },
      {
        name: 'destroy_agent',
        description: '销毁一个 Agent',
        inputSchema: {
          type: 'object',
          properties: { agentId: { type: 'string', description: '要销毁的 Agent ID' } },
          required: ['agentId'],
        },
      },
      {
        name: 'create_cron_job',
        description: '创建定时任务，让指定 Agent 按 cron 表达式定期执行任务',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '任务名称' },
            cron: { type: 'string', description: 'Cron 表达式，如 "0 9 * * *" 表示每天9点' },
            agentId: { type: 'string', description: '执行任务的 Agent ID' },
            prompt: { type: 'string', description: '发送给 Agent 的提示词' },
          },
          required: ['cron', 'agentId', 'prompt'],
        },
      },
      {
        name: 'list_cron_jobs',
        description: '列出所有定时任务',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'remove_cron_job',
        description: '删除一个定时任务',
        inputSchema: {
          type: 'object',
          properties: { jobId: { type: 'string', description: '定时任务 ID' } },
          required: ['jobId'],
        },
      },
    ],
    call: builtinPlatform,
  },
}

// ─── Stdio MCP Client ───

class StdioMcpClient {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private buffer = ''
  private _tools: ToolDef[] = []
  private mcpId: string

  constructor(private config: McpConfig) {
    this.mcpId = config.id
  }

  async connect(): Promise<void> {
    if (!this.config.command) throw new Error(`MCP ${this.config.name}: no command specified`)

    const env = { ...process.env, ...(this.config.env || {}) }
    this.proc = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })

    // Wait for process to be ready (stdout writable)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`MCP ${this.config.name}: spawn timeout`)), 15000)
      this.proc!.on('spawn', () => { clearTimeout(timeout); resolve() })
      this.proc!.on('error', (e) => { clearTimeout(timeout); reject(e) })
    })

    this.proc.stdout!.on('data', (data: Buffer) => {
      this.buffer += data.toString()
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id != null && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!
            this.pending.delete(msg.id)
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
            else p.resolve(msg.result)
          }
        } catch { /* ignore non-JSON lines */ }
      }
    })

    this.proc.on('error', (err) => {
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    })

    this.proc.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('MCP process exited'))
      this.pending.clear()
      this.proc = null
    })

    // Initialize handshake
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'nmclaw', version: '0.1.0' },
    })
    this.notify('notifications/initialized')

    // Discover tools
    const result = await this.request('tools/list', {})
    this._tools = (result.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      mcpId: this.mcpId,
    }))
  }

  private request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error('MCP process not connected'))
        return
      }
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      const timeoutMs = method === 'tools/call' ? 120000 : 30000
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP timeout: ${method}`))
        }
      }, timeoutMs)
    })
  }

  private notify(method: string, params?: any): void {
    if (!this.proc?.stdin?.writable) return
    const msg: any = { jsonrpc: '2.0', method }
    if (params) msg.params = params
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  getTools(): ToolDef[] {
    return this._tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.request('tools/call', { name, arguments: args })
    const content = (result.content || [])
      .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n')
    return { content, isError: result.isError }
  }

  disconnect(): void {
    this.proc?.kill()
    this.proc = null
  }
}

// ─── Connection pool for stdio MCPs ───

const stdioClients = new Map<string, StdioMcpClient>()

async function getStdioClient(mcp: McpConfig): Promise<StdioMcpClient> {
  let client = stdioClients.get(mcp.id)
  if (client) return client
  client = new StdioMcpClient(mcp)
  await client.connect()
  stdioClients.set(mcp.id, client)
  return client
}

// ─── Public API ───

/** Get ALL tools from ALL registered MCPs (shared pool) */
export async function getAllTools(): Promise<ToolDef[]> {
  const mcps = listMcps()
  const tools: ToolDef[] = []

  for (const mcp of mcps) {
    if (mcp.transport === 'builtin') {
      const builtin = BUILTIN_REGISTRY[mcp.name]
      if (builtin) {
        tools.push(...builtin.tools.map((t) => ({ ...t, mcpId: mcp.id })))
      }
    } else if (mcp.transport === 'stdio') {
      try {
        const client = await getStdioClient(mcp)
        tools.push(...client.getTools())
      } catch (e) {
        console.error(`Failed to connect to MCP ${mcp.name}:`, e)
      }
    }
    // sse / streamable-http: future
  }

  return tools
}

/** Get tools only for MCPs bound to a specific agent */
export async function getToolsForAgent(mcpIds: string[]): Promise<ToolDef[]> {
  const mcps = listMcps().filter((m) => mcpIds.includes(m.id))
  const tools: ToolDef[] = []

  for (const mcp of mcps) {
    if (mcp.transport === 'builtin') {
      const builtin = BUILTIN_REGISTRY[mcp.name]
      if (builtin) {
        tools.push(...builtin.tools.map((t) => ({ ...t, mcpId: mcp.id })))
      }
    } else if (mcp.transport === 'stdio') {
      try {
        const client = await getStdioClient(mcp)
        tools.push(...client.getTools())
      } catch (e) {
        console.error(`Failed to connect to MCP ${mcp.name}:`, e)
      }
    }
  }

  return tools
}

/** Pre-connect all stdio MCPs at startup */
export async function warmupStdioMcps(): Promise<void> {
  const mcps = listMcps().filter((m) => m.transport === 'stdio')
  await Promise.allSettled(mcps.map(async (mcp) => {
    try {
      const client = await getStdioClient(mcp)
      console.log(`  ✓ MCP ${mcp.name}: ${client.getTools().map((t) => t.name).join(', ')}`)
    } catch (e) {
      console.error(`  ✗ MCP ${mcp.name}: ${e instanceof Error ? e.message : e}`)
    }
  }))
}

/** Call a tool by name, routing to the correct MCP handler */
export async function callTool(mcpId: string, toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
  const mcp = getMcp(mcpId)
  if (!mcp) return { content: `MCP not found: ${mcpId}`, isError: true }

  if (mcp.transport === 'builtin') {
    const builtin = BUILTIN_REGISTRY[mcp.name]
    if (!builtin) return { content: `Unknown builtin MCP: ${mcp.name}`, isError: true }
    return builtin.call(toolName, input)
  }

  if (mcp.transport === 'stdio') {
    try {
      const client = await getStdioClient(mcp)
      return client.callTool(toolName, input)
    } catch (e) {
      return { content: `MCP call failed: ${e instanceof Error ? e.message : e}`, isError: true }
    }
  }

  return { content: `Unsupported MCP transport: ${mcp.transport}`, isError: true }
}

/** Find which MCP provides a given tool name */
export function findToolMcp(tools: ToolDef[], toolName: string): string | undefined {
  return tools.find((t) => t.name === toolName)?.mcpId
}

/** Cleanup all stdio connections */
export function shutdownAllMcps(): void {
  for (const client of stdioClients.values()) {
    client.disconnect()
  }
  stdioClients.clear()
}
