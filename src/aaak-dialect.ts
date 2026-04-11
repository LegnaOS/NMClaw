/**
 * AAAK Structured Summary Dialect — pure extraction, zero dependencies.
 * Extracts entities, topics, key sentences, emotions, and flags from text.
 */

export interface AAAKResult {
  entities: { name: string; type: 'person' | 'project' | 'tool' | 'concept' | 'place' }[]
  topics: string[]
  keySentences: string[]
  emotions: { tag: string; intensity: number }[]
  flags: string[]
}

const EMOTION_MAP: Record<string, string> = {
  love: 'love', joy: 'joy', anger: 'rage', sadness: 'sad', fear: 'fear',
  pride: 'pride', peace: 'peace', relief: 'relief', humor: 'humor',
  tenderness: 'tender', raw_honesty: 'raw', self_doubt: 'doubt',
  anxiety: 'anx', exhaustion: 'exhaust', conviction: 'convict',
  warmth: 'warmth', curiosity: 'curious', gratitude: 'grat',
  frustration: 'frust', confusion: 'confuse', satisfaction: 'satis',
  excitement: 'excite', determination: 'determ', surprise: 'surprise',
  nostalgia: 'nostal', loneliness: 'lonely', awe: 'awe',
  contempt: 'contempt', envy: 'envy', shame: 'shame', guilt: 'guilt',
}

const EMOTION_SIGNALS: Record<string, string> = {
  decided: 'determ', prefer: 'convict', worried: 'anx', excited: 'excite',
  frustrated: 'frust', confused: 'confuse', love: 'love', hate: 'rage',
  hope: 'peace', afraid: 'fear', proud: 'pride', grateful: 'grat',
  curious: 'curious', tired: 'exhaust', happy: 'joy', sad: 'sad',
  angry: 'rage', surprised: 'surprise', relieved: 'relief',
  决定: 'determ', 担心: 'anx', 兴奋: 'excite', 困惑: 'confuse',
  喜欢: 'love', 讨厌: 'rage', 害怕: 'fear', 骄傲: 'pride',
  感谢: 'grat', 好奇: 'curious', 累: 'exhaust', 开心: 'joy',
  难过: 'sad', 生气: 'rage',
}

const AMBIGUOUS_NAMES = new Set([
  'will', 'bill', 'mark', 'april', 'may', 'june', 'joy', 'hope', 'faith',
  'chance', 'chase', 'hunter', 'dash', 'flash', 'star', 'sky', 'river',
  'brook', 'lane', 'art', 'clay', 'max', 'rex', 'ray', 'jay', 'rose',
  'violet', 'lily', 'ivy', 'ash', 'reed', 'sage',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'july',
])

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'can', 'may', 'might', 'shall', 'not', 'no', 'nor', 'and',
  'but', 'or', 'if', 'while', 'that', 'this', 'these', 'those', 'then',
  'than', 'so', 'for', 'of', 'in', 'on', 'at', 'to', 'by', 'from',
  'with', 'as', 'into', 'about', 'up', 'out', 'its', 'it', 'i', 'me',
  'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'his',
  'her', 'who', 'what', 'when', 'where', 'how', 'all', 'each', 'every',
  'both', 'few', 'more', 'most', 'other', 'some', 'such', 'just', 'also',
  'very', 'often', 'however', 'too', 'usually', 'really', 'already', 'since',
  'been', 'between', 'after', 'before', 'during', 'without', 'again',
])

const PLACE_HINTS = /city|country|town|village|市|省|区|county|state|island/i
const TOOL_SUFFIX = /\.(js|py|ts|go|rs)$|DB$|API$/i
const PROJECT_HINT = /project|app|system|platform|framework|service/i

/* ── helpers ── */

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?。！？\n])\s+/).filter(s => s.length > 1)
}

function isCapitalized(w: string): boolean {
  return w.length >= 2 && w[0] >= 'A' && w[0] <= 'Z'
}

