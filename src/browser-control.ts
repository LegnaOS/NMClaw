/**
 * B9: Browser Control — Playwright-based browser automation tool
 * 参考 OpenClaw browser extension 的 action 设计，用 Playwright 高层 API 实现
 * 注册为 NMClaw MCP 内置工具
 */
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { chromium } from 'playwright-core'

// ─── Session 管理 ───

interface BrowserSession {
  browser: Browser
  context: BrowserContext
  pages: Map<number, Page>  // tabIndex → Page
  activeTab: number
  createdAt: number
}

let session: BrowserSession | null = null
const SESSION_TIMEOUT = 5 * 60 * 1000 // 5 分钟自动关闭
let sessionTimer: ReturnType<typeof setTimeout> | null = null

function resetTimer(): void {
  if (sessionTimer) clearTimeout(sessionTimer)
  sessionTimer = setTimeout(() => { stopBrowser().catch(() => {}) }, SESSION_TIMEOUT)
}

async function ensureSession(): Promise<BrowserSession> {
  if (session) { resetTimer(); return session }

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  const pages = new Map<number, Page>([[0, page]])

  session = { browser, context, pages, activeTab: 0, createdAt: Date.now() }
  resetTimer()
  return session
}

function getActivePage(): Page {
  if (!session) throw new Error('Browser not started')
  const page = session.pages.get(session.activeTab)
  if (!page) throw new Error(`Tab ${session.activeTab} not found`)
  return page
}

// ─── Actions ───

export async function startBrowser(): Promise<string> {
  await ensureSession()
  return 'Browser started (Chromium headless, 1280x720)'
}

export async function stopBrowser(): Promise<string> {
  if (!session) return 'Browser not running'
  if (sessionTimer) clearTimeout(sessionTimer)
  try { await session.browser.close() } catch { /* */ }
  session = null
  return 'Browser stopped'
}

export async function browserStatus(): Promise<string> {
  if (!session) return 'Browser: not running'
  const tabs = [...session.pages.entries()].map(([i, p]) => `  [${i}${i === session!.activeTab ? '*' : ''}] ${p.url()}`)
  return `Browser: running (${session.pages.size} tabs)\n${tabs.join('\n')}`
}

export async function browserNavigate(url: string): Promise<string> {
  const s = await ensureSession()
  const page = getActivePage()
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const status = resp?.status() ?? 0
  return `Navigated to ${page.url()} (status: ${status})`
}

export async function browserScreenshot(fullPage: boolean = false): Promise<{ image: Buffer; contentType: string }> {
  await ensureSession()
  const page = getActivePage()
  const buffer = await page.screenshot({ fullPage, type: 'png', timeout: 15000 })
  return { image: buffer, contentType: 'image/png' }
}

export async function browserClick(selector: string): Promise<string> {
  await ensureSession()
  const page = getActivePage()
  await page.click(selector, { timeout: 10000 })
  return `Clicked: ${selector}`
}

export async function browserType(selector: string, text: string): Promise<string> {
  await ensureSession()
  const page = getActivePage()
  await page.fill(selector, text, { timeout: 10000 })
  return `Typed "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" into ${selector}`
}

export async function browserPress(key: string): Promise<string> {
  await ensureSession()
  const page = getActivePage()
  await page.keyboard.press(key)
  return `Pressed key: ${key}`
}

