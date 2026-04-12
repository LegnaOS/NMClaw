/**
 * Document Parser — 文档解析内置 MCP
 * 支持 PDF / Excel(.xlsx/.xls) / Word(.docx) / PowerPoint(.pptx) / RTF
 */
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, basename } from 'node:path'

// ─── 常量 ───

const MAX_TEXT = 50_000       // 最大返回字符数
const MAX_FILE = 100 * 1024 * 1024  // 100MB
const MAX_SHEETS = 20
const MAX_SLIDES = 100

const SUPPORTED_EXTS = new Set(['.pdf', '.xlsx', '.xls', '.docx', '.pptx', '.rtf'])
const LEGACY_EXTS = new Set(['.doc', '.ppt'])

type DocFormat = 'pdf' | 'xlsx' | 'xls' | 'docx' | 'pptx' | 'rtf'

interface ParseResult {
  format: string
  fileName: string
  fileSize: string
  content: string
  truncated: boolean
  metadata: Record<string, unknown>
}

// ─── 工具函数 ───

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max) + '\n\n...[内容已截断，共 ' + text.length + ' 字符]', truncated: true }
}

function detectFormat(filePath: string): DocFormat | null {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.xlsx' || ext === '.xls') return ext.slice(1) as DocFormat
  if (ext === '.docx') return 'docx'
  if (ext === '.pptx') return 'pptx'
  if (ext === '.rtf') return 'rtf'
  return null
}

// ─── PDF 解析 ───

async function parsePdf(buffer: Buffer, pages?: string): Promise<ParseResult> {
  const pdfParse = (await import('pdf-parse')).default
  const opts: Record<string, unknown> = {}
  if (pages) {
    // 解析页码范围 "1-5" 或 "1,3,5"
    const pageSet = new Set<number>()
    for (const part of pages.split(',')) {
      const range = part.trim().split('-').map(Number)
      if (range.length === 2) {
        for (let i = range[0]; i <= range[1]; i++) pageSet.add(i)
      } else if (range.length === 1 && !isNaN(range[0])) {
        pageSet.add(range[0])
      }
    }
    opts.pagerender = (pageData: any) => {
      if (!pageSet.has(pageData.pageIndex + 1)) return Promise.resolve('')
      return pageData.getTextContent().then((tc: any) =>
        tc.items.map((i: any) => i.str).join('')
      )
    }
  }
  const data = await pdfParse(buffer, opts)
  const { text, truncated } = truncate(data.text || '', MAX_TEXT)
  return {
    format: 'pdf', fileName: '', fileSize: '',
    content: text, truncated,
    metadata: { pages: data.numpages },
  }
}

// ─── Excel 解析 ───

async function parseXlsx(buffer: Buffer, sheetFilter?: string[]): Promise<ParseResult> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const sheetNames = sheetFilter?.length
    ? wb.SheetNames.filter(n => sheetFilter.includes(n))
    : wb.SheetNames.slice(0, MAX_SHEETS)

  const parts: string[] = []
  const sheetMeta: { name: string; rows: number; cols: number }[] = []
  let totalLen = 0

  for (const name of sheetNames) {
    if (totalLen >= MAX_TEXT) break
    const ws = wb.Sheets[name]
    if (!ws) continue
    const rows: string[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as string[][]
    if (rows.length === 0) continue

    // 构建 Markdown 表格
    const header = rows[0].map(c => String(c ?? ''))
    const divider = header.map(() => '---')
    const lines = [`## Sheet: ${name}`, `| ${header.join(' | ')} |`, `| ${divider.join(' | ')} |`]
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i].map(c => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '))
      lines.push(`| ${row.join(' | ')} |`)
    }
    const chunk = lines.join('\n')
    parts.push(chunk)
    totalLen += chunk.length
    sheetMeta.push({ name, rows: rows.length, cols: header.length })
  }

  const remaining = wb.SheetNames.length - sheetNames.length
  let content = parts.join('\n\n')
  if (remaining > 0) content += `\n\n...[还有 ${remaining} 个工作表未显示]`
  const t = truncate(content, MAX_TEXT)
  return {
    format: 'xlsx', fileName: '', fileSize: '',
    content: t.text, truncated: t.truncated,
    metadata: { sheets: sheetMeta, totalSheets: wb.SheetNames.length },
  }
}

// ─── Word 解析 ───

async function parseDocx(buffer: Buffer): Promise<ParseResult> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  const { text, truncated } = truncate(result.value || '', MAX_TEXT)
  return {
    format: 'docx', fileName: '', fileSize: '',
    content: text, truncated,
    metadata: {},
  }
}

// ─── PowerPoint 解析 ───

async function parsePptx(buffer: Buffer): Promise<ParseResult> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buffer)
  const slides: { index: number; text: string }[] = []

  // 找到所有 slide XML
  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0')
      const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0')
      return na - nb
    })
    .slice(0, MAX_SLIDES)

  for (const f of slideFiles) {
    const xml = await zip.files[f].async('text')
    // 提取 <a:t> 文本节点
    const texts: string[] = []
    for (const m of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) {
      const t = m[1].trim()
      if (t) texts.push(t)
    }
    const idx = parseInt(f.match(/slide(\d+)/)?.[1] || '0')
    if (texts.length > 0) slides.push({ index: idx, text: texts.join(' ') })
  }

  const content = slides.map(s => `## 幻灯片 ${s.index}\n${s.text}`).join('\n\n')
  const t = truncate(content, MAX_TEXT)
  return {
    format: 'pptx', fileName: '', fileSize: '',
    content: t.text, truncated: t.truncated,
    metadata: { slides: slideFiles.length },
  }
}

