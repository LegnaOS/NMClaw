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

import { addModel, removeModel, listModels, getModel } from './model-registry.js'
import { addSkill, removeSkill, listSkills, getSkill } from './skill-registry.js'
import { addMcp, removeMcp, listMcps, getMcp } from './mcp-registry.js'
import {
  createAgent, destroyAgent, listAgents, getAgent,
  sweepLifecycle, modifyAgent, touchAgent,
} from './agent-manager.js'
import { matchAgent, dispatch, getSystemStatus } from './genesis.js'
import { listTasks, getTask, getTaskTrace, deleteTask } from './tracker.js'
import { streamTask } from './executor.js'
import { createGraph, listGraphs, getGraph, removeGraph, executeGraph } from './graph.js'
import { searchSkills as clawHubSearch, getSkillInfo as clawHubInfo } from './clawhub.js'
import { scanLocalMcps, getLocalMcpSources } from './local-mcp-scanner.js'
import { loadStore, updateStore } from './store.js'
import { seedDefaults } from './seed.js'
import { warmupStdioMcps } from './mcp-runtime.js'
import { startCron, listCronJobs, addCronJob, removeCronJob, toggleCronJob } from './cron.js'
import type { CostTier, McpTransport, ChatMessage } from './types.js'

// Seed default models & agents on first run
seedDefaults()

// Pre-connect all stdio MCPs
console.log('⏳ 预连接 stdio MCP...')
warmupStdioMcps().then(() => console.log('✓ MCP 预连接完成'))

// Start CRON scheduler
startCron()

const app = new Hono()

app.use('/api/*', cors())

// ─── Lifecycle sweep middleware ───
app.use('/api/*', async (c, next) => {
  sweepLifecycle()
  await next()
})

// ═══════════════════════════════════
//  System
// ═══════════════════════════════════
app.get('/api/status', (c) => {
  const status = getSystemStatus()
  const { bypass } = loadStore()
  const tasks = listTasks(5)
  return c.json({ ...status, bypass, recentTasks: tasks })
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
    apiKeyEnv: body.apiKeyEnv,
    baseUrl: body.baseUrl,
    defaultParams: body.defaultParams,
  })
  return c.json(model, 201)
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

app.delete('/api/mcps/:id', (c) => {
  const ok = removeMcp(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
})

// ─── Local MCP Scanner ───
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

  // Genesis routing: find best worker for the last user message
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
  const matched = matchAgent(lastUserMsg?.content ?? '')

  const agents = listAgents().filter((a) => a.state !== 'destroyed')
  const genesis = agents.find((a) => a.id === 'genesis')
  const targetAgent = matched || genesis || agents[0]

  if (!targetAgent) return c.json({ error: 'no agents available' }, 400)

  return streamSSE(c, async (stream) => {
    try {
      // Show routing info if dispatched to a worker
      if (targetAgent.id !== 'genesis' && matched) {
        await stream.writeSSE({ data: `[${targetAgent.name} 处理中]\n\n` })
      }

      for await (const chunk of streamTask(targetAgent.id, messages)) {
        await stream.writeSSE({ data: chunk })
      }
      await stream.writeSSE({ data: '[DONE]' })
    } catch (err) {
      await stream.writeSSE({ data: `[ERROR] ${err instanceof Error ? err.message : err}` })
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
  const ok = toggleCronJob(c.req.param('id'), body.enabled)
  if (!ok) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

app.delete('/api/cron/:id', (c) => {
  const ok = removeCronJob(c.req.param('id'))
  return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404)
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
