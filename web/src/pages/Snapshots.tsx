import { useEffect, useState } from 'react'
import { api } from '../api'

interface Snapshot {
  id: number
  action: string
  summary: string
  created_at: number
}

interface FileSnapshot {
  id: number
  action: string
  file_path: string
  file_size: number
  created_at: number
}

type Tab = 'platform' | 'file'

export default function Snapshots() {
  const [tab, setTab] = useState<Tab>('platform')
  const [items, setItems] = useState<Snapshot[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<number | null>(null)
  const [diffData, setDiffData] = useState<Record<number, Record<string, { before: number; after: number }>>>({})
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [configEnabled, setConfigEnabled] = useState(true)
  const [configMaxVersions, setConfigMaxVersions] = useState(10)
  const [configSaving, setConfigSaving] = useState(false)
  // File snapshots
  const [fileItems, setFileItems] = useState<FileSnapshot[]>([])
  const [fileTotal, setFileTotal] = useState(0)
  const [fileLoading, setFileLoading] = useState(true)
  const [fileRestoring, setFileRestoring] = useState<number | null>(null)

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

  const loadFileSnapshots = async () => {
    setFileLoading(true)
    try {
      const res = await api.listFileSnapshots(100)
      setFileItems(res.items)
      setFileTotal(res.total)
    } catch { /* */ }
    setFileLoading(false)
  }

  useEffect(() => { if (tab === 'file') loadFileSnapshots() }, [tab])

  const handleFileRestore = async (id: number) => {
    if (!confirm(`确认恢复文件快照 #${id}？\n\n当前文件会自动备份，可随时再次回溯。`)) return
    setFileRestoring(id)
    try {
      const res = await api.restoreFileSnapshot(id)
      alert(`已恢复文件: ${res.path}`)
      loadFileSnapshots()
    } catch (e) {
      alert(`恢复失败: ${e instanceof Error ? e.message : e}`)
    }
    setFileRestoring(null)
  }

  const loadConfig = async () => {
    try {
      const cfg = await api.getSnapshotConfig()
      setConfigEnabled(cfg.enabled)
      setConfigMaxVersions(cfg.maxVersions)
    } catch { /* */ }
  }

  const saveConfig = async () => {
    setConfigSaving(true)
    try {
      await api.updateSnapshotConfig({ enabled: configEnabled, maxVersions: configMaxVersions })
      load()
    } catch (e) {
      alert(`保存失败: ${e instanceof Error ? e.message : e}`)
    }
    setConfigSaving(false)
  }

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

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-[#f1f5f9]">记忆回溯</h2>
          <p className="text-sm text-[#94a3b8] mt-1">平台配置 + 文件操作，均可回溯恢复</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-[#64748b]">
            {tab === 'platform' ? `${total} 条配置快照` : `${fileTotal} 条文件快照`}
          </span>
          <button
            onClick={() => { if (!showSettings) loadConfig(); setShowSettings(!showSettings) }}
            className="px-3 py-1.5 text-xs rounded bg-[#334155] text-[#94a3b8] hover:bg-[#475569] hover:text-[#f1f5f9] transition-colors"
          >
            {showSettings ? '收起设置' : '⚙ 设置'}
          </button>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-1 mb-4 bg-[#1e293b] rounded-lg p-1 w-fit">
        {([['platform', '平台配置'], ['file', '文件快照']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-1.5 text-xs rounded-md transition-colors ${
              tab === key ? 'bg-[#3b82f6] text-white' : 'text-[#94a3b8] hover:text-[#f1f5f9]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {showSettings && (
        <div className="mb-6 bg-[#1e293b] border border-[#334155] rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-[#f1f5f9]">启用快照</div>
              <div className="text-xs text-[#64748b] mt-0.5">关闭后不再自动记录操作快照</div>
            </div>
            <button
              onClick={() => setConfigEnabled(!configEnabled)}
              className={`relative w-11 h-6 rounded-full transition-colors ${configEnabled ? 'bg-[#3b82f6]' : 'bg-[#475569]'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${configEnabled ? 'translate-x-5' : ''}`} />
            </button>
          </div>

          {configEnabled && (
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-[#f1f5f9]">保留版本数</div>
                <div className="text-xs text-[#64748b] mt-0.5">最小 3，最大 200，永远保留最初始版本</div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={3} max={200} value={configMaxVersions}
                  onChange={e => setConfigMaxVersions(Number(e.target.value))}
                  className="w-32 accent-[#3b82f6]"
                />
                <input
                  type="number"
                  min={3} max={200} value={configMaxVersions}
                  onChange={e => {
                    const v = Number(e.target.value)
                    if (v >= 3 && v <= 200) setConfigMaxVersions(v)
                  }}
                  className="w-16 px-2 py-1 text-sm bg-[#0f172a] border border-[#334155] rounded text-[#f1f5f9] text-center"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={saveConfig}
              disabled={configSaving}
              className="px-4 py-1.5 text-xs rounded bg-[#3b82f6] text-white hover:bg-[#2563eb] disabled:opacity-50 transition-colors"
            >
              {configSaving ? '保存中...' : '保存设置'}
            </button>
          </div>
        </div>
      )}

      {tab === 'platform' && (loading ? (
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
      ))}

      {tab === 'file' && (fileLoading ? (
        <div className="text-center text-[#64748b] py-12">加载中...</div>
      ) : fileItems.length === 0 ? (
        <div className="text-center text-[#64748b] py-12">暂无文件快照。当文件被覆写、移动或删除时，系统会自动备份原文件内容。</div>
      ) : (
        <div className="space-y-2">
          {fileItems.map((snap, i) => (
            <div key={snap.id} className="bg-[#1e293b] border border-[#334155] rounded-lg overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex flex-col items-center shrink-0">
                  <div className={`w-3 h-3 rounded-full ${i === 0 ? 'bg-[#f59e0b]' : 'bg-[#475569]'}`} />
                  {i < fileItems.length - 1 && <div className="w-px h-4 bg-[#334155] mt-1" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-[#64748b]">#{snap.id}</span>
                    <span className="text-sm font-medium text-[#f1f5f9]">{snap.action}</span>
                    <span className="text-xs text-[#64748b]">{formatSize(snap.file_size)}</span>
                  </div>
                  <div className="text-xs text-[#94a3b8] mt-0.5 truncate" title={snap.file_path}>
                    {snap.file_path}
                  </div>
                  <div className="text-xs text-[#64748b] mt-0.5">
                    {formatTime(snap.created_at)} · {timeAgo(snap.created_at)}
                  </div>
                </div>

                <button
                  onClick={() => handleFileRestore(snap.id)}
                  disabled={fileRestoring !== null}
                  className="px-2.5 py-1 text-xs rounded bg-[#1d4ed8] text-white hover:bg-[#2563eb] disabled:opacity-50 transition-colors shrink-0"
                >
                  {fileRestoring === snap.id ? '恢复中...' : '恢复文件'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
