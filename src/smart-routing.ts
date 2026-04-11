/**
 * F5: Smart Model Routing
 * 简单消息路由到便宜模型，复杂任务保持主模型
 */
import { getModel, listModels } from './model-registry.js'
import { getAgent } from './agent-manager.js'
import type { ChatMessage, ModelConfig, CostTier } from './types.js'

export interface RoutingDecision {
  modelId: string
  reason: 'simple_message' | 'complex_task' | 'primary_default'
  originalModelId: string
}

// 复杂关键词集合（中英文）
const COMPLEX_KEYWORDS = new Set([
  'debug', 'debugging', 'implement', 'implementation', 'refactor', 'refactoring',
  'patch', 'traceback', 'stacktrace', 'exception', 'error', 'analyze', 'analysis',
  'investigate', 'architecture', 'design', 'compare', 'benchmark', 'optimize',
  'review', 'terminal', 'shell', 'pytest', 'test', 'tests', 'plan', 'planning',
  'delegate', 'docker', 'kubernetes', 'deploy', 'migration', 'security', 'audit',
  '调试', '实现', '重构', '分析', '架构', '设计', '优化', '部署', '迁移',
  '审计', '测试', '排查', '诊断', '修复', '编写', '开发',
])

const COST_ORDER: Record<CostTier, number> = { free: 0, low: 1, medium: 2, high: 3 }

/** 判断消息是否足够简单，可以路由到便宜模型 */
export function isSimpleMessage(content: string): boolean {
  if (!content) return false
  // 长度检查
  if (content.length > 200) return false
  // 换行检查
  if ((content.match(/\n/g) || []).length >= 3) return false
  // 代码块检查
  if (/```/.test(content) || /`[^`]+`/.test(content) && content.length > 100) return false
  // URL 检查
  if (/https?:\/\//.test(content)) return false
  // 复杂关键词检查
  const lower = content.toLowerCase()
  for (const kw of COMPLEX_KEYWORDS) {
    if (lower.includes(kw)) return false
  }
  return true
}

/** 找到最便宜的可用模型 */
export function findCheapestModel(excludeId?: string): ModelConfig | undefined {
  const models = listModels()
    .filter(m => m.enabled !== false && m.id !== excludeId && m.capabilities.includes('chat'))
    .sort((a, b) => COST_ORDER[a.costTier] - COST_ORDER[b.costTier])
  return models[0]
}

/** 为指定 agent 的消息选择模型 */
export function routeModel(agentId: string, messages: ChatMessage[]): RoutingDecision {
  const agent = getAgent(agentId)
  if (!agent) return { modelId: '', reason: 'primary_default', originalModelId: '' }

  const originalModelId = agent.modelId
  const primaryModel = getModel(originalModelId)
  if (!primaryModel) return { modelId: originalModelId, reason: 'primary_default', originalModelId }

  // 只对最后一条用户消息做判断
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUser) return { modelId: originalModelId, reason: 'primary_default', originalModelId }

  if (!isSimpleMessage(lastUser.content)) {
    return { modelId: originalModelId, reason: 'complex_task', originalModelId }
  }

  // 找更便宜的模型
  const cheap = findCheapestModel(originalModelId)
  if (!cheap || COST_ORDER[cheap.costTier] >= COST_ORDER[primaryModel.costTier]) {
    return { modelId: originalModelId, reason: 'primary_default', originalModelId }
  }

  console.log(`[smart-routing] simple message → ${cheap.name} (${cheap.costTier}) instead of ${primaryModel.name} (${primaryModel.costTier})`)
  return { modelId: cheap.id, reason: 'simple_message', originalModelId }
}
