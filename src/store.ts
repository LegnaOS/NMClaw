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

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true })
  }
}

export function loadStore(): StoreData {
  ensureDir()
  if (!existsSync(STORE_FILE)) {
    saveStore(DEFAULT_STORE)
    return structuredClone(DEFAULT_STORE)
  }
  const raw = readFileSync(STORE_FILE, 'utf-8')
  return JSON.parse(raw) as StoreData
}

export function saveStore(data: StoreData): void {
  ensureDir()
  writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

/** Read-modify-write helper */
export function updateStore(fn: (data: StoreData) => void): StoreData {
  const data = loadStore()
  fn(data)
  saveStore(data)
  return data
}

export function getStoreDir(): string {
  return STORE_DIR
}
