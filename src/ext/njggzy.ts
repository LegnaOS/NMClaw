/**
 * njggzy — Nanjing Public Resource Trading (南京公共资源交易)
 *
 * Ported from requirements/src/ (Python/FastAPI) into a single TypeScript module.
 * Provides builtin MCP tools for scraping, storing, and querying bidding data.
 */
import Database from 'better-sqlite3'
import { resolve, dirname } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { assertSafeUrl } from '../ssrf.js'
import type { ToolResult } from '../mcp-runtime.js'

// ═══════════════════════════════════════════════════
// §1  Constants
// ═══════════════════════════════════════════════════

const BASE_URL = (process.env.NJGGZY_BASE_URL || 'https://njggzy.nanjing.gov.cn').replace(/\/+$/, '')
const LIST_API = `${BASE_URL}/webdb_njggzy/fjszListAction.action?cmd=getInfolist`
const HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: `${BASE_URL}/`,
}
const TENDER_CATS = ['068001002', '068001001', '068001003', '068001004', '068001005']
const AWARD_CATS = ['068002001', '068002002']

// ═══════════════════════════════════════════════════
// §2  Key Normalization
// ═══════════════════════════════════════════════════

export function normalizeProjectKey(s: string): string {
  if (!s) return ''
  s = s.replace(/【[^】]{0,30}】/g, '')
  s = s.replace(/\s+/g, '')
  s = s.replace(/[（）()\[\]【】《》\u201c\u201d"'·•，,。.;；:：/\\\-—_]/g, '')
  return s.trim().toLowerCase()
}

export function normalizeSectionKey(s: string): string {
  if (!s) return ''
  s = s.replace(/\s+/g, '')
  s = s.replace(/[（）()\[\]【】《》\u201c\u201d"'·•，,。.;；:：/\\\-—_]/g, '')
  return s.trim().toLowerCase()
}

// ═══════════════════════════════════════════════════
// §3  SQLite
// ═══════════════════════════════════════════════════

let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (_db) return _db
  const dbPath = process.env.NJGGZY_DB_PATH || resolve(process.cwd(), 'data', 'njggzy.db')
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.exec(`
    CREATE TABLE IF NOT EXISTS tenders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bid_section_no TEXT, project_name TEXT, bid_section_name TEXT,
      contract_estimate_wan REAL, publish_date TEXT, detail_url TEXT,
      project_key TEXT, bid_section_key TEXT,
      created_at TEXT, updated_at TEXT, UNIQUE(detail_url)
    );
    CREATE TABLE IF NOT EXISTS awards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bid_section_no TEXT, project_name TEXT, bid_section_name TEXT,
      publish_date TEXT, detail_url TEXT, project_key TEXT, bid_section_key TEXT,
      candidate_name TEXT, bid_price_yuan REAL, duration_days INTEGER,
      created_at TEXT, updated_at TEXT, UNIQUE(detail_url)
    );
    CREATE TABLE IF NOT EXISTS details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, detail_url TEXT NOT NULL,
      extracted_json TEXT NOT NULL, raw_text TEXT NOT NULL,
      fetched_at TEXT NOT NULL, UNIQUE(kind, detail_url)
    );
  `)
  return _db
}

function utcNow(): string { return new Date().toISOString() }

// ═══════════════════════════════════════════════════
// §4  DB Operations
// ═══════════════════════════════════════════════════

interface ListingRow {
  bid_section_no: string; project_name: string; bid_section_name: string
  contract_estimate_wan: number | null; publish_date: string; detail_url: string
  project_key: string; bid_section_key: string
}

function upsertTender(db: Database.Database, r: ListingRow): void {
  const now = utcNow()
  db.prepare(`
    INSERT INTO tenders(bid_section_no, project_name, bid_section_name, contract_estimate_wan,
      publish_date, detail_url, project_key, bid_section_key, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(detail_url) DO UPDATE SET
      bid_section_no=excluded.bid_section_no, project_name=excluded.project_name,
      bid_section_name=excluded.bid_section_name, contract_estimate_wan=excluded.contract_estimate_wan,
      publish_date=excluded.publish_date, project_key=excluded.project_key,
      bid_section_key=excluded.bid_section_key, updated_at=excluded.updated_at
  `).run(r.bid_section_no, r.project_name, r.bid_section_name, r.contract_estimate_wan,
    r.publish_date, r.detail_url, r.project_key, r.bid_section_key, now, now)
}

function upsertAward(db: Database.Database, r: ListingRow & { candidate_name?: string; bid_price_yuan?: number | null; duration_days?: number | null }): void {
  const now = utcNow()
  db.prepare(`
    INSERT INTO awards(bid_section_no, project_name, bid_section_name,
      publish_date, detail_url, project_key, bid_section_key,
      candidate_name, bid_price_yuan, duration_days, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(detail_url) DO UPDATE SET
      bid_section_no=excluded.bid_section_no, project_name=excluded.project_name,
      bid_section_name=excluded.bid_section_name, publish_date=excluded.publish_date,
      project_key=excluded.project_key, bid_section_key=excluded.bid_section_key,
      candidate_name=COALESCE(excluded.candidate_name, awards.candidate_name),
      bid_price_yuan=COALESCE(excluded.bid_price_yuan, awards.bid_price_yuan),
      duration_days=COALESCE(excluded.duration_days, awards.duration_days),
      updated_at=excluded.updated_at
  `).run(r.bid_section_no, r.project_name, r.bid_section_name,
    r.publish_date, r.detail_url, r.project_key, r.bid_section_key,
    r.candidate_name ?? null, r.bid_price_yuan ?? null, r.duration_days ?? null, now, now)
}

function saveDetail(db: Database.Database, kind: string, url: string, extracted: Record<string, unknown>, rawText: string): void {
  db.prepare(`
    INSERT INTO details(kind, detail_url, extracted_json, raw_text, fetched_at) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(kind, detail_url) DO UPDATE SET extracted_json=excluded.extracted_json, raw_text=excluded.raw_text, fetched_at=excluded.fetched_at
  `).run(kind, url, JSON.stringify(extracted), rawText, utcNow())
}

function updateAwardSummary(db: Database.Database, url: string, name: string | null, price: number | null, days: number | null): void {
  db.prepare(`
    UPDATE awards SET
      candidate_name=CASE WHEN ?1 IS NOT NULL THEN ?1 ELSE candidate_name END,
      bid_price_yuan=CASE WHEN ?2 IS NOT NULL THEN ?2 ELSE bid_price_yuan END,
      duration_days=CASE WHEN ?3 IS NOT NULL THEN ?3 ELSE duration_days END,
      updated_at=?4 WHERE detail_url=?5
  `).run(name, price, days, utcNow(), url)
}

// ═══════════════════════════════════════════════════
// §5  HTTP Helpers
// ═══════════════════════════════════════════════════

async function fetchHtml(url: string, timeoutMs = 20000): Promise<string> {
  await assertSafeUrl(url)
  let lastErr: Error | null = null
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)))
    }
  }
  throw lastErr ?? new Error('fetch failed')
}

