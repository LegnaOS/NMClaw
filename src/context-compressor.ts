/**
 * F2: Context Compressor
 * 上下文超阈值时自动压缩中间轮次，保护头尾消息
 * 5 阶段: 裁剪旧 tool_result → 保护头部 → 找尾部边界 → 摘要中间 → 验证配对
 */
import type { ChatMessage } from './types.js'

export interface CompressionConfig {
  thresholdChars: number       // 触发压缩的字符数阈值
  preserveHeadMessages: number // 保护头部消息数
  preserveTailMessages: number // 保护尾部消息数
  cooldownMs: number           // 压缩冷却时间
  summaryMaxChars: number      // 摘要最大字符数
  toolResultTruncateChars: number // 旧 tool_result 截断阈值
}

export interface CompressionResult {
  compressed: boolean
  originalCount: number
  compressedCount: number
  savedChars: number
}

const DEFAULT_CONFIG: CompressionConfig = {
  thresholdChars: 80_000,
  preserveHeadMessages: 1,
  preserveTailMessages: 4,
  cooldownMs: 600_000,
  summaryMaxChars: 2000,
  toolResultTruncateChars: 500,
}

// 冷却追踪
const cooldownMap = new Map<string, number>()

/** 检查是否在冷却期内 */
function isInCooldown(agentId: string, config: CompressionConfig): boolean {
  const last = cooldownMap.get(agentId)
  if (!last) return false
  return Date.now() - last < config.cooldownMs
}

/** 估算字符数对应的 token 数（中文密度更高） */
function estimateTokens(text: string): number {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const ratio = cjkCount / Math.max(text.length, 1)
  const factor = ratio > 0.3 ? 2 : 4
  return Math.ceil(text.length / factor)
}

/** 计算消息数组的总字符数 */
function totalChars(messages: any[]): number {
  return messages.reduce((sum: number, m: any) => {
    if (typeof m.content === 'string') return sum + m.content.length
    if (Array.isArray(m.content)) {
      return sum + m.content.reduce((s: number, b: any) => {
        if (b.type === 'text') return s + (b.text?.length || 0)
        if (b.type === 'tool_result') return s + (b.content?.length || 0)
        if (b.type === 'tool_use') return s + JSON.stringify(b.input || {}).length
        return s + JSON.stringify(b).length
      }, 0)
    }
    return sum + JSON.stringify(m.content).length
  }, 0)
}

// ─── Phase 1: 裁剪旧 tool_result ───

function pruneOldToolResults(messages: any[], tailStart: number, truncateChars: number): any[] {
  return messages.map((m, i) => {
    if (i >= tailStart) return m // 尾部不动
    if (m.role !== 'user') return m

    // Anthropic native: content 是数组，包含 tool_result
    if (Array.isArray(m.content)) {
      const newContent = m.content.map((block: any) => {
        if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > truncateChars) {
          return { ...block, content: `[结果已压缩: ${block.content.slice(0, 100)}...]` }
        }
        return block
      })
      return { ...m, content: newContent }
    }

    // XML 路径: content 是字符串，包含 <tool_result>
    if (typeof m.content === 'string' && m.content.includes('<tool_result')) {
      const pruned = m.content.replace(
        /<tool_result[^>]*>([\s\S]{500,}?)<\/tool_result>/g,
        (match: string, inner: string) => {
          const tag = match.match(/<tool_result[^>]*>/)?.[0] || '<tool_result>'
          return `${tag}[结果已压缩: ${inner.slice(0, 100)}...]</tool_result>`
        }
      )
      return { ...m, content: pruned }
    }

    return m
  })
}

// ─── Phase 4: 摘要中间轮次（确定性，无 LLM 调用） ───

function summarizeMiddle(messages: any[], headEnd: number, tailStart: number, maxChars: number): string {
  const middle = messages.slice(headEnd, tailStart)
  const points: string[] = []

  for (const m of middle) {
    const text = typeof m.content === 'string' ? m.content :
      Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ') : ''

    if (!text) continue

    if (m.role === 'user') {
      // 提取用户问题的关键部分
      const q = text.replace(/<tool_result[\s\S]*?<\/tool_result>/g, '').trim()
      if (q.length > 10) points.push(`问: ${q.slice(0, 150)}`)
    } else if (m.role === 'assistant') {
      // 提取助手回答的首句
      const clean = text.replace(/<tool_call[\s\S]*?<\/tool_call>/g, '').trim()
      const firstSentence = clean.match(/^[^。！？\n]{10,200}[。！？]?/)?.[0]
      if (firstSentence) points.push(`答: ${firstSentence}`)
    }
  }

  let summary = points.join('\n')
  if (summary.length > maxChars) summary = summary.slice(0, maxChars) + '...'

  return `[上下文压缩摘要 — ${middle.length} 条消息已压缩]\n\n${summary}`
}

// ─── Phase 5: 验证 tool_call/tool_result 配对 ───

function validateToolPairs(messages: any[]): any[] {
  // 收集所有 tool_use id
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'tool_use' && block.id) toolUseIds.add(block.id)
        if (block.type === 'tool_result' && block.tool_use_id) toolResultIds.add(block.tool_use_id)
      }
    }
  }

  // 找到孤立的 tool_result（没有对应的 tool_use）
  const orphanResults = new Set<string>()
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphanResults.add(id)
  }

  if (orphanResults.size === 0) return messages

  // 移除孤立的 tool_result
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m
    const filtered = m.content.filter((block: any) => {
      if (block.type === 'tool_result' && orphanResults.has(block.tool_use_id)) return false
      return true
    })
    if (filtered.length === 0) return null
    return { ...m, content: filtered }
  }).filter(Boolean)
}

