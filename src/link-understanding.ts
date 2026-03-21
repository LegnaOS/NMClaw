/**
 * Link Understanding — Ported from OpenClaw
 *
 * Detects bare URLs in user messages, fetches their content,
 * and augments the message with extracted text so the LLM
 * can "see" what the user is referring to.
 */
import { isBlockedHostnameOrIp, assertSafeUrl } from './ssrf.js'
import { extractContent } from './web-extract.js'

const MARKDOWN_LINK_RE = /\[[^\]]*]\((https?:\/\/\S+?)\)/gi
const BARE_LINK_RE = /https?:\/\/\S+/gi
const MAX_LINKS = 3
const FETCH_TIMEOUT_MS = 15_000
const MAX_CONTENT_CHARS = 8000

const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function isAllowedUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (isBlockedHostnameOrIp(parsed.hostname)) return false
    return true
  } catch { return false }
}

/** Extract up to MAX_LINKS bare URLs from a message (skips markdown-formatted links). */
export function extractLinksFromMessage(message: string): string[] {
  const source = message?.trim()
  if (!source) return []
  const sanitized = source.replace(MARKDOWN_LINK_RE, ' ')
  const seen = new Set<string>()
  const results: string[] = []
  for (const match of sanitized.matchAll(BARE_LINK_RE)) {
    const raw = match[0]?.trim()
    if (!raw || !isAllowedUrl(raw) || seen.has(raw)) continue
    seen.add(raw)
    results.push(raw)
    if (results.length >= MAX_LINKS) break
  }
  return results
}

/** Fetch a single URL and extract content as markdown. */
async function fetchUrlContent(url: string): Promise<string | null> {
  try {
    await assertSafeUrl(url)
    const res = await fetch(url, {
      headers: {
        'User-Agent': WEB_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') || ''
    const body = await res.text()

    // Non-HTML: return as-is (truncated)
    if (!contentType.includes('html')) {
      return body.length > MAX_CONTENT_CHARS
        ? body.slice(0, MAX_CONTENT_CHARS) + '\n...[truncated]'
        : body
    }

    const result = await extractContent(body, url)
    if (!result?.text) return null

    let text = result.title ? `# ${result.title}\n\n${result.text}` : result.text
    if (text.length > MAX_CONTENT_CHARS) {
      text = text.slice(0, MAX_CONTENT_CHARS) + '\n...[truncated]'
    }
    return text
  } catch { return null }
}

/** Format fetched content into a block that's appended to the user message. */
function formatLinkOutput(url: string, content: string): string {
  return `<link_content url="${url}">\n${content}\n</link_content>`
}

/**
 * Process a user message: detect URLs, fetch content, return augmented message.
 * If no URLs found or all fetches fail, returns the original message unchanged.
 */
export async function augmentMessageWithLinks(message: string): Promise<{
  augmented: string
  urls: string[]
}> {
  const urls = extractLinksFromMessage(message)
  if (urls.length === 0) return { augmented: message, urls: [] }

  const results = await Promise.allSettled(
    urls.map(url => fetchUrlContent(url).then(content =>
      content ? formatLinkOutput(url, content) : null
    ))
  )

  const outputs = results
    .filter((r): r is PromiseFulfilledResult<string | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((v): v is string => v !== null)

  if (outputs.length === 0) return { augmented: message, urls }

  return {
    augmented: `${message.trim()}\n\n${outputs.join('\n\n')}`,
    urls,
  }
}