async function fetchListApi(categorynum: string, keyword: string, pageIndex: number, pageSize: number): Promise<Record<string, unknown>[]> {
  await assertSafeUrl(LIST_API)
  const body = new URLSearchParams({ categorynum, keyword: keyword || '', pageIndex: String(pageIndex), pageSize: String(pageSize) })
  const res = await fetch(LIST_API, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const outer = await res.json() as Record<string, unknown>
  const custom = typeof outer.custom === 'string' ? JSON.parse(outer.custom) : (outer.custom || {})
  return ((custom as Record<string, unknown>).Table as Record<string, unknown>[]) || []
}

function toFloat(s: unknown): number | null {
  if (s == null) return null
  if (typeof s === 'number') return s
  const str = String(s).trim().replace(/[^\d.]/g, '')
  if (!str) return null
  const v = parseFloat(str)
  return isNaN(v) ? null : v
}

function mapListRow(row: Record<string, unknown>): ListingRow {
  const href = String(row.href || '')
  const projectName = String(row.ProjectName || '')
  const bidSectionName = String(row.BiaoDuanName || '')
  return {
    bid_section_no: String(row.BiaoDuanNO || ''),
    project_name: projectName,
    bid_section_name: bidSectionName,
    contract_estimate_wan: toFloat(row.HeTongGuSuanPrice ?? row.FaBaoPrice ?? ''),
    publish_date: String(row.GongGaoFBDate || row.infodate || ''),
    detail_url: href ? new URL(href, BASE_URL + '/').href : '',
    project_key: normalizeProjectKey(projectName),
    bid_section_key: normalizeSectionKey(bidSectionName),
  }
}

// ═══════════════════════════════════════════════════
// §6  Scraping
// ═══════════════════════════════════════════════════

function parseYmd(s: string): Date | null {
  const t = (s || '').trim().slice(0, 10)
  if (!t) return null
  const d = new Date(t + 'T00:00:00Z')
  return isNaN(d.getTime()) ? null : d
}

async function scrapeListing(kind: 'tender' | 'award', sinceDate?: string, pageSize = 50): Promise<ListingRow[]> {
  const cats = kind === 'tender' ? TENDER_CATS : AWARD_CATS
  const sinceDt = sinceDate ? parseYmd(sinceDate) : null
  const results: ListingRow[] = []

  for (const cat of cats) {
    let page = 1
    while (page <= 400) {
      let rawRows: Record<string, unknown>[]
      try {
        rawRows = await fetchListApi(cat, '', page, pageSize)
      } catch { break }
      if (!rawRows.length) break
      const mapped = rawRows.map(mapListRow)
      results.push(...mapped)
      if (sinceDt) {
        const lastDt = parseYmd(mapped[mapped.length - 1].publish_date)
        if (lastDt && lastDt < sinceDt) break
      }
      page++
    }
  }

  if (sinceDt) {
    return results.filter(r => {
      const d = parseYmd(r.publish_date)
      return !d || d >= sinceDt
    })
  }
  return results
}

// ═══════════════════════════════════════════════════
// §7  Detail Extraction (regex-based, no BeautifulSoup)
// ═══════════════════════════════════════════════════

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}

