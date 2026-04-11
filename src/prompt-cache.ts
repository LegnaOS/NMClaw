/**
 * F3: Frozen Snapshot Cache
 * Session 级 system prompt 冻结，最大化 Anthropic prompt cache 命中率
 * Memory/skill 写入只更新磁盘，不更新当前 session 的 system prompt
 */
import { createHash } from 'node:crypto'

interface CachedSession {
  systemPrompt: string
  frozenAt: number
}

const sessionCache = new Map<string, CachedSession>()
const SESSION_TTL = 30 * 60 * 1000 // 30 minutes
const MAX_SESSIONS = 100

/** 从 agentId + 首条消息内容派生 session ID */
export function deriveSessionId(agentId: string, firstMessageContent: string): string {
  const hash = createHash('sha256').update(firstMessageContent).digest('hex').slice(0, 8)
  return `${agentId}:${hash}`
}

/** 获取或构建冻结的 system prompt */
export function getOrBuildFrozenPrompt(
  agentId: string,
  sessionId: string,
  builder: () => string,
): string {
  // 清理过期条目
  evictExpired()

  const cached = sessionCache.get(sessionId)
  if (cached && Date.now() - cached.frozenAt < SESSION_TTL) {
    return cached.systemPrompt
  }

  // 首次构建
  const systemPrompt = builder()

  // LRU 淘汰
  if (sessionCache.size >= MAX_SESSIONS) {
    let oldestKey = ''
    let oldestTime = Infinity
    for (const [k, v] of sessionCache) {
      if (v.frozenAt < oldestTime) { oldestTime = v.frozenAt; oldestKey = k }
    }
    if (oldestKey) sessionCache.delete(oldestKey)
  }

  sessionCache.set(sessionId, { systemPrompt, frozenAt: Date.now() })
  console.log(`[prompt-cache] frozen session ${sessionId} (${sessionCache.size} active)`)
  return systemPrompt
}

/** 手动失效某个 session */
export function invalidateSession(sessionId: string): void {
  sessionCache.delete(sessionId)
}

/** 获取缓存统计 */
export function getSessionCacheStats(): { activeSessions: number; oldestAgeMs: number } {
  evictExpired()
  let oldestAge = 0
  const now = Date.now()
  for (const v of sessionCache.values()) {
    const age = now - v.frozenAt
    if (age > oldestAge) oldestAge = age
  }
  return { activeSessions: sessionCache.size, oldestAgeMs: oldestAge }
}

function evictExpired(): void {
  const now = Date.now()
  for (const [k, v] of sessionCache) {
    if (now - v.frozenAt > SESSION_TTL) sessionCache.delete(k)
  }
}
