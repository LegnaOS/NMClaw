import { spawn, type ChildProcess } from 'node:child_process'
import { getMcp, listMcps } from './mcp-registry.js'
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
