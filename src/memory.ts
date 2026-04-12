/**
 * Agent Long-term Memory — SQLite per agent
 * Storage: ~/.nmclaw/memory/{agentId}.sqlite
 */
import Database from 'better-sqlite3'
import { nanoid } from 'nanoid'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { getStoreDir } from './store.js'

const RECENT_TURNS_LIMIT = 10
const COMPACT_THRESHOLD = 20
const MAX_SUMMARIES = 5
const MAX_MEMORY_CHARS = 4000
const MAX_SNIP = 500

const dbCache = new Map<string, Database.Database>()

function getDb(agentId: string): Database.Database {
  const cached = dbCache.get(agentId)
  if (cached) return cached
  const dir = join(getStoreDir(), 'memory')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, `${agentId}.sqlite`))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 3000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL, user_message TEXT NOT NULL,
      assistant_response TEXT NOT NULL, created_at INTEGER NOT NULL,
      summarized INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL, content TEXT NOT NULL,
      turn_start_id INTEGER NOT NULL, turn_end_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_agent ON turns(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_summaries_agent ON summaries(agent_id, created_at);
  `)
  // F4: FTS5 全文检索
  ensureFTS(db)
  // M5: Palace drawers 表
  ensureDrawers(db)
  dbCache.set(agentId, db)
  return db
}

export function saveTurn(agentId: string, userMsg: string, asstResp: string): void {
  const db = getDb(agentId)
  db.prepare('INSERT INTO turns (agent_id, user_message, assistant_response, created_at) VALUES (?, ?, ?, ?)')
    .run(agentId, userMsg, asstResp, Date.now())
  const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM turns WHERE agent_id = ? AND summarized = 0')
    .get(agentId) as { cnt: number }
  if (cnt >= COMPACT_THRESHOLD) scheduleCompaction(agentId)
}

export function loadMemoryContext(agentId: string): string {
  const db = getDb(agentId)
  const parts: string[] = []
  const sums = db.prepare('SELECT content FROM summaries WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(agentId, MAX_SUMMARIES) as { content: string }[]
  if (sums.length) {
    parts.push('## 历史记忆摘要')
    for (const s of sums.reverse()) parts.push(s.content)
  }
  const turns = db.prepare('SELECT user_message, assistant_response, created_at FROM turns WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(agentId, RECENT_TURNS_LIMIT) as { user_message: string; assistant_response: string; created_at: number }[]
  if (turns.length) {
    parts.push('## 最近对话记录')
    for (const t of turns.reverse()) {
      const ts = new Date(t.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      parts.push(`[${ts}]\n用户: ${t.user_message.slice(0, MAX_SNIP)}\n助手: ${t.assistant_response.slice(0, MAX_SNIP)}`)
    }
  }
  if (!parts.length) return ''
  let mem = parts.join('\n\n')
  if (mem.length > MAX_MEMORY_CHARS) mem = mem.slice(0, MAX_MEMORY_CHARS) + '\n...(记忆已截断)'
  return `\n\n---\n\n[长期记忆 — 以下是你过去与用户的交互记录，请参考但不必逐条复述]\n\n${mem}`
}

const compacting = new Set<string>()
function scheduleCompaction(id: string): void {
  if (compacting.has(id)) return
  compacting.add(id)
  setImmediate(() => {
    try { compactTurns(id) } catch (e) { console.error(`[memory] compact err ${id}:`, e) }
    finally { compacting.delete(id) }
  })
}

export function compactTurns(agentId: string): void {
  const db = getDb(agentId)
  const rows = db.prepare(
    'SELECT id, user_message, assistant_response, created_at FROM turns WHERE agent_id = ? AND summarized = 0 ORDER BY created_at ASC LIMIT ?'
  ).all(agentId, COMPACT_THRESHOLD) as { id: number; user_message: string; assistant_response: string; created_at: number }[]
  if (rows.length < COMPACT_THRESHOLD) return
  const d0 = new Date(rows[0].created_at).toLocaleDateString('zh-CN')
  const d1 = new Date(rows[rows.length - 1].created_at).toLocaleDateString('zh-CN')
  const lines = [`[${d0} ~ ${d1}] ${rows.length} 轮对话摘要:`]
  for (const t of rows) {
    lines.push(`- 问: ${t.user_message.replace(/\s+/g, ' ').slice(0, 100)} → 答: ${t.assistant_response.replace(/\s+/g, ' ').slice(0, 100)}`)
  }
  const ids = rows.map(r => r.id)
  db.transaction(() => {
    db.prepare('INSERT INTO summaries (agent_id, content, turn_start_id, turn_end_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(agentId, lines.join('\n'), ids[0], ids[ids.length - 1], Date.now())
    db.prepare(`UPDATE turns SET summarized = 1 WHERE agent_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
      .run(agentId, ...ids)
  })()
  console.log(`[memory] compacted ${rows.length} turns for ${agentId}`)
}

