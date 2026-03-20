import { useEffect, useState } from 'react'
import { api } from '../api'

export default function ClawHub() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<any>(null)
  const [error, setError] = useState('')

  // Load popular skills on mount
  useEffect(() => {
    api.clawHubSearch('').then(setResults).catch(() => {})
  }, [])

  const search = async () => {
    setSearching(true)
    setError('')
    try {
      const data = await api.clawHubSearch(query.trim())
      setResults(data || [])
      if (query.trim() && !data?.length) setError('未找到匹配的技能')
    } catch (err) {
      setError(err instanceof Error ? err.message : '搜索失败')
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  const install = async (slug: string) => {
    setInstalling(slug)
    try {
      await api.clawHubInstall(slug)
      setInstalled((prev) => new Set(prev).add(slug))
    } catch (err) {
      setError(`安装失败: ${err instanceof Error ? err.message : err}`)
    } finally {
      setInstalling(null)
    }
  }

  const showDetail = async (slug: string) => {
    try {
      const info = await api.clawHubInfo(slug)
      setDetail(info)
    } catch {
      setDetail(null)
    }
  }

  const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">ClawHub 技能商店</h2>
          <p className="text-xs text-[#64748b] mt-1">搜索并一键安装 Agent 技能 — clawhub.ai</p>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="搜索技能... (如: browser, summarize, code)"
          className="flex-1 bg-[#0f172a] border border-[#475569] rounded-lg px-4 py-2 text-sm focus:border-[#3b82f6] outline-none"
        />
        <button
          onClick={search}
          disabled={searching}
          className="px-4 py-2 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-lg text-sm transition-colors shrink-0"
        >
          {searching ? '搜索中...' : '搜索'}
        </button>
      </div>

      {/* Quick categories */}
      <div className="flex flex-wrap gap-2">
        {['browser', 'code', 'summarize', 'database', 'api', 'devtools', 'security'].map((cat) => (
          <button
            key={cat}
            onClick={() => { setQuery(cat); setTimeout(() => search(), 0) }}
            className="px-3 py-1.5 bg-[#1e293b] border border-[#334155] rounded-lg text-xs text-[#94a3b8] hover:border-[#3b82f6] hover:text-[#f1f5f9] transition-colors"
          >
            {cat}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Detail panel */}
      {detail && (
        <div className="bg-[#1e293b] rounded-lg border border-[#334155] p-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                {detail.ownerAvatar && <img src={detail.ownerAvatar} alt="" className="w-6 h-6 rounded-full" />}
                <h3 className="text-sm font-bold">{detail.displayName || detail.slug}</h3>
                {detail.version && <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#334155] text-[#64748b]">v{detail.version}</span>}
              </div>
              {detail.tags?.length > 0 && (
                <div className="flex gap-1 mt-1">
                  {detail.tags.map((t: string) => (
                    <span key={t} className="px-1.5 py-0.5 rounded text-[10px] bg-[#334155] text-[#94a3b8]">{t}</span>
                  ))}
                </div>
              )}
              <p className="text-xs text-[#94a3b8] mt-2">{detail.summary || '无描述'}</p>
              <div className="flex gap-3 mt-1 text-[10px] text-[#64748b]">
                {detail.owner && <span>by {detail.owner}</span>}
                {detail.downloads > 0 && <span>↓ {fmt(detail.downloads)}</span>}
                {detail.stars > 0 && <span>★ {fmt(detail.stars)}</span>}
              </div>
            </div>
            <button onClick={() => setDetail(null)} className="text-xs text-[#64748b] hover:text-[#94a3b8]">关闭</button>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => install(detail.slug)}
              disabled={installing === detail.slug || installed.has(detail.slug)}
              className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded text-xs transition-colors"
            >
              {installed.has(detail.slug) ? '已安装' : installing === detail.slug ? '安装中...' : '安装到本地'}
            </button>
            <code className="px-3 py-1.5 bg-[#0f172a] rounded text-xs text-[#94a3b8] font-mono">
              npx clawhub@latest install {detail.slug}
            </code>
          </div>
        </div>
      )}

      {/* Results list */}
      {results.length > 0 && (
        <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
          <div className="px-4 py-3 border-b border-[#334155]">
            <p className="text-xs text-[#94a3b8]">{query.trim() ? `找到 ${results.length} 个技能` : `热门技能 (${results.length})`}</p>
          </div>
          <div className="divide-y divide-[#334155]/50 max-h-[60vh] overflow-auto">
            {results.map((skill: any) => (
              <div key={skill.slug} className="p-3 flex items-center justify-between hover:bg-[#334155]/20">
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => showDetail(skill.slug)}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{skill.displayName || skill.slug}</span>
                    {skill.version && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#334155] text-[#64748b]">v{skill.version}</span>
                    )}
                  </div>
                  <p className="text-xs text-[#64748b] mt-0.5 truncate">{skill.summary || '无描述'}</p>
                  <div className="flex gap-3 mt-0.5 text-[10px] text-[#64748b]">
                    {skill.owner && <span>{skill.owner}</span>}
                    {skill.downloads > 0 && <span>↓ {fmt(skill.downloads)}</span>}
                    {skill.stars > 0 && <span>★ {fmt(skill.stars)}</span>}
                  </div>
                </div>
                <button
                  onClick={() => install(skill.slug)}
                  disabled={installing === skill.slug || installed.has(skill.slug)}
                  className="px-3 py-1 rounded text-xs transition-colors shrink-0 ml-3 disabled:opacity-40 bg-[#3b82f6] hover:bg-[#2563eb]"
                >
                  {installed.has(skill.slug) ? '已安装' : installing === skill.slug ? '...' : '安装'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {results.length === 0 && !error && !searching && (
        <div className="bg-[#1e293b] rounded-lg border border-[#334155] p-4">
          <p className="text-xs text-[#94a3b8]">ClawHub 是 OpenClaw 生态的技能注册中心。搜索社区发布的 AgentSkills，一键安装到 NMClaw。</p>
          <p className="text-xs text-[#64748b] mt-2">命令行安装: <code className="font-mono text-[#f1f5f9]">npx clawhub@latest install &lt;slug&gt;</code></p>
        </div>
      )}
    </div>
  )
}
