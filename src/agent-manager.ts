import { nanoid } from 'nanoid'
import { loadStore, updateStore } from './store.js'
import type { AgentConfig, AgentState } from './types.js'

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
const ONE_DAY = 24 * 60 * 60 * 1000

export function createAgent(input: {
  name: string
  description: string
  modelId: string
  skillIds?: string[]
  mcpIds?: string[]
  systemPrompt?: string
  ttl?: number
  idleTimeout?: number
  autoRenew?: boolean
}): AgentConfig {
  const now = Date.now()
  const agent: AgentConfig = {
    id: nanoid(12),
    name: input.name,
    description: input.description,
    modelId: input.modelId,
    skillIds: input.skillIds ?? [],
    mcpIds: input.mcpIds ?? [],
    systemPrompt: input.systemPrompt ?? '',
    lifecycle: {
      ttl: input.ttl ?? SEVEN_DAYS,
      idleTimeout: input.idleTimeout ?? ONE_DAY,
      autoRenew: input.autoRenew ?? false,
    },
    state: 'active',
    createdAt: now,
    lastActiveAt: now,
  }
  updateStore((s) => s.agents.push(agent))
  return agent
}

export function destroyAgent(id: string): boolean {
  let found = false
  updateStore((s) => {
    const agent = s.agents.find((a) => a.id === id)
    if (agent && agent.state !== 'destroyed') {
      agent.state = 'destroyed'
      found = true
    }
  })
  return found
}

export function listAgents(includeDestroyed = false): AgentConfig[] {
  const agents = loadStore().agents
  return includeDestroyed ? agents : agents.filter((a) => a.state !== 'destroyed')
}

export function getAgent(id: string): AgentConfig | undefined {
  return loadStore().agents.find((a) => a.id === id)
}

export function touchAgent(id: string): void {
  updateStore((s) => {
    const agent = s.agents.find((a) => a.id === id)
    if (agent) {
      agent.lastActiveAt = Date.now()
      agent.state = 'active'
    }
  })
}

export function updateAgentState(id: string, state: AgentState): void {
  updateStore((s) => {
    const agent = s.agents.find((a) => a.id === id)
    if (agent) agent.state = state
  })
}

export function modifyAgent(id: string, patch: Partial<Pick<AgentConfig, 'name' | 'description' | 'modelId' | 'skillIds' | 'mcpIds' | 'systemPrompt'>>): boolean {
  let found = false
  updateStore((s) => {
    const agent = s.agents.find((a) => a.id === id)
    if (agent) {
      Object.assign(agent, patch)
      found = true
    }
  })
  return found
}

/**
 * Lifecycle sweep — call on every CLI invocation.
 * Checks TTL expiry and idle timeout, transitions agents accordingly.
 * Returns list of agents that were transitioned.
 */
export function sweepLifecycle(): { expired: AgentConfig[]; idled: AgentConfig[] } {
  const expired: AgentConfig[] = []
  const idled: AgentConfig[] = []
  const now = Date.now()

  updateStore((s) => {
    for (const agent of s.agents) {
      if (agent.state === 'destroyed') continue

      // TTL expiry — hard limit
      if (now - agent.createdAt >= agent.lifecycle.ttl) {
        if (agent.lifecycle.autoRenew) {
          agent.createdAt = now // renew
        } else {
          agent.state = 'pending_destroy'
          expired.push({ ...agent })
        }
        continue
      }

      // Idle timeout
      if (agent.state === 'active' && now - agent.lastActiveAt >= agent.lifecycle.idleTimeout) {
        agent.state = 'idle'
        idled.push({ ...agent })
      }

      // Idle → pending_destroy (double idle timeout)
      if (agent.state === 'idle' && now - agent.lastActiveAt >= agent.lifecycle.idleTimeout * 2) {
        agent.state = 'pending_destroy'
        expired.push({ ...agent })
      }
    }
  })

  return { expired, idled }
}
