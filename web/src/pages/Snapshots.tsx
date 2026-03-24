import { useEffect, useState } from 'react'
import { api } from '../api'

interface Snapshot {
  id: number
  action: string
  summary: string
  created_at: number
}

export default function Snapshots() {
  const [items, setItems] = useState<Snapshot[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<number | null>(null)
  const [diffData, setDiffData] = useState<Record<number, Record<string, { before: number; after: number }>>>({})
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await api.listSnapshots(100)
      setItems(res.items)
      setTotal(res.total)
    } catch { /* */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handleDiff = async (id: number) => {
    if (expandedId === id) { setExpandedId(null); return }
    setExpandedId(id)
    if (diffData[id]) return
    try {
      const diff = await api.getSnapshotDiff(id)
      setDiffData(prev => ({ ...prev, [id]: diff }))
    } catch { /* */ }
  }

  const handleRestore = async (id: number) => {
    if (!confirm(`确认恢复到快照 #${id}？\n\n当前状态会自动保存为新快照，可随时再次回溯。`)) return
    setRestoring(id)
    try {
      await api.restoreSnapshot(id)
      alert(`已恢复到快照 #${id}`)
      load()
    } catch (e) {
      alert(`恢复失败: ${e instanceof Error ? e.message : e}`)
    }
    setRestoring(null)
  }

  const formatTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

  const timeAgo = (ts: number) => {
    const diff = Date.now() - ts
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
    return `${Math.floor(diff / 86400000)} 天前`
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-[#f1f5f9]">记忆回溯</h2>
          <p className="text-sm text-[#94a3b8] mt-1">每次资源变更自动拍快照，可随时恢复到任意历史版本</p>
        </div>
        <div className="text-sm text-[#64748b]">
          共 {total} 条快照（最多保留 200 条）
        </div>
      </div>

      {loading ? (
        <div className="text-center text-[#64748b] py-12">加载中...</div>
      ) : items.length === 0 ? (
        <div className="text-center text-[#64748b] py-12">暂无操作快照。当你创建、修改或删除资源时，系统会自动记录。</div>
      ) : (
        <div className="space-y-2">
          {items.map((snap, i) => (
            <div key={snap.id} className="bg-[#1e293b] border border-[#334155] rounded-lg overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3">
                {/* 时间线指示器 */}
                <div className="flex flex-col items-center shrink-0">
                  <div className={`w-3 h-3 rounded-full ${i === 0 ? 'bg-[#22c55e]' : 'bg-[#475569]'}`} />
                  {i < items.length - 1 && <div className="w-px h-4 bg-[#334155] mt-1" />}
                </div>

                {/* 快照信息 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-[#64748b]">#{snap.id}</span>
                    <span className="text-sm font-medium text-[#f1f5f9]">{snap.action}</span>
                    {snap.summary && <span className="text-xs text-[#94a3b8]">— {snap.summary}</span>}
                  </div>
                  <div className="text-xs text-[#64748b] mt-0.5">
                    {formatTime(snap.created_at)} · {timeAgo(snap.created_at)}
                  </div>
                </div>

                {/* 操作按钮 */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleDiff(snap.id)}
                    className="px-2.5 py-1 text-xs rounded bg-[#334155] text-[#94a3b8] hover:bg-[#475569] hover:text-[#f1f5f9] transition-colors"
                  >
                    {expandedId === snap.id ? '收起' : '差异'}
                  </button>
                  <button
                    onClick={() => handleRestore(snap.id)}
                    disabled={restoring !== null}
                    className="px-2.5 py-1 text-xs rounded bg-[#1d4ed8] text-white hover:bg-[#2563eb] disabled:opacity-50 transition-colors"
                  >
                    {restoring === snap.id ? '恢复中...' : '恢复'}
                  </button>
                </div>
              </div>

              {/* 差异展开 */}
              {expandedId === snap.id && (
                <div className="px-4 pb-3 pt-1 border-t border-[#334155]/50">
                  {diffData[snap.id] ? (
                    Object.keys(diffData[snap.id]).length === 0 ? (
                      <div className="text-xs text-[#64748b]">与当前状态无差异</div>
                    ) : (
                      <div className="grid grid-cols-3 gap-2">
                        {Object.entries(diffData[snap.id]).map(([key, val]) => (
                          <div key={key} className="text-xs">
                            <span className="text-[#94a3b8]">{key}: </span>
                            <span className="text-[#f87171]">{val.before}</span>
                            <span className="text-[#64748b]"> → </span>
                            <span className="text-[#22c55e]">{val.after}</span>
                          </div>
                        ))}
                      </div>
                    )
                  ) : (
                    <div className="text-xs text-[#64748b]">加载中...</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
