import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'

// Load .env if exists (before any other imports that need env vars)
const __dirname_early = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname_early, '..', '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq > 0) {
      const k = t.slice(0, eq).trim()
      const v = t.slice(eq + 1).trim()
      if (!process.env[k]) process.env[k] = v
    }
  }
}

import { addModel, removeModel, listModels, getModel, modifyModel } from './model-registry.js'
import { addSkill, removeSkill, listSkills, getSkill, modifySkill } from './skill-registry.js'
import { addMcp, removeMcp, listMcps, getMcp, modifyMcp } from './mcp-registry.js'
import {
  createAgent, destroyAgent, listAgents, getAgent,
  sweepLifecycle, modifyAgent, touchAgent, isProtectedAgent,
} from './agent-manager.js'
import { matchAgent, dispatch, getSystemStatus } from './genesis.js'
import { listTasks, getTask, getTaskTrace, deleteTask } from './tracker.js'
import { streamTask, getCacheStats } from './executor.js'
import { recordSnapshot, shouldSnapshot, describeAction, listSnapshots, getSnapshot, restoreSnapshot, diffSnapshot, getSnapshotCount, getSnapshotConfig, listFileSnapshots, getFileSnapshotCount, restoreFileSnapshot } from './snapshot.js'
import { createGraph, listGraphs, getGraph, removeGraph, modifyGraph, executeGraph } from './graph.js'
import { searchSkills as clawHubSearch, getSkillInfo as clawHubInfo } from './ext/clawhub.js'
import { scanLocalMcps, getLocalMcpSources } from './local-mcp-scanner.js'
import { loadStore, updateStore } from './store.js'
import { seedDefaults, migrateBuiltins } from './seed.js'
import { warmupStdioMcps } from './mcp-runtime.js'
import { startHeartbeatLoop } from './ext/evomap.js'
import { startCron, listCronJobs, addCronJob, removeCronJob, toggleCronJob, updateCronJob } from './cron.js'
import { listChannels, addChannel, modifyChannel, removeChannel, handleFeishuEvent, sendToChannel, startAllFeishuMonitors, startFeishuMonitor, stopFeishuMonitor, getFeishuMonitorStatus, listPairings, approvePairing, rejectPairing, getChannelMessages, getChannelConversations, subscribeChannelMessages } from './channels/feishu.js'
import { listTurns, listSummaries, getMemoryStats, addTurn, editTurn, deleteTurn, deleteSummary, purgeAgentMemory, extractKnowledgeGraph, searchAllAgents, searchMemory } from './memory.js'
import type { CostTier, McpTransport, ChatMessage } from './types.js'

// Seed default models & agents on first run
seedDefaults()
// Migrate: ensure new builtin MCPs are added to existing installations
migrateBuiltins()

// Pre-connect all stdio MCPs
console.log('⏳ 预连接 stdio MCP...')
warmupStdioMcps().then(() => console.log('✓ MCP 预连接完成'))

// Start CRON scheduler
startCron()

// Resume EvoMap heartbeat if already registered
startHeartbeatLoop()

// Start Feishu WebSocket monitors for enabled channels
startAllFeishuMonitors()

const app = new Hono()

app.use('/api/*', cors())

// ─── Lifecycle sweep middleware ───
app.use('/api/*', async (c, next) => {
  sweepLifecycle()
  await next()
})

// ─── 记忆回溯：自动快照中间件 ───
app.use('/api/*', async (c, next) => {
  const method = c.req.method
  const path = c.req.path
  if (shouldSnapshot(method, path)) {
    const action = describeAction(method, path)
    recordSnapshot(action)
  }
  await next()
})

// ═══════════════════════════════════
//  System
// ═══════════════════════════════════
app.get('/api/status', (c) => {
  const status = getSystemStatus()
  const { bypass } = loadStore()
  const tasks = listTasks(5)
  const cache = getCacheStats()
  return c.json({ ...status, bypass, recentTasks: tasks, cache })
})

