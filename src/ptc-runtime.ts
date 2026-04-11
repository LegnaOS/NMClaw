/**
 * F6: Programmatic Tool Calling (PTC)
 * LLM 写 JS 脚本批量调用工具，一次推理完成多步工作
 * 父进程启动临时 HTTP server 接收子进程的工具调用回调
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nanoid } from 'nanoid'
import { callTool, findToolMcp } from './mcp-runtime.js'
import type { ToolDef } from './mcp-runtime.js'

export interface PTCConfig {
  timeoutMs: number
  maxToolCalls: number
  maxStdoutBytes: number
  blockedTools: string[]
}

export interface PTCResult {
  stdout: string
  stderr: string
  toolCallCount: number
  exitCode: number
  durationMs: number
  timedOut: boolean
}

const DEFAULT_CONFIG: PTCConfig = {
  timeoutMs: 300_000,
  maxToolCalls: 50,
  maxStdoutBytes: 51_200,
  blockedTools: [
    'dispatch_to_agent', 'destroy_agent', 'create_agent', 'modify_agent',
    'delete_file', 'run_shell_command', 'restore_snapshot', 'evolve_skill',
  ],
}

// 敏感环境变量关键词
const SECRET_SUBSTRINGS = ['API_KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'CREDENTIAL', 'PRIVATE']

/** 生成工具存根模块 */
export function generateToolStub(tools: ToolDef[], port: number, token: string): string {
  const funcs = tools.map(t => {
    const desc = t.description.replace(/'/g, "\\'")
    return `/** ${desc} */
export async function ${t.name.replace(/-/g, '_')}(args = {}) {
  return _call('${t.name}', args);
}`
  }).join('\n\n')

  return `// Auto-generated NMClaw PTC tool stubs
const _PORT = ${port};
const _TOKEN = '${token}';

async function _call(tool, args) {
  const res = await fetch('http://127.0.0.1:' + _PORT + '/ptc/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PTC-Token': _TOKEN },
    body: JSON.stringify({ tool, arguments: args }),
  });
  if (!res.ok) throw new Error('Tool call failed: ' + res.status);
  return res.json();
}

// Built-in helpers
export function json_parse(text) { return JSON.parse(text); }
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
export async function retry(fn, maxAttempts = 3, delay = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    try { return await fn(); } catch (e) {
      if (i === maxAttempts - 1) throw e;
      await sleep(delay * (i + 1));
    }
  }
}

${funcs}
`
}

/** 过滤安全的环境变量 */
function safeEnv(): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue
    if (SECRET_SUBSTRINGS.some(s => k.toUpperCase().includes(s))) continue
    safe[k] = v
  }
  return safe
}

/** 截断输出，保留首尾 */
function truncateOutput(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const half = Math.floor(maxBytes / 2)
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  const head = new TextDecoder().decode(bytes.slice(0, half))
  const tail = new TextDecoder().decode(bytes.slice(-half))
  return `${head}\n\n...[输出已截断，原始 ${bytes.length} 字节]...\n\n${tail}`
}

/** 执行 PTC 脚本 */
export async function executeScript(
  script: string,
  availableTools: ToolDef[],
  config?: Partial<PTCConfig>,
): Promise<PTCResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const start = Date.now()

  // 过滤工具
  const blockedSet = new Set(cfg.blockedTools)
  const tools = availableTools.filter(t => !blockedSet.has(t.name))

  // 创建临时目录
  const workDir = join(tmpdir(), `nmclaw-ptc-${nanoid(8)}`)
  mkdirSync(workDir, { recursive: true })

  // 生成 token 和端口
  const token = nanoid(32)
  let toolCallCount = 0
  let timedOut = false

  // 启动临时 HTTP server
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/ptc/call') {
      res.writeHead(404); res.end(); return
    }

    // 验证 token
    if (req.headers['x-ptc-token'] !== token) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'invalid token' })); return
    }

    // 检查调用次数
    if (toolCallCount >= cfg.maxToolCalls) {
      res.writeHead(429); res.end(JSON.stringify({ error: `超过最大工具调用次数 (${cfg.maxToolCalls})` })); return
    }

    // 读取请求体
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString())

    const toolName = body.tool as string
    const args = body.arguments as Record<string, unknown> || {}

    // 检查工具是否允许
    if (blockedSet.has(toolName)) {
      res.writeHead(403); res.end(JSON.stringify({ error: `工具 ${toolName} 被禁止` })); return
    }

    const mcpId = findToolMcp(tools, toolName)
    if (!mcpId) {
      res.writeHead(404); res.end(JSON.stringify({ error: `工具 ${toolName} 不存在` })); return
    }

    toolCallCount++
    try {
      const result = await callTool(mcpId, toolName, args)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ content: result.content, isError: result.isError }))
    } catch (err) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    }
  })

  // 监听随机端口
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port

  try {
    // 写入存根和脚本
    const stubContent = generateToolStub(tools, port, token)
    writeFileSync(join(workDir, 'nmclaw_tools.mjs'), stubContent)
    writeFileSync(join(workDir, 'script.mjs'), `import * as tools from './nmclaw_tools.mjs';\n\n${script}`)

    // 执行脚本
    const result = await new Promise<PTCResult>((resolve) => {
      let stdout = ''
      let stderr = ''

      const child = spawn('node', ['--experimental-vm-modules', 'script.mjs'], {
        cwd: workDir,
        env: safeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: cfg.timeoutMs,
      })

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
        if (Buffer.byteLength(stdout) > cfg.maxStdoutBytes * 2) {
          stdout = truncateOutput(stdout, cfg.maxStdoutBytes)
        }
      })

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
        if (stderr.length > 10240) stderr = stderr.slice(-10240)
      })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, cfg.timeoutMs)

      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          stdout: truncateOutput(stdout, cfg.maxStdoutBytes),
          stderr: stderr.slice(0, 10240),
          toolCallCount,
          exitCode: code ?? 1,
          durationMs: Date.now() - start,
          timedOut,
        })
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({
          stdout: '',
          stderr: err.message,
          toolCallCount,
          exitCode: 1,
          durationMs: Date.now() - start,
          timedOut: false,
        })
      })
    })

    return result
  } finally {
    server.close()
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* */ }
  }
}
