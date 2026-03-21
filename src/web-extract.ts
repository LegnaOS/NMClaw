/**
 * Web Content Extraction — Ported from OpenClaw
 *
 * Three layers:
 * 1. sanitizeHtml — remove hidden elements (CSS, aria-hidden, class-based)
 * 2. Readability — extract main article content via @mozilla/readability
 * 3. htmlToMarkdown — fallback regex-based HTML-to-Markdown conversion
 *
 * Anti-prompt-injection: strips invisible Unicode characters.
 */

// ── Lazy-load Readability deps ──
let _readabilityDeps: Promise<{
  Readability: typeof import('@mozilla/readability').Readability
  parseHTML: typeof import('linkedom').parseHTML
}> | undefined

async function loadReadabilityDeps() {
  if (!_readabilityDeps) {
    _readabilityDeps = Promise.all([
      import('@mozilla/readability'),
      import('linkedom'),
    ]).then(([r, l]) => ({ Readability: r.Readability, parseHTML: l.parseHTML }))
  }
  try { return await _readabilityDeps }
  catch { _readabilityDeps = undefined; throw new Error('Failed to load Readability') }
}

// ── Invisible Unicode stripping ──
const INVISIBLE_UNICODE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/gu

export function stripInvisibleUnicode(text: string): string {
  return text.replace(INVISIBLE_UNICODE_RE, '')
}

// ── CSS/HTML visibility sanitization ──
const HIDDEN_STYLE_PATTERNS: [string, RegExp][] = [
  ['display', /^\s*none\s*$/i],
  ['visibility', /^\s*hidden\s*$/i],
  ['opacity', /^\s*0\s*$/],
  ['font-size', /^\s*0(px|em|rem|pt|%)?\s*$/i],
  ['text-indent', /^\s*-\d{4,}px\s*$/],
  ['color', /^\s*transparent\s*$/i],
  ['color', /^\s*rgba\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)\s*$/i],
]

const HIDDEN_CLASSES = new Set([
  'sr-only', 'visually-hidden', 'd-none', 'hidden',
  'invisible', 'screen-reader-only', 'offscreen',
])

function isStyleHidden(style: string): boolean {
  for (const [prop, pattern] of HIDDEN_STYLE_PATTERNS) {
    const escaped = prop.replace(/-/g, '\\-')
    const m = style.match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, 'i'))
    if (m && pattern.test(m[1])) return true
  }
  // transform: scale(0)
  const transform = style.match(/(?:^|;)\s*transform\s*:\s*([^;]+)/i)
  if (transform && /scale\s*\(\s*0\s*\)/i.test(transform[1])) return true
  // offscreen positioning
  const left = style.match(/(?:^|;)\s*left\s*:\s*([^;]+)/i)
  if (left && /^\s*-\d{4,}px\s*$/i.test(left[1])) return true
  return false
}

function shouldRemoveElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (['meta', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed'].includes(tag)) return true
  if (tag === 'input' && el.getAttribute('type')?.toLowerCase() === 'hidden') return true
  if (el.getAttribute('aria-hidden') === 'true') return true
  if (el.hasAttribute('hidden')) return true
  const cls = el.getAttribute('class') ?? ''
  if (cls.toLowerCase().split(/\s+/).some(c => HIDDEN_CLASSES.has(c))) return true
  const style = el.getAttribute('style') ?? ''
  if (style && isStyleHidden(style)) return true
  return false
}

export async function sanitizeHtml(html: string): Promise<string> {
  let sanitized = html.replace(/<!--[\s\S]*?-->/g, '')
  try {
    const { parseHTML } = await loadReadabilityDeps()
    const { document } = parseHTML(sanitized) as { document: Document }
    const all = Array.from(document.querySelectorAll('*'))
    for (let i = all.length - 1; i >= 0; i--) {
      if (shouldRemoveElement(all[i])) all[i].parentNode?.removeChild(all[i])
    }
    return (document as unknown as { toString(): string }).toString()
  } catch { return sanitized }
}

// ── HTML to Markdown ──
function decodeEntities(v: string): string {
  return v
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/gi, (_, d) => String.fromCharCode(parseInt(d, 10)))
}

function stripTags(v: string): string { return decodeEntities(v.replace(/<[^>]+>/g, '')) }

function normalizeWs(v: string): string {
  return v.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()
}

export function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? normalizeWs(stripTags(titleMatch[1])) : undefined
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
  // Links → markdown
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWs(stripTags(body))
    return label ? `[${label}](${href})` : href
  })
  // Headings
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, body) =>
    `\n${'#'.repeat(Math.min(6, parseInt(lvl)))} ${normalizeWs(stripTags(body))}\n`)
  // List items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWs(stripTags(body))
    return label ? `\n- ${label}` : ''
  })
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, '\n')
  return { text: normalizeWs(stripTags(text)), title }
}

// ── Main extraction pipeline ──
const MAX_HTML_CHARS = 1_000_000

export async function extractContent(html: string, url: string): Promise<{ text: string; title?: string } | null> {
  const clean = await sanitizeHtml(html)

  // Try Readability first (best quality)
  if (clean.length <= MAX_HTML_CHARS) {
    try {
      const { Readability, parseHTML } = await loadReadabilityDeps()
      const { document } = parseHTML(clean)
      try { (document as any).baseURI = url } catch {}
      const reader = new Readability(document, { charThreshold: 0 })
      const parsed = reader.parse()
      if (parsed?.content) {
        const rendered = htmlToMarkdown(parsed.content)
        const text = stripInvisibleUnicode(rendered.text)
        if (text) return { text, title: parsed.title || rendered.title }
      }
    } catch { /* fall through to basic extraction */ }
  }

  // Fallback: basic HTML-to-Markdown
  const rendered = htmlToMarkdown(clean)
  const text = stripInvisibleUnicode(rendered.text)
  return text ? { text, title: rendered.title } : null
}

