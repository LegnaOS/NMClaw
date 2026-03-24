/**
 * 记忆回溯 — 操作快照引擎
 * 每次平台状态变更前自动拍快照，支持回溯到任意历史版本
 * Storage: ~/.nmclaw/snapshots.sqlite
 *
 * 配置项（store.snapshot）：
 *   enabled: boolean  — false 关闭快照
 *   maxVersions: 3-200 — 保留版本数，默认 10
 *   永远保留最初始版本（id 最小的那条）
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getStoreDir } from './store.js'
import type { SnapshotConfig } from './types.js'

const DEFAULT_CONFIG: SnapshotConfig = { enabled: true, maxVersions: 10 }

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (db) return db
  const dir = getStoreDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'snapshots.sqlite'))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 3000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      store_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snap_time ON snapshots(created_at);
    CREATE TABLE IF NOT EXISTS file_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_content BLOB,
      file_size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fsnap_time ON file_snapshots(created_at);
    CREATE INDEX IF NOT EXISTS idx_fsnap_path ON file_snapshots(file_path);
  `)
  return db
}

// ─── 配置读取 ───

function loadConfig(): SnapshotConfig {
  try {
    const storeFile = join(getStoreDir(), 'store.json')
    if (!existsSync(storeFile)) return DEFAULT_CONFIG
    const store = JSON.parse(readFileSync(storeFile, 'utf-8'))
    if (!store.snapshot) return DEFAULT_CONFIG
    return {
      enabled: store.snapshot.enabled ?? DEFAULT_CONFIG.enabled,
      maxVersions: store.snapshot.maxVersions ?? DEFAULT_CONFIG.maxVersions,
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

export function getSnapshotConfig(): SnapshotConfig {
  return loadConfig()
}

// ─── 操作描述映射 ───

const ACTION_LABELS: Record<string, string> = {
  'POST /api/models': '创建模型',
  'PATCH /api/models': '修改模型',
  'DELETE /api/models': '删除模型',
  'POST /api/skills': '创建技能',
  'PATCH /api/skills': '修改技能',
  'DELETE /api/skills': '删除技能',
  'POST /api/mcps': '创建 MCP',
  'PATCH /api/mcps': '修改 MCP',
  'DELETE /api/mcps': '删除 MCP',
  'POST /api/agents': '创建 Agent',
  'PATCH /api/agents': '修改 Agent',
  'DELETE /api/agents': '删除 Agent',
  'POST /api/graphs': '创建 Graph',
  'PATCH /api/graphs': '修改 Graph',
  'DELETE /api/graphs': '删除 Graph',
  'POST /api/cron': '创建定时任务',
  'PATCH /api/cron': '修改定时任务',
  'DELETE /api/cron': '删除定时任务',
  'POST /api/channels': '创建渠道',
  'PATCH /api/channels': '修改渠道',
  'DELETE /api/channels': '删除渠道',
  'POST /api/bypass/enable': '启用 Bypass',
  'POST /api/bypass/disable': '禁用 Bypass',
}

export function describeAction(method: string, path: string): string {
  const exact = ACTION_LABELS[`${method} ${path}`]
  if (exact) return exact
  for (const [pattern, label] of Object.entries(ACTION_LABELS)) {
    const [m, p] = pattern.split(' ')
    if (m === method && path.startsWith(p)) return label
  }
  return `${method} ${path}`
}

// ─── 快照 CRUD ───

export interface SnapshotRow {
  id: number
  action: string
  summary: string
  created_at: number
}

export interface SnapshotDetail extends SnapshotRow {
  store_json: string
}

/** 拍快照：保存当前 store.json 状态 */
export function recordSnapshot(action: string, summary = ''): number {
  const config = loadConfig()
  if (!config.enabled) return -1

  const d = getDb()
  const storeFile = join(getStoreDir(), 'store.json')
  if (!existsSync(storeFile)) return -1

  const data = readFileSync(storeFile, 'utf-8')
  const info = d.prepare('INSERT INTO snapshots (action, summary, store_json, created_at) VALUES (?, ?, ?, ?)')
    .run(action, summary, data, Date.now())

  // 淘汰策略：永远保留最初始版本（id 最小），超出上限时删除其余最旧的
  evictOldSnapshots(d, config.maxVersions)

  console.log(`[snapshot] recorded #${info.lastInsertRowid}: ${action}${summary ? ` — ${summary}` : ''}`)
  return info.lastInsertRowid as number
}