function findValue(text: string, keywords: string[]): string | null {
  for (const kw of keywords) {
    const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = text.match(new RegExp(`${esc}\\s*[：:]\\s*([^\\n]{1,2000})`, 's'))
    if (m) return m[1].trim()
  }
  for (const kw of keywords) {
    const idx = text.indexOf(kw)
    if (idx >= 0) {
      const snippet = text.slice(idx, idx + 2400)
      const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const m = snippet.match(new RegExp(`${esc}\\s*([^\\n]{1,2000})`))
      if (m) { const v = m[1].trim().replace(/^[：:\s]+/, ''); if (v) return v }
    }
  }
  return null
}

function extractFirstNumber(text: string, labels: string[]): string | null {
  for (const lab of labels) {
    const idx = text.indexOf(lab)
    if (idx < 0) continue
    const snippet = text.slice(idx, idx + 800)
    const m = snippet.match(/([0-9]+(?:\.[0-9]+)?)/)
    if (m) return m[1]
  }
  return null
}

function extractTenderDetail(html: string): { extracted: Record<string, unknown>; rawText: string } {
  const rawText = stripHtml(html)
  const extracted: Record<string, unknown> = {}
  extracted['建设地点'] = findValue(rawText, ['建设地点', '项目地点', '地点'])
  extracted['招标范围'] = findValue(rawText, ['招标范围', '工程范围', '招标内容', '招标标段内容'])
  extracted['计划工期'] = findValue(rawText, ['计划工期', '工期', '建设工期', '服务期限', '服务期'])
  extracted['合同估算价'] = findValue(rawText, ['合同估算价', '合同估算价(元)', '合同估算价（元）', '估算价'])
  extracted['工程规模'] = findValue(rawText, ['工程规模', '项目规模', '建设规模', '规模'])
  extracted['控制价'] = findValue(rawText, ['控制价', '招标控制价', '最高投标限价', '最高限价'])
  extracted['资质条件'] = findValue(rawText, ['资质条件'])
  extracted['项目负责人资格'] = findValue(rawText, ['项目负责人资格', '项目负责人资格要求'])
  extracted['项目负责人业绩要求'] = findValue(rawText, ['项目负责人业绩', '项目负责人业绩要求', '项目经理业绩'])

  // Duration: extract number
  const dur = extracted['计划工期']
  if (dur) {
    const nm = String(dur).match(/([0-9]+(?:\.[0-9]+)?)/)
    if (nm) extracted['计划工期'] = nm[1]
  }
  return { extracted, rawText }
}