// ═══════════════════════════════════
//  Models
// ═══════════════════════════════════
app.get('/api/models', (c) => c.json(listModels()))

app.post('/api/models', async (c) => {
  const body = await c.req.json()
  const model = addModel({
    name: body.name,
    provider: body.provider,
    capabilities: body.capabilities ?? [],
    costTier: body.costTier ?? 'medium',
    apiKey: body.apiKey,
    apiKeyEnv: body.apiKeyEnv,
    baseUrl: body.baseUrl,
    defaultParams: body.defaultParams,
  })
  return c.json(model, 201)
})

app.patch('/api/models/:id', async (c) => {
  const body = await c.req.json()
  const ok = modifyModel(c.req.param('id'), body)
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json(getModel(c.req.param('id')))
})

app.delete('/api/models/:id', (c) => {
  const ok = removeModel(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

// ═══════════════════════════════════
//  Skills
// ═══════════════════════════════════
app.get('/api/skills', (c) => c.json(listSkills()))

// Upload must be registered before POST /api/skills to avoid route conflicts
app.post('/api/skills/upload', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || typeof file === 'string') return c.json({ error: 'file required' }, 400)

  const { parseSkillArchive } = await import('./skill-upload.js')
  try {
    const parsed = await parseSkillArchive(file)
    const skill = addSkill({
      name: parsed.name,
      description: parsed.description,
      promptTemplate: parsed.promptTemplate,
      requiredMcps: parsed.requiredMcps ?? [],
      compatibleModels: ['*'],
    })
    return c.json(skill, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'upload failed' }, 400)
  }
})

app.post('/api/skills/import-url', async (c) => {
  const body = await c.req.json()
  const { url } = body
  if (!url || typeof url !== 'string') return c.json({ error: 'url required' }, 400)

  const { fetchSkillFromUrl } = await import('./skill-upload.js')
  try {
    const parsed = await fetchSkillFromUrl(url)
    const skill = addSkill({
      name: parsed.name,
      description: parsed.description,
      promptTemplate: parsed.promptTemplate,
      requiredMcps: parsed.requiredMcps ?? [],
      compatibleModels: ['*'],
    })
    return c.json(skill, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'import failed' }, 400)
  }
})

app.post('/api/skills', async (c) => {
  const body = await c.req.json()
  const skill = addSkill({
    name: body.name,
    description: body.description ?? '',
    promptTemplate: body.promptTemplate ?? '',
    requiredMcps: body.requiredMcps,
    compatibleModels: body.compatibleModels,
  })
  return c.json(skill, 201)
})

app.patch('/api/skills/:id', async (c) => {
  const body = await c.req.json()
  const ok = modifySkill(c.req.param('id'), body)
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json(getSkill(c.req.param('id')))
})