export function purgeAgentMemory(agentId: string): void {
  const db = getDb(agentId)
  db.exec('DELETE FROM turns; DELETE FROM summaries;')
  console.log(`[memory] purged ${agentId}`)
}

// ─── CRUD for management UI ───

export interface TurnRow {
  id: number; agent_id: string; user_message: string; assistant_response: string
  created_at: number; summarized: number
}
export interface SummaryRow {
  id: number; agent_id: string; content: string
  turn_start_id: number; turn_end_id: number; created_at: number
}

export function listTurns(agentId: string, limit = 100, offset = 0): TurnRow[] {
  const db = getDb(agentId)
  return db.prepare('SELECT * FROM turns WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(agentId, limit, offset) as TurnRow[]
}

export function listSummaries(agentId: string, limit = 50): SummaryRow[] {
  const db = getDb(agentId)
  return db.prepare('SELECT * FROM summaries WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(agentId, limit) as SummaryRow[]
}

export function getMemoryStats(agentId: string): { turnCount: number; summaryCount: number; dbSizeKB: number } {
  const db = getDb(agentId)
  const { tc } = db.prepare('SELECT COUNT(*) as tc FROM turns WHERE agent_id = ?').get(agentId) as { tc: number }
  const { sc } = db.prepare('SELECT COUNT(*) as sc FROM summaries WHERE agent_id = ?').get(agentId) as { sc: number }
  const { ps } = db.prepare("SELECT page_count * page_size as ps FROM pragma_page_count(), pragma_page_size()").get() as { ps: number }
  return { turnCount: tc, summaryCount: sc, dbSizeKB: Math.round(ps / 1024) }
}

export function addTurn(agentId: string, userMsg: string, asstResp: string): TurnRow {
  const db = getDb(agentId)
  const info = db.prepare('INSERT INTO turns (agent_id, user_message, assistant_response, created_at) VALUES (?, ?, ?, ?)')
    .run(agentId, userMsg, asstResp, Date.now())
  return db.prepare('SELECT * FROM turns WHERE id = ?').get(info.lastInsertRowid) as TurnRow
}

export function editTurn(agentId: string, turnId: number, data: { user_message?: string; assistant_response?: string }): boolean {
  const db = getDb(agentId)
  const sets: string[] = []; const vals: any[] = []
  if (data.user_message !== undefined) { sets.push('user_message = ?'); vals.push(data.user_message) }
  if (data.assistant_response !== undefined) { sets.push('assistant_response = ?'); vals.push(data.assistant_response) }
  if (!sets.length) return false
  vals.push(turnId, agentId)
  return db.prepare(`UPDATE turns SET ${sets.join(', ')} WHERE id = ? AND agent_id = ?`).run(...vals).changes > 0
}

export function deleteTurn(agentId: string, turnId: number): boolean {
  const db = getDb(agentId)
  return db.prepare('DELETE FROM turns WHERE id = ? AND agent_id = ?').run(turnId, agentId).changes > 0
}

export function deleteSummary(agentId: string, summaryId: number): boolean {
  const db = getDb(agentId)
  return db.prepare('DELETE FROM summaries WHERE id = ? AND agent_id = ?').run(summaryId, agentId).changes > 0
}

// ─── Knowledge Graph extraction ───

export interface GraphNode { id: string; label: string; weight: number }
export interface GraphEdge { source: string; target: string; weight: number }
export interface KnowledgeGraph { nodes: GraphNode[]; edges: GraphEdge[] }

/** Extract entities from memory and build co-occurrence graph */
export function extractKnowledgeGraph(agentId: string): KnowledgeGraph {
  const db = getDb(agentId)
  const turns = db.prepare('SELECT user_message, assistant_response FROM turns WHERE agent_id = ? ORDER BY created_at DESC LIMIT 200')
    .all(agentId) as { user_message: string; assistant_response: string }[]
  const sums = db.prepare('SELECT content FROM summaries WHERE agent_id = ?')
    .all(agentId) as { content: string }[]

  const entityFreq = new Map<string, number>()
  const cooccur = new Map<string, number>()

  // Simple entity extraction: Chinese/English words ≥2 chars, filter stopwords
  const STOP = new Set(['的','了','在','是','我','你','他','她','它','们','这','那','有','不','和','与','也','都','会','能',
    'the','a','an','is','are','was','were','be','been','to','of','and','in','that','it','for','on','with','as','at','by','this',
    '可以','什么','怎么','如何','需要','使用','进行','通过','已经','没有','知道','一个','一些','应该','因为','所以','但是','如果','虽然',
    '请','吗','呢','啊','吧','嗯','哦','好的','ok','yes','no','好','对','嗯嗯','谢谢','thank','thanks','please','help','want','need'])

  const extract = (text: string): string[] => {
    // match Chinese phrases (2-6 chars) and English words (2+ chars)
    const raw = text.match(/[\u4e00-\u9fff]{2,6}|[a-zA-Z_][a-zA-Z0-9_]{1,30}/g) || []
    return raw.map(w => w.toLowerCase()).filter(w => !STOP.has(w) && w.length >= 2)
  }

  const allDocs = [
    ...turns.map(t => `${t.user_message} ${t.assistant_response}`),
    ...sums.map(s => s.content),
  ]

  for (const doc of allDocs) {
    const entities = [...new Set(extract(doc))]
    for (const e of entities) entityFreq.set(e, (entityFreq.get(e) ?? 0) + 1)
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const key = [entities[i], entities[j]].sort().join('|')
        cooccur.set(key, (cooccur.get(key) ?? 0) + 1)
      }
    }
  }

  // Filter: keep top N entities by frequency
  const sorted = [...entityFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)
  const topSet = new Set(sorted.map(([k]) => k))
  const nodes: GraphNode[] = sorted.map(([id, weight]) => ({ id, label: id, weight }))
  const edges: GraphEdge[] = []
  for (const [key, weight] of cooccur) {
    if (weight < 2) continue
    const [s, t] = key.split('|')
    if (topSet.has(s) && topSet.has(t)) edges.push({ source: s, target: t, weight })
  }

  return { nodes, edges }
}

