/**
 * M6: Semantic Search — TF-IDF + Cosine Similarity
 * 零外部依赖，用 SQLite drawers 表做语义搜索
 */
import { getAllDrawerContents, getDrawerCount } from './memory.js'
import { searchMemory } from './memory.js'

export interface SearchHit {
  drawerId: string
  content: string
  wing: string
  room: string
  similarity: number
  memoryType?: string
}

// ─── 中文 bigram 分词 + 英文空格分词 ───

function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()
  // 英文词
  for (const m of lower.matchAll(/[a-z][a-z0-9_]{1,}/g)) tokens.push(m[0])
  // 中文 bigram
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2))
  return tokens
}

// ─── TF-IDF ───

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  const len = tokens.length || 1
  for (const [k, v] of tf) tf.set(k, v / len)
  return tf
}

// IDF 缓存
const idfCache = new Map<string, { idf: Map<string, number>; cachedAt: number; docCount: number }>()
const IDF_CACHE_TTL = 120_000

export function buildIDFMap(agentId: string): Map<string, number> {
  const cached = idfCache.get(agentId)
  const docCount = getDrawerCount(agentId)
  if (cached && Date.now() - cached.cachedAt < IDF_CACHE_TTL && cached.docCount === docCount) {
    return cached.idf
  }

  const drawers = getAllDrawerContents(agentId)
  const df = new Map<string, number>()
  const N = drawers.length || 1

  for (const d of drawers) {
    const seen = new Set<string>()
    for (const t of tokenize(d.content)) {
      if (!seen.has(t)) { df.set(t, (df.get(t) ?? 0) + 1); seen.add(t) }
    }
  }

  const idf = new Map<string, number>()
  for (const [term, count] of df) {
    idf.set(term, Math.log((N + 1) / (count + 1)) + 1)
  }

  idfCache.set(agentId, { idf, cachedAt: Date.now(), docCount })
  return idf
}

export function buildTFIDF(text: string, idfMap: Map<string, number>): Map<string, number> {
  const tokens = tokenize(text)
  const tf = termFrequency(tokens)
  const tfidf = new Map<string, number>()
  for (const [term, freq] of tf) {
    tfidf.set(term, freq * (idfMap.get(term) ?? 1))
  }
  return tfidf
}

export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, normA = 0, normB = 0
  for (const [k, v] of a) {
    normA += v * v
    const bv = b.get(k)
    if (bv !== undefined) dot += v * bv
  }
  for (const v of b.values()) normB += v * v
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export function semanticSearch(
  agentId: string,
  query: string,
  options?: { wing?: string; room?: string; limit?: number },
): SearchHit[] {
  const limit = options?.limit ?? 5
  const drawers = getAllDrawerContents(agentId)
  if (drawers.length === 0) return []

  // 如果 drawers > 1000，先用 FTS5 粗筛
  let candidates = drawers
  if (drawers.length > 1000) {
    const ftsResults = searchMemory(query, agentId, 100)
    if (ftsResults.length > 0) {
      const ftsIds = new Set(ftsResults.map(r => String(r.turnId)))
      // FTS 搜的是 turns 表，这里只能做关键词过滤
      const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2)
      candidates = drawers.filter(d => {
        const lower = d.content.toLowerCase()
        return queryWords.some(w => lower.includes(w))
      })
      if (candidates.length === 0) candidates = drawers.slice(0, 200)
    }
  }

  // Wing/Room 过滤
  if (options?.wing) candidates = candidates.filter(d => d.wing === options.wing)
  if (options?.room) candidates = candidates.filter(d => d.room === options.room)

  const idfMap = buildIDFMap(agentId)
  const queryVec = buildTFIDF(query, idfMap)

  const scored: SearchHit[] = candidates.map(d => ({
    drawerId: d.id,
    content: d.content,
    wing: d.wing,
    room: d.room,
    similarity: cosineSimilarity(queryVec, buildTFIDF(d.content, idfMap)),
    memoryType: d.memoryType,
  }))

  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, limit).filter(h => h.similarity > 0.01)
}