app.delete('/api/skills/:id', (c) => {
  const ok = removeSkill(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

// ═══════════════════════════════════
//  MCPs
// ═══════════════════════════════════
app.get('/api/mcps', (c) => c.json(listMcps()))

app.post('/api/mcps', async (c) => {
  const body = await c.req.json()
  const mcp = addMcp({
    name: body.name,
    description: body.description ?? '',
    transport: (body.transport ?? 'stdio') as McpTransport,
    command: body.command,
    args: body.args,
    url: body.url,
    env: body.env,
  })
  return c.json(mcp, 201)
})

app.patch('/api/mcps/:id', async (c) => {
  const body = await c.req.json()
  const ok = modifyMcp(c.req.param('id'), body)
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json(getMcp(c.req.param('id')))
})

app.delete('/api/mcps/:id', (c) => {
  const ok = removeMcp(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

// ─── Local MCP Scanner ───
app.post('/api/mcps/import-json', async (c) => {
  const body = await c.req.json()
  const { mcpServers } = body as { mcpServers?: Record<string, any> }
  if (!mcpServers || typeof mcpServers !== 'object') {
    return c.json({ error: 'mcpServers object required' }, 400)
  }
  const imported: any[] = []
  for (const [name, cfg] of Object.entries(mcpServers)) {
    const mcp = addMcp({
      name,
      description: cfg.description ?? `JSON 导入: ${name}`,
      transport: cfg.url ? 'sse' : 'stdio',
      command: cfg.command,
      args: cfg.args ?? [],
      url: cfg.url,
      env: cfg.env ?? {},
    })
    imported.push(mcp)
  }
  return c.json(imported, 201)
})

app.get('/api/local-mcps', (c) => {
  const entries = scanLocalMcps()
  const sources = getLocalMcpSources()
  return c.json({ entries, sources })
})

app.post('/api/local-mcps/import', async (c) => {
  const body = await c.req.json()
  const { name, command, args, env } = body
  if (!name || !command) return c.json({ error: 'name and command required' }, 400)
  const mcp = addMcp({
    name,
    description: body.description ?? `从本地导入: ${name}`,
    transport: 'stdio',
    command,
    args: args ?? [],
    env: env ?? {},
  })
  return c.json(mcp, 201)
})

// ═══════════════════════════════════
//  Agents
// ═══════════════════════════════════
app.get('/api/agents', (c) => {
  const includeDestroyed = c.req.query('all') === 'true'
  return c.json(listAgents(includeDestroyed))
})

app.get('/api/agents/:id', (c) => {
  const agent = getAgent(c.req.param('id'))
  if (!agent) return c.json({ error: 'not found' }, 404)
  const model = getModel(agent.modelId)
  return c.json({ ...agent, model })
})

app.post('/api/agents', async (c) => {
  const body = await c.req.json()
  const agent = createAgent({
    name: body.name,
    description: body.description ?? '',
    modelId: body.modelId,
    skillIds: body.skillIds ?? [],
    mcpIds: body.mcpIds ?? [],
    systemPrompt: body.systemPrompt,
    ttl: body.ttl,
    idleTimeout: body.idleTimeout,
    autoRenew: body.autoRenew,
  })
  return c.json(agent, 201)
})

app.patch('/api/agents/:id', async (c) => {
  const body = await c.req.json()
  const ok = modifyAgent(c.req.param('id'), body)
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json(getAgent(c.req.param('id')))
})

app.delete('/api/agents/:id', (c) => {
  const agent = getAgent(c.req.param('id'))
  if (!agent) return c.json({ error: 'not found' }, 404)
  if (isProtectedAgent(agent)) return c.json({ error: '受保护的核心 Agent，不能销毁' }, 403)
  const ok = destroyAgent(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

// ═══════════════════════════════════
//  Tasks
// ═══════════════════════════════════
app.get('/api/tasks', (c) => {
  const limit = parseInt(c.req.query('limit') ?? '20')
  return c.json(listTasks(limit))
})

app.get('/api/tasks/:id', (c) => {
  const task = getTask(c.req.param('id'))
  if (!task) return c.json({ error: 'not found' }, 404)
  return c.json(task)
})

app.get('/api/tasks/:id/trace', (c) => {
  const spans = getTaskTrace(c.req.param('id'))
  return c.json(spans)
})

app.delete('/api/tasks/:id', (c) => {
  const ok = deleteTask(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

app.post('/api/tasks', async (c) => {
  const body = await c.req.json()
  let agentId = body.agentId

  if (!agentId) {
    const matched = matchAgent(body.prompt ?? '')
    if (matched) {
      agentId = matched.id
    } else {
      const agents = listAgents().filter((a) => a.state !== 'destroyed')
      if (agents.length === 0) return c.json({ error: 'no agents available' }, 400)
      agentId = agents[0].id
    }
  }

  const task = await dispatch(agentId, body.prompt)
  return c.json(task, 201)
})

// ═══════════════════════════════════
//  Chat (SSE streaming)
// ═══════════════════════════════════
app.post('/api/chat', async (c) => {
  const body = await c.req.json()
  const { messages } = body as { messages: ChatMessage[] }

  if (!messages?.length) return c.json({ error: 'messages required' }, 400)

  // Always route to Genesis — it decides delegation via dispatch_to_agent tool
  const agents = listAgents().filter((a) => a.state !== 'destroyed')
  const genesis = agents.find((a) => a.id === 'genesis')
  const targetAgent = genesis || agents[0]

  if (!targetAgent) return c.json({ error: 'no agents available' }, 400)

  return streamSSE(c, async (stream) => {
    const abortController = new AbortController()
    stream.onAbort(() => {
      console.log('[chat] client disconnected, aborting')
      abortController.abort()
    })
    try {
      // Send agent info marker
      await stream.writeSSE({ data: `[AGENT_INFO:${targetAgent.id}|${targetAgent.name}]` })

      for await (const chunk of streamTask(targetAgent.id, messages, undefined, abortController.signal)) {
        if (abortController.signal.aborted) break
        await stream.writeSSE({ data: JSON.stringify(chunk) })
      }
      if (!abortController.signal.aborted) {
        await stream.writeSSE({ data: '[DONE]' })
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        await stream.writeSSE({ data: `[ERROR] ${err instanceof Error ? err.message : err}` })
      }
    }
  })
})

// ═══════════════════════════════════
//  Bypass
// ═══════════════════════════════════
app.get('/api/bypass', (c) => c.json(loadStore().bypass))

app.post('/api/bypass/enable', (c) => {
  updateStore((s) => { s.bypass.enabled = true })
  return c.json({ ok: true })
})

app.post('/api/bypass/disable', (c) => {
  updateStore((s) => { s.bypass.enabled = false })
  return c.json({ ok: true })
})

// ═══════════════════════════════════
//  Agent Graph
// ═══════════════════════════════════
app.get('/api/graphs', (c) => c.json(listGraphs()))

app.get('/api/graphs/:id', (c) => {
  const graph = getGraph(c.req.param('id'))
  if (!graph) return c.json({ error: 'not found' }, 404)
  return c.json(graph)
})

app.post('/api/graphs', async (c) => {
  const body = await c.req.json()
  const graph = createGraph({
    name: body.name,
    description: body.description ?? '',
    nodes: body.nodes ?? [],
    edges: body.edges ?? [],
  })
  return c.json(graph, 201)
})

app.patch('/api/graphs/:id', async (c) => {
  const body = await c.req.json()
  const ok = modifyGraph(c.req.param('id'), body)
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json(getGraph(c.req.param('id')))
})

app.delete('/api/graphs/:id', (c) => {
  const ok = removeGraph(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

app.post('/api/graphs/:id/execute', async (c) => {
  const body = await c.req.json()
  const graphId = c.req.param('id')
  const input = body.input ?? ''

  return streamSSE(c, async (stream) => {
    try {
      await executeGraph(graphId, input, async (event) => {
        await stream.writeSSE({ data: JSON.stringify(event) })
      })
    } catch (err) {
      await stream.writeSSE({ data: JSON.stringify({ type: 'node_error', error: err instanceof Error ? err.message : String(err) }) })
    }
  })
})

// ═══════════════════════════════════
//  ClawHub
// ═══════════════════════════════════
app.get('/api/clawhub/search', async (c) => {
  const q = c.req.query('q') ?? ''
  if (!q) return c.json([])
  try {
    const results = await clawHubSearch(q)
    return c.json(results)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'search failed' }, 502)
  }
})

app.get('/api/clawhub/skills/:slug', async (c) => {
  try {
    const info = await clawHubInfo(c.req.param('slug'))
    return c.json(info)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'fetch failed' }, 502)
  }
})

app.post('/api/clawhub/install', async (c) => {
  const body = await c.req.json()
  const { slug } = body
  try {
    const info = await clawHubInfo(slug)
    if (!info) return c.json({ error: 'skill not found' }, 404)

    const skill = addSkill({
      name: info.displayName || slug,
      description: info.summary ?? `Installed from ClawHub: ${slug}`,
      promptTemplate: info.summary ?? '',
      requiredMcps: [],
      compatibleModels: ['*'],
    })
    return c.json({ ...skill, source: 'clawhub', slug }, 201)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'install failed' }, 502)
  }
})

// ═══════════════════════════════════
//  CRON 定时任务
// ═══════════════════════════════════
app.get('/api/cron', (c) => c.json(listCronJobs()))

app.post('/api/cron', async (c) => {
  const body = await c.req.json()
  if (!body.name || !body.schedule || !body.agentId || !body.prompt) {
    return c.json({ error: 'name, schedule, agentId, prompt required' }, 400)
  }
  const job = addCronJob({
    name: body.name,
    schedule: body.schedule,
    agentId: body.agentId,
    prompt: body.prompt,
    enabled: body.enabled ?? true,
  })
  return c.json(job, 201)
})

app.patch('/api/cron/:id', async (c) => {
  const body = await c.req.json()
  const job = updateCronJob(c.req.param('id'), body)
  if (!job) return c.json({ error: 'not found' }, 404)
  return c.json(job)
})

app.delete('/api/cron/:id', (c) => {
  const ok = removeCronJob(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

// ═══════════════════════════════════
//  Channels (IM Bot Integration)
// ═══════════════════════════════════
app.get('/api/channels', (c) => c.json(listChannels()))

app.post('/api/channels', async (c) => {
  const body = await c.req.json()
  if (!body.name || !body.type || !body.agentId) {
    return c.json({ error: 'name, type, agentId required' }, 400)
  }
  const channel = addChannel({
    name: body.name,
    type: body.type,
    enabled: body.enabled ?? true,
    agentId: body.agentId,
    config: body.config || {},
  })
  return c.json(channel, 201)
})

app.patch('/api/channels/:id', async (c) => {
  const body = await c.req.json()
  const ch = modifyChannel(c.req.param('id'), body)
  if (!ch) return c.json({ error: 'not found' }, 404)
  return c.json(ch)
})

app.delete('/api/channels/:id', (c) => {
  const ok = removeChannel(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

// Feishu event callback endpoint (legacy webhook mode)
app.post('/api/channels/:id/feishu/callback', async (c) => {
  const body = await c.req.json()
  const result = await handleFeishuEvent(c.req.param('id'), body)
  return c.json(result)
})

// Channel monitor control
app.post('/api/channels/:id/start', async (c) => {
  const ch = listChannels().find((x) => x.id === c.req.param('id'))
  if (!ch) return c.json({ error: 'not found' }, 404)
  const result = await startFeishuMonitor(ch)
  if (!result.ok) return c.json({ error: result.error, status: 'stopped' }, 500)
  return c.json({ ok: true, status: 'running' })
})

app.post('/api/channels/:id/stop', (c) => {
  stopFeishuMonitor(c.req.param('id'))
  return c.json({ ok: true, status: 'stopped' })
})

app.get('/api/channels/:id/status', (c) => {
  return c.json({ status: getFeishuMonitorStatus(c.req.param('id')) })
})

// Pairing management
app.get('/api/pairings', (c) => {
  const channelId = c.req.query('channelId')
  return c.json(listPairings(channelId || undefined))
})

app.post('/api/pairings/:code/approve', (c) => {
  const ok = approvePairing(c.req.param('code'))
  if (!ok) return c.json({ error: '配对码不存在或已处理' }, 404)
  return c.json({ ok: true })
})

app.post('/api/pairings/:code/reject', (c) => {
  const ok = rejectPairing(c.req.param('code'))
  if (!ok) return c.json({ error: '配对码不存在或已处理' }, 404)
  return c.json({ ok: true })
})

// Send message to channel (for testing / manual trigger)
app.post('/api/channels/:id/send', async (c) => {
  const body = await c.req.json()
  if (!body.text) return c.json({ error: 'text required' }, 400)
  try {
    await sendToChannel(c.req.param('id'), body.text)
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'send failed' }, 500)
  }
})

// Channel message log
app.get('/api/channel-messages', (c) => {
  const channelId = c.req.query('channelId')
  const conversationId = c.req.query('conversationId')
  const limit = parseInt(c.req.query('limit') ?? '50')
  let msgs = getChannelMessages(channelId || undefined, limit)
  if (conversationId) msgs = msgs.filter(m => m.conversationId === conversationId)
  return c.json(msgs)
})

app.get('/api/channel-conversations', (c) => {
  return c.json(getChannelConversations())
})

// SSE stream for real-time channel message updates
app.get('/api/channel-messages/stream', (c) => {
  return streamSSE(c, async (stream) => {
    let alive = true
    const unsub = subscribeChannelMessages(() => {
      if (!alive) return
      const recent = getChannelMessages(undefined, 1)
      if (recent.length > 0) {
        stream.writeSSE({ data: JSON.stringify(recent[recent.length - 1]) }).catch(() => { alive = false })
      }
    })
    // Keep alive
    while (alive) {
      await stream.writeSSE({ data: '"ping"' })
      await new Promise(r => setTimeout(r, 15000))
    }
    unsub()
  })
})

// ═══════════════════════════════════
//  记忆回溯（Snapshots）
// ═══════════════════════════════════
app.get('/api/snapshots', (c) => {
  const limit = parseInt(c.req.query('limit') ?? '50')
  const offset = parseInt(c.req.query('offset') ?? '0')
  const items = listSnapshots(limit, offset)
  const total = getSnapshotCount()
  return c.json({ items, total })
})

app.get('/api/snapshots/config', (c) => {
  return c.json(getSnapshotConfig())
})

app.patch('/api/snapshots/config', async (c) => {
  const body = await c.req.json()
  updateStore((s) => {
    if (!s.snapshot) s.snapshot = { enabled: true, maxVersions: 10 }
    if (typeof body.enabled === 'boolean') s.snapshot.enabled = body.enabled
    if (typeof body.maxVersions === 'number') {
      s.snapshot.maxVersions = Math.max(3, Math.min(200, Math.round(body.maxVersions)))
    }
  })
  return c.json(getSnapshotConfig())
})

app.get('/api/snapshots/:id', (c) => {
  const snap = getSnapshot(parseInt(c.req.param('id')))
  if (!snap) return c.json({ error: 'not found' }, 404)
  const diff = diffSnapshot(snap.id)
  return c.json({ id: snap.id, action: snap.action, summary: snap.summary, created_at: snap.created_at, diff: diff.diff ?? {} })
})

app.get('/api/snapshots/:id/diff', (c) => {
  const result = diffSnapshot(parseInt(c.req.param('id')))
  if (!result.ok) return c.json({ error: result.error }, 404)
  return c.json(result.diff)
})

app.post('/api/snapshots/:id/restore', (c) => {
  const result = restoreSnapshot(parseInt(c.req.param('id')))
  if (!result.ok) return c.json({ error: result.error }, 404)
  return c.json({ ok: true, message: `已恢复到快照 #${c.req.param('id')}` })
})

// ─── File Snapshots ───

app.get('/api/file-snapshots', (c) => {
  const limit = parseInt(c.req.query('limit') || '50')
  const offset = parseInt(c.req.query('offset') || '0')
  const items = listFileSnapshots(limit, offset)
  const total = getFileSnapshotCount()
  return c.json({ items, total })
})

app.post('/api/file-snapshots/:id/restore', (c) => {
  const result = restoreFileSnapshot(parseInt(c.req.param('id')))
  if (!result.ok) return c.json({ error: result.error }, 404)
  return c.json({ ok: true, path: result.path })
})

// ═══════════════════════════════════
//  Agent Memory Management
// ═══════════════════════════════════
app.get('/api/agents/:id/memory', (c) => {
  const agentId = c.req.param('id')
  const limit = parseInt(c.req.query('limit') ?? '100')
  const offset = parseInt(c.req.query('offset') ?? '0')
  const turns = listTurns(agentId, limit, offset)
  const summaries = listSummaries(agentId)
  const stats = getMemoryStats(agentId)
  return c.json({ turns, summaries, stats })
})

app.post('/api/agents/:id/memory/turns', async (c) => {
  const agentId = c.req.param('id')
  const body = await c.req.json()
  if (!body.user_message || !body.assistant_response) return c.json({ error: 'user_message and assistant_response required' }, 400)
  const turn = addTurn(agentId, body.user_message, body.assistant_response)
  return c.json(turn, 201)
})

app.patch('/api/agents/:id/memory/turns/:turnId', async (c) => {
  const body = await c.req.json()
  const ok = editTurn(c.req.param('id'), parseInt(c.req.param('turnId')), body)
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

app.delete('/api/agents/:id/memory/turns/:turnId', (c) => {
  const ok = deleteTurn(c.req.param('id'), parseInt(c.req.param('turnId')))
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

app.delete('/api/agents/:id/memory/summaries/:sumId', (c) => {
  const ok = deleteSummary(c.req.param('id'), parseInt(c.req.param('sumId')))
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

app.delete('/api/agents/:id/memory', (c) => {
  purgeAgentMemory(c.req.param('id'))
  return c.json({ ok: true })
})

app.get('/api/agents/:id/memory/graph', (c) => {
  const graph = extractKnowledgeGraph(c.req.param('id'))
  return c.json(graph)
})

// F4: Cross-Session Memory Search
app.get('/api/memory/search', (c) => {
  const q = c.req.query('q')
  if (!q) return c.json({ error: 'q parameter required' }, 400)
  const agentId = c.req.query('agentId')
  const limit = parseInt(c.req.query('limit') || '20')
  const results = agentId ? searchMemory(q, agentId, limit) : searchAllAgents(q, limit)
  return c.json(results)
})

// ═══════════════════════════════════
//  File download (for web chat file delivery)
// ═══════════════════════════════════
app.get('/api/files/download', async (c) => {
  const filePath = c.req.query('path')
  if (!filePath) return c.json({ error: 'path required' }, 400)

  const { resolve, basename } = await import('node:path')
  const fs = await import('node:fs')
  const resolved = resolve(filePath)

  if (!fs.existsSync(resolved)) return c.json({ error: 'file not found' }, 404)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) return c.json({ error: 'not a file' }, 400)

  const data = fs.readFileSync(resolved)
  const name = basename(resolved)
  c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`)
  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Length', String(stat.size))
  return c.body(data)
})

// ═══════════════════════════════════
//  Serve static frontend
// ═══════════════════════════════════
const __dirname = dirname(fileURLToPath(import.meta.url))
const webDist = join(__dirname, '..', 'web', 'dist')

if (existsSync(webDist)) {
  app.use('/*', serveStatic({ root: webDist, rewriteRequestPath: (p) => p }))
  app.get('*', async (c) => {
    const { readFileSync } = await import('node:fs')
    const html = readFileSync(join(webDist, 'index.html'), 'utf-8')
    return c.html(html)
  })
}

// ═══════════════════════════════════
//  Start
// ═══════════════════════════════════
const port = parseInt(process.env.PORT ?? '3000')

console.log(`NMClaw server running on http://localhost:${port}`)
serve({ fetch: app.fetch, port })