export async function browserSnapshot(): Promise<string> {
  await ensureSession()
  const page = getActivePage()
  // 获取页面可访问性快照（类似 OpenClaw 的 aria snapshot）
  const title = await page.title()
  const url = page.url()
  // 提取页面文本内容（限制长度）
  const text = await page.evaluate(() => {
    const body = document.body
    if (!body) return ''
    // 提取可见文本，排除 script/style
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        const tag = parent.tagName.toLowerCase()
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT
        const style = getComputedStyle(parent)
        if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    })
    const texts: string[] = []
    let total = 0
    while (walker.nextNode()) {
      const t = (walker.currentNode.textContent || '').trim()
      if (t && total < 8000) { texts.push(t); total += t.length }
    }
    return texts.join('\n')
  })

  // 提取链接和按钮
  const interactables = await page.evaluate(() => {
    const items: string[] = []
    document.querySelectorAll('a[href], button, input, select, textarea').forEach((el, i) => {
      if (i >= 50) return
      const tag = el.tagName.toLowerCase()
      const text = (el as HTMLElement).innerText?.trim().slice(0, 80) || ''
      const href = (el as HTMLAnchorElement).href || ''
      const type = (el as HTMLInputElement).type || ''
      const placeholder = (el as HTMLInputElement).placeholder || ''
      if (tag === 'a') items.push(`[link] "${text}" → ${href}`)
      else if (tag === 'button') items.push(`[button] "${text}"`)
      else if (tag === 'input') items.push(`[input:${type}] placeholder="${placeholder}"`)
      else if (tag === 'select') items.push(`[select] "${text}"`)
      else if (tag === 'textarea') items.push(`[textarea] placeholder="${placeholder}"`)
    })
    return items
  })

  const parts = [`# Page Snapshot\n**URL:** ${url}\n**Title:** ${title}\n`]
  if (text) parts.push(`## Content\n${text.slice(0, 4000)}${text.length > 4000 ? '\n...(truncated)' : ''}`)
  if (interactables.length) parts.push(`\n## Interactive Elements\n${interactables.join('\n')}`)
  return parts.join('\n')
}

export async function browserEvaluate(expression: string): Promise<string> {
  await ensureSession()
  const page = getActivePage()
  const result = await page.evaluate(expression)
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
}

export async function browserWait(selector?: string, timeMs?: number): Promise<string> {
  await ensureSession()
  const page = getActivePage()
  if (selector) {
    await page.waitForSelector(selector, { timeout: timeMs || 10000 })
    return `Element found: ${selector}`
  }
  if (timeMs) {
    await page.waitForTimeout(Math.min(timeMs, 30000))
    return `Waited ${timeMs}ms`
  }
  return 'Nothing to wait for'
}

export async function browserResize(width: number, height: number): Promise<string> {
  await ensureSession()
  const page = getActivePage()
  await page.setViewportSize({ width, height })
  return `Viewport resized to ${width}x${height}`
}

export async function browserTabs(action: 'list' | 'new' | 'close' | 'switch', index?: number): Promise<string> {
  const s = await ensureSession()
  if (action === 'list') {
    const tabs = [...s.pages.entries()].map(([i, p]) => `[${i}${i === s.activeTab ? '*' : ''}] ${p.url()}`)
    return `Tabs:\n${tabs.join('\n')}`
  }
  if (action === 'new') {
    const page = await s.context.newPage()
    const idx = Math.max(...s.pages.keys()) + 1
    s.pages.set(idx, page)
    s.activeTab = idx
    return `New tab opened (index: ${idx})`
  }
  if (action === 'close') {
    const idx = index ?? s.activeTab
    const page = s.pages.get(idx)
    if (!page) return `Tab ${idx} not found`
    await page.close()
    s.pages.delete(idx)
    if (s.activeTab === idx) {
      s.activeTab = s.pages.keys().next().value ?? 0
    }
    return `Tab ${idx} closed`
  }
  if (action === 'switch' && index !== undefined) {
    if (!s.pages.has(index)) return `Tab ${index} not found`
    s.activeTab = index
    return `Switched to tab ${index}: ${s.pages.get(index)!.url()}`
  }
  return 'Unknown tab action'
}

export async function browserPdf(): Promise<{ data: Buffer; contentType: string }> {
  await ensureSession()
  const page = getActivePage()
  const buffer = await page.pdf({ format: 'A4' })
  return { data: buffer, contentType: 'application/pdf' }
}

// ─── MCP 工具定义 ───

