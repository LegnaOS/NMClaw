/**
 * F1: Skill Auto-Evolution
 * 自主技能学习 — Agent 完成复杂任务后自动提取方法论保存为 SKILL.md
 * 存储: ~/.nmclaw/skills/{skill-name}/SKILL.md
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'
import { getStoreDir } from './store.js'
import { scanContent, shouldBlock } from './injection-scanner.js'
import type { ChatMessage } from './types.js'

export interface EvolvedSkillMeta {
  name: string
  description: string
  version: number
  platforms: string[]
  prerequisites: string[]
  createdAt: number
  updatedAt: number
  sourceAgentId?: string
  toolCallCount?: number
}

// ─── 磁盘路径 ───

export function getSkillsDir(): string {
  const dir = join(getStoreDir(), 'skills')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// ─── 索引缓存 ───

let indexCache: { skills: EvolvedSkillMeta[]; cachedAt: number } | null = null
const INDEX_CACHE_TTL = 60_000 // 60s

/** 扫描磁盘，仅解析 YAML frontmatter（快速） */
export function loadSkillIndex(): EvolvedSkillMeta[] {
  if (indexCache && Date.now() - indexCache.cachedAt < INDEX_CACHE_TTL) {
    return indexCache.skills
  }
  const dir = getSkillsDir()
  const skills: EvolvedSkillMeta[] = []
  let entries: string[]
  try { entries = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { entries = [] }

  for (const name of entries) {
    const mdPath = join(dir, name, 'SKILL.md')
    if (!existsSync(mdPath)) continue
    try {
      const raw = readFileSync(mdPath, 'utf-8')
      const meta = parseFrontmatter(raw)
      if (meta) skills.push(meta)
    } catch { /* skip malformed */ }
  }

  indexCache = { skills, cachedAt: Date.now() }
  return skills
}

/** 读取完整 SKILL.md 内容 */
export function loadSkillContent(skillName: string): string | null {
  const mdPath = join(getSkillsDir(), skillName, 'SKILL.md')
  if (!existsSync(mdPath)) return null
  return readFileSync(mdPath, 'utf-8')
}

/** 原子写入技能（写临时文件 + rename），写入前安全扫描 */
export function saveSkill(meta: EvolvedSkillMeta, content: string): { ok: boolean; error?: string } {
  // 安全扫描
  const scan = scanContent(content, 'agent-created')
  if (shouldBlock(scan, 'agent-created')) {
    const threats = scan.threats.map(t => `${t.category}:${t.pattern}`).join(', ')
    console.warn(`[skill-evolution] BLOCKED save "${meta.name}": ${threats}`)
    return { ok: false, error: `安全扫描拦截: ${threats}` }
  }

  const skillDir = join(getSkillsDir(), meta.name)
  if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true })

  const mdPath = join(skillDir, 'SKILL.md')
  const tmpPath = mdPath + '.tmp'

  // 构建 SKILL.md 内容
  const frontmatter = [
    '---',
    `name: ${meta.name}`,
    `description: ${meta.description}`,
    `version: ${meta.version}`,
    `platforms: [${meta.platforms.join(', ')}]`,
    `prerequisites: [${meta.prerequisites.join(', ')}]`,
    `created: ${new Date(meta.createdAt).toISOString()}`,
    `updated: ${new Date(meta.updatedAt).toISOString()}`,
    meta.sourceAgentId ? `sourceAgent: ${meta.sourceAgentId}` : '',
    '---',
  ].filter(Boolean).join('\n')

  const fullContent = `${frontmatter}\n\n${content}`

  try {
    writeFileSync(tmpPath, fullContent, 'utf-8')
    renameSync(tmpPath, mdPath)
    // 清除索引缓存
    indexCache = null
    console.log(`[skill-evolution] saved "${meta.name}" v${meta.version}`)
    return { ok: true }
  } catch (err) {
    try { rmSync(tmpPath, { force: true }) } catch { /* */ }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 删除技能 */
export function deleteSkill(skillName: string): boolean {
  const skillDir = join(getSkillsDir(), skillName)
  if (!existsSync(skillDir)) return false
  try {
    rmSync(skillDir, { recursive: true, force: true })
    indexCache = null
    console.log(`[skill-evolution] deleted "${skillName}"`)
    return true
  } catch { return false }
}

// ─── 进化触发逻辑 ───

const EVOLVE_TOOL_THRESHOLD = 5
const EVOLVE_ERROR_THRESHOLD = 2

/** 判断是否应该触发技能进化 */
export function shouldEvolveSkill(toolCallCount: number, errorsOvercome: number): boolean {
  return toolCallCount >= EVOLVE_TOOL_THRESHOLD || errorsOvercome >= EVOLVE_ERROR_THRESHOLD
}

/** 构建技能提取 prompt */
export function buildSkillExtractionPrompt(messages: ChatMessage[], toolTrace: string[]): string {
  const conversationSummary = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map(m => `${m.role}: ${m.content.slice(0, 300)}`)
    .join('\n')

  const toolSummary = toolTrace.slice(-20).join('\n')

  return `你刚刚完成了一个复杂任务，使用了多个工具调用。请分析这次任务的方法论，提取为一个可复用的技能。

## 对话摘要
${conversationSummary}

## 工具调用记录
${toolSummary}

## 输出要求
请用以下 JSON 格式输出技能信息（不要输出其他内容）：
\`\`\`json
{
  "name": "技能名称（英文kebab-case，如 web-research）",
  "description": "一句话描述这个技能的用途",
  "prerequisites": ["需要的工具名称列表"],
  "content": "技能的详细步骤说明（Markdown 格式）"
}
\`\`\`

要求：
- name 必须是英文 kebab-case，2-64 字符
- description 用中文，不超过 200 字符
- content 包含：何时使用、具体步骤、常见陷阱
- 只提取通用可复用的方法论，不要包含具体的数据或参数`
}

/** 从 LLM 响应中解析技能 */
export function parseSkillFromResponse(response: string): { meta: EvolvedSkillMeta; content: string } | null {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) || response.match(/\{[\s\S]*"name"[\s\S]*"content"[\s\S]*\}/)
  if (!jsonMatch) return null

  try {
    const raw = jsonMatch[1] || jsonMatch[0]
    const parsed = JSON.parse(raw.trim())
    if (!parsed.name || !parsed.content) return null

    // 验证 name 格式
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(parsed.name)) return null

    const now = Date.now()
    // 检查是否已存在（版本递增）
    const existing = loadSkillIndex().find(s => s.name === parsed.name)

    return {
      meta: {
        name: parsed.name,
        description: parsed.description || '',
        version: existing ? existing.version + 1 : 1,
        platforms: parsed.platforms || [],
        prerequisites: parsed.prerequisites || [],
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      },
      content: parsed.content,
    }
  } catch { return null }
}

