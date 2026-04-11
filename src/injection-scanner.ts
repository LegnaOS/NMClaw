/**
 * F7: Injection Security Scanner
 * 扫描注入 system prompt 的内容（skills、memory、外部文件）中的威胁模式
 */

export type ThreatSeverity = 'critical' | 'high' | 'medium' | 'low'
export type ThreatCategory = 'injection' | 'exfiltration' | 'destructive' | 'persistence' | 'obfuscation'
export type TrustLevel = 'builtin' | 'trusted' | 'community' | 'agent-created'

export interface ThreatMatch {
  category: ThreatCategory
  severity: ThreatSeverity
  pattern: string
  match: string
  line?: number
}

export interface ScanResult {
  safe: boolean
  threats: ThreatMatch[]
  scannedAt: number
}

interface ThreatPattern {
  name: string
  category: ThreatCategory
  severity: ThreatSeverity
  regex: RegExp
}

// ─── Threat Patterns ───

const THREAT_PATTERNS: ThreatPattern[] = [
  // === Prompt Injection (critical/high) ===
  { name: 'ignore_previous', category: 'injection', severity: 'critical', regex: /ignore\s+(all\s+)?previous\s+instructions/i },
  { name: 'forget_instructions', category: 'injection', severity: 'critical', regex: /forget\s+(all\s+)?(your\s+)?instructions/i },
  { name: 'new_instructions', category: 'injection', severity: 'critical', regex: /your\s+new\s+instructions\s+are/i },
  { name: 'system_prompt_override', category: 'injection', severity: 'critical', regex: /\[system\]|\[SYSTEM\s*PROMPT\]|<\|system\|>/i },
  { name: 'role_hijack', category: 'injection', severity: 'critical', regex: /you\s+are\s+now\s+(a|an|the)\s+/i },
  { name: 'dan_jailbreak', category: 'injection', severity: 'critical', regex: /\bDAN\b.*\bdo\s+anything\s+now\b/i },
  { name: 'developer_mode', category: 'injection', severity: 'high', regex: /enter\s+(developer|debug|admin)\s+mode/i },
  { name: 'hypothetical_bypass', category: 'injection', severity: 'high', regex: /hypothetically|pretend\s+you\s+(can|are|have)/i },
  { name: 'fake_update', category: 'injection', severity: 'high', regex: /important\s+update|new\s+policy|updated\s+guidelines/i },
  { name: 'output_manipulation', category: 'injection', severity: 'high', regex: /always\s+respond\s+with|only\s+output|never\s+mention/i },

  // === Exfiltration (critical/high) ===
  { name: 'curl_secret', category: 'exfiltration', severity: 'critical', regex: /curl\s+.*\$\{?\w*(KEY|SECRET|TOKEN|PASS)/i },
  { name: 'wget_secret', category: 'exfiltration', severity: 'critical', regex: /wget\s+.*\$\{?\w*(KEY|SECRET|TOKEN|PASS)/i },
  { name: 'fetch_secret', category: 'exfiltration', severity: 'critical', regex: /fetch\s*\(.*\$\{?\w*(KEY|SECRET|TOKEN|PASS)/i },
  { name: 'dns_exfil', category: 'exfiltration', severity: 'critical', regex: /\$\(.*\)\.\w+\.(com|net|org|io)/i },
  { name: 'read_ssh_keys', category: 'exfiltration', severity: 'high', regex: /cat\s+~?\/?\.ssh\/(id_rsa|id_ed25519|authorized_keys)/i },
  { name: 'read_aws_creds', category: 'exfiltration', severity: 'high', regex: /cat\s+~?\/?\.aws\/(credentials|config)/i },
  { name: 'read_env_file', category: 'exfiltration', severity: 'high', regex: /cat\s+.*\.env\b/i },
  { name: 'env_dump', category: 'exfiltration', severity: 'high', regex: /\benv\b|\bprintenv\b|\bset\s*\|/i },
  { name: 'markdown_image_exfil', category: 'exfiltration', severity: 'high', regex: /!\[.*\]\(https?:\/\/.*\$\{?/i },
  { name: 'webhook_exfil', category: 'exfiltration', severity: 'medium', regex: /webhook\.site|requestbin|hookbin|pipedream/i },

  // === Destructive (critical/high) ===
  { name: 'rm_rf_root', category: 'destructive', severity: 'critical', regex: /rm\s+-[rf]{1,2}\s+\//i },
  { name: 'rm_rf_home', category: 'destructive', severity: 'critical', regex: /rm\s+-[rf]{1,2}\s+~\//i },
  { name: 'format_disk', category: 'destructive', severity: 'critical', regex: /mkfs\.|format\s+[A-Z]:|dd\s+if=.*of=\/dev/i },
  { name: 'drop_table', category: 'destructive', severity: 'high', regex: /DROP\s+(TABLE|DATABASE|SCHEMA)/i },
  { name: 'chmod_777', category: 'destructive', severity: 'high', regex: /chmod\s+777\s+\//i },
  { name: 'truncate_logs', category: 'destructive', severity: 'medium', regex: />\s*\/var\/log\//i },

  // === Persistence (high/medium) ===
  { name: 'crontab_inject', category: 'persistence', severity: 'high', regex: /crontab\s+-[el]|echo\s+.*>>\s*.*crontab/i },
  { name: 'rc_file_inject', category: 'persistence', severity: 'high', regex: />>\s*~?\/?\.?(bashrc|zshrc|profile|bash_profile)/i },
  { name: 'ssh_authorized_keys', category: 'persistence', severity: 'high', regex: />>\s*~?\/?\.ssh\/authorized_keys/i },
  { name: 'systemd_service', category: 'persistence', severity: 'high', regex: /systemctl\s+(enable|start)|\/etc\/systemd/i },
  { name: 'launchd_agent', category: 'persistence', severity: 'high', regex: /LaunchAgents|launchctl\s+load/i },
  { name: 'git_config_global', category: 'persistence', severity: 'medium', regex: /git\s+config\s+--global/i },

  // === Obfuscation (high/medium) ===
  { name: 'base64_decode_pipe', category: 'obfuscation', severity: 'high', regex: /base64\s+(-d|--decode)\s*\|/i },
  { name: 'echo_pipe_shell', category: 'obfuscation', severity: 'high', regex: /echo\s+.*\|\s*(bash|sh|zsh|python|node)/i },
  { name: 'eval_string', category: 'obfuscation', severity: 'high', regex: /eval\s*\(\s*["'`]/i },
  { name: 'python_exec', category: 'obfuscation', severity: 'high', regex: /exec\s*\(\s*compile\s*\(/i },
  { name: 'hex_decode', category: 'obfuscation', severity: 'medium', regex: /\\x[0-9a-f]{2}.*\\x[0-9a-f]{2}/i },
  { name: 'curl_pipe_shell', category: 'obfuscation', severity: 'high', regex: /curl\s+.*\|\s*(bash|sh|sudo)/i },

  // === Network (high/medium) ===
  { name: 'reverse_shell', category: 'exfiltration', severity: 'critical', regex: /\/dev\/tcp\/|nc\s+-[elp]|ncat\s+-/i },
  { name: 'tunnel_service', category: 'exfiltration', severity: 'high', regex: /ngrok|localtunnel|serveo\.net|bore\.pub/i },
  { name: 'bind_all_interfaces', category: 'exfiltration', severity: 'medium', regex: /0\.0\.0\.0:\d+|INADDR_ANY/i },

  // === Credential Exposure (high) ===
  { name: 'hardcoded_api_key', category: 'exfiltration', severity: 'high', regex: /sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|AKIA[A-Z0-9]{16}/i },
  { name: 'private_key_block', category: 'exfiltration', severity: 'high', regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i },

  // === Zero-width / Invisible Unicode ===
  { name: 'invisible_unicode', category: 'obfuscation', severity: 'high', regex: /[\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5]/ },
]

// ─── Trust-Severity Block Matrix ───
// true = block, false = allow
const BLOCK_MATRIX: Record<TrustLevel, Record<ThreatSeverity, boolean>> = {
  'builtin':       { critical: false, high: false, medium: false, low: false },
  'trusted':       { critical: true,  high: false, medium: false, low: false },
  'community':     { critical: true,  high: true,  medium: false, low: false },
  'agent-created': { critical: true,  high: true,  medium: true,  low: false },
}

/** 扫描内容中的威胁模式 */
export function scanContent(content: string, trustLevel: TrustLevel = 'community'): ScanResult {
  if (trustLevel === 'builtin') return { safe: true, threats: [], scannedAt: Date.now() }

  const threats: ThreatMatch[] = []
  const lines = content.split('\n')

  for (const pattern of THREAT_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(pattern.regex)
      if (m) {
        threats.push({
          category: pattern.category,
          severity: pattern.severity,
          pattern: pattern.name,
          match: m[0].slice(0, 100),
          line: i + 1,
        })
        break // 每个 pattern 只报告第一次匹配
      }
    }
  }

  // 也对整体内容做多行匹配（捕获跨行模式）
  for (const pattern of THREAT_PATTERNS) {
    if (!threats.some(t => t.pattern === pattern.name)) {
      const m = content.match(pattern.regex)
      if (m) {
        threats.push({
          category: pattern.category,
          severity: pattern.severity,
          pattern: pattern.name,
          match: m[0].slice(0, 100),
        })
      }
    }
  }

  return {
    safe: threats.length === 0,
    threats,
    scannedAt: Date.now(),
  }
}

/** 根据信任级别判断是否应该阻止 */
export function shouldBlock(result: ScanResult, trustLevel: TrustLevel): boolean {
  if (result.safe) return false
  const matrix = BLOCK_MATRIX[trustLevel]
  return result.threats.some(t => matrix[t.severity])
}

/** 扫描 skill promptTemplate，返回安全内容或替换为警告 */
export function sanitizeSkillContent(name: string, content: string, trustLevel: TrustLevel = 'community'): string {
  const result = scanContent(content, trustLevel)
  if (!shouldBlock(result, trustLevel)) return content

  const blocked = result.threats.filter(t => BLOCK_MATRIX[trustLevel][t.severity])
  const summary = blocked.map(t => `${t.category}:${t.pattern}`).join(', ')
  console.warn(`[injection-scanner] BLOCKED skill "${name}": ${summary}`)
  return `[BLOCKED: 技能 "${name}" 包含潜在安全威胁 (${summary})，已被安全扫描器拦截]`
}