// ─── 主入口: Anthropic 原生格式压缩 ───

export function compressAnthropicMessages(
  messages: any[],
  systemPromptChars: number,
  agentId: string = 'default',
  config?: Partial<CompressionConfig>,
): { messages: any[]; result: CompressionResult } {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const originalCount = messages.length
  const originalChars = totalChars(messages) + systemPromptChars

  // 不需要压缩
  if (originalChars < cfg.thresholdChars) {
    return { messages, result: { compressed: false, originalCount, compressedCount: originalCount, savedChars: 0 } }
  }

  // 冷却期
  if (isInCooldown(agentId, cfg)) {
    return { messages, result: { compressed: false, originalCount, compressedCount: originalCount, savedChars: 0 } }
  }

  // 消息太少，不压缩
  const minMessages = cfg.preserveHeadMessages + cfg.preserveTailMessages + 2
  if (messages.length < minMessages) {
    return { messages, result: { compressed: false, originalCount, compressedCount: originalCount, savedChars: 0 } }
  }

  const headEnd = cfg.preserveHeadMessages
  const tailStart = messages.length - cfg.preserveTailMessages

  // Phase 1: 裁剪旧 tool_result
  let compressed = pruneOldToolResults(messages, tailStart, cfg.toolResultTruncateChars)

  // 裁剪后检查是否还需要进一步压缩
  const afterPruneChars = totalChars(compressed) + systemPromptChars
  if (afterPruneChars < cfg.thresholdChars) {
    const savedChars = originalChars - afterPruneChars
    cooldownMap.set(agentId, Date.now())
    return { messages: compressed, result: { compressed: true, originalCount, compressedCount: compressed.length, savedChars } }
  }

  // Phase 2-3: 保护头尾，摘要中间
  const head = compressed.slice(0, headEnd)
  const tail = compressed.slice(tailStart)
  const summaryText = summarizeMiddle(compressed, headEnd, tailStart, cfg.summaryMaxChars)

  const summaryMessage = { role: 'user', content: summaryText }
  compressed = [...head, summaryMessage, ...tail]

  // Phase 5: 验证配对
  compressed = validateToolPairs(compressed)

  const finalChars = totalChars(compressed) + systemPromptChars
  const savedChars = originalChars - finalChars

  cooldownMap.set(agentId, Date.now())
  console.log(`[context-compressor] ${originalCount} → ${compressed.length} messages, saved ${savedChars} chars`)

  return {
    messages: compressed,
    result: { compressed: true, originalCount, compressedCount: compressed.length, savedChars },
  }
}

// ─── ChatMessage 格式压缩（OpenAI / XML 路径） ───

export function compressChatMessages(
  messages: ChatMessage[],
  agentId: string = 'default',
  config?: Partial<CompressionConfig>,
): { messages: ChatMessage[]; result: CompressionResult } {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const originalCount = messages.length
  const originalChars = messages.reduce((s, m) => s + m.content.length, 0)

  if (originalChars < cfg.thresholdChars || messages.length < cfg.preserveHeadMessages + cfg.preserveTailMessages + 2) {
    return { messages, result: { compressed: false, originalCount, compressedCount: originalCount, savedChars: 0 } }
  }

  if (isInCooldown(agentId, cfg)) {
    return { messages, result: { compressed: false, originalCount, compressedCount: originalCount, savedChars: 0 } }
  }

  const headEnd = cfg.preserveHeadMessages
  const tailStart = messages.length - cfg.preserveTailMessages

  // 摘要中间
  const middle = messages.slice(headEnd, tailStart)
  const points: string[] = []
  for (const m of middle) {
    if (m.role === 'user') {
      const q = m.content.replace(/<tool_result[\s\S]*?<\/tool_result>/g, '').trim()
      if (q.length > 10) points.push(`问: ${q.slice(0, 150)}`)
    } else if (m.role === 'assistant') {
      const clean = m.content.replace(/<tool_call[\s\S]*?<\/tool_call>/g, '').trim()
      const first = clean.match(/^[^。！？\n]{10,200}[。！？]?/)?.[0]
      if (first) points.push(`答: ${first}`)
    }
  }

  let summary = points.join('\n')
  if (summary.length > cfg.summaryMaxChars) summary = summary.slice(0, cfg.summaryMaxChars) + '...'

  const summaryMsg: ChatMessage = {
    role: 'user',
    content: `[上下文压缩摘要 — ${middle.length} 条消息已压缩]\n\n${summary}`,
  }

  const compressed = [...messages.slice(0, headEnd), summaryMsg, ...messages.slice(tailStart)]
  const finalChars = compressed.reduce((s, m) => s + m.content.length, 0)

  cooldownMap.set(agentId, Date.now())
  console.log(`[context-compressor] ${originalCount} → ${compressed.length} messages, saved ${originalChars - finalChars} chars`)

  return {
    messages: compressed,
    result: { compressed: true, originalCount, compressedCount: compressed.length, savedChars: originalChars - finalChars },
  }
}