export function getBrowserToolDefs() {
  return [
    {
      name: 'browser_status', description: '浏览器状态：是否运行、打开的标签页',
      inputSchema: { type: 'object', properties: {} },
      concurrencySafe: true, readOnly: true,
    },
    {
      name: 'browser_start', description: '启动浏览器（Chromium headless）',
      inputSchema: { type: 'object', properties: {} },
      concurrencySafe: false, readOnly: false,
    },
    {
      name: 'browser_stop', description: '关闭浏览器',
      inputSchema: { type: 'object', properties: {} },
      concurrencySafe: false, readOnly: false,
    },
    {
      name: 'browser_navigate', description: '导航到指定 URL',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL' } }, required: ['url'] },
      concurrencySafe: false, readOnly: false,
    },
    {
      name: 'browser_screenshot', description: '截取当前页面截图',
      inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean', description: '是否截取完整页面（默认仅视口）' } } },
      concurrencySafe: true, readOnly: true,
    },
    {
      name: 'browser_snapshot', description: '获取页面文本快照（内容+可交互元素列表），比截图更适合 AI 理解',
      inputSchema: { type: 'object', properties: {} },
      concurrencySafe: true, readOnly: true,
    },
    {
      name: 'browser_click', description: '点击页面元素',
      inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' } }, required: ['selector'] },
      concurrencySafe: false, readOnly: false,
    },
    {
      name: 'browser_type', description: '在输入框中输入文本',
      inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' }, text: { type: 'string', description: '要输入的文本' } }, required: ['selector', 'text'] },
      concurrencySafe: false, readOnly: false,
    },
    {
      name: 'browser_press', description: '按下键盘按键（如 Enter, Tab, Escape）',
      inputSchema: { type: 'object', properties: { key: { type: 'string', description: '按键名称' } }, required: ['key'] },
      concurrencySafe: false, readOnly: false,
    },
    {
      name: 'browser_evaluate', description: '在页面中执行 JavaScript 表达式',
      inputSchema: { type: 'object', properties: { expression: { type: 'string', description: 'JS 表达式' } }, required: ['expression'] },
      concurrencySafe: true, readOnly: true,
    },
    {
      name: 'browser_wait', description: '等待元素出现或指定时间',
      inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器（可选）' }, timeMs: { type: 'number', description: '等待毫秒数（可选）' } } },
      concurrencySafe: true, readOnly: true,
    },
    {
      name: 'browser_resize', description: '调整浏览器视口大小',
      inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] },
      concurrencySafe: false, readOnly: false,
    },
    {
      name: 'browser_tabs', description: '管理浏览器标签页（list/new/close/switch）',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'new', 'close', 'switch'] }, index: { type: 'number', description: '标签页索引（close/switch 时需要）' } }, required: ['action'] },
      concurrencySafe: false, readOnly: false,
    },
    {
      name: 'browser_pdf', description: '将当前页面导出为 PDF',
      inputSchema: { type: 'object', properties: {} },
      concurrencySafe: true, readOnly: true,
    },
  ]
}

// ─── MCP 工具调用 handler ───

export async function handleBrowserTool(name: string, input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
  try {
    switch (name) {
      case 'browser_status': return { content: await browserStatus() }
      case 'browser_start': return { content: await startBrowser() }
      case 'browser_stop': return { content: await stopBrowser() }
      case 'browser_navigate': return { content: await browserNavigate(input.url as string) }
      case 'browser_screenshot': {
        const { image } = await browserScreenshot(input.fullPage as boolean)
        return { content: `Screenshot taken (${(image.byteLength / 1024).toFixed(0)} KB PNG). Use browser_snapshot for text-based page analysis.` }
      }
      case 'browser_snapshot': return { content: await browserSnapshot() }
      case 'browser_click': return { content: await browserClick(input.selector as string) }
      case 'browser_type': return { content: await browserType(input.selector as string, input.text as string) }
      case 'browser_press': return { content: await browserPress(input.key as string) }
      case 'browser_evaluate': return { content: await browserEvaluate(input.expression as string) }
      case 'browser_wait': return { content: await browserWait(input.selector as string, input.timeMs as number) }
      case 'browser_resize': return { content: await browserResize(input.width as number, input.height as number) }
      case 'browser_tabs': return { content: await browserTabs(input.action as any, input.index as number) }
      case 'browser_pdf': {
        const { data } = await browserPdf()
        return { content: `PDF generated (${(data.byteLength / 1024).toFixed(0)} KB)` }
      }
      default: return { content: `Unknown browser action: ${name}`, isError: true }
    }
  } catch (e) {
    return { content: `Browser error: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
}
