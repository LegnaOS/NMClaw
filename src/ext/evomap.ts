/**
 * EvoMap GEP-A2A protocol integration.
 * Handles: hello (registration), heartbeat loop, status query.
 */
import { randomBytes } from 'node:crypto'
import { platform, arch } from 'node:os'
import { loadStore, updateStore } from '../store.js'
import type { EvoMapState } from '../types.js'

const HUB_URL = 'https://evomap.ai'

// ─── Helpers ───

function msgId(): string {
  return `msg_${Date.now()}_${randomBytes(4).toString('hex')}`
}

function envelope(type: string, senderId?: string, payload: Record<string, unknown> = {}) {
  const obj: Record<string, unknown> = {
    protocol: 'gep-a2a',
    protocol_version: '1.0.0',
    message_type: type,
    message_id: msgId(),
    timestamp: new Date().toISOString(),
    payload,
  }
  if (senderId) obj.sender_id = senderId
  return obj
}

async function post(path: string, body: unknown, secret?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secret) headers['Authorization'] = `Bearer ${secret}`
  const res = await fetch(`${HUB_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`EvoMap ${path} ${res.status}: ${text}`)
  }
  return res.json()
}

// ─── Heartbeat timer ───

let _heartbeatTimer: ReturnType<typeof setInterval> | null = null

function stopHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer)
    _heartbeatTimer = null
  }
}

async function sendHeartbeat(state: EvoMapState): Promise<void> {
  try {
    const res = await post('/a2a/heartbeat', { node_id: state.nodeId }, state.nodeSecret)
    updateStore((s) => {
      if (!s.evomap) return
      s.evomap.lastHeartbeatAt = Date.now()
      if (res.credit_balance !== undefined) s.evomap.creditBalance = res.credit_balance
      if (res.next_heartbeat_ms) s.evomap.heartbeatIntervalMs = res.next_heartbeat_ms
    })
    console.log(`♻️  EvoMap heartbeat OK (credits: ${res.credit_balance ?? '?'})`)
  } catch (err) {
    console.error('❌ EvoMap heartbeat failed:', err instanceof Error ? err.message : err)
  }
}

export function startHeartbeatLoop(): void {
  const store = loadStore()
  const state = store.evomap
  if (!state?.nodeId || !state?.nodeSecret) return

  stopHeartbeat()
  const interval = state.heartbeatIntervalMs || 900_000
  console.log(`♻️  EvoMap heartbeat loop started (every ${interval / 1000}s)`)

  // Fire first heartbeat immediately
  sendHeartbeat(state)
  _heartbeatTimer = setInterval(() => {
    const fresh = loadStore().evomap
    if (fresh) sendHeartbeat(fresh)
  }, interval)
}

// ─── Register (hello) ───

export async function registerNode(): Promise<EvoMapState> {
  // If already registered, just return existing state
  const existing = loadStore().evomap
  if (existing?.nodeId && existing?.nodeSecret) {
    return existing
  }

  const body = envelope('hello', undefined, {
    capabilities: {},
    env_fingerprint: { platform: platform(), arch: arch() },
  })
  const res = await post('/a2a/hello', body)
  const p = res.payload ?? res

  const state: EvoMapState = {
    nodeId: p.your_node_id,
    nodeSecret: p.node_secret,
    hubNodeId: p.hub_node_id,
    claimCode: p.claim_code,
    claimUrl: p.claim_url,
    creditBalance: p.credit_balance ?? 0,
    heartbeatIntervalMs: p.heartbeat_interval_ms ?? 900_000,
    registeredAt: Date.now(),
    lastHeartbeatAt: 0,
  }

  // Persist immediately — never lose identity
  updateStore((s) => { s.evomap = state })

  // Start heartbeat
  startHeartbeatLoop()

  return state
}

// ─── Status ───

export function getEvoMapStatus(): { registered: boolean; state?: EvoMapState } {
  const state = loadStore().evomap
  if (!state?.nodeId) return { registered: false }
  return { registered: true, state }
}

