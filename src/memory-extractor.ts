/**
 * M3+M7: Memory Extractor + Dedup
 * 5 类记忆提取（decision/preference/milestone/problem/emotional）+ 近似去重
 * 纯正则，无 LLM 依赖
 */
import { extractAAAK, formatAAAK } from './aaak-dialect.js'
import { addDrawer, getAllDrawerContents } from './memory.js'

export type MemoryType = 'decision' | 'preference' | 'milestone' | 'problem' | 'emotional'

export interface ExtractedMemory {
  content: string
  memoryType: MemoryType
  confidence: number
  keywords: string[]
  chunkIndex: number
}

// ─── 5 组正则标记 ───

const DECISION_MARKERS = [
  /\b(decided|chose|picked|went with|settled on|opted for)\b/i,
  /\b(because|reason|rationale|trade-?off)\b/i,
  /\b(instead of|rather than|over|versus)\b/i,
  /\b(decision|choice|approach)\b/i,
  /决定|选择|采用|方案|权衡|取舍/,
]

const PREFERENCE_MARKERS = [
  /\balways use\b/i, /\bnever use\b/i,
  /\bdon'?t (ever |like to )?(use|do|mock|stub|import)\b/i,
  /\bi (like|prefer|hate|love) (to|when|how)\b/i,
  /\bplease (always|never|don'?t)\b/i,
  /\bmy (rule|preference|style|convention) is\b/i,
  /\bwe (always|never)\b/i,
  /偏好|习惯|规则|风格|约定|总是|从不|必须/,
]

const MILESTONE_MARKERS = [
  /\b(it works|it worked|got it working)\b/i,
  /\b(fixed|solved|breakthrough)\b/i,
  /\b(figured (it )?out|nailed it|cracked (it|the))\b/i,
  /\b(finally|first time|first ever)\b/i,
  /\b(built|created|implemented|shipped|launched|deployed)\b/i,
  /\b(discovered|realized|found (out|that)|turns out)\b/i,
  /成功|突破|搞定|解决了|终于|第一次|里程碑|上线|发布/,
]

const PROBLEM_MARKERS = [
  /\b(bug|error|crash|fail|broke|broken)\b/i,
  /\b(issue|problem|trouble|stuck|blocked)\b/i,
  /\b(doesn'?t work|can'?t|won'?t|unable)\b/i,
  /\b(root cause|workaround|hack|hotfix)\b/i,
  /\b(debug|traceback|stack ?trace|exception)\b/i,
  /报错|崩溃|失败|卡住|问题|故障|异常|排查|修复/,
]

const EMOTIONAL_MARKERS = [
  /\b(feel|feeling|felt|emotion)\b/i,
  /\b(happy|sad|angry|frustrated|excited|scared|proud)\b/i,
  /\b(love|hate|miss|wish|hope|fear|worry)\b/i,
  /\b(grateful|thankful|sorry|regret)\b/i,
  /\b(amazing|terrible|wonderful|awful|beautiful)\b/i,
  /开心|难过|生气|兴奋|害怕|骄傲|感谢|遗憾|焦虑|感动/,
]

const ALL_MARKERS: Record<MemoryType, RegExp[]> = {
  decision: DECISION_MARKERS,
  preference: PREFERENCE_MARKERS,
  milestone: MILESTONE_MARKERS,
  problem: PROBLEM_MARKERS,
  emotional: EMOTIONAL_MARKERS,
}

// ─── 代码行过滤 ───

const CODE_LINE_PATTERNS = [
  /^\s*[$#]\s/,
  /^\s*(cd|source|echo|export|pip|npm|git|python|bash|curl|wget|mkdir|rm|cp|mv|ls|cat|grep|find|chmod|sudo|brew|docker)\s/,
  /^\s*```/,
  /^\s*(import|from|const|let|var|function|class|def|return|if|else|for|while)\s/,
  /^\s*[{}();]/,
  /^\s*\/\//,
  /^\s*#\s/,
]

function isCodeLine(line: string): boolean {
  return CODE_LINE_PATTERNS.some(p => p.test(line))
}

function extractProse(text: string): string {
  return text.split('\n').filter(l => !isCodeLine(l)).join('\n')
}

// ─── 情感消歧 ───

function hasResolution(text: string): boolean {
  return /\b(fixed|solved|works|working|nailed it|figured|the (fix|answer|solution))\b/i.test(text) ||
    /修复|解决|搞定|成功/i.test(text)
}

function getSentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const pos = (text.match(/\b(good|great|nice|love|happy|excited|works|fixed|solved|success)\b/gi) || []).length +
    (text.match(/好|棒|成功|开心|喜欢|解决/g) || []).length
  const neg = (text.match(/\b(bad|terrible|hate|angry|sad|fail|broke|error|bug)\b/gi) || []).length +
    (text.match(/差|糟|失败|生气|难过|讨厌|报错/g) || []).length
  if (pos > neg + 1) return 'positive'
  if (neg > pos + 1) return 'negative'
  return 'neutral'
}

function disambiguate(type: MemoryType, text: string, scores: Record<string, number>): MemoryType {
  const sentiment = getSentiment(text)
  if (type === 'problem' && hasResolution(text)) {
    if ((scores.emotional ?? 0) > 0 && sentiment === 'positive') return 'emotional'
    return 'milestone'
  }
  if (type === 'problem' && sentiment === 'positive') {
    if ((scores.milestone ?? 0) > 0) return 'milestone'
    if ((scores.emotional ?? 0) > 0) return 'emotional'
  }
  return type
}

// ─── 主提取函数 ───

function scoreMarkers(text: string, markers: RegExp[]): number {
  let score = 0
  for (const m of markers) { if (m.test(text)) score++ }
  return score
}

export function classifyMemoryType(text: string): { type: MemoryType; confidence: number; keywords: string[] } {
  const prose = extractProse(text)
  const scores: Record<string, number> = {}
  const keywords: string[] = []

  for (const [type, markers] of Object.entries(ALL_MARKERS)) {
    const score = scoreMarkers(prose, markers)
    if (score > 0) {
      scores[type] = score
      for (const m of markers) {
        const match = prose.match(m)
        if (match) keywords.push(match[0].slice(0, 30))
      }
    }
  }

  if (Object.keys(scores).length === 0) return { type: 'emotional', confidence: 0, keywords: [] }

  let maxType = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0] as MemoryType
  const maxScore = scores[maxType]
  maxType = disambiguate(maxType, prose, scores)

  const lengthBonus = text.length > 500 ? 2 : text.length > 200 ? 1 : 0
  const confidence = Math.min(1.0, (maxScore + lengthBonus) / 5.0)

  return { type: maxType, confidence, keywords: [...new Set(keywords)].slice(0, 5) }
}

export function extractMemories(text: string, minConfidence: number = 0.3): ExtractedMemory[] {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length >= 20)
  const memories: ExtractedMemory[] = []

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]
    const { type, confidence, keywords } = classifyMemoryType(para)
    if (confidence >= minConfidence) {
      memories.push({ content: para.trim(), memoryType: type, confidence, keywords, chunkIndex: i })
    }
  }

  return memories
}

// ─── Wing/Room 自动分类 ───

const TECH_KEYWORDS = /\b(code|debug|api|server|database|deploy|docker|git|npm|test|build|compile|error|bug|function|class|module)\b|代码|调试|接口|服务器|数据库|部署|编译|测试/i
const PERSONAL_KEYWORDS = /\b(feel|happy|sad|love|hate|family|friend|life|dream|hope|wish)\b|感觉|开心|难过|喜欢|讨厌|家人|朋友|生活|梦想/i

export function autoWingRoom(text: string, agentId: string): { wing: string; room: string } {
  let wing = `wing_${agentId.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`
  let room = 'general'

  if (TECH_KEYWORDS.test(text)) wing = 'technical'
  else if (PERSONAL_KEYWORDS.test(text)) wing = 'personal'

  // Room: 从 AAAK 话题中取第一个
  const aaak = extractAAAK(text)
  if (aaak.topics.length > 0) room = aaak.topics[0].replace(/\s+/g, '-').slice(0, 64)

  return { wing, room }
}

// ─── M7: 近似去重 ───

export function isDuplicate(agentId: string, content: string, threshold: number = 0.85): { duplicate: boolean; matchId?: string; similarity?: number } {
  const drawers = getAllDrawerContents(agentId)
  if (drawers.length === 0) return { duplicate: false }

  const queryTokens = tokenizeSimple(content)
  if (queryTokens.size === 0) return { duplicate: false }

  for (const d of drawers) {
    const docTokens = tokenizeSimple(d.content)
    const sim = jaccardSimilarity(queryTokens, docTokens)
    if (sim >= threshold) return { duplicate: true, matchId: d.id, similarity: sim }
  }

  return { duplicate: false }
}

function tokenizeSimple(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z\u4e00-\u9fff]{2,}/g)) tokens.add(m[0])
  return tokens
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0
  for (const t of a) { if (b.has(t)) intersection++ }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

// ─── 自动存储记忆到 Palace ───

export function extractAndStore(agentId: string, userMessage: string, assistantResponse: string): number {
  const fullText = `用户: ${userMessage}\n助手: ${assistantResponse}`
  const memories = extractMemories(fullText, 0.4)
  let stored = 0

  for (const mem of memories) {
    const { duplicate } = isDuplicate(agentId, mem.content)
    if (duplicate) continue

    const { wing, room } = autoWingRoom(mem.content, agentId)
    const aaak = formatAAAK(extractAAAK(mem.content))

    addDrawer(agentId, {
      wing, room,
      content: mem.content,
      memoryType: mem.memoryType,
      aaak: aaak || undefined,
      importance: mem.confidence,
    })
    stored++
  }

  return stored
}
