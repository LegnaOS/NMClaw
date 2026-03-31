import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { StoreData } from './types.js'

const STORE_DIR = join(homedir(), '.nmclaw')
const STORE_FILE = join(STORE_DIR, 'store.json')

const DEFAULT_STORE: StoreData = {
  models: [],
  skills: [],
  mcps: [],
  agents: [],
  tasks: [],
  traces: [],
  bypass: {
    enabled: false,
    rules: {},
    neverBypass: ['delete_data', 'modify_model_registry', 'access_credentials'],
  },
  graphs: [],
  channels: [],
  pairings: [],
}

/* ── 内存缓存 & 写入合并状态 ── */
let cached: StoreData | null = null
let dirty = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

const DEBOUNCE_MS = 50

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true })
  }
}

function scheduleDirtyFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushStore()
  }, DEBOUNCE_MS)
}

export function loadStore(): StoreData {
  if (cached) return structuredClone(cached)

  ensureDir()
  if (!existsSync(STORE_FILE)) {
    cached = structuredClone(DEFAULT_STORE)
    saveStore(cached)
    return structuredClone(cached)
  }
  const raw = readFileSync(STORE_FILE, 'utf-8')
  cached = JSON.parse(raw) as StoreData
  return structuredClone(cached)
}

export function saveStore(data: StoreData): void {
  ensureDir()
  writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8')
  cached = data
  dirty = false
}

/** Read-modify-write helper (debounced disk write) */
export function updateStore(fn: (data: StoreData) => void): StoreData {
  if (!cached) loadStore()
  fn(cached!)
  dirty = true
  scheduleDirtyFlush()
  return structuredClone(cached!)
}

/** 立即将缓存写入磁盘（如果 dirty） */
export function flushStore(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (dirty && cached) {
    saveStore(cached)
  }
}

/** 清除内存缓存，下次 loadStore 重新读磁盘 */
export function invalidateCache(): void {
  flushStore()
  cached = null
}

export function getStoreDir(): string {
  return STORE_DIR
}

/* ── 进程退出保护 ── */
process.on('exit', () => flushStore())
process.on('SIGINT', () => { flushStore(); process.exit(0) })
process.on('SIGTERM', () => { flushStore(); process.exit(0) })
