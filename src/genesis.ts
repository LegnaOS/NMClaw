import { listAgents, getAgent } from './agent-manager.js'
import { getModel, listModels } from './model-registry.js'
import { listSkills } from './skill-registry.js'
import { executeTask } from './executor.js'
import { createTask, updateTask, addSpan } from './tracker.js'
import type { AgentConfig, Task } from './types.js'

/**
 * Genesis Agent — the kernel.
 * It doesn't think. It routes.
 * It doesn't execute. It dispatches.
 */

/** Find the best available agent for a given prompt (simple keyword matching for MVP) */
export function matchAgent(prompt: string): AgentConfig | undefined {
  const agents = listAgents().filter((a) => (a.state === 'active' || a.state === 'idle') && a.id !== 'genesis')
  if (agents.length === 0) return undefined

  const lower = prompt.toLowerCase()

  // Score each agent by keyword overlap with description + skills
  let best: AgentConfig | undefined
  let bestScore = 0

  for (const agent of agents) {
    let score = 0
    const desc = agent.description.toLowerCase()
    const name = agent.name.toLowerCase()

    // Simple word overlap scoring
    for (const word of lower.split(/\s+/)) {
      if (word.length < 2) continue
      if (desc.includes(word)) score += 2
      if (name.includes(word)) score += 3
    }

    // Boost agents with skills
    if (agent.skillIds.length > 0) score += 1

    if (score > bestScore) {
      bestScore = score
      best = agent
    }
  }

  return best
}

/** Dispatch a task to a specific agent */
export async function dispatch(agentId: string, prompt: string): Promise<Task> {
  const agent = getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)

  const model = getModel(agent.modelId)
  if (!model) throw new Error(`Model ${agent.modelId} not found`)

  const task = createTask(agentId, prompt)
  const start = Date.now()

  updateTask(task.id, { status: 'running' })

  const dispatchSpan = addSpan({
    taskId: task.id,
    agentId,
    action: 'dispatch',
    type: 'dispatch',
    name: agent.name,
    input: prompt,
    timestamp: start,
    durationMs: 0,
    status: 'success',
  })

  try {
    const result = await executeTask(agentId, prompt, (step) => {
      addSpan({
        taskId: task.id,
        parentSpanId: dispatchSpan.spanId,
        agentId,
        action: step.type === 'llm' ? 'llm_call' : 'tool_call',
        type: step.type,
        name: step.name,
        input: step.input,
        output: step.output,
        tokensUsed: step.tokens,
        durationMs: step.durationMs,
        timestamp: Date.now() - step.durationMs,
        status: step.status,
      })
    })

    const duration = Date.now() - start
    updateTask(task.id, {
      status: 'completed',
      output: result.content,
      tokensUsed: result.tokensUsed,
      completedAt: Date.now(),
    })

    // Update dispatch span duration
    addSpan({
      taskId: task.id,
      agentId,
      action: 'complete',
      type: 'chain',
      name: 'total',
      tokensUsed: result.tokensUsed,
      durationMs: duration,
      timestamp: start,
      status: 'success',
    })

    return { ...task, status: 'completed', output: result.content, tokensUsed: result.tokensUsed }
  } catch (err) {
    const duration = Date.now() - start
    const errorMsg = err instanceof Error ? err.message : String(err)

    updateTask(task.id, {
      status: 'failed',
      error: errorMsg,
      completedAt: Date.now(),
    })

    addSpan({
      taskId: task.id,
      agentId,
      action: 'error',
      type: 'chain',
      name: 'error',
      input: prompt,
      output: errorMsg,
      durationMs: duration,
      timestamp: start,
      status: 'error',
    })

    return { ...task, status: 'failed', error: errorMsg }
  }
}

/** Get a summary of the current system state (for dashboard) */
export function getSystemStatus() {
  const agents = listAgents(true)
  const models = listModels()
  const skills = listSkills()

  return {
    agents: {
      total: agents.length,
      active: agents.filter((a) => a.state === 'active').length,
      idle: agents.filter((a) => a.state === 'idle').length,
      pendingDestroy: agents.filter((a) => a.state === 'pending_destroy').length,
      destroyed: agents.filter((a) => a.state === 'destroyed').length,
    },
    models: models.length,
    skills: skills.length,
  }
}
