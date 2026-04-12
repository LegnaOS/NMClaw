/**
 * Document Parser — 文档解析内置 MCP
 * 支持 PDF / Excel(.xlsx/.xls) / Word(.docx) / PowerPoint(.pptx) / RTF
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
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

// ─── Excel 编辑 ───

async function editXlsx(filePath: string, edits: XlsxEdit[]): Promise<string> {
  const XLSX = await import('xlsx')
  const buffer = await readFile(filePath)
  const wb = XLSX.read(buffer, { type: 'buffer' })

  let changeCount = 0
  for (const edit of edits) {
    const sheetName = edit.sheet || wb.SheetNames[0]
    let ws = wb.Sheets[sheetName]

    // 新建工作表
    if (!ws && edit.action === 'add_sheet') {
      ws = XLSX.utils.aoa_to_sheet([[]])
      XLSX.utils.book_append_sheet(wb, ws, sheetName)
      changeCount++
      continue
    }
    if (!ws) throw new Error(`工作表 "${sheetName}" 不存在`)

    if (edit.action === 'set_cell') {
      // 设置单元格值: { action: 'set_cell', cell: 'A1', value: 'hello' }
      if (!edit.cell || edit.value === undefined) throw new Error('set_cell 需要 cell 和 value')
      ws[edit.cell] = { t: typeof edit.value === 'number' ? 'n' : 's', v: edit.value }
      changeCount++
    } else if (edit.action === 'set_row') {
      // 设置整行: { action: 'set_row', row: 2, values: ['a', 'b', 'c'] }
      if (!edit.row || !edit.values) throw new Error('set_row 需要 row 和 values')
      for (let c = 0; c < edit.values.length; c++) {
        const cell = XLSX.utils.encode_cell({ r: edit.row - 1, c })
        const v = edit.values[c]
        ws[cell] = { t: typeof v === 'number' ? 'n' : 's', v }
      }
      // 更新范围
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1')
      range.e.r = Math.max(range.e.r, edit.row - 1)
      range.e.c = Math.max(range.e.c, edit.values.length - 1)
      ws['!ref'] = XLSX.utils.encode_range(range)
      changeCount++
    } else if (edit.action === 'append_rows') {
      // 追加行: { action: 'append_rows', rows: [['a','b'],['c','d']] }
      if (!edit.rows) throw new Error('append_rows 需要 rows')
      XLSX.utils.sheet_add_aoa(ws, edit.rows, { origin: -1 })
      changeCount += edit.rows.length
    } else if (edit.action === 'delete_row') {
      // 删除行（通过重建工作表）
      if (!edit.row) throw new Error('delete_row 需要 row')
      const data: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1 })
      data.splice(edit.row - 1, 1)
      const newWs = XLSX.utils.aoa_to_sheet(data)
      wb.Sheets[sheetName] = newWs
      changeCount++
    } else if (edit.action === 'rename_sheet') {
      // 重命名工作表
      if (!edit.newName) throw new Error('rename_sheet 需要 newName')
      const idx = wb.SheetNames.indexOf(sheetName)
      if (idx >= 0) wb.SheetNames[idx] = edit.newName
      wb.Sheets[edit.newName] = ws
      delete wb.Sheets[sheetName]
      changeCount++
    } else if (edit.action === 'delete_sheet') {
      const idx = wb.SheetNames.indexOf(sheetName)
      if (idx >= 0) {
        wb.SheetNames.splice(idx, 1)
        delete wb.Sheets[sheetName]
        changeCount++
      }
    } else if (edit.action === 'add_sheet') {
      // 已在上面处理
    } else {
      throw new Error(`未知 Excel 编辑操作: ${edit.action}`)
    }
  }

  const outBuf = XLSX.write(wb, { type: 'buffer', bookType: filePath.endsWith('.xls') ? 'xls' : 'xlsx' })
  await writeFile(filePath, outBuf)
  return `Excel 已保存: ${changeCount} 处修改 → ${basename(filePath)}`
}

interface XlsxEdit {
  action: 'set_cell' | 'set_row' | 'append_rows' | 'delete_row' | 'rename_sheet' | 'delete_sheet' | 'add_sheet'
  sheet?: string
  cell?: string
  value?: unknown
  row?: number
  values?: unknown[]
  rows?: unknown[][]
  newName?: string
}

// ─── Word 编辑（文本替换 + 追加段落） ───

async function editDocx(filePath: string, edits: DocxEdit[]): Promise<string> {
  const JSZip = (await import('jszip')).default
  const buffer = await readFile(filePath)
  const zip = await JSZip.loadAsync(buffer)

  const docXml = await zip.files['word/document.xml']?.async('text')
  if (!docXml) throw new Error('无效的 .docx 文件')

  let xml = docXml
  let changeCount = 0

  for (const edit of edits) {
    if (edit.action === 'replace') {
      // 文本替换: { action: 'replace', find: '旧文本', replace: '新文本' }
      if (!edit.find) throw new Error('replace 需要 find')
      // Word XML 中文本可能被拆分到多个 <w:t> 节点，先尝试直接替换
      const before = xml
      xml = xml.split(edit.find).join(edit.replace || '')
      if (xml !== before) changeCount++
    } else if (edit.action === 'append') {
      // 追加段落: { action: 'append', text: '新段落内容' }
      if (!edit.text) throw new Error('append 需要 text')
      const newParagraph = `<w:p><w:r><w:t>${escapeXml(edit.text)}</w:t></w:r></w:p>`
      // 在 </w:body> 前插入
      xml = xml.replace('</w:body>', `${newParagraph}</w:body>`)
      changeCount++
    } else {
      throw new Error(`未知 Word 编辑操作: ${edit.action}`)
    }
  }

  zip.file('word/document.xml', xml)
  const outBuf = await zip.generateAsync({ type: 'nodebuffer' })
  await writeFile(filePath, outBuf)
  return `Word 已保存: ${changeCount} 处修改 → ${basename(filePath)}`
}

interface DocxEdit {
  action: 'replace' | 'append'
  find?: string
  replace?: string
  text?: string
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── PPT 文字替换 ───

async function editPptx(filePath: string, edits: PptxEdit[]): Promise<string> {
  const JSZip = (await import('jszip')).default
  const buffer = await readFile(filePath)
  const zip = await JSZip.loadAsync(buffer)

  let changeCount = 0

  for (const edit of edits) {
    if (edit.action === 'replace') {
      if (!edit.find) throw new Error('replace 需要 find')
      // 在指定幻灯片或所有幻灯片中替换
      const slideFiles = Object.keys(zip.files)
        .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))

      const targets = edit.slide
        ? slideFiles.filter(f => f === `ppt/slides/slide${edit.slide}.xml`)
        : slideFiles

      for (const f of targets) {
        let xml = await zip.files[f].async('text')
        const before = xml
        xml = xml.split(edit.find).join(edit.replace || '')
        if (xml !== before) {
          zip.file(f, xml)
          changeCount++
        }
      }
    } else {
      throw new Error(`未知 PPT 编辑操作: ${edit.action}`)
    }
  }

  const outBuf = await zip.generateAsync({ type: 'nodebuffer' })
  await writeFile(filePath, outBuf)
  return `PowerPoint 已保存: ${changeCount} 处修改 → ${basename(filePath)}`
}

interface PptxEdit {
  action: 'replace'
  find?: string
  replace?: string
  slide?: number  // 指定幻灯片编号，不填则全部
}

// ─── 统一编辑入口 ───

async function editDocument(filePath: string, edits: unknown[]): Promise<string> {
  if (!existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`)
  const ext = extname(filePath).toLowerCase()

  if (ext === '.xlsx' || ext === '.xls') {
    return editXlsx(filePath, edits as XlsxEdit[])
  }
  if (ext === '.docx') {
    return editDocx(filePath, edits as DocxEdit[])
  }
  if (ext === '.pptx') {
    return editPptx(filePath, edits as PptxEdit[])
  }
  if (ext === '.pdf') {
    throw new Error('PDF 是打印格式，不支持原地编辑。可以用 parse_document 读取内容后生成新文件。')
  }
  throw new Error(`不支持编辑 ${ext} 格式。可编辑格式: .xlsx, .xls, .docx, .pptx`)
}

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
    {
      name: 'edit_document',
      description: '编辑文档文件，保留原始格式。支持 Excel(.xlsx/.xls) 完整编辑、Word(.docx) 文本替换/追加、PowerPoint(.pptx) 文字替换。PDF 不支持编辑。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          edits: {
            type: 'array',
            description: '编辑操作列表',
            items: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  description: 'Excel: set_cell/set_row/append_rows/delete_row/rename_sheet/delete_sheet/add_sheet。Word: replace/append。PPT: replace',
                },
                sheet: { type: 'string', description: 'Excel: 工作表名（默认第一个）' },
                cell: { type: 'string', description: 'Excel set_cell: 单元格地址如 "A1"' },
                value: { description: 'Excel set_cell: 单元格值' },
                row: { type: 'number', description: 'Excel set_row/delete_row: 行号（从1开始）' },
                values: { type: 'array', description: 'Excel set_row: 整行值数组' },
                rows: { type: 'array', description: 'Excel append_rows: 二维数组' },
                newName: { type: 'string', description: 'Excel rename_sheet: 新名称' },
                find: { type: 'string', description: 'Word/PPT replace: 要查找的文本' },
                replace: { type: 'string', description: 'Word/PPT replace: 替换为的文本' },
                text: { type: 'string', description: 'Word append: 追加的段落文本' },
                slide: { type: 'number', description: 'PPT replace: 指定幻灯片编号（不填则全部）' },
              },
              required: ['action'],
            },
          },
        },
        required: ['path', 'edits'],
      },
      concurrencySafe: false,
      readOnly: false,
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
    if (name === 'edit_document') {
      const msg = await editDocument(input.path as string, input.edits as unknown[])
      return { content: msg }
    }
    return { content: `未知工具: ${name}`, isError: true }
  } catch (e) {
    return { content: `文档解析错误: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
}
