/**
 * 记忆回溯 — 操作快照引擎
 * 每次平台状态变更前自动拍快照，支持回溯到任意历史版本
 * Storage: ~/.nmclaw/snapshots.sqlite
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getStoreDir } from './store.js'

const MAX_SNAPSHOTS = 200

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
  `)
  return db
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
  // 精确匹配
  const exact = ACTION_LABELS[`${method} ${path}`]
  if (exact) return exact
  // 前缀匹配（处理 /api/models/:id 这类路径）
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
  const d = getDb()
  const storeFile = join(getStoreDir(), 'store.json')
  if (!existsSync(storeFile)) return -1

  const data = readFileSync(storeFile, 'utf-8')
  const info = d.prepare('INSERT INTO snapshots (action, summary, store_json, created_at) VALUES (?, ?, ?, ?)')
    .run(action, summary, data, Date.now())

  // 淘汰超出上限的旧快照
  d.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY created_at DESC LIMIT ?)').run(MAX_SNAPSHOTS)

  console.log(`[snapshot] recorded #${info.lastInsertRowid}: ${action}${summary ? ` — ${summary}` : ''}`)
  return info.lastInsertRowid as number
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
  // 排除非变更操作
  if (EXCLUDED_PATHS.some(p => path.startsWith(p))) return false
  // 排除特定 POST 端点（执行/发送/启停/回调）
  if (method === 'POST' && (
    path.includes('/execute') || path.includes('/send') ||
    path.includes('/start') || path.includes('/stop') ||
    path.includes('/callback') || path.includes('/stream')
  )) return false
  // 匹配资源变更路径
  return MUTATING_PREFIXES.some(p => path.startsWith(p))
}
