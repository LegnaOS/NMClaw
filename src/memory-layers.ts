/**
 * M1: 4-Layer Memory Stack
 * L0 身份（~100 tokens）→ L1 核心故事（~500-800）→ L2 按需加载 → L3 深度搜索
 * 替代原始 loadMemoryContext()，大幅减少 prompt 膨胀
 */
import { getAgent } from './agent-manager.js'
import { getDrawers, getWings, getDrawerCount } from './memory.js'
import { semanticSearch } from './semantic-search.js'

export interface LayerConfig {
  l0MaxChars: number
  l1MaxChars: number
  l2MaxChars: number
  l3MaxResults: number
}

const DEFAULT_CONFIG: LayerConfig = {
  l0MaxChars: 400,
  l1MaxChars: 2000,
  l2MaxChars: 1500,
  l3MaxResults: 5,
}

/** L0: 身份层 — agent 描述 + 核心偏好 */
export function loadL0(agentId: string, config?: Partial<LayerConfig>): string {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const agent = getAgent(agentId)
  if (!agent) return ''

  const parts: string[] = []
  parts.push(`[身份] ${agent.name}: ${agent.description || '通用助手'}`)

  // 从 drawers 中取 preference 类型的 top 条目
  const prefs = getDrawers(agentId, undefined, undefined, 5)
    .filter(d => d.memoryType === 'preference')
  if (prefs.length > 0) {
    parts.push('[偏好]')
    for (const p of prefs) {
      parts.push(`- ${p.content.slice(0, 150)}`)
    }
  }

  let text = parts.join('\n')
  if (text.length > cfg.l0MaxChars) text = text.slice(0, cfg.l0MaxChars) + '...'
  return text
}

/** L1: 核心故事 — importance 最高的记忆，按类型分组 */
export function loadL1(agentId: string, config?: Partial<LayerConfig>): string {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const drawers = getDrawers(agentId, undefined, undefined, 20)
  if (drawers.length === 0) return ''

  const byType = new Map<string, string[]>()
  for (const d of drawers) {
    const type = d.memoryType || 'general'
    if (!byType.has(type)) byType.set(type, [])
    byType.get(type)!.push(d.content.slice(0, 200))
  }

  const TYPE_LABELS: Record<string, string> = {
    decision: '决策', preference: '偏好', milestone: '里程碑',
    problem: '问题', emotional: '情感', general: '通用',
  }

  const parts: string[] = ['[核心记忆]']
  let totalChars = 0
  for (const [type, items] of byType) {
    if (totalChars >= cfg.l1MaxChars) break
    parts.push(`\n### ${TYPE_LABELS[type] || type}`)
    for (const item of items.slice(0, 3)) {
      if (totalChars >= cfg.l1MaxChars) break
      parts.push(`- ${item}`)
      totalChars += item.length
    }
  }

  return parts.join('\n')
}

/** L2: 按需加载 — 指定 wing/room 的记忆（通过工具调用触发） */
export function loadL2(agentId: string, topic: string, config?: Partial<LayerConfig>): string {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // 尝试按 wing 匹配
  let drawers = getDrawers(agentId, topic, undefined, 10)
  // 如果没有，尝试按 room 匹配
  if (drawers.length === 0) {
    const wings = getWings(agentId)
    for (const w of wings) {
      drawers = getDrawers(agentId, w.wing, topic, 10)
      if (drawers.length > 0) break
    }
  }

  if (drawers.length === 0) return `未找到与 "${topic}" 相关的记忆`

  const parts: string[] = [`[按需记忆: ${topic}]`]
  let totalChars = 0
  for (const d of drawers) {
    if (totalChars >= cfg.l2MaxChars) break
    const snippet = d.content.slice(0, 300)
    parts.push(`- [${d.wing}/${d.room}] ${snippet}`)
    totalChars += snippet.length
  }

  return parts.join('\n')
}

/** L3: 深度搜索 — 语义搜索（通过 search_memory 工具触发） */
export function loadL3(agentId: string, query: string, config?: Partial<LayerConfig>): string {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const hits = semanticSearch(agentId, query, { limit: cfg.l3MaxResults })

  if (hits.length === 0) return `未找到与 "${query}" 相关的深度记忆`

  const parts: string[] = [`[深度搜索: ${query}]`]
  for (const h of hits) {
    parts.push(`- [${h.wing}/${h.room}] (相似度 ${(h.similarity * 100).toFixed(0)}%) ${h.content.slice(0, 300)}`)
  }

  return parts.join('\n')
}

/** 构建完整记忆 prompt（L0+L1），替代 loadMemoryContext() */
export function buildMemoryPrompt(agentId: string, config?: Partial<LayerConfig>): string {
  const drawerCount = getDrawerCount(agentId)

  // 如果没有 drawers，返回空（回退到原始 loadMemoryContext）
  if (drawerCount === 0) return ''

  const l0 = loadL0(agentId, config)
  const l1 = loadL1(agentId, config)
  const wings = getWings(agentId)

  const parts: string[] = []
  if (l0) parts.push(l0)
  if (l1) parts.push(l1)

  // 附加宫殿概览
  if (wings.length > 0) {
    const wingList = wings.map(w => `${w.wing}(${w.count})`).join(', ')
    parts.push(`\n[记忆宫殿: ${drawerCount} 条记忆, ${wings.length} 个领域: ${wingList}]`)
    parts.push('使用 recall_memory 按领域加载更多记忆，search_memory 深度搜索。')
  }

  return '\n\n---\n\n' + parts.join('\n')
}