function isSentenceStart(text: string, idx: number): boolean {
  if (idx === 0) return true
  const before = text.slice(Math.max(0, idx - 3), idx)
  return /[.!?。！？\n]\s*$/.test(before)
}

/* ── core functions ── */

function extractEntities(text: string): AAAKResult['entities'] {
  const seen = new Map<string, AAAKResult['entities'][0]>()
  const re = /\b([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const name = m[1]
    const idx = m.index
    if (name.length < 2 || AMBIGUOUS_NAMES.has(name.toLowerCase())) continue
    if (STOPWORDS.has(name.toLowerCase())) continue
    if (isSentenceStart(text, idx) && !name.includes(' ')) continue
    if (seen.has(name)) continue
    let type: AAAKResult['entities'][0]['type'] = 'person'
    if (TOOL_SUFFIX.test(name)) type = 'tool'
    else if (PROJECT_HINT.test(name)) type = 'project'
    else if (PLACE_HINTS.test(name)) type = 'place'
    else if (name.includes(' ')) type = 'concept'
    seen.set(name, { name, type })
  }
  return [...seen.values()]
}

function extractTopics(text: string): string[] {
  const freq = new Map<string, number>()
  for (const w of text.toLowerCase().split(/[\s,;:!?.。，；：！？]+/)) {
    const clean = w.replace(/[^a-z\u4e00-\u9fff]/g, '')
    if (clean.length < 2 || STOPWORDS.has(clean)) continue
    freq.set(clean, (freq.get(clean) ?? 0) + 1)
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0])
}

export function detectEmotion(text: string): { tag: string; intensity: number }[] {
  const hits = new Map<string, number>()
  const lower = text.toLowerCase()
  for (const [kw, tag] of Object.entries(EMOTION_SIGNALS)) {
    const re = new RegExp(kw, 'gi')
    const count = (lower.match(re) ?? []).length
    if (count > 0) hits.set(tag, Math.min((hits.get(tag) ?? 0) + count, 5))
  }
  return [...hits.entries()].map(([tag, intensity]) => ({ tag, intensity }))
}

function extractKeySentences(text: string, entities: AAAKResult['entities']): string[] {
  const sents = sentences(text)
  const entityNames = new Set(entities.map(e => e.name.toLowerCase()))
  const signalKeys = Object.keys(EMOTION_SIGNALS)
  const scored = sents.map(s => {
    const sl = s.toLowerCase()
    let score = 0
    for (const n of entityNames) if (sl.includes(n.toLowerCase())) score += 2
    for (const k of signalKeys) if (sl.includes(k)) score += 1
    return { s: s.trim(), score }
  })
  return scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(x => x.s)
}

export function extractAAAK(text: string): AAAKResult {
  const entities = extractEntities(text)
  const topics = extractTopics(text)
  const emotions = detectEmotion(text)
  const keySentences = extractKeySentences(text, entities)
  const flags: string[] = []
  if (text.length > 2000) flags.push('long')
  if (/\?|？/.test(text)) flags.push('question')
  if (/TODO|FIXME|HACK/i.test(text)) flags.push('action')
  if (/!{2,}|！{2,}/.test(text)) flags.push('emphasis')
  return { entities, topics, keySentences, emotions, flags }
}

export function formatAAAK(result: AAAKResult): string {
  const parts: string[] = []
  if (result.entities.length)
    parts.push('E:' + result.entities.map(e => `${e.name}/${e.type}`).join(','))
  if (result.topics.length)
    parts.push('T:' + result.topics.join(','))
  if (result.keySentences.length)
    parts.push('K:' + result.keySentences.map(s => `"${s}"`).join(','))
  if (result.flags.length)
    parts.push('F:' + result.flags.join(','))
  if (result.emotions.length)
    parts.push('EM:' + result.emotions.map(e => `${e.tag}/${e.intensity}`).join(','))
  return parts.join(' ')
}
