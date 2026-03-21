import { nanoid } from 'nanoid'
import { loadStore, updateStore } from './store.js'
import type { McpConfig, McpTransport } from './types.js'

export function addMcp(input: {
  name: string
  description: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}): McpConfig {
  const mcp: McpConfig = {
    id: nanoid(12),
    name: input.name,
    description: input.description,
    transport: input.transport,
    command: input.command,
    args: input.args,
    url: input.url,
    env: input.env,
    createdAt: Date.now(),
  }
  updateStore((s) => {
    s.mcps.push(mcp)
    // Auto-bind to Genesis — 确保 Genesis 始终拥有最高权限
    const genesis = s.agents.find((a) => a.id === 'genesis')
    if (genesis && !genesis.mcpIds.includes(mcp.id)) {
      genesis.mcpIds.push(mcp.id)
    }
  })
  return mcp
}

export function removeMcp(id: string): boolean {
  let found = false
  updateStore((s) => {
    const idx = s.mcps.findIndex((m) => m.id === id)
    if (idx >= 0) {
      s.mcps.splice(idx, 1)
      found = true
    }
  })
  return found
}

export function modifyMcp(id: string, patch: Partial<Pick<McpConfig, 'name' | 'description' | 'transport' | 'command' | 'args' | 'url' | 'env' | 'enabled'>>): boolean {
  let found = false
  updateStore((s) => {
    const m = s.mcps.find((x) => x.id === id)
    if (m) { Object.assign(m, patch); found = true }
  })
  return found
}

export function listMcps(): McpConfig[] {
  return loadStore().mcps
}

export function getMcp(id: string): McpConfig | undefined {
  return loadStore().mcps.find((m) => m.id === id)
}
