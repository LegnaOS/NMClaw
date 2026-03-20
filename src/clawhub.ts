/**
 * ClawHub integration — uses Convex API directly.
 * ClawHub is an OpenClaw ecosystem skill registry powered by Convex.
 */

const CONVEX_URL = 'https://wry-manatee-359.convex.cloud'

interface ConvexResponse<T> {
  status: 'success' | 'error'
  value?: T
  errorMessage?: string
}

interface SkillEntry {
  skill: {
    _id: string
    slug: string
    displayName: string
    summary?: string
    tags?: Record<string, string>
    stats?: { downloads?: number; stars?: number; installsAllTime?: number; versions?: number }
    updatedAt?: number
    createdAt?: number
  }
  latestVersion: {
    version: string
    changelog?: string
    createdAt?: number
  } | null
  owner: {
    handle?: string
    displayName?: string
    image?: string
  } | null
  ownerHandle?: string
}

interface ListResponse {
  page: SkillEntry[]
  hasMore: boolean
  nextCursor?: string
}

// Simple in-memory cache to avoid 429 rate limits
let skillsCache: { data: SkillEntry[]; ts: number } | null = null
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function convexQuery<T>(path: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Convex-Client': 'npm-1.33.0',
    },
    body: JSON.stringify({
      path,
      format: 'convex_encoded_json',
      args: [args],
    }),
  })

  if (!res.ok) {
    if (res.status === 429) throw new Error('ClawHub 请求过于频繁，请稍后再试')
    throw new Error(`Convex API error: ${res.status}`)
  }

  const data = await res.json() as ConvexResponse<T>
  if (data.status === 'error') throw new Error(data.errorMessage ?? 'Convex query failed')
  return data.value as T
}

async function fetchAllSkills(): Promise<SkillEntry[]> {
  if (skillsCache && Date.now() - skillsCache.ts < CACHE_TTL) {
    return skillsCache.data
  }

  const result = await convexQuery<ListResponse>('skills:listPublicPageV4', {
    dir: 'desc',
    highlightedOnly: false,
    nonSuspiciousOnly: false,
    numItems: 50,
    sort: 'downloads',
  })

  const entries = result.page ?? []
  skillsCache = { data: entries, ts: Date.now() }
  return entries
}

/** Search skills — fetches from Convex and filters locally */
export async function searchSkills(query: string): Promise<any[]> {
  const entries = await fetchAllSkills()
  const q = query.toLowerCase().trim()

  if (!q) return entries.map(toPublicSkill)

  return entries
    .filter((e) => {
      const name = (e.skill.displayName ?? '').toLowerCase()
      const slug = (e.skill.slug ?? '').toLowerCase()
      const summary = (e.skill.summary ?? '').toLowerCase()
      return name.includes(q) || slug.includes(q) || summary.includes(q)
    })
    .map(toPublicSkill)
}

/** Get skill detail by slug */
export async function getSkillInfo(slug: string): Promise<any> {
  const result = await convexQuery<SkillEntry | null>('skills:getBySlug', { slug })
  if (!result) throw new Error('Skill not found')
  return toPublicSkill(result)
}

function toPublicSkill(entry: SkillEntry) {
  const s = entry.skill
  const tags = s.tags ? Object.keys(s.tags).filter((k) => k !== 'latest') : []
  return {
    slug: s.slug,
    displayName: s.displayName,
    summary: s.summary ?? '',
    tags,
    downloads: s.stats?.downloads ?? 0,
    stars: s.stats?.stars ?? 0,
    installs: s.stats?.installsAllTime ?? 0,
    versions: s.stats?.versions ?? 0,
    version: entry.latestVersion?.version ?? '',
    changelog: entry.latestVersion?.changelog ?? '',
    owner: entry.ownerHandle ?? entry.owner?.handle ?? '',
    ownerAvatar: entry.owner?.image ?? '',
    updatedAt: s.updatedAt ?? s.createdAt ?? 0,
  }
}
