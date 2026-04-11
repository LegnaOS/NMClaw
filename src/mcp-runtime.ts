import { spawn, type ChildProcess } from 'node:child_process'
import { getMcp, listMcps } from './mcp-registry.js'
import { listModels } from './model-registry.js'
import { listSkills } from './skill-registry.js'
import { createAgent, listAgents, destroyAgent, modifyAgent } from './agent-manager.js'
import { addCronJob, listCronJobs, removeCronJob } from './cron.js'
import { registerNode, getEvoMapStatus } from './ext/evomap.js'
import { builtinNjggzy } from './ext/njggzy.js'
import { assertSafeUrl } from './ssrf.js'
import { extractContent, htmlToMarkdown } from './web-extract.js'
import type { McpConfig } from './types.js'


// ─── Types ───

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mcpId: string
  concurrencySafe?: boolean  // 是否可并发执行，默认 true（undefined 视为 true）
  readOnly?: boolean         // 是否只读操作
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

// ─── Delete confirmation token store (in-memory, 5 min TTL) ───
const deleteTokens = new Map<string, { path: string; createdAt: number }>()
const DELETE_TOKEN_TTL = 5 * 60 * 1000

function generateDeleteToken(filePath: string): string {
  // Cleanup expired tokens
  const now = Date.now()
  for (const [k, v] of deleteTokens) {
    if (now - v.createdAt > DELETE_TOKEN_TTL) deleteTokens.delete(k)
  }
  const token = `del_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  deleteTokens.set(token, { path: filePath, createdAt: now })
  return token
}

async function builtinFilesystem(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const fs = await import('node:fs')
  const { resolve, dirname, basename } = await import('node:path')
  try {
    if (name === 'read_file') {
      const p = resolve(input.path as string)
      const content = fs.readFileSync(p, 'utf-8')
      return { content: content.length > 10000 ? content.slice(0, 10000) + '\n...[truncated]' : content }
    }
    if (name === 'list_directory') {
      const p = resolve(input.path as string)
      const entries = fs.readdirSync(p, { withFileTypes: true })
      const list = entries.map((e) => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`)
      return { content: list.join('\n') }
    }
    if (name === 'write_file') {
      const p = resolve(input.path as string)
      const existed = fs.existsSync(p) && fs.statSync(p).isFile()
      if (existed) {
        const { recordFileSnapshot } = await import('./snapshot.js')
        recordFileSnapshot('Agent 覆写文件', p)
      }
      fs.writeFileSync(p, input.content as string, 'utf-8')
      if (!existed) {
        const { recordFileSnapshot } = await import('./snapshot.js')
        recordFileSnapshot('Agent 创建文件', p)
      }
      return { content: `已写入: ${p}` }
    }
    if (name === 'get_file_info') {
      const p = resolve(input.path as string)
      const s = fs.statSync(p)
      return {
        content: JSON.stringify({
          path: p, size: s.size, isDirectory: s.isDirectory(),
          modified: s.mtime.toISOString(), created: s.birthtime.toISOString(),
        }),
      }
    }
    if (name === 'copy_file') {
      const src = resolve(input.source as string)
      const dst = resolve(input.destination as string)
      if (!fs.existsSync(src)) return { content: `源文件不存在: ${src}`, isError: true }
      // If destination is a directory, copy into it with same filename
      const finalDst = fs.existsSync(dst) && fs.statSync(dst).isDirectory()
        ? resolve(dst, basename(src))
        : dst
      // Ensure destination directory exists
      fs.mkdirSync(dirname(finalDst), { recursive: true })
      fs.copyFileSync(src, finalDst)
      return { content: `已复制: ${src} → ${finalDst}` }
    }
    if (name === 'move_file') {
      const src = resolve(input.source as string)
      const dst = resolve(input.destination as string)
      if (!fs.existsSync(src)) return { content: `源文件不存在: ${src}`, isError: true }
      // 移动前备份源文件
      if (fs.statSync(src).isFile()) {
        const { recordFileSnapshot } = await import('./snapshot.js')
        recordFileSnapshot('Agent 移动文件', src)
      }
      const finalDst = fs.existsSync(dst) && fs.statSync(dst).isDirectory()
        ? resolve(dst, basename(src))
        : dst
      fs.mkdirSync(dirname(finalDst), { recursive: true })
      fs.renameSync(src, finalDst)
      return { content: `已移动: ${src} → ${finalDst}` }
    }
    if (name === 'send_file') {
      const p = resolve(input.path as string)
      if (!fs.existsSync(p)) return { content: `文件不存在: ${p}`, isError: true }
      const stat = fs.statSync(p)
      if (!stat.isFile()) return { content: `不是文件: ${p}`, isError: true }
      return { content: `文件已就绪: ${p} (${(stat.size / 1024).toFixed(1)} KB)` }
    }
    if (name === 'delete_file') {
      const p = resolve(input.path as string)
      const confirmToken = input.confirmToken as string | undefined
      if (!fs.existsSync(p)) return { content: `文件不存在: ${p}`, isError: true }
      const stat = fs.statSync(p)
      const desc = stat.isDirectory() ? `目录（含所有内容）` : `文件 (${(stat.size / 1024).toFixed(1)} KB)`

      if (!confirmToken) {
        // Phase 1: generate token, return warning
        const token = generateDeleteToken(p)
        return {
          content: `⚠️ 删除确认请求\n\n即将删除: ${p}\n类型: ${desc}\n\n⚠️ 此操作不可撤销！请先向用户确认是否要删除此${stat.isDirectory() ? '目录' : '文件'}。\n\n用户确认后，请再次调用 delete_file 并传入 confirmToken: "${token}"`,
        }
      }

      // Phase 2: validate token and delete
      const stored = deleteTokens.get(confirmToken)
      if (!stored || stored.path !== p) {
        return { content: `确认令牌无效或已过期，请重新发起删除请求`, isError: true }
      }
      deleteTokens.delete(confirmToken)
      // 删除前备份文件内容
      if (stat.isFile()) {
        const { recordFileSnapshot } = await import('./snapshot.js')
        recordFileSnapshot('Agent 删除文件', p)
      }
      if (stat.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true })
      } else {
        fs.unlinkSync(p)
      }
      return { content: `已删除: ${p}` }
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
    if (name === 'import_skill_url') {
      const url = input.url as string
      if (!url) return { content: '缺少 url 参数', isError: true }
      const { fetchSkillFromUrl } = await import('./skill-upload.js')
      const { addSkill } = await import('./skill-registry.js')
      const parsed = await fetchSkillFromUrl(url)
      const skill = addSkill({
        name: parsed.name,
        description: parsed.description,
        promptTemplate: parsed.promptTemplate,
        requiredMcps: parsed.requiredMcps ?? [],
        compatibleModels: ['*'],
      })
      return { content: `技能导入成功:\n${JSON.stringify({ id: skill.id, name: skill.name, description: skill.description }, null, 2)}` }
    }
    if (name === 'list_channels') {
      const { listChannels } = await import('./channels/feishu.js')
      const channels = listChannels().map(c => ({ id: c.id, name: c.name, type: c.type, agentId: c.agentId }))
      return { content: JSON.stringify(channels, null, 2) }
    }
    if (name === 'send_file_to_channel') {
      const channelId = input.channelId as string
      const filePath = input.filePath as string
      if (!channelId || !filePath) return { content: '缺少 channelId 或 filePath', isError: true }
      const { sendFileToChannel } = await import('./channels/feishu.js')
      const result = await sendFileToChannel(channelId, filePath)
      return { content: result }
    }
    if (name === 'search_memory') {
      const query = input.query as string
      if (!query) return { content: '缺少 query 参数', isError: true }
      const { searchAllAgents, searchMemory } = await import('./memory.js')
      const agentId = input.agentId as string | undefined
      const limit = (input.limit as number) || 20
      const results = agentId ? searchMemory(query, agentId, limit) : searchAllAgents(query, limit)
      if (results.length === 0) return { content: `未找到与 "${query}" 相关的对话记录` }
      const lines = results.map(r => {
        const ts = new Date(r.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        return `[${ts}] Agent:${r.agentId}\n  用户: ${r.userMessage.slice(0, 150)}\n  助手: ${r.assistantResponse.slice(0, 150)}`
      })
      return { content: `找到 ${results.length} 条相关记录:\n\n${lines.join('\n\n')}` }
    }
    return { content: `未知平台操作: ${name}`, isError: true }
  } catch (e) {
    return { content: `平台操作错误: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}

// ─── F1: Skill Evolution tools ───

async function builtinEvolution(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const { loadSkillIndex, loadSkillContent, saveSkill, deleteSkill } = await import('./skill-evolution.js')
    const { EvolvedSkillMeta } = await import('./skill-evolution.js') as any
    if (name === 'list_evolved_skills') {
      const skills = loadSkillIndex()
      if (skills.length === 0) return { content: '暂无进化技能。完成复杂任务后系统会自动提取技能，也可用 evolve_skill 手动创建。' }
      const lines = skills.map((s: any) =>
        `- ${s.name} (v${s.version}): ${s.description}${s.prerequisites.length ? ` [需要: ${s.prerequisites.join(', ')}]` : ''}`
      )
      return { content: `进化技能库 (${skills.length} 个):\n\n${lines.join('\n')}` }
    }
    if (name === 'view_evolved_skill') {
      const skillName = input.name as string
      if (!skillName) return { content: '缺少 name 参数', isError: true }
      const content = loadSkillContent(skillName)
      if (!content) return { content: `技能 "${skillName}" 不存在`, isError: true }
      return { content }
    }
    if (name === 'evolve_skill') {
      const skillName = input.name as string
      const content = input.content as string
      if (!skillName || !content) return { content: '缺少 name 或 content 参数', isError: true }
      if (!/^[a-z][a-z0-9-]{1,63}$/.test(skillName)) return { content: '名称格式错误：需要英文 kebab-case，2-64 字符', isError: true }
      const existing = loadSkillIndex().find((s: any) => s.name === skillName)
      const now = Date.now()
      const meta = {
        name: skillName,
        description: (input.description as string) || '',
        version: existing ? existing.version + 1 : 1,
        platforms: [] as string[],
        prerequisites: (input.prerequisites as string[]) || [],
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      }
      const result = saveSkill(meta, content)
      if (!result.ok) return { content: `保存失败: ${result.error}`, isError: true }
      return { content: `技能 "${skillName}" v${meta.version} 已${existing ? '更新' : '创建'}` }
    }
    if (name === 'delete_evolved_skill') {
      const skillName = input.name as string
      if (!skillName) return { content: '缺少 name 参数', isError: true }
      const ok = deleteSkill(skillName)
      return ok ? { content: `技能 "${skillName}" 已删除` } : { content: `技能 "${skillName}" 不存在`, isError: true }
    }
    return { content: `未知进化操作: ${name}`, isError: true }
  } catch (e) {
    return { content: `进化操作错误: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}

// ─── F6: PTC tools ───

async function builtinPTC(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (name !== 'execute_script') return { content: `未知 PTC 操作: ${name}`, isError: true }
  const script = input.script as string
  if (!script) return { content: '缺少 script 参数', isError: true }
  try {
    const { executeScript } = await import('./ptc-runtime.js')
    // 收集当前可用工具
    const allTools = await getAllTools()
    const allowedTools = input.allowedTools as string[] | undefined
    const config = allowedTools ? { blockedTools: [] as string[] } : undefined
    const tools = allowedTools ? allTools.filter(t => allowedTools.includes(t.name)) : allTools
    const result = await executeScript(script, tools, config)
    const parts = [`退出码: ${result.exitCode}`, `工具调用: ${result.toolCallCount} 次`, `耗时: ${result.durationMs}ms`]
    if (result.timedOut) parts.push('⚠️ 执行超时')
    if (result.stdout) parts.push(`\n--- stdout ---\n${result.stdout}`)
    if (result.stderr) parts.push(`\n--- stderr ---\n${result.stderr}`)
    return { content: parts.join('\n'), isError: result.exitCode !== 0 }
  } catch (e) {
    return { content: `PTC 执行错误: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}

// ─── Snapshot tools: 记忆回溯 ───

async function builtinSnapshot(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const snap = await import('./snapshot.js')
    if (name === 'list_snapshots') {
      const limit = (input.limit as number) || 20
      const items = snap.listSnapshots(limit)
      if (items.length === 0) return { content: '暂无操作快照记录' }
      const lines = items.map(s => {
        const time = new Date(s.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        return `#${s.id} | ${time} | ${s.action}${s.summary ? ` — ${s.summary}` : ''}`
      })
      return { content: `最近 ${items.length} 条操作快照:\n\n${lines.join('\n')}` }
    }
    if (name === 'restore_snapshot') {
      const id = input.snapshotId as number
      if (!id) return { content: '缺少 snapshotId', isError: true }
      const result = snap.restoreSnapshot(id)
      if (!result.ok) return { content: result.error ?? '恢复失败', isError: true }
      return { content: `✅ 已恢复到快照 #${id}。恢复前的状态已自动保存，可随时再次回溯。` }
    }
    if (name === 'diff_snapshot') {
      const id = input.snapshotId as number
      if (!id) return { content: '缺少 snapshotId', isError: true }
      const result = snap.diffSnapshot(id)
      if (!result.ok) return { content: result.error ?? '对比失败', isError: true }
      const diff = result.diff ?? {}
      if (Object.keys(diff).length === 0) return { content: `快照 #${id} 与当前状态无差异` }
      const lines = Object.entries(diff).map(([k, v]) => `${k}: ${v.before} → ${v.after}`)
      return { content: `快照 #${id} 与当前状态差异:\n${lines.join('\n')}` }
    }
    if (name === 'list_file_snapshots') {
      const limit = (input.limit as number) || 20
      const items = snap.listFileSnapshots(limit)
      if (items.length === 0) return { content: '暂无文件快照记录' }
      const lines = items.map(s => {
        const time = new Date(s.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        const size = s.file_size < 1024 ? `${s.file_size}B` : `${(s.file_size / 1024).toFixed(1)}KB`
        return `#${s.id} | ${time} | ${s.action} | ${s.file_path} (${size})`
      })
      return { content: `最近 ${items.length} 条文件快照:\n\n${lines.join('\n')}` }
    }
    if (name === 'restore_file_snapshot') {
      const id = input.snapshotId as number
      if (!id) return { content: '缺少 snapshotId', isError: true }
      const result = snap.restoreFileSnapshot(id)
      if (!result.ok) return { content: result.error ?? '恢复失败', isError: true }
      return { content: `✅ 已恢复文件: ${result.path}。恢复前的文件已自动备份。` }
    }
    return { content: `未知快照操作: ${name}`, isError: true }
  } catch (e) {
    return { content: `快照操作错误: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}

// ─── Web tools: search / fetch / scrape ───

const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Minimal HTML-to-text: strip tags, collapse whitespace */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * web_search — DuckDuckGo HTML scraper (inspired by SearXNG duckduckgo engine).
 * POST to https://html.duckduckgo.com/html/ with form data, parse results from HTML.
 * No API key needed. No vqd needed for first page.
 */
async function builtinWebSearch(_name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const query = (input.query as string)?.trim()
  if (!query) return { content: '缺少 query 参数', isError: true }
  const maxResults = Math.min((input.maxResults as number) || 10, 20)

  try {
    const formData = new URLSearchParams()
    formData.set('q', query)
    formData.set('b', '')      // first page
    formData.set('kl', '')     // all regions

    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'User-Agent': WEB_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://html.duckduckgo.com/',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      },
      body: formData.toString(),
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) return { content: `DuckDuckGo 返回 HTTP ${res.status}`, isError: true }
    const html = await res.text()

    // Parse results — DDG HTML uses div.web-result with h2>a for title/url and a.result__snippet for content
    const results: { title: string; url: string; snippet: string }[] = []

    // Extract each result block
    const resultBlocks = html.split(/class="[^"]*web-result[^"]*"/)
    for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
      const block = resultBlocks[i]

      // Extract URL from h2>a href
      const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/)
        || block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/)
        || block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="result__a"/)
      if (!urlMatch) continue

      let url = urlMatch[1]
      // DDG wraps URLs through redirect: //duckduckgo.com/l/?uddg=...
      if (url.includes('uddg=')) {
        const uddg = url.match(/uddg=([^&]+)/)
        if (uddg) url = decodeURIComponent(uddg[1])
      }

      // Extract title
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</)
      const title = titleMatch ? htmlToText(titleMatch[1]) : url

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)(?:<\/a>|<\/td>)/)
      const snippet = snippetMatch ? htmlToText(snippetMatch[1]) : ''

      results.push({ title, url, snippet })
    }

    if (results.length === 0) {
      return { content: JSON.stringify({ query, results: [], message: '未找到结果（可能被 DDG 限流）' }) }
    }

    return { content: JSON.stringify({ query, count: results.length, results }) }
  } catch (e) {
    return { content: `搜索失败: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}

/**
 * fetch_url — SSRF-safe HTTP GET + Readability extraction.
 * Uses ssrf.ts for network security, web-extract.ts for content quality.
 */
async function builtinFetchUrl(_name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const url = (input.url as string)?.trim()
  if (!url) return { content: '缺少 url 参数', isError: true }
  const maxLen = (input.maxLength as number) || 15000
  const raw = (input.raw as boolean) || false

  try {
    await assertSafeUrl(url)
    const res = await fetch(url, {
      headers: {
        'User-Agent': WEB_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    })

    if (!res.ok) return { content: `HTTP ${res.status} ${res.statusText}`, isError: true }

    const contentType = res.headers.get('content-type') || ''
    const body = await res.text()

    let content: string
    if (raw || !contentType.includes('html')) {
      content = body
    } else {
      const result = await extractContent(body, url)
      if (result?.text) {
        content = result.title ? `# ${result.title}\n\n${result.text}` : result.text
      } else {
        // Fallback to basic conversion
        const basic = htmlToMarkdown(body)
        content = basic.title ? `# ${basic.title}\n\n${basic.text}` : basic.text
      }
    }

    if (content.length > maxLen) {
      content = content.slice(0, maxLen) + '\n...[truncated]'
    }

    return { content }
  } catch (e) {
    return { content: `抓取失败: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}

/**
 * scrape_page — SSRF-safe deep scraper with Readability + visibility sanitization.
 * Multiple User-Agents, retry logic, anti-prompt-injection via hidden element removal.
 */
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
]

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

async function builtinScrapePage(_name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const url = (input.url as string)?.trim()
  if (!url) return { content: '缺少 url 参数', isError: true }
  const maxLen = (input.maxLength as number) || 15000
  const maxRetries = 2

  try {
    await assertSafeUrl(url)
  } catch (e) {
    return { content: `安全检查失败: ${e instanceof Error ? e.message : e}`, isError: true }
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const ua = attempt === 0 ? WEB_UA : randomUA()
      const res = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
          'Accept-Encoding': 'gzip, deflate',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'max-age=0',
        },
        signal: AbortSignal.timeout(25000),
        redirect: 'follow',
      })

      if (!res.ok) {
        if (attempt < maxRetries && (res.status === 403 || res.status === 429)) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
        return { content: `HTTP ${res.status} ${res.statusText}`, isError: true }
      }

      const body = await res.text()

      // Use Readability + visibility sanitization pipeline
      const result = await extractContent(body, url)
      let content: string
      if (result?.text) {
        content = result.title ? `# ${result.title}\n\n${result.text}` : result.text
      } else {
        const basic = htmlToMarkdown(body)
        content = basic.title ? `# ${basic.title}\n\n${basic.text}` : basic.text
      }

      // Check if we got meaningful content
      const cleanLen = content.replace(/\s+/g, '').length
      if (cleanLen < 50 && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 500))
        continue
      }

      if (content.length > maxLen) {
        content = content.slice(0, maxLen) + '\n...[truncated]'
      }

      return { content }
    } catch (e) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      return { content: `页面抓取失败: ${e instanceof Error ? e.message : e}`, isError: true }
    }
  }

  return { content: '抓取失败: 多次重试后仍无法获取内容', isError: true }
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
      concurrencySafe: true,
      readOnly: true,
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
      concurrencySafe: true,
      readOnly: true,
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
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'list_directory',
        description: '列出目录内容',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: '目录绝对路径' } },
          required: ['path'],
        },
        concurrencySafe: true,
        readOnly: true,
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
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'get_file_info',
        description: '获取文件或目录的元信息（大小、修改时间等）',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: '文件或目录的绝对路径' } },
          required: ['path'],
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'copy_file',
        description: '复制文件到指定位置。如果目标是目录，则复制到该目录下保留原文件名',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '源文件绝对路径' },
            destination: { type: 'string', description: '目标路径（文件路径或目录路径）' },
          },
          required: ['source', 'destination'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'move_file',
        description: '移动/重命名文件。如果目标是目录，则移动到该目录下保留原文件名',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '源文件绝对路径' },
            destination: { type: 'string', description: '目标路径（文件路径或目录路径）' },
          },
          required: ['source', 'destination'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'send_file',
        description: '将本地文件发送给当前 Web 对话中的用户。用户说"把文件发给我"、"发送文件"时调用此工具，文件会以下载链接的形式出现在聊天界面',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要发送的文件的绝对路径' },
          },
          required: ['path'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'delete_file',
        description: '删除文件或目录（危险操作，需要两步确认）。第一次调用只传 path，会返回确认令牌和警告信息，你必须先向用户确认。用户同意后，第二次调用传入 path + confirmToken 才会真正删除。',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要删除的文件或目录的绝对路径' },
            confirmToken: { type: 'string', description: '确认令牌（第二次调用时传入，由第一次调用返回）' },
          },
          required: ['path'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
    ],
    call: builtinFilesystem,
  },
  shell: {
    tools: [{
      name: 'run_shell_command',
      description: '在 macOS 系统 shell 中执行命令（zsh）。注意：macOS 的 grep 不支持 -P，请用 grep -E；sed 不支持换行替换，请用 perl 或 awk 代替',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
        },
        required: ['command'],
      },
      concurrencySafe: false,
      readOnly: false,
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
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'list_agents',
        description: '列出平台上所有 Agent（包括名称、状态、模型等信息）',
        inputSchema: { type: 'object', properties: {} },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'list_models',
        description: '列出平台上所有可用的 AI 模型',
        inputSchema: { type: 'object', properties: {} },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'list_skills',
        description: '列出平台上所有可用的技能',
        inputSchema: { type: 'object', properties: {} },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'list_mcps',
        description: '列出平台上所有可用的 MCP 工具',
        inputSchema: { type: 'object', properties: {} },
        concurrencySafe: true,
        readOnly: true,
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
        concurrencySafe: false,
        readOnly: false,
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
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'destroy_agent',
        description: '销毁一个 Agent',
        inputSchema: {
          type: 'object',
          properties: { agentId: { type: 'string', description: '要销毁的 Agent ID' } },
          required: ['agentId'],
        },
        concurrencySafe: false,
        readOnly: false,
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
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'list_cron_jobs',
        description: '列出所有定时任务',
        inputSchema: { type: 'object', properties: {} },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'remove_cron_job',
        description: '删除一个定时任务',
        inputSchema: {
          type: 'object',
          properties: { jobId: { type: 'string', description: '定时任务 ID' } },
          required: ['jobId'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'import_skill_url',
        description: '从 URL 导入技能（Markdown 格式的 SKILL.md）。用户说"把 https://xxx/skill.md 加到技能库"时调用此工具',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: '技能文件的 URL（如 https://evomap.ai/skill.md）' } },
          required: ['url'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'list_channels',
        description: '列出所有消息渠道（飞书等），用于查看可发送文件的目标渠道',
        inputSchema: { type: 'object', properties: {} },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'send_file_to_channel',
        description: '将本地文件发送到指定消息渠道（飞书）。用户说"把文件发给我"时，先用 list_channels 获取渠道列表，再调用此工具发送文件',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: '目标渠道 ID（先用 list_channels 查看）' },
            filePath: { type: 'string', description: '要发送的本地文件绝对路径' },
          },
          required: ['channelId', 'filePath'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      // F4: 跨会话记忆搜索
      {
        name: 'search_memory',
        description: '跨会话搜索所有 Agent 的对话记录（全文检索）。可搜索历史对话中的关键词、话题、解决方案等',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            agentId: { type: 'string', description: '可选，限定搜索某个 Agent' },
            limit: { type: 'number', description: '最大返回条数（默认 20）' },
          },
          required: ['query'],
        },
        concurrencySafe: true,
        readOnly: true,
      },
    ],
    call: builtinPlatform,
  },
  web: {
    tools: [
      {
        name: 'web_search',
        description: '在互联网上搜索信息（使用 DuckDuckGo，无需 API key）。返回标题、URL 和摘要。适合查找最新资讯、技术文档、产品信息等',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            maxResults: { type: 'number', description: '最大返回结果数（默认 10，最多 20）' },
          },
          required: ['query'],
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'fetch_url',
        description: '抓取网页内容并提取文本。适合静态页面、API 响应、RSS 等。速度快，无浏览器开销',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要抓取的 URL' },
            maxLength: { type: 'number', description: '最大返回字符数（默认 15000）' },
            raw: { type: 'boolean', description: '是否返回原始内容而不做 HTML-to-text 转换（默认 false）' },
          },
          required: ['url'],
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'scrape_page',
        description: '增强型网页抓取（纯 HTTP，无需浏览器）。多策略内容提取 + 自动重试 + User-Agent 轮换。比 fetch_url 更智能的内容解析，适合复杂页面结构',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要抓取的 URL' },
            maxLength: { type: 'number', description: '最大返回字符数（默认 15000）' },
            selector: { type: 'string', description: '可选 CSS 选择器（标签名、.class、#id），只提取匹配元素的文本' },
          },
          required: ['url'],
        },
        concurrencySafe: true,
        readOnly: true,
      },
    ],
    call: (name: string, input: Record<string, unknown>) => {
      if (name === 'web_search') return builtinWebSearch(name, input)
      if (name === 'fetch_url') return builtinFetchUrl(name, input)
      if (name === 'scrape_page') return builtinScrapePage(name, input)
      return Promise.resolve({ content: `未知 web 操作: ${name}`, isError: true })
    },
  },

  // ═══ EvoMap (GEP-A2A) ═══
  evomap: {
    tools: [
      {
        name: 'evomap_register',
        description: '注册当前节点到 EvoMap 协作进化网络。首次注册后返回 claim_url，用户访问该链接即可绑定节点到自己的 EvoMap 账户。已注册则返回现有状态',
        inputSchema: { type: 'object', properties: {}, required: [] },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'evomap_status',
        description: '查看 EvoMap 节点状态：是否已注册、node_id、积分余额、上次心跳时间、claim_url 等',
        inputSchema: { type: 'object', properties: {}, required: [] },
        concurrencySafe: true,
        readOnly: true,
      },
    ],
    call: async (name: string, _input: Record<string, unknown>) => {
      if (name === 'evomap_register') {
        try {
          const state = await registerNode()
          return {
            content: JSON.stringify({
              registered: true,
              node_id: state.nodeId,
              claim_url: state.claimUrl,
              claim_code: state.claimCode,
              credit_balance: state.creditBalance,
              message: `节点已注册。请用户访问 ${state.claimUrl} 绑定账户（激活码: ${state.claimCode}）。心跳已自动启动。`,
            }, null, 2),
          }
        } catch (err) {
          return { content: `EvoMap 注册失败: ${err instanceof Error ? err.message : err}`, isError: true }
        }
      }
      if (name === 'evomap_status') {
        const { registered, state } = getEvoMapStatus()
        if (!registered) return { content: JSON.stringify({ registered: false, message: '尚未注册 EvoMap。使用 evomap_register 工具注册。' }) }
        return {
          content: JSON.stringify({
            registered: true,
            node_id: state!.nodeId,
            claim_url: state!.claimUrl,
            credit_balance: state!.creditBalance,
            last_heartbeat: state!.lastHeartbeatAt ? new Date(state!.lastHeartbeatAt).toISOString() : 'never',
            heartbeat_interval_s: (state!.heartbeatIntervalMs || 900000) / 1000,
          }, null, 2),
        }
      }
      return Promise.resolve({ content: `未知 evomap 操作: ${name}`, isError: true })
    },
  },

  // ═══ njggzy (南京公共资源交易) ═══
  njggzy: {
    tools: [
      {
        name: 'njggzy_scrape',
        description: '抓取南京公共资源交易中心的招标/中标公告列表并存入本地数据库',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['tender', 'award'], description: '类型：tender=招标公告, award=中标公告' },
            since_date: { type: 'string', description: '可选，只抓取该日期之后的公告（YYYY-MM-DD）' },
          },
          required: ['kind'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'njggzy_detail',
        description: '抓取并解析单条招标/中标公告的详情页，提取合同估算价、中标候选人、投标报价等关键字段',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['tender', 'award'], description: '类型' },
            url: { type: 'string', description: '详情页 URL' },
          },
          required: ['kind', 'url'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'njggzy_query_tenders',
        description: '查询本地数据库中的招标公告（支持关键词搜索）',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '搜索关键词（项目名称/标段名称）' },
            limit: { type: 'number', description: '返回条数（默认50）' },
          },
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'njggzy_query_awards',
        description: '查询本地数据库中的中标公告（支持关键词搜索）',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '搜索关键词（项目名称/标段名称/中标人）' },
            limit: { type: 'number', description: '返回条数（默认50）' },
          },
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'njggzy_match',
        description: '招标-中标关联匹配：通过项目名和标段名自动关联招标公告与中标结果',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选，项目名称关键词过滤' },
          },
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'njggzy_stats',
        description: '查看招标信息数据库统计：招标数量、中标数量、已匹配数量',
        inputSchema: { type: 'object', properties: {} },
        concurrencySafe: true,
        readOnly: true,
      },
    ],
    call: builtinNjggzy,
  },
  snapshot: {
    tools: [
      {
        name: 'list_snapshots',
        description: '列出平台操作快照（记忆回溯）。每次创建/修改/删除资源时自动拍快照，最多保留 200 条',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '返回条数（默认 20）' },
          },
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'restore_snapshot',
        description: '恢复到指定快照版本（记忆回溯）。恢复前会自动保存当前状态，所以恢复操作本身也可以撤销。⚠️ 必须先向用户确认再执行',
        inputSchema: {
          type: 'object',
          properties: {
            snapshotId: { type: 'number', description: '要恢复到的快照 ID（先用 list_snapshots 查看）' },
          },
          required: ['snapshotId'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'diff_snapshot',
        description: '对比指定快照与当前状态的差异，显示各资源数量变化',
        inputSchema: {
          type: 'object',
          properties: {
            snapshotId: { type: 'number', description: '快照 ID' },
          },
          required: ['snapshotId'],
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'list_file_snapshots',
        description: '列出文件快照（文件级回溯）。文件被覆写、移动或删除前自动备份原内容，可恢复',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '返回条数（默认 20）' },
          },
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'restore_file_snapshot',
        description: '恢复文件快照 — 将备份内容写回原路径。恢复前会自动备份当前文件。⚠️ 必须先向用户确认再执行',
        inputSchema: {
          type: 'object',
          properties: {
            snapshotId: { type: 'number', description: '文件快照 ID（先用 list_file_snapshots 查看）' },
          },
          required: ['snapshotId'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
    ],
    call: builtinSnapshot,
  },

  // ═══ F1: Skill Evolution (技能自动进化) ═══
  evolution: {
    tools: [
      {
        name: 'list_evolved_skills',
        description: '列出所有自动进化的技能（仅元数据：名称、描述、版本、前置工具）',
        inputSchema: { type: 'object', properties: {} },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'view_evolved_skill',
        description: '查看进化技能的完整 SKILL.md 内容',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: '技能名称（英文 kebab-case）' } },
          required: ['name'],
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'evolve_skill',
        description: '手动创建或更新一个进化技能。content 为 Markdown 格式的技能说明',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '技能名称（英文 kebab-case，2-64字符）' },
            description: { type: 'string', description: '一句话描述' },
            content: { type: 'string', description: '技能详细内容（Markdown）' },
            prerequisites: { type: 'array', items: { type: 'string' }, description: '需要的工具名列表' },
          },
          required: ['name', 'content'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'delete_evolved_skill',
        description: '删除一个进化技能',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: '技能名称' } },
          required: ['name'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
    ],
    call: builtinEvolution,
  },

  // ═══ F6: Programmatic Tool Calling (编程式工具调用) ═══
  ptc: {
    tools: [{
      name: 'execute_script',
      description: '执行 JavaScript 脚本，可批量调用工具（编程式工具调用）。脚本中可通过 tools.工具名(参数) 调用可用工具。适合需要多步工具调用、循环、条件判断的复杂任务',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript 脚本内容（ES Module 格式）' },
          allowedTools: { type: 'array', items: { type: 'string' }, description: '允许使用的工具名列表（可选，默认安全子集）' },
        },
        required: ['script'],
      },
      concurrencySafe: false,
      readOnly: false,
    }],
    call: builtinPTC,
  },

  // ═══ MemPalace: 记忆宫殿 + 日记 + 知识图谱 ═══
  palace: {
    tools: [
      {
        name: 'palace_status',
        description: '记忆宫殿状态：总记忆数、领域(wing)/话题(room)分布',
        inputSchema: {
          type: 'object',
          properties: { agentId: { type: 'string', description: 'Agent ID（可选，默认当前）' } },
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'palace_list_wings',
        description: '列出记忆宫殿的所有领域(wing)及记忆数量',
        inputSchema: {
          type: 'object',
          properties: { agentId: { type: 'string', description: 'Agent ID（可选）' } },
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'palace_list_rooms',
        description: '列出指定领域(wing)下的所有话题(room)',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID（可选）' },
            wing: { type: 'string', description: '领域名称' },
          },
          required: ['wing'],
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'recall_memory',
        description: '按需加载记忆：指定领域(wing)或话题(room)的记忆内容。用于深入了解某个话题',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID（可选）' },
            topic: { type: 'string', description: '领域或话题名称' },
          },
          required: ['topic'],
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'palace_add_drawer',
        description: '手动添加一条记忆到宫殿',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID（可选）' },
            wing: { type: 'string', description: '领域' },
            room: { type: 'string', description: '话题' },
            content: { type: 'string', description: '记忆内容' },
            memoryType: { type: 'string', enum: ['decision', 'preference', 'milestone', 'problem', 'emotional'], description: '记忆类型' },
          },
          required: ['wing', 'room', 'content'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'palace_semantic_search',
        description: '语义搜索记忆宫殿（TF-IDF 相似度），比关键词搜索更智能',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID（可选）' },
            query: { type: 'string', description: '搜索内容' },
            wing: { type: 'string', description: '限定领域（可选）' },
            limit: { type: 'number', description: '最大返回数（默认 5）' },
          },
          required: ['query'],
        },
        concurrencySafe: true,
        readOnly: true,
      },
      // M9: Agent 日记
      {
        name: 'diary_write',
        description: 'Agent 写日记：记录观察、想法、工作内容。日记自动存入 wing_{agentName}/diary',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID（可选）' },
            entry: { type: 'string', description: '日记内容' },
            topic: { type: 'string', description: '话题标签（可选）' },
          },
          required: ['entry'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      // M10: 知识图谱工具
      {
        name: 'kg_add_entity',
        description: '添加实体到知识图谱（人/项目/工具/概念）',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID（可选）' },
            name: { type: 'string', description: '实体名称' },
            type: { type: 'string', description: '类型（person/project/tool/concept）' },
          },
          required: ['name'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'kg_add_fact',
        description: '添加关系事实到知识图谱（主语-谓语-宾语 + 时间窗口）',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID（可选）' },
            subject: { type: 'string', description: '主语实体' },
            predicate: { type: 'string', description: '关系（如 works_on, loves, is_partner_of）' },
            object: { type: 'string', description: '宾语实体' },
            validFrom: { type: 'string', description: '生效日期（ISO 格式，可选）' },
          },
          required: ['subject', 'predicate', 'object'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'kg_expire_fact',
        description: '标记知识图谱中的事实过期（不删除，保留历史）',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID（可选）' },
            tripleId: { type: 'string', description: '三元组 ID' },
          },
          required: ['tripleId'],
        },
        concurrencySafe: false,
        readOnly: false,
      },
      {
        name: 'kg_query',
        description: '查询知识图谱中实体的所有关系',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID（可选）' },
            entity: { type: 'string', description: '实体名称' },
          },
          required: ['entity'],
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'kg_timeline',
        description: '知识图谱时间线：按时间顺序展示实体的事实变化',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Agent ID（可选）' },
            entity: { type: 'string', description: '实体名称（可选，不填则全部）' },
          },
        },
        concurrencySafe: true,
        readOnly: true,
      },
      {
        name: 'kg_stats',
        description: '知识图谱统计：实体数、关系数、当前/过期事实数',
        inputSchema: {
          type: 'object',
          properties: { agentId: { type: 'string', description: 'Agent ID（可选）' } },
        },
        concurrencySafe: true,
        readOnly: true,
      },
    ],
    call: builtinPalace,
  },

  // ═══ Browser Control (Playwright) ═══
  browser: {
    tools: [], // 启动时加载
    call: builtinBrowser,
  },
}

