/**
 * SSRF Protection — Simplified from OpenClaw's infra/net/ssrf.ts
 *
 * Core security property: block requests to private/internal IPs and hostnames.
 * No undici dependency — works with Node's native fetch.
 * DNS-rebinding prevention via resolve-then-check.
 */
import { lookup as dnsLookup } from 'node:dns/promises'

// ── Blocked hostnames ──
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',    // GCP metadata
  'metadata.internal',
  'instance-data',               // AWS alias
])

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
]

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, '')
}

function isBlockedHostname(hostname: string): boolean {
  const norm = normalizeHostname(hostname)
  if (!norm) return true  // empty hostname = blocked
  if (BLOCKED_HOSTNAMES.has(norm)) return true
  return BLOCKED_HOSTNAME_SUFFIXES.some(s => norm.endsWith(s))
}

// ── Private IP detection ──
// IPv4 private/special-use ranges (RFC 1918, RFC 5737, loopback, link-local, etc.)
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false
  const [a, b] = parts
  if (a === 10) return true                                  // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true           // 172.16.0.0/12
  if (a === 192 && b === 168) return true                    // 192.168.0.0/16
  if (a === 127) return true                                 // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true                    // 169.254.0.0/16 link-local
  if (a === 0) return true                                   // 0.0.0.0/8
  if (a >= 224) return true                                  // multicast + reserved
  if (a === 100 && b >= 64 && b <= 127) return true          // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true    // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true       // 198.18.0.0/15 benchmark
  return false
}

// Simplified IPv6 check — block loopback, link-local, unique-local, mapped-IPv4-private
function isPrivateIPv6(ip: string): boolean {
  const norm = ip.toLowerCase()
  if (norm === '::1' || norm === '::') return true            // loopback / unspecified
  if (norm.startsWith('fe80:')) return true                   // link-local
  if (norm.startsWith('fc') || norm.startsWith('fd')) return true  // unique-local
  // IPv4-mapped IPv6: ::ffff:x.x.x.x
  const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped && isPrivateIPv4(mapped[1])) return true
  return false
}

function isPrivateIP(address: string): boolean {
  if (address.includes(':')) return isPrivateIPv6(address)
  return isPrivateIPv4(address)
}

// ── Public API ──

/** Check if a hostname or IP literal is blocked (no DNS lookup). */
export function isBlockedHostnameOrIp(hostname: string): boolean {
  const norm = normalizeHostname(hostname)
  if (!norm) return true
  if (isBlockedHostname(norm)) return true
  if (isPrivateIP(norm)) return true
  return false
}

/**
 * Validate URL is safe to fetch — checks hostname + resolved IPs.
 * Throws on blocked targets.
 */
export async function assertSafeUrl(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked protocol: ${parsed.protocol}`)
  }

  const hostname = normalizeHostname(parsed.hostname)

  // Phase 1: fast check on literal hostname/IP
  if (isBlockedHostnameOrIp(hostname)) {
    throw new Error(`Blocked: private/internal hostname or IP — ${hostname}`)
  }

  // Phase 2: resolve DNS and check all returned IPs (prevents DNS rebinding)
  try {
    const results = await dnsLookup(hostname, { all: true })
    for (const entry of results) {
      if (isPrivateIP(entry.address)) {
        throw new Error(`Blocked: ${hostname} resolves to private IP ${entry.address}`)
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Blocked:')) throw e
    // DNS lookup failure for IP literals is OK — already checked above
  }
}

