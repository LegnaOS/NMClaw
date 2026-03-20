import { Command } from 'commander'
import { input, select, confirm, checkbox } from '@inquirer/prompts'
import chalk from 'chalk'
import ora from 'ora'

import { addModel, removeModel, listModels, getModel } from './model-registry.js'
import { addSkill, removeSkill, listSkills } from './skill-registry.js'
import { addMcp, removeMcp, listMcps } from './mcp-registry.js'
import {
  createAgent, destroyAgent, listAgents, getAgent,
  sweepLifecycle, modifyAgent,
} from './agent-manager.js'
import { matchAgent, dispatch, getSystemStatus } from './genesis.js'
import { listTasks, getTask, getTaskTrace } from './tracker.js'
import { requestPermission } from './permission.js'
import { loadStore, updateStore } from './store.js'
import type { CostTier, McpTransport } from './types.js'

const program = new Command()

program
  .name('nmclaw')
  .description('Agent 调度平台 — 创世Agent是内核，不是God Agent')
  .version('0.1.0')

// ─── Lifecycle sweep on every invocation ───
function runSweep() {
  const { expired, idled } = sweepLifecycle()
  if (idled.length > 0) {
    console.log(chalk.yellow(`⏳ ${idled.length} 个Agent进入idle状态`))
  }
  if (expired.length > 0) {
    console.log(chalk.red(`⚠️  ${expired.length} 个Agent已过期，等待销毁确认`))
  }
}

// ─── Helper: format time duration ───
function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000)
  if (hours >= 24) return `${Math.floor(hours / 24)}天${hours % 24}小时`
  if (hours > 0) return `${hours}小时`
  const mins = Math.floor(ms / 60000)
  return `${mins}分钟`
}

function stateLabel(state: string): string {
  switch (state) {
    case 'active': return chalk.green('● Active')
    case 'idle': return chalk.yellow('○ Idle')
    case 'pending_destroy': return chalk.red('◌ Pending Destroy')
    case 'destroyed': return chalk.gray('✕ Destroyed')
    default: return state
  }
}

// ═══════════════════════════════════════════
//  MODEL commands
// ═══════════════════════════════════════════
const modelCmd = program.command('model').description('模型库管理')