// 加载浏览器工具定义
let browserToolsLoaded = false
async function ensureBrowserTools() {
  if (browserToolsLoaded) return
  const { getBrowserToolDefs } = await import('./browser-control.js')
  BUILTIN_REGISTRY.browser.tools = getBrowserToolDefs()
  browserToolsLoaded = true
}
ensureBrowserTools()

// ─── Browser handler ───

async function builtinBrowser(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const { handleBrowserTool } = await import('./browser-control.js')
  return await handleBrowserTool(name, input)
}

// ─── MemPalace handler ───

async function builtinPalace(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const aid = (input.agentId as string) || 'genesis'

    // Palace tools
    if (name === 'palace_status') {
      const { getDrawerCount, getWings } = await import('./memory.js')
      const count = getDrawerCount(aid)
      const wings = getWings(aid)
      if (count === 0) return { content: '记忆宫殿为空。对话过程中系统会自动提取记忆。' }
      const wingList = wings.map(w => `${w.wing}: ${w.count} 条`).join('\n')
      return { content: `记忆宫殿 (${count} 条记忆, ${wings.length} 个领域):\n${wingList}` }
    }
    if (name === 'palace_list_wings') {
      const { getWings } = await import('./memory.js')
      const wings = getWings(aid)
      if (wings.length === 0) return { content: '暂无记忆领域' }
      return { content: wings.map(w => `- ${w.wing} (${w.count} 条)`).join('\n') }
    }
    if (name === 'palace_list_rooms') {
      const { getRooms } = await import('./memory.js')
      const rooms = getRooms(aid, input.wing as string)
      if (rooms.length === 0) return { content: `领域 "${input.wing}" 下暂无话题` }
      return { content: rooms.map(r => `- ${r.room} (${r.count} 条)`).join('\n') }
    }
    if (name === 'recall_memory') {
      const { loadL2 } = await import('./memory-layers.js')
      return { content: loadL2(aid, input.topic as string) }
    }
    if (name === 'palace_add_drawer') {
      const { addDrawer } = await import('./memory.js')
      const id = addDrawer(aid, {
        wing: input.wing as string, room: input.room as string,
        content: input.content as string, memoryType: input.memoryType as string,
      })
      return { content: `记忆已添加 (id: ${id})` }
    }
    if (name === 'palace_semantic_search') {
      const { semanticSearch } = await import('./semantic-search.js')
      const hits = semanticSearch(aid, input.query as string, {
        wing: input.wing as string, limit: (input.limit as number) || 5,
      })
      if (hits.length === 0) return { content: `未找到与 "${input.query}" 相关的记忆` }
      const lines = hits.map(h => `[${h.wing}/${h.room}] (${(h.similarity * 100).toFixed(0)}%) ${h.content.slice(0, 200)}`)
      return { content: `找到 ${hits.length} 条相关记忆:\n\n${lines.join('\n\n')}` }
    }

    // Diary
    if (name === 'diary_write') {
      const { addDrawer } = await import('./memory.js')
      const agentName = listAgents().find(a => a.id === aid)?.name || aid
      const wing = `wing_${agentName.toLowerCase().replace(/\s+/g, '_')}`
      const id = addDrawer(aid, {
        wing, room: 'diary',
        content: input.entry as string,
        memoryType: 'emotional',
        importance: 0.6,
      })
      return { content: `日记已记录 (${wing}/diary, id: ${id})` }
    }

    // Knowledge Graph
    if (name === 'kg_add_entity') {
      const { KnowledgeGraph } = await import('./knowledge-graph.js')
      const kg = new KnowledgeGraph(aid)
      kg.addEntity(input.name as string, (input.type as string) || 'unknown')
      return { content: `实体 "${input.name}" 已添加` }
    }
    if (name === 'kg_add_fact') {
      const { KnowledgeGraph } = await import('./knowledge-graph.js')
      const kg = new KnowledgeGraph(aid)
      kg.addTriple(
        input.subject as string, input.predicate as string, input.object as string,
        input.validFrom as string,
      )
      return { content: `事实已添加: ${input.subject} → ${input.predicate} → ${input.object}` }
    }
    if (name === 'kg_expire_fact') {
      const { KnowledgeGraph } = await import('./knowledge-graph.js')
      const kg = new KnowledgeGraph(aid)
      kg.expireTriple(input.tripleId as string)
      return { content: `事实 ${input.tripleId} 已标记过期` }
    }
    if (name === 'kg_query') {
      const { KnowledgeGraph } = await import('./knowledge-graph.js')
      const kg = new KnowledgeGraph(aid)
      const result = kg.queryEntity(input.entity as string)
      if (!result.entity) return { content: `实体 "${input.entity}" 不存在` }
      const lines = [`实体: ${result.entity.name} (${result.entity.type})`]
      for (const t of result.triples) {
        const status = t.validTo ? '(已过期)' : '(当前)'
        lines.push(`  ${t.subject} → ${t.predicate} → ${t.object} ${status}`)
      }
      return { content: lines.join('\n') }
    }
    if (name === 'kg_timeline') {
      const { KnowledgeGraph } = await import('./knowledge-graph.js')
      const kg = new KnowledgeGraph(aid)
      const timeline = kg.getTimeline(input.entity as string)
      if (timeline.length === 0) return { content: '知识图谱中暂无时间线数据' }
      const lines = timeline.map(t => {
        const from = t.validFrom || '?'
        const to = t.validTo || '至今'
        return `[${from} → ${to}] ${t.subject} → ${t.predicate} → ${t.object}`
      })
      return { content: `时间线 (${timeline.length} 条):\n${lines.join('\n')}` }
    }
    if (name === 'kg_stats') {
      const { KnowledgeGraph } = await import('./knowledge-graph.js')
      const kg = new KnowledgeGraph(aid)
      const stats = kg.getStats()
      return { content: `知识图谱: ${stats.entities} 实体, ${stats.triples} 关系 (当前 ${stats.current}, 过期 ${stats.expired})` }
    }

    return { content: `未知宫殿操作: ${name}`, isError: true }
  } catch (e) {
    return { content: `宫殿操作错误: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}

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