/** 构建技能索引 prompt（注入 system prompt，仅元数据） */
export function buildSkillIndexPrompt(): string {
  const skills = loadSkillIndex()
  if (skills.length === 0) return ''

  const lines = skills.map(s =>
    `- ${s.name} (v${s.version}): ${s.description}${s.prerequisites.length ? ` [需要: ${s.prerequisites.join(', ')}]` : ''}`
  )

  return `[进化技能库 — ${skills.length} 个自动学习的技能]\n${lines.join('\n')}\n\n使用 list_evolved_skills 查看详情，view_evolved_skill 查看完整内容。`
}

// ─── YAML Frontmatter 解析 ───

function parseFrontmatter(raw: string): EvolvedSkillMeta | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null

  const yaml = match[1]
  const get = (key: string): string => {
    const m = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    return m ? m[1].trim() : ''
  }
  const getArray = (key: string): string[] => {
    const val = get(key)
    if (!val) return []
    const m = val.match(/\[([^\]]*)\]/)
    if (!m) return [val]
    return m[1].split(',').map(s => s.trim()).filter(Boolean)
  }

  const name = get('name')
  if (!name) return null

  return {
    name,
    description: get('description'),
    version: parseInt(get('version')) || 1,
    platforms: getArray('platforms'),
    prerequisites: getArray('prerequisites'),
    createdAt: new Date(get('created') || 0).getTime() || Date.now(),
    updatedAt: new Date(get('updated') || 0).getTime() || Date.now(),
    sourceAgentId: get('sourceAgent') || undefined,
  }
}