function extractAwardDetail(html: string): { extracted: Record<string, unknown>; rawText: string } {
  const rawText = stripHtml(html)
  const extracted: Record<string, unknown> = {}
  extracted['中标候选人名称'] = findValue(rawText, ['拟中标候选人', '中标候选人名称', '第一中标候选人', '中标候选人', '中标人'])
  extracted['投标报价(元)'] = findValue(rawText, ['投标报价(元)', '投标报价', '投标总报价', '中标价', '中标金额', '合同价格'])
  extracted['工期（日历日）'] = findValue(rawText, ['工期（日历日）', '工期（日历天）', '工期', '日历天', '服务期', '服务期限'])
  extracted['项目负责人'] = findValue(rawText, ['项目负责人', '施工项目负责人', '项目经理', '总监理工程师'])

  // Fallback: extract first number for price/duration
  if (!extracted['投标报价(元)'] || !String(extracted['投标报价(元)']).match(/\d/)) {
    const n = extractFirstNumber(rawText, ['投标报价', '中标价', '报价(元)', '合同价格', '中标金额'])
    if (n) extracted['投标报价(元)'] = n
  }
  if (!extracted['工期（日历日）'] || !String(extracted['工期（日历日）']).match(/\d/)) {
    const n = extractFirstNumber(rawText, ['工期（日历日', '工期（日历天', '工期', '服务期', '服务期限'])
    if (n) extracted['工期（日历日）'] = n
  }
  return { extracted, rawText }
}

function parseBidPrice(v: unknown): number | null {
  if (v == null) return null
  const s = String(v).replace(/,/g, '').replace(/，/g, '')
  let mul = 1
  if (s.includes('亿')) mul = 1e8
  else if (s.includes('万')) mul = 1e4
  const nums = s.match(/([0-9][0-9,]*(?:\.[0-9]+)?)/g)
  if (!nums) return null
  const vals = nums.map(n => parseFloat(n.replace(/,/g, ''))).filter(n => !isNaN(n))
  return vals.length ? Math.max(...vals) * mul : null
}

function parseDuration(v: unknown): number | null {
  if (v == null) return null
  const m = String(v).match(/([0-9]+)/)
  return m ? parseInt(m[1], 10) : null
}

// ═══════════════════════════════════════════════════
// §8  Public API — builtin MCP handler
// ═══════════════════════════════════════════════════

async function scrapeAndStore(kind: 'tender' | 'award', sinceDate?: string): Promise<string> {
  const db = getDb()
  const rows = await scrapeListing(kind, sinceDate)
  for (const r of rows) {
    if (kind === 'tender') upsertTender(db, r)
    else upsertAward(db, r)
  }
  return `已抓取 ${rows.length} 条${kind === 'tender' ? '招标' : '中标'}公告`
}

async function fetchAndParseDetail(kind: 'tender' | 'award', detailUrl: string): Promise<string> {
  const db = getDb()
  const html = await fetchHtml(detailUrl)
  const { extracted, rawText } = kind === 'tender' ? extractTenderDetail(html) : extractAwardDetail(html)
  saveDetail(db, kind, detailUrl, extracted, rawText)
  if (kind === 'award') {
    const candidateName = extracted['中标候选人名称'] as string | null
    const bidPrice = parseBidPrice(extracted['投标报价(元)'])
    const duration = parseDuration(extracted['工期（日历日）'])
    updateAwardSummary(db, detailUrl, candidateName, bidPrice, duration)
  }
  return JSON.stringify(extracted, null, 2)
}