/** 淘汰旧快照：保留 maxVersions 条 + 永远保留初始版本 */
function evictOldSnapshots(d: Database.Database, maxVersions: number): void {
  const total = (d.prepare('SELECT COUNT(*) as cnt FROM snapshots').get() as { cnt: number }).cnt
  if (total <= maxVersions) return

  // 找到初始版本 id（最小的 id）
  const first = d.prepare('SELECT id FROM snapshots ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined
  if (!first) return

  // 删除：排除初始版本 + 排除最新的 (maxVersions - 1) 条
  // 保留集合 = 初始版本 + 最新 (maxVersions - 1) 条
  d.prepare(`
    DELETE FROM snapshots
    WHERE id != ?
    AND id NOT IN (SELECT id FROM snapshots ORDER BY created_at DESC LIMIT ?)
  `).run(first.id, maxVersions - 1)
}

/** 列出快照（分页） */
export function listSnapshots(limit = 50, offset = 0): SnapshotRow[] {
  return getDb().prepare('SELECT id, action, summary, created_at FROM snapshots ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as SnapshotRow[]
}

/** 获取快照详情（含完整 store_json） */
export function getSnapshot(id: number): SnapshotDetail | undefined {
  return getDb().prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as SnapshotDetail | undefined
}

/** 获取快照总数 */
export function getSnapshotCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) as cnt FROM snapshots').get() as { cnt: number }
  return row.cnt
}

/** 恢复到指定快照 — 先保存当前状态（恢复操作本身也可回溯） */
export function restoreSnapshot(id: number): { ok: boolean; error?: string } {
  const snap = getDb().prepare('SELECT store_json FROM snapshots WHERE id = ?').get(id) as { store_json: string } | undefined
  if (!snap) return { ok: false, error: '快照不存在' }

  // 恢复前先拍一个快照（让恢复操作本身也可以撤销）
  recordSnapshot(`restore:${id}`, `恢复到快照 #${id}`)

  // 覆写 store.json
  const storeFile = join(getStoreDir(), 'store.json')
  writeFileSync(storeFile, snap.store_json, 'utf-8')

  console.log(`[snapshot] restored to #${id}`)
  return { ok: true }
}

/** 对比快照与当前状态的差异（资源数量级别） */
export function diffSnapshot(id: number): { ok: boolean; diff?: Record<string, { before: number; after: number }>; error?: string } {
  const snap = getDb().prepare('SELECT store_json FROM snapshots WHERE id = ?').get(id) as { store_json: string } | undefined
  if (!snap) return { ok: false, error: '快照不存在' }

  const storeFile = join(getStoreDir(), 'store.json')
  if (!existsSync(storeFile)) return { ok: false, error: 'store.json 不存在' }

  const current = JSON.parse(readFileSync(storeFile, 'utf-8'))
  const snapshot = JSON.parse(snap.store_json)

  const keys = ['models', 'skills', 'mcps', 'agents', 'graphs', 'channels'] as const
  const diff: Record<string, { before: number; after: number }> = {}
  for (const k of keys) {
    const before = Array.isArray(snapshot[k]) ? snapshot[k].length : 0
    const after = Array.isArray(current[k]) ? current[k].length : 0
    if (before !== after) diff[k] = { before, after }
  }

  return { ok: true, diff }
}

// ─── 文件快照 ───

const MAX_FILE_SNAPSHOT_SIZE = 10 * 1024 * 1024 // 10MB

