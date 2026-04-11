/**
 * F8: Enhanced Sub-Agent Delegation
 * 隔离的子 Agent 实例，独立工具集、上下文、迭代预算
 */
import type { ToolDef } from './mcp-runtime.js'

export interface DelegationConfig {
  maxDepth: number
  maxConcurrentChildren: number
  maxIterations: number
  blockedTools: string[]
}

export interface DelegationContext {
  depth: number
  parentAgentId: string
  parentTaskId?: string
  toolRestrictions: string[]
  maxRounds: number
}

const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
  maxDepth: 2,
  maxConcurrentChildren: 3,
  maxIterations: 50,
  blockedTools: [
    'dispatch_to_agent', 'destroy_agent', 'create_agent', 'modify_agent',
    'execute_script', 'restore_snapshot', 'evolve_skill', 'delete_evolved_skill',
  ],
}

// 活跃委派追踪
const activeDelegations = new Map<string, { count: number; children: Set<string> }>()

/** 检查是否可以委派 */
export function canDelegate(parentAgentId: string, depth: number, config?: Partial<DelegationConfig>): boolean {
  const cfg = { ...DEFAULT_DELEGATION_CONFIG, ...config }

  if (depth >= cfg.maxDepth) {
    console.log(`[delegation] BLOCKED: depth ${depth} >= max ${cfg.maxDepth}`)
    return false
  }

  const active = activeDelegations.get(parentAgentId)
  if (active && active.count >= cfg.maxConcurrentChildren) {
    console.log(`[delegation] BLOCKED: ${parentAgentId} has ${active.count} active children (max ${cfg.maxConcurrentChildren})`)
    return false
  }

  return true
}

/** 注册子 Agent */
export function registerChild(parentAgentId: string, childAgentId: string): void {
  let entry = activeDelegations.get(parentAgentId)
  if (!entry) {
    entry = { count: 0, children: new Set() }
    activeDelegations.set(parentAgentId, entry)
  }
  entry.children.add(childAgentId)
  entry.count = entry.children.size
  console.log(`[delegation] registered child ${childAgentId} for ${parentAgentId} (${entry.count} active)`)
}

/** 注销子 Agent */
export function unregisterChild(parentAgentId: string, childAgentId: string): void {
  const entry = activeDelegations.get(parentAgentId)
  if (!entry) return
  entry.children.delete(childAgentId)
  entry.count = entry.children.size
  if (entry.count === 0) activeDelegations.delete(parentAgentId)
  console.log(`[delegation] unregistered child ${childAgentId} for ${parentAgentId} (${entry.count} remaining)`)
}

/** 获取活跃委派数 */
export function getActiveDelegationCount(parentAgentId: string): number {
  return activeDelegations.get(parentAgentId)?.count ?? 0
}

/** 构建子 Agent 的聚焦 system prompt */
export function buildChildSystemPrompt(goal: string, context: string, workspacePath?: string): string {
  const parts = [
    '你是一个专注执行特定任务的 Worker Agent。',
    '',
    `## 任务目标`,
    goal,
  ]

  if (context) {
    parts.push('', '## 上下文信息', context)
  }

  if (workspacePath) {
    parts.push('', `## 工作目录`, `当前工作目录: ${workspacePath}`)
  }

  parts.push(
    '',
    '## 执行规则',
    '- 专注完成任务目标，不要偏离',
    '- 完成后直接输出结果，不要询问后续操作',
    '- 如果遇到无法解决的问题，说明原因并停止',
    '- 请用中文回答',
  )

  return parts.join('\n')
}

/** 过滤子 Agent 可用的工具集 */
export function filterToolsForChild(
  tools: ToolDef[],
  blocked?: string[],
  allowed?: string[],
): ToolDef[] {
  const blockedSet = new Set(blocked || DEFAULT_DELEGATION_CONFIG.blockedTools)

  let filtered = tools.filter(t => !blockedSet.has(t.name))

  // 如果指定了 allowed，取交集
  if (allowed && allowed.length > 0) {
    const allowedSet = new Set(allowed)
    filtered = filtered.filter(t => allowedSet.has(t.name))
  }

  return filtered
}

/** 创建委派上下文 */
export function createDelegationContext(
  parentAgentId: string,
  depth: number = 0,
  toolRestrictions: string[] = [],
  maxRounds: number = DEFAULT_DELEGATION_CONFIG.maxIterations,
  parentTaskId?: string,
): DelegationContext {
  return {
    depth: depth + 1,
    parentAgentId,
    parentTaskId,
    toolRestrictions,
    maxRounds: Math.min(maxRounds, DEFAULT_DELEGATION_CONFIG.maxIterations),
  }
}

/** 获取委派统计 */
export function getDelegationStats(): { totalActive: number; parents: { id: string; children: number }[] } {
  const parents: { id: string; children: number }[] = []
  let totalActive = 0
  for (const [id, entry] of activeDelegations) {
    parents.push({ id, children: entry.count })
    totalActive += entry.count
  }
  return { totalActive, parents }
}