modelCmd.command('add').description('注册新模型').action(async () => {
  runSweep()

  const name = await input({ message: '模型名称 (如 claude-sonnet-4-6):' })
  const provider = await select({
    message: '提供商:',
    choices: [
      { value: 'anthropic', name: 'Anthropic (Claude)' },
      { value: 'openai', name: 'OpenAI' },
      { value: 'deepseek', name: 'DeepSeek' },
      { value: 'ollama', name: 'Ollama (本地)' },
      { value: 'other', name: '其他 (OpenAI兼容)' },
    ],
  })
  const capabilities = await input({ message: '能力标签 (逗号分隔, 如 reasoning,coding):' })
  const costTier = await select<CostTier>({
    message: '成本等级:',
    choices: [
      { value: 'free', name: 'Free (本地/免费)' },
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  })

  let apiKeyEnv: string | undefined
  let baseUrl: string | undefined

  if (provider !== 'ollama') {
    apiKeyEnv = await input({
      message: 'API Key 环境变量名 (如 ANTHROPIC_API_KEY):',
      default: provider === 'anthropic' ? 'ANTHROPIC_API_KEY'
        : provider === 'openai' ? 'OPENAI_API_KEY'
        : provider === 'deepseek' ? 'DEEPSEEK_API_KEY'
        : undefined,
    })
  }

  if (provider === 'ollama') {
    baseUrl = await input({ message: 'Ollama地址:', default: 'http://localhost:11434/v1' })
  } else if (provider === 'deepseek') {
    baseUrl = await input({ message: 'API Base URL:', default: 'https://api.deepseek.com/v1' })
  } else if (provider === 'other') {
    baseUrl = await input({ message: 'API Base URL:' })
  }

  const ok = await requestPermission('model:add', `注册模型 "${name}" (${provider})`)
  if (!ok) { console.log(chalk.gray('已取消')); return }

  const model = addModel({
    name,
    provider,
    capabilities: capabilities.split(',').map((s) => s.trim()).filter(Boolean),
    costTier,
    apiKeyEnv,
    baseUrl,
  })
  console.log(chalk.green(`✓ 模型已注册: ${model.id} (${model.name})`))
})

modelCmd.command('list').description('列出所有模型').action(() => {
  runSweep()
  const models = listModels()
  if (models.length === 0) {
    console.log(chalk.gray('暂无注册模型。使用 nmclaw model add 添加。'))
    return
  }
  console.log(chalk.bold('\n模型库:\n'))
  for (const m of models) {
    console.log(`  ${chalk.cyan(m.id)}  ${m.name}  [${m.provider}]  ${chalk.yellow(m.costTier)}  ${m.capabilities.join(', ')}`)
  }
  console.log()
})

modelCmd.command('remove').argument('<id>', '模型ID').description('移除模型').action(async (id: string) => {
  runSweep()
  const ok = await requestPermission('model:remove', `移除模型 ${id}`)
  if (!ok) return
  if (removeModel(id)) {
    console.log(chalk.green(`✓ 模型已移除: ${id}`))
  } else {
    console.log(chalk.red(`✗ 模型不存在: ${id}`))
  }
})

// ═══════════════════════════════════════════
//  SKILL commands
// ═══════════════════════════════════════════
const skillCmd = program.command('skill').description('技能库管理')

skillCmd.command('add').description('注册新技能').action(async () => {
  runSweep()
  const name = await input({ message: '技能名称:' })
  const description = await input({ message: '技能描述:' })
  const promptTemplate = await input({ message: 'Prompt模板 (支持 {{variable}} 占位符):' })
  const requiredMcpsRaw = await input({ message: '依赖的MCP (逗号分隔, 可留空):' })

  const ok = await requestPermission('skill:add', `注册技能 "${name}"`)
  if (!ok) { console.log(chalk.gray('已取消')); return }

  const skill = addSkill({
    name,
    description,
    promptTemplate,
    requiredMcps: requiredMcpsRaw ? requiredMcpsRaw.split(',').map((s) => s.trim()) : [],
  })
  console.log(chalk.green(`✓ 技能已注册: ${skill.id} (${skill.name})`))
})

skillCmd.command('list').description('列出所有技能').action(() => {
  runSweep()
  const skills = listSkills()
  if (skills.length === 0) {
    console.log(chalk.gray('暂无注册技能。使用 nmclaw skill add 添加。'))
    return
  }
  console.log(chalk.bold('\n技能库:\n'))
  for (const s of skills) {
    console.log(`  ${chalk.cyan(s.id)}  ${s.name}  ${chalk.gray(s.description)}`)
  }
  console.log()
})

skillCmd.command('remove').argument('<id>', '技能ID').description('移除技能').action(async (id: string) => {
  runSweep()
  const ok = await requestPermission('skill:remove', `移除技能 ${id}`)
  if (!ok) return
  if (removeSkill(id)) {
    console.log(chalk.green(`✓ 技能已移除: ${id}`))
  } else {
    console.log(chalk.red(`✗ 技能不存在: ${id}`))
  }
})

// ═══════════════════════════════════════════
//  MCP commands
// ═══════════════════════════════════════════
const mcpCmd = program.command('mcp').description('MCP库管理')

mcpCmd.command('add').description('注册新MCP').action(async () => {
  runSweep()
  const name = await input({ message: 'MCP名称:' })
  const description = await input({ message: 'MCP描述:' })
  const transport = await select<McpTransport>({
    message: '传输方式:',
    choices: [
      { value: 'stdio', name: 'stdio (本地进程)' },
      { value: 'sse', name: 'SSE (HTTP流)' },
      { value: 'streamable-http', name: 'Streamable HTTP' },
    ],
  })

  let command: string | undefined
  let args: string[] | undefined
  let url: string | undefined

  if (transport === 'stdio') {
    command = await input({ message: '启动命令 (如 npx):' })
    const argsRaw = await input({ message: '命令参数 (空格分隔):' })
    args = argsRaw ? argsRaw.split(/\s+/) : []
  } else {
    url = await input({ message: '服务URL:' })
  }

  const ok = await requestPermission('mcp:add', `注册MCP "${name}"`)
  if (!ok) { console.log(chalk.gray('已取消')); return }

  const mcp = addMcp({ name, description, transport, command, args, url })
  console.log(chalk.green(`✓ MCP已注册: ${mcp.id} (${mcp.name})`))
})

mcpCmd.command('list').description('列出所有MCP').action(() => {
  runSweep()
  const mcps = listMcps()
  if (mcps.length === 0) {
    console.log(chalk.gray('暂无注册MCP。使用 nmclaw mcp add 添加。'))
    return
  }
  console.log(chalk.bold('\nMCP库:\n'))
  for (const m of mcps) {
    console.log(`  ${chalk.cyan(m.id)}  ${m.name}  [${m.transport}]  ${chalk.gray(m.description)}`)
  }
  console.log()
})

mcpCmd.command('remove').argument('<id>', 'MCP ID').description('移除MCP').action(async (id: string) => {
  runSweep()
  const ok = await requestPermission('mcp:remove', `移除MCP ${id}`)
  if (!ok) return
  if (removeMcp(id)) {
    console.log(chalk.green(`✓ MCP已移除: ${id}`))
  } else {
    console.log(chalk.red(`✗ MCP不存在: ${id}`))
  }
})

// ═══════════════════════════════════════════
//  AGENT commands
// ═══════════════════════════════════════════
const agentCmd = program.command('agent').description('Agent管理')

agentCmd.command('create').description('创建Worker Agent').action(async () => {
  runSweep()
  const models = listModels()
  if (models.length === 0) {
    console.log(chalk.red('请先注册至少一个模型: nmclaw model add'))
    return
  }

  const name = await input({ message: 'Agent名称:' })
  const description = await input({ message: 'Agent职责描述:' })

  const modelId = await select({
    message: '选择模型:',
    choices: models.map((m) => ({
      value: m.id,
      name: `${m.name} [${m.provider}] (${m.costTier})`,
    })),
  })

  const skills = listSkills()
  let skillIds: string[] = []
  if (skills.length > 0) {
    skillIds = await checkbox({
      message: '选择技能 (可多选):',
      choices: skills.map((s) => ({ value: s.id, name: `${s.name} — ${s.description}` })),
    })
  }

  const mcps = listMcps()
  let mcpIds: string[] = []
  if (mcps.length > 0) {
    mcpIds = await checkbox({
      message: '选择MCP (可多选):',
      choices: mcps.map((m) => ({ value: m.id, name: `${m.name} [${m.transport}]` })),
    })
  }

  const systemPrompt = await input({ message: '系统提示词 (可留空):' })

  const ttlDays = await input({ message: 'TTL天数 (默认7):', default: '7' })
  const idleHours = await input({ message: '空闲超时小时数 (默认24):', default: '24' })

  const model = getModel(modelId)
  const ok = await requestPermission(
    'agent:create',
    `创建Agent "${name}" (模型: ${model?.name}, 技能: ${skillIds.length}个, MCP: ${mcpIds.length}个)`,
    { costTier: model?.costTier }
  )
  if (!ok) { console.log(chalk.gray('已取消')); return }

  const agent = createAgent({
    name,
    description,
    modelId,
    skillIds,
    mcpIds,
    systemPrompt: systemPrompt || undefined,
    ttl: parseInt(ttlDays) * 24 * 60 * 60 * 1000,
    idleTimeout: parseInt(idleHours) * 60 * 60 * 1000,
  })

  console.log(chalk.green(`\n✓ Agent已创建`))
  console.log(`  ID:    ${chalk.cyan(agent.id)}`)
  console.log(`  名称:  ${agent.name}`)
  console.log(`  模型:  ${model?.name}`)
  console.log(`  TTL:   ${ttlDays}天`)
  console.log()
})

agentCmd.command('list').description('列出所有Agent').action(() => {
  runSweep()
  const agents = listAgents(true)
  if (agents.length === 0) {
    console.log(chalk.gray('暂无Agent。使用 nmclaw agent create 创建。'))
    return
  }
  console.log(chalk.bold('\nAgent列表:\n'))
  const now = Date.now()
  for (const a of agents) {
    const model = getModel(a.modelId)
    const ttlLeft = a.lifecycle.ttl - (now - a.createdAt)
    const idleTime = now - a.lastActiveAt
    console.log(`  ${stateLabel(a.state)}  ${chalk.cyan(a.id)}  ${a.name}`)
    console.log(`         模型: ${model?.name ?? '?'}  技能: ${a.skillIds.length}  MCP: ${a.mcpIds.length}`)
    if (a.state !== 'destroyed') {
      console.log(`         TTL剩余: ${formatDuration(Math.max(0, ttlLeft))}  空闲: ${formatDuration(idleTime)}`)
    }
    console.log()
  }
})

agentCmd.command('info').argument('<id>', 'Agent ID').description('查看Agent详情').action((id: string) => {
  runSweep()
  const agent = getAgent(id)
  if (!agent) { console.log(chalk.red(`Agent不存在: ${id}`)); return }

  const model = getModel(agent.modelId)
  const now = Date.now()

  console.log(chalk.bold(`\nAgent: ${agent.name}\n`))
  console.log(`  ID:          ${chalk.cyan(agent.id)}`)
  console.log(`  状态:        ${stateLabel(agent.state)}`)
  console.log(`  描述:        ${agent.description}`)
  console.log(`  模型:        ${model?.name ?? '?'} [${model?.provider ?? '?'}]`)
  console.log(`  技能:        ${agent.skillIds.length > 0 ? agent.skillIds.join(', ') : '无'}`)
  console.log(`  MCP:         ${agent.mcpIds.length > 0 ? agent.mcpIds.join(', ') : '无'}`)
  console.log(`  TTL:         ${formatDuration(agent.lifecycle.ttl)} (剩余 ${formatDuration(Math.max(0, agent.lifecycle.ttl - (now - agent.createdAt)))})`)
  console.log(`  空闲超时:    ${formatDuration(agent.lifecycle.idleTimeout)}`)
  console.log(`  上次活跃:    ${formatDuration(now - agent.lastActiveAt)}前`)
  console.log(`  创建时间:    ${new Date(agent.createdAt).toLocaleString()}`)
  if (agent.systemPrompt) {
    console.log(`  系统提示词:  ${agent.systemPrompt.slice(0, 100)}${agent.systemPrompt.length > 100 ? '...' : ''}`)
  }
  console.log()
})

agentCmd.command('destroy').argument('<id>', 'Agent ID').description('销毁Agent').action(async (id: string) => {
  runSweep()
  const agent = getAgent(id)
  if (!agent) { console.log(chalk.red(`Agent不存在: ${id}`)); return }

  const ok = await requestPermission('agent:destroy', `销毁Agent "${agent.name}" (${id})`)
  if (!ok) { console.log(chalk.gray('已取消')); return }

  if (destroyAgent(id)) {
    console.log(chalk.green(`✓ Agent已销毁: ${agent.name} (${id})`))
  }
})

// ═══════════════════════════════════════════
//  TASK commands
// ═══════════════════════════════════════════
const taskCmd = program.command('task').description('任务管理')

taskCmd.command('run').argument('<prompt>', '任务描述').option('-a, --agent <id>', '指定Agent').description('派发任务').action(async (prompt: string, opts: { agent?: string }) => {
  runSweep()

  let agentId = opts.agent

  if (!agentId) {
    // Genesis: auto-match
    const matched = matchAgent(prompt)
    if (matched) {
      console.log(chalk.gray(`创世Agent匹配到: ${matched.name} (${matched.id})`))
      const useIt = await confirm({ message: `使用 "${matched.name}" 执行此任务?`, default: true })
      if (useIt) {
        agentId = matched.id
      }
    }

    if (!agentId) {
      // Manual selection
      const agents = listAgents().filter((a) => a.state !== 'destroyed')
      if (agents.length === 0) {
        console.log(chalk.red('没有可用的Agent。请先创建: nmclaw agent create'))
        return
      }
      agentId = await select({
        message: '选择执行Agent:',
        choices: agents.map((a) => {
          const model = getModel(a.modelId)
          return { value: a.id, name: `${a.name} [${model?.name ?? '?'}] ${stateLabel(a.state)}` }
        }),
      })
    }
  }

  const ok = await requestPermission('task:dispatch', `派发任务到Agent ${agentId}`)
  if (!ok) { console.log(chalk.gray('已取消')); return }

  const spinner = ora('执行中...').start()
  try {
    const task = await dispatch(agentId, prompt)
    spinner.stop()

    if (task.status === 'completed') {
      console.log(chalk.green(`\n✓ 任务完成 (${task.tokensUsed ?? 0} tokens)\n`))
      console.log(task.output)
      console.log()
    } else {
      console.log(chalk.red(`\n✗ 任务失败: ${task.error}\n`))
    }
  } catch (err) {
    spinner.stop()
    console.log(chalk.red(`\n✗ 执行错误: ${err instanceof Error ? err.message : err}\n`))
  }
})

taskCmd.command('list').description('列出最近任务').action(() => {
  runSweep()
  const tasks = listTasks()
  if (tasks.length === 0) {
    console.log(chalk.gray('暂无任务记录。'))
    return
  }
  console.log(chalk.bold('\n最近任务:\n'))
  for (const t of tasks) {
    const agent = getAgent(t.agentId)
    const status = t.status === 'completed' ? chalk.green('✓')
      : t.status === 'failed' ? chalk.red('✗')
      : t.status === 'running' ? chalk.yellow('⟳')
      : chalk.gray('…')
    console.log(`  ${status}  ${chalk.cyan(t.id)}  ${agent?.name ?? '?'}  ${t.prompt.slice(0, 60)}`)
    if (t.tokensUsed) console.log(`     ${chalk.gray(`${t.tokensUsed} tokens`)}`)
  }
  console.log()
})

taskCmd.command('trace').argument('<id>', '任务ID').description('查看任务执行追踪').action((id: string) => {
  runSweep()
  const task = getTask(id)
  if (!task) { console.log(chalk.red(`任务不存在: ${id}`)); return }

  const spans = getTaskTrace(id)
  const agent = getAgent(task.agentId)

  console.log(chalk.bold(`\n任务追踪: ${id}\n`))
  console.log(`  Agent:  ${agent?.name ?? '?'}`)
  console.log(`  状态:   ${task.status}`)
  console.log(`  Prompt: ${task.prompt.slice(0, 100)}`)
  console.log()

  if (spans.length === 0) {
    console.log(chalk.gray('  无追踪数据'))
  } else {
    for (const span of spans) {
      console.log(`  ${chalk.gray('├─')} ${chalk.yellow(span.action)}  ${span.durationMs}ms  ${span.tokensUsed ? `${span.tokensUsed} tokens` : ''}`)
      if (span.output) {
        console.log(`  ${chalk.gray('│')}  ${span.output.slice(0, 200)}`)
      }
    }
  }
  console.log()
})

// ═══════════════════════════════════════════
//  BYPASS commands
// ═══════════════════════════════════════════
const bypassCmd = program.command('bypass').description('Bypass模式管理')

bypassCmd.command('enable').description('开启Bypass模式').action(() => {
  updateStore((s) => { s.bypass.enabled = true })
  console.log(chalk.green('✓ Bypass模式已开启'))
})

bypassCmd.command('disable').description('关闭Bypass模式').action(() => {
  updateStore((s) => { s.bypass.enabled = false })
  console.log(chalk.green('✓ Bypass模式已关闭'))
})

bypassCmd.command('status').description('查看Bypass状态').action(() => {
  const { bypass } = loadStore()
  console.log(chalk.bold('\nBypass模式:\n'))
  console.log(`  状态: ${bypass.enabled ? chalk.green('开启') : chalk.gray('关闭')}`)
  console.log(`  规则:`)
  if (bypass.rules.autoCreateMaxCostTier) {
    console.log(`    自动创建Agent (最高成本: ${bypass.rules.autoCreateMaxCostTier})`)
  }
  if (bypass.rules.autoDestroyIdleHours) {
    console.log(`    自动销毁空闲Agent (${bypass.rules.autoDestroyIdleHours}小时)`)
  }
  if (bypass.rules.autoDispatchReadOnly) {
    console.log(`    自动派发只读任务`)
  }
  console.log(`  永不Bypass: ${bypass.neverBypass.join(', ')}`)
  console.log()
})

// ═══════════════════════════════════════════
//  STATUS / DASHBOARD
// ═══════════════════════════════════════════
program.command('status').description('系统状态总览').action(() => {
  runSweep()
  const status = getSystemStatus()
  const { bypass } = loadStore()
  const tasks = listTasks(5)

  console.log(chalk.bold('\n═══ NMClaw 控制面板 ═══\n'))

  console.log(chalk.bold('  Agent'))
  console.log(`    Active: ${chalk.green(String(status.agents.active))}  Idle: ${chalk.yellow(String(status.agents.idle))}  Pending: ${chalk.red(String(status.agents.pendingDestroy))}  Destroyed: ${chalk.gray(String(status.agents.destroyed))}`)
  console.log()

  console.log(chalk.bold('  资源库'))
  console.log(`    模型: ${status.models}  技能: ${status.skills}  MCP: ${listMcps().length}`)
  console.log()

  console.log(chalk.bold('  Bypass'))
  console.log(`    ${bypass.enabled ? chalk.green('开启') : chalk.gray('关闭')}`)
  console.log()

  if (tasks.length > 0) {
    console.log(chalk.bold('  最近任务'))
    for (const t of tasks.slice(-3)) {
      const s = t.status === 'completed' ? chalk.green('✓') : t.status === 'failed' ? chalk.red('✗') : chalk.yellow('⟳')
      console.log(`    ${s} ${t.prompt.slice(0, 50)}  ${t.tokensUsed ? chalk.gray(`${t.tokensUsed}t`) : ''}`)
    }
  }

  console.log()
})

program.parse()