export interface FileSnapshotRow {
  id: number
  action: string
  file_path: string
  file_size: number
  created_at: number
}

export interface FileSnapshotDetail extends FileSnapshotRow {
  file_content: Buffer
}

/** 文件快照：在破坏性文件操作前备份文件内容 */
export function recordFileSnapshot(action: string, filePath: string): number {
  const config = loadConfig()
  if (!config.enabled) return -1

  if (!existsSync(filePath)) return -1
  const stat = statSync(filePath)
  if (!stat.isFile()) return -1
  if (stat.size > MAX_FILE_SNAPSHOT_SIZE) return -1

  const d = getDb()
  const content = readFileSync(filePath)
  const info = d.prepare('INSERT INTO file_snapshots (action, file_path, file_content, file_size, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(action, filePath, content, stat.size, Date.now())

  evictOldFileSnapshots(d, config.maxVersions)

  console.log(`[file-snapshot] recorded #${info.lastInsertRowid}: ${action} — ${filePath} (${(stat.size / 1024).toFixed(1)} KB)`)
  return info.lastInsertRowid as number
}

function evictOldFileSnapshots(d: Database.Database, maxVersions: number): void {
  const limit = maxVersions * 3 // 文件快照允许更多条目（每个文件独立计数太复杂，用总量控制）
  const total = (d.prepare('SELECT COUNT(*) as cnt FROM file_snapshots').get() as { cnt: number }).cnt
  if (total <= limit) return
  d.prepare('DELETE FROM file_snapshots WHERE id NOT IN (SELECT id FROM file_snapshots ORDER BY created_at DESC LIMIT ?)').run(limit)
}

export function listFileSnapshots(limit = 50, offset = 0): FileSnapshotRow[] {
  return getDb().prepare('SELECT id, action, file_path, file_size, created_at FROM file_snapshots ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as FileSnapshotRow[]
}

export function getFileSnapshotCount(): number {
  return (getDb().prepare('SELECT COUNT(*) as cnt FROM file_snapshots').get() as { cnt: number }).cnt
}

export function getFileSnapshot(id: number): FileSnapshotDetail | undefined {
  return getDb().prepare('SELECT * FROM file_snapshots WHERE id = ?').get(id) as FileSnapshotDetail | undefined
}

/** 恢复文件快照 — 将备份内容写回原路径 */
export function restoreFileSnapshot(id: number): { ok: boolean; error?: string; path?: string } {
  const snap = getDb().prepare('SELECT file_path, file_content FROM file_snapshots WHERE id = ?').get(id) as { file_path: string; file_content: Buffer } | undefined
  if (!snap) return { ok: false, error: '文件快照不存在' }

  // 恢复前备份当前文件（如果存在）
  if (existsSync(snap.file_path)) {
    recordFileSnapshot(`restore:${id}`, snap.file_path)
  }

  const dir = dirname(snap.file_path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  writeFileSync(snap.file_path, snap.file_content)
  console.log(`[file-snapshot] restored #${id} → ${snap.file_path}`)
  return { ok: true, path: snap.file_path }
}

// ─── 判断是否为需要快照的变更请求 ───

const MUTATING_PREFIXES = [
  '/api/models', '/api/skills', '/api/mcps', '/api/agents',
  '/api/graphs', '/api/cron', '/api/channels', '/api/bypass',
  '/api/pairings',
]

const EXCLUDED_PATHS = [
  '/api/chat', '/api/tasks', '/api/status',
  '/api/channel-messages', '/api/channel-conversations',
  '/api/clawhub', '/api/local-mcps',
]

export function shouldSnapshot(method: string, path: string): boolean {
  if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') return false
  if (EXCLUDED_PATHS.some(p => path.startsWith(p))) return false
  if (method === 'POST' && (
    path.includes('/execute') || path.includes('/send') ||
    path.includes('/start') || path.includes('/stop') ||
    path.includes('/callback') || path.includes('/stream')
  )) return false
  return MUTATING_PREFIXES.some(p => path.startsWith(p))
}