function queryTenders(keyword?: string, limit = 50): string {
  const db = getDb()
  let sql = 'SELECT * FROM tenders'
  const params: unknown[] = []
  if (keyword) {
    sql += ' WHERE project_name LIKE ? OR bid_section_name LIKE ?'
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  sql += ' ORDER BY publish_date DESC LIMIT ?'
  params.push(limit)
  const rows = db.prepare(sql).all(...params)
  return JSON.stringify(rows, null, 2)
}

function queryAwards(keyword?: string, limit = 50): string {
  const db = getDb()
  let sql = 'SELECT * FROM awards'
  const params: unknown[] = []
  if (keyword) {
    sql += ' WHERE project_name LIKE ? OR bid_section_name LIKE ? OR candidate_name LIKE ?'
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  sql += ' ORDER BY publish_date DESC LIMIT ?'
  params.push(limit)
  const rows = db.prepare(sql).all(...params)
  return JSON.stringify(rows, null, 2)
}

function matchTenderAward(keyword?: string): string {
  const db = getDb()
  let sql = `
    SELECT t.project_name, t.bid_section_name, t.contract_estimate_wan,
      a.candidate_name, a.bid_price_yuan, a.duration_days,
      t.publish_date AS tender_date, a.publish_date AS award_date,
      t.detail_url AS tender_url, a.detail_url AS award_url
    FROM tenders t INNER JOIN awards a
      ON t.project_key = a.project_key AND t.bid_section_key = a.bid_section_key`
  const params: unknown[] = []
  if (keyword) {
    sql += ' WHERE t.project_name LIKE ?'
    params.push(`%${keyword}%`)
  }
  sql += ' ORDER BY a.publish_date DESC LIMIT 100'
  const rows = db.prepare(sql).all(...params)
  return JSON.stringify(rows, null, 2)
}

function getStats(): string {
  const db = getDb()
  const tCount = (db.prepare('SELECT COUNT(*) AS c FROM tenders').get() as any).c
  const aCount = (db.prepare('SELECT COUNT(*) AS c FROM awards').get() as any).c
  const matched = (db.prepare('SELECT COUNT(*) AS c FROM tenders t INNER JOIN awards a ON t.project_key = a.project_key AND t.bid_section_key = a.bid_section_key').get() as any).c
  return JSON.stringify({ tenders: tCount, awards: aCount, matched }, null, 2)
}

export async function builtinNjggzy(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'njggzy_scrape': {
        const kind = (input.kind as string) === 'award' ? 'award' as const : 'tender' as const
        const since = input.since_date as string | undefined
        const msg = await scrapeAndStore(kind, since)
        return { content: msg }
      }
      case 'njggzy_detail': {
        const kind = (input.kind as string) === 'award' ? 'award' as const : 'tender' as const
        const url = input.url as string
        if (!url) return { content: '缺少 url 参数', isError: true }
        const result = await fetchAndParseDetail(kind, url)
        return { content: result }
      }
      case 'njggzy_query_tenders': {
        return { content: queryTenders(input.keyword as string | undefined, input.limit as number | undefined) }
      }
      case 'njggzy_query_awards': {
        return { content: queryAwards(input.keyword as string | undefined, input.limit as number | undefined) }
      }
      case 'njggzy_match': {
        return { content: matchTenderAward(input.keyword as string | undefined) }
      }
      case 'njggzy_stats': {
        return { content: getStats() }
      }
      default:
        return { content: `未知 njggzy 操作: ${name}`, isError: true }
    }
  } catch (e) {
    return { content: `njggzy 错误: ${e instanceof Error ? e.message : e}`, isError: true }
  }
}