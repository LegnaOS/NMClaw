import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface LocalMcpEntry {
  name: string
  source: 'kiro' | 'codebuddy' | 'claude-desktop' | 'claude-code'
  command: string
  args: string[]
  env: Record<string, string>
  disabled: boolean
}

const SCAN_PATHS: { path: string; source: LocalMcpEntry['source'] }[] = [
  { path: join(homedir(), '.kiro', 'settings', 'mcp.json'), source: 'kiro' },
  { path: join(homedir(), '.codebuddy', 'mcp.json'), source: 'codebuddy' },
  { path: join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), source: 'claude-desktop' },
]

export function scanLocalMcps(): LocalMcpEntry[] {
  const results: LocalMcpEntry[] = []

  for (const { path, source } of SCAN_PATHS) {
    if (!existsSync(path)) continue
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      const servers = raw.mcpServers || {}
      for (const [name, config] of Object.entries(servers)) {
        const c = config as any
        results.push({
          name,
          source,
          command: c.command || '',
          args: c.args || [],
          env: c.env || {},
          disabled: !!c.disabled,
        })
      }
    } catch { /* skip unreadable configs */ }
  }

  // Deduplicate by name (prefer kiro > codebuddy > claude-desktop)
  const seen = new Map<string, LocalMcpEntry>()
  for (const entry of results) {
    const key = entry.name.toLowerCase().replace(/\s+/g, '-')
    if (!seen.has(key)) seen.set(key, entry)
  }

  return [...seen.values()]
}

export function getLocalMcpSources(): { source: string; path: string; exists: boolean }[] {
  return SCAN_PATHS.map(({ path, source }) => ({
    source,
    path,
    exists: existsSync(path),
  }))
}
