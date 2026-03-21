/**
 * Skill archive upload parser.
 * Supports .zip and .tar.gz containing SKILL.md (or any .md file).
 */

import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

interface ParsedSkill {
  name: string
  description: string
  promptTemplate: string
  requiredMcps?: string[]
}

/** Parse a SKILL.md file into skill metadata */
function parseSkillMd(content: string, fallbackName: string): ParsedSkill {
  const lines = content.split('\n')
  let name = fallbackName
  let description = ''
  const promptLines: string[] = []
  let inFrontmatter = false
  let frontmatterDone = false
  const requiredMcps: string[] = []

  for (const line of lines) {
    // YAML frontmatter
    if (line.trim() === '---' && !frontmatterDone) {
      if (inFrontmatter) { inFrontmatter = false; frontmatterDone = true; continue }
      inFrontmatter = true; continue
    }
    if (inFrontmatter) {
      const m = line.match(/^(\w+):\s*(.+)/)
      if (m) {
        if (m[1] === 'name') name = m[2].trim()
        if (m[1] === 'description') description = m[2].trim()
      }
      continue
    }

    // First heading as name
    const h1 = line.match(/^#\s+(.+)/)
    if (h1 && name === fallbackName) { name = h1[1].trim(); continue }

    // First paragraph as description
    if (!description && line.trim() && !line.startsWith('#')) {
      description = line.trim()
      promptLines.push(line)
      continue
    }

    promptLines.push(line)
  }

  return {
    name,
    description: description || name,
    promptTemplate: promptLines.join('\n').trim(),
    requiredMcps,
  }
}

/** Find .md files recursively (max 2 levels deep) */
function findMdFiles(dir: string, depth = 0): string[] {
  if (depth > 2) return []
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...findMdFiles(full, depth + 1))
    } else if (entry.toLowerCase().endsWith('.md')) {
      results.push(full)
    }
  }
  return results
}

/** Pick the best .md file: SKILL.md > README.md > first .md */
function pickBestMd(files: string[]): string | undefined {
  const names = files.map((f) => ({ path: f, name: f.split('/').pop()!.toLowerCase() }))
  return (
    names.find((f) => f.name === 'skill.md')?.path ??
    names.find((f) => f.name === 'readme.md')?.path ??
    names[0]?.path
  )
}

/** Fetch a SKILL.md from a URL and parse it */
export async function fetchSkillFromUrl(url: string): Promise<ParsedSkill> {
  const res = await fetch(url, {
    headers: { 'Accept': 'text/markdown, text/plain, */*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`获取失败: HTTP ${res.status} ${res.statusText}`)
  const contentType = res.headers.get('content-type') ?? ''
  const text = await res.text()
  if (!text.trim()) throw new Error('URL 返回了空内容')
  // Basic sanity: if it looks like HTML without any markdown, reject
  if (contentType.includes('text/html') && !text.includes('#') && !text.includes('---')) {
    throw new Error('URL 返回的是 HTML 页面而非 Markdown 文件')
  }
  const fallbackName = new URL(url).pathname.split('/').pop()?.replace(/\.md$/i, '') || 'imported-skill'
  return parseSkillMd(text, fallbackName)
}

export async function parseSkillArchive(file: File): Promise<ParsedSkill> {
  const fileName = file.name ?? 'upload'
  const buf = Buffer.from(await file.arrayBuffer())

  // Single .md file upload
  if (fileName.toLowerCase().endsWith('.md')) {
    const content = buf.toString('utf-8')
    const baseName = fileName.replace(/\.md$/i, '')
    return parseSkillMd(content, baseName)
  }

  // Archive: extract to temp dir
  const tmpDir = mkdtempSync(join(tmpdir(), 'nmclaw-skill-'))
  const archivePath = join(tmpDir, fileName)

  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(archivePath, buf)

    if (fileName.endsWith('.zip')) {
      execSync(`unzip -o -q "${archivePath}" -d "${tmpDir}/out"`, { timeout: 10000 })
    } else if (fileName.endsWith('.tar.gz') || fileName.endsWith('.tgz')) {
      execSync(`mkdir -p "${tmpDir}/out" && tar xzf "${archivePath}" -C "${tmpDir}/out"`, { timeout: 10000 })
    } else if (fileName.endsWith('.tar')) {
      execSync(`mkdir -p "${tmpDir}/out" && tar xf "${archivePath}" -C "${tmpDir}/out"`, { timeout: 10000 })
    } else {
      throw new Error('不支持的文件格式，请上传 .zip / .tar.gz / .tgz / .md 文件')
    }

    const outDir = join(tmpDir, 'out')
    const mdFiles = findMdFiles(outDir)
    if (mdFiles.length === 0) {
      throw new Error('压缩包中未找到 .md 文件 (需要 SKILL.md 或 README.md)')
    }

    const bestMd = pickBestMd(mdFiles)!
    const content = readFileSync(bestMd, 'utf-8')
    const baseName = fileName.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '')
    return parseSkillMd(content, baseName)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