// ─── M5: Palace Structure (Wing/Room/Drawer) ───

export interface DrawerInput {
  wing: string; room: string; content: string
  memoryType?: string; aaak?: string; sourceTurnId?: number; importance?: number
}
export interface Drawer {
  id: string; agentId: string; wing: string; room: string; content: string
  memoryType?: string; aaak?: string; sourceTurnId?: number; importance: number
  createdAt: number; accessedAt: number; accessCount: number
}

function ensureDrawers(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drawers (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      wing TEXT NOT NULL,
      room TEXT NOT NULL,
      content TEXT NOT NULL,
      memory_type TEXT,
      aaak TEXT,
      source_turn_id INTEGER,
      importance REAL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      access_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_drawers_wing ON drawers(agent_id, wing);
    CREATE INDEX IF NOT EXISTS idx_drawers_room ON drawers(agent_id, wing, room);
    CREATE INDEX IF NOT EXISTS idx_drawers_type ON drawers(agent_id, memory_type);
    CREATE INDEX IF NOT EXISTS idx_drawers_importance ON drawers(agent_id, importance DESC);
  `)
}

export function addDrawer(agentId: string, input: DrawerInput): string {
  const db = getDb(agentId)
  const id = nanoid(12)
  const now = Date.now()
  db.prepare(`INSERT INTO drawers (id, agent_id, wing, room, content, memory_type, aaak, source_turn_id, importance, created_at, accessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, agentId, input.wing, input.room, input.content,
    input.memoryType ?? null, input.aaak ?? null, input.sourceTurnId ?? null,
    input.importance ?? 0.5, now, now,
  )
  return id
}

export function getDrawers(agentId: string, wing?: string, room?: string, limit: number = 20): Drawer[] {
  const db = getDb(agentId)
  let sql = 'SELECT * FROM drawers WHERE agent_id = ?'
  const params: any[] = [agentId]
  if (wing) { sql += ' AND wing = ?'; params.push(wing) }
  if (room) { sql += ' AND room = ?'; params.push(room) }
  sql += ' ORDER BY importance DESC, accessed_at DESC LIMIT ?'
  params.push(limit)
  return (db.prepare(sql).all(...params) as any[]).map(r => ({
    id: r.id, agentId: r.agent_id, wing: r.wing, room: r.room, content: r.content,
    memoryType: r.memory_type, aaak: r.aaak, sourceTurnId: r.source_turn_id,
    importance: r.importance, createdAt: r.created_at, accessedAt: r.accessed_at, accessCount: r.access_count,
  }))
}

export function getWings(agentId: string): { wing: string; count: number }[] {
  const db = getDb(agentId)
  return db.prepare('SELECT wing, COUNT(*) as count FROM drawers WHERE agent_id = ? GROUP BY wing ORDER BY count DESC')
    .all(agentId) as { wing: string; count: number }[]
}

export function getRooms(agentId: string, wing: string): { room: string; count: number }[] {
  const db = getDb(agentId)
  return db.prepare('SELECT room, COUNT(*) as count FROM drawers WHERE agent_id = ? AND wing = ? GROUP BY room ORDER BY count DESC')
    .all(agentId, wing) as { room: string; count: number }[]
}

export function touchDrawer(agentId: string, drawerId: string): void {
  const db = getDb(agentId)
  db.prepare('UPDATE drawers SET accessed_at = ?, access_count = access_count + 1 WHERE id = ? AND agent_id = ?')
    .run(Date.now(), drawerId, agentId)
}

export function deleteDrawer(agentId: string, drawerId: string): boolean {
  const db = getDb(agentId)
  const r = db.prepare('DELETE FROM drawers WHERE id = ? AND agent_id = ?').run(drawerId, agentId)
  return r.changes > 0
}

export function getDrawerCount(agentId: string): number {
  const db = getDb(agentId)
  const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM drawers WHERE agent_id = ?').get(agentId) as { cnt: number }
  return cnt
}

export function getAllDrawerContents(agentId: string): { id: string; content: string; wing: string; room: string; memoryType?: string }[] {
  const db = getDb(agentId)
  return (db.prepare('SELECT id, content, wing, room, memory_type FROM drawers WHERE agent_id = ?').all(agentId) as any[]).map(r => ({
    id: r.id, content: r.content, wing: r.wing, room: r.room, memoryType: r.memory_type,
  }))
}

export function closeAllMemoryDbs(): void {
  for (const [, db] of dbCache) { try { db.close() } catch { /* */ } }
  dbCache.clear()
}

// ─── F4: Cross-Session Search (FTS5) ───

export interface SearchResult {
  agentId: string
  turnId: number
  userMessage: string
  assistantResponse: string
  createdAt: number
  rank: number
  snippet: string
}

/** 确保 FTS5 虚拟表存在 */
function ensureFTS(db: Database.Database): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
        user_message, assistant_response,
        content='turns', content_rowid='id',
        tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS turns_fts_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, user_message, assistant_response)
        VALUES (new.id, new.user_message, new.assistant_response);
      END;
      CREATE TRIGGER IF NOT EXISTS turns_fts_ad AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, user_message, assistant_response)
        VALUES ('delete', old.id, old.user_message, old.assistant_response);
      END;
      CREATE TRIGGER IF NOT EXISTS turns_fts_au AFTER UPDATE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, user_message, assistant_response)
        VALUES ('delete', old.id, old.user_message, old.assistant_response);
        INSERT INTO turns_fts(rowid, user_message, assistant_response)
        VALUES (new.id, new.user_message, new.assistant_response);
      END;
    `)
    // 首次创建时重建索引
    const { cnt } = db.prepare("SELECT COUNT(*) as cnt FROM turns_fts").get() as { cnt: number }
    const { total } = db.prepare("SELECT COUNT(*) as total FROM turns").get() as { total: number }
    if (cnt === 0 && total > 0) {
      db.exec("INSERT INTO turns_fts(turns_fts) VALUES('rebuild')")
      console.log(`[memory-fts] rebuilt index for ${total} turns`)
    }
  } catch (e) {
    // FTS5 可能不可用（某些 SQLite 编译版本），静默降级
    console.warn('[memory-fts] FTS5 init failed, search disabled:', e)
  }
}

/** 清洗 FTS5 查询（转义特殊字符） */
function sanitizeFtsQuery(query: string): string {
  // 移除 FTS5 特殊字符，保留中文和英文
  let clean = query
    .replace(/[+{}()^~]/g, ' ')
    .replace(/"/g, ' ')
    .replace(/\*/g, ' ')
    .trim()
  if (!clean) return ''
  // 每个词加引号（避免 FTS5 语法错误）
  const words = clean.split(/\s+/).filter(w => w.length >= 2)
  if (words.length === 0) return ''
  return words.map(w => `"${w}"`).join(' ')
}

/** 搜索单个 agent 的记忆 */
export function searchMemory(query: string, agentId: string, limit: number = 20): SearchResult[] {
  const ftsQuery = sanitizeFtsQuery(query)
  if (!ftsQuery) return []

  try {
    const db = getDb(agentId)
    const rows = db.prepare(`
      SELECT t.id, t.user_message, t.assistant_response, t.created_at,
             rank
      FROM turns_fts fts
      JOIN turns t ON t.id = fts.rowid
      WHERE turns_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as any[]

    return rows.map(r => ({
      agentId,
      turnId: r.id,
      userMessage: r.user_message,
      assistantResponse: r.assistant_response,
      createdAt: r.created_at,
      rank: r.rank,
      snippet: `${r.user_message.slice(0, 200)}...`,
    }))
  } catch {
    return []
  }
}

/** 跨所有 agent 搜索记忆 */
export function searchAllAgents(query: string, limit: number = 20): SearchResult[] {
  const memDir = join(getStoreDir(), 'memory')
  if (!existsSync(memDir)) return []

  let files: string[]
  try { files = readdirSync(memDir).filter(f => f.endsWith('.sqlite')) } catch { return [] }

  const allResults: SearchResult[] = []
  for (const file of files) {
    const agentId = basename(file, '.sqlite')
    const results = searchMemory(query, agentId, limit)
    allResults.push(...results)
  }

  // 按 rank 排序，取 top N
  allResults.sort((a, b) => a.rank - b.rank)
  return allResults.slice(0, limit)
}