// ─── RTF 解析 ───

async function parseRtf(buffer: Buffer): Promise<ParseResult> {
  let raw = buffer.toString('latin1')
  // 去掉 RTF 头部
  raw = raw.replace(/^\{\\rtf1[^}]*\}?/, '')
  // 处理 Unicode 转义 \uN?
  raw = raw.replace(/\\u(\d+)\??/g, (_, code) => String.fromCharCode(parseInt(code)))
  // \par → 换行
  raw = raw.replace(/\\par\b/g, '\n')
  // 去掉所有控制字 \xxx
  raw = raw.replace(/\\[a-z]+\d*\s?/gi, '')
  // 去掉花括号
  raw = raw.replace(/[{}]/g, '')
  // 清理多余空白
  raw = raw.replace(/\n{3,}/g, '\n\n').trim()
  const { text, truncated } = truncate(raw, MAX_TEXT)
  return {
    format: 'rtf', fileName: '', fileSize: '',
    content: text, truncated,
    metadata: {},
  }
}

// ─── 统一解析入口 ───

async function parseDocument(filePath: string, opts?: { pages?: string; sheets?: string[] }): Promise<ParseResult> {
  if (!existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`)

  const ext = extname(filePath).toLowerCase()
  if (LEGACY_EXTS.has(ext)) {
    throw new Error(`不支持旧版 ${ext} 格式，请转换为 ${ext === '.doc' ? '.docx' : '.pptx'} 后重试`)
  }

  const format = detectFormat(filePath)
  if (!format) {
    throw new Error(`不支持的格式: ${ext}。支持: ${[...SUPPORTED_EXTS].join(', ')}`)
  }

  const info = await stat(filePath)
  if (info.size > MAX_FILE) {
    throw new Error(`文件过大 (${humanSize(info.size)})，最大支持 ${humanSize(MAX_FILE)}`)
  }

  const buffer = await readFile(filePath)
  let result: ParseResult

  try {
    switch (format) {
      case 'pdf': result = await parsePdf(buffer, opts?.pages); break
      case 'xlsx': case 'xls': result = await parseXlsx(buffer, opts?.sheets); break
      case 'docx': result = await parseDocx(buffer); break
      case 'pptx': result = await parsePptx(buffer); break
      case 'rtf': result = await parseRtf(buffer); break
      default: throw new Error(`未实现的格式: ${format}`)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('password') || msg.includes('encrypt') || msg.includes('Password')) {
      throw new Error('文件已加密，请提供未加密版本')
    }
    throw e
  }

  result.fileName = basename(filePath)
  result.fileSize = humanSize(info.size)
  return result
}

// ─── 元信息（不解析全文） ───

async function getDocumentInfo(filePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`)

  const ext = extname(filePath).toLowerCase()
  const info = await stat(filePath)
  const base: Record<string, unknown> = {
    fileName: basename(filePath),
    fileSize: humanSize(info.size),
    extension: ext,
    supported: SUPPORTED_EXTS.has(ext),
  }

  if (LEGACY_EXTS.has(ext)) {
    base.supported = false
    base.hint = `旧版格式，请转换为 ${ext === '.doc' ? '.docx' : '.pptx'}`
    return base
  }

  if (!SUPPORTED_EXTS.has(ext)) return base

  const buffer = await readFile(filePath)
  try {
    if (ext === '.pdf') {
      const pdfParse = (await import('pdf-parse')).default
      const data = await pdfParse(buffer, { max: 0 })
      base.pages = data.numpages
      base.info = data.info
    } else if (ext === '.xlsx' || ext === '.xls') {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(buffer, { type: 'buffer', sheetStubs: true })
      base.sheets = wb.SheetNames
      base.sheetCount = wb.SheetNames.length
    } else if (ext === '.pptx') {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(buffer)
      const slideCount = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length
      base.slides = slideCount
    }
  } catch { /* 元信息获取失败不报错 */ }

  return base
}

// ─── MCP 工具定义 ───

export function getDocumentToolDefs() {
  return [
    {
      name: 'parse_document',
      description: '解析文档文件，提取文本内容。支持 PDF/Excel(.xlsx/.xls)/Word(.docx)/PowerPoint(.pptx)/RTF。Excel 输出 Markdown 表格，PPT 按幻灯片分段。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          pages: { type: 'string', description: 'PDF 页码范围（可选），如 "1-5" 或 "1,3,5"' },
          sheets: { type: 'array', items: { type: 'string' }, description: 'Excel 工作表名过滤（可选），不填则解析全部' },
        },
        required: ['path'],
      },
      concurrencySafe: true,
      readOnly: true,
    },
    {
      name: 'document_info',
      description: '获取文档元信息（页数/工作表/幻灯片数），不解析全文内容，速度快。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
        },
        required: ['path'],
      },
      concurrencySafe: true,
      readOnly: true,
    },
  ]
}

// ─── MCP 工具 handler ───

export async function handleDocumentTool(name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
  try {
    if (name === 'parse_document') {
      const result = await parseDocument(
        input.path as string,
        { pages: input.pages as string, sheets: input.sheets as string[] },
      )
      return {
        content: JSON.stringify({
          format: result.format,
          fileName: result.fileName,
          fileSize: result.fileSize,
          truncated: result.truncated,
          metadata: result.metadata,
          content: result.content,
        }, null, 2),
      }
    }
    if (name === 'document_info') {
      const info = await getDocumentInfo(input.path as string)
      return { content: JSON.stringify(info, null, 2) }
    }
    return { content: `未知工具: ${name}`, isError: true }
  } catch (e) {
    return { content: `文档解析错误: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
}
