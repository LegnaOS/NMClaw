import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../api'

interface Props { agentId: string; agentName: string; onClose: () => void }

export default function AgentMemory({ agentId, agentName, onClose }: Props) {
  const [tab, setTab] = useState<'turns' | 'summaries' | 'graph'>('turns')
  const [turns, setTurns] = useState<any[]>([])
  const [summaries, setSummaries] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [graph, setGraph] = useState<any>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editData, setEditData] = useState({ user_message: '', assistant_response: '' })
  const [addForm, setAddForm] = useState({ user_message: '', assistant_response: '' })
  const [showAdd, setShowAdd] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const load = useCallback(() => {
    api.getAgentMemory(agentId).then((d: any) => {
      setTurns(d.turns || []); setSummaries(d.summaries || []); setStats(d.stats)
    }).catch(() => {})
  }, [agentId])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (tab === 'graph') api.getMemoryGraph(agentId).then(setGraph).catch(() => {}) }, [tab, agentId])

  // Canvas force graph
  useEffect(() => {
    if (tab !== 'graph' || !graph || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')!
    const W = canvas.width = canvas.parentElement!.clientWidth
    const H = canvas.height = 500
    const nodes = (graph.nodes || []).map((n: any, i: number) => ({
      ...n, x: W / 2 + (Math.random() - 0.5) * 300, y: H / 2 + (Math.random() - 0.5) * 300, vx: 0, vy: 0, idx: i
    }))
    const edges = (graph.edges || []).map((e: any) => ({
      ...e, si: nodes.findIndex((n: any) => n.id === e.source), ti: nodes.findIndex((n: any) => n.id === e.target)
    })).filter((e: any) => e.si >= 0 && e.ti >= 0)
    if (!nodes.length) { ctx.fillStyle = '#64748b'; ctx.font = '14px sans-serif'; ctx.fillText('暂无记忆数据', W / 2 - 50, H / 2); return }
    const maxW = Math.max(1, ...nodes.map((n: any) => n.weight))
    let animId = 0
    const tick = () => {
      // force sim
      for (const n of nodes) { n.vx *= 0.9; n.vy *= 0.9 }
      // repulsion
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy)); const f = 800 / (d * d)
        dx *= f / d; dy *= f / d; nodes[i].vx -= dx; nodes[i].vy -= dy; nodes[j].vx += dx; nodes[j].vy += dy
      }
      // attraction
      for (const e of edges) {
        const a = nodes[e.si], b = nodes[e.ti]; let dx = b.x - a.x, dy = b.y - a.y
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy)); const f = (d - 80) * 0.02
        dx = dx / d * f; dy = dy / d * f; a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy
      }
      // center gravity
      for (const n of nodes) { n.vx += (W / 2 - n.x) * 0.001; n.vy += (H / 2 - n.y) * 0.001; n.x += n.vx; n.y += n.vy }
      // draw
      ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H)
      for (const e of edges) {
        const a = nodes[e.si], b = nodes[e.ti]; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
        ctx.strokeStyle = `rgba(59,130,246,${Math.min(0.6, e.weight * 0.15)})`; ctx.lineWidth = Math.min(3, e.weight * 0.5); ctx.stroke()
      }
      for (const n of nodes) {
        const r = 4 + (n.weight / maxW) * 12; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = `hsl(${210 + (n.weight / maxW) * 40}, 80%, ${50 + (n.weight / maxW) * 20}%)`; ctx.fill()
        ctx.fillStyle = '#e2e8f0'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(n.label, n.x, n.y - r - 4)
      }
      animId = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(animId)
  }, [tab, graph])

  const handleDelete = async (turnId: number) => { await api.deleteMemoryTurn(agentId, turnId); load() }
  const handleDeleteSummary = async (id: number) => { await api.deleteMemorySummary(agentId, id); load() }
  const handleClear = async () => { if (!confirm(`确认清空 ${agentName} 的全部记忆？此操作不可恢复。`)) return; await api.clearAgentMemory(agentId); load() }
  const startEdit = (t: any) => { setEditingId(t.id); setEditData({ user_message: t.user_message, assistant_response: t.assistant_response }) }
  const saveEdit = async () => { if (editingId === null) return; await api.editMemoryTurn(agentId, editingId, editData); setEditingId(null); load() }
  const handleAdd = async () => { if (!addForm.user_message || !addForm.assistant_response) return; await api.addMemoryTurn(agentId, addForm); setAddForm({ user_message: '', assistant_response: '' }); setShowAdd(false); load() }
  const fmtTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#1e293b] rounded-xl border border-[#334155] w-full max-w-5xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#334155]">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold">🧠 {agentName} — 记忆管理</span>
            {stats && <span className="text-xs text-[#64748b]">{stats.turnCount} 轮 · {stats.summaryCount} 摘要 · {stats.dbSizeKB}KB</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleClear} className="px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 rounded">清空全部</button>
            <button onClick={onClose} className="text-[#64748b] hover:text-white text-lg">✕</button>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex gap-1 p-2 border-b border-[#334155]">
          {(['turns', 'summaries', 'graph'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 rounded text-sm ${tab === t ? 'bg-[#3b82f6] text-white' : 'text-[#94a3b8] hover:bg-[#334155]'}`}>
              {t === 'turns' ? '对话记录' : t === 'summaries' ? '摘要' : '知识拓扑'}
            </button>
          ))}
        </div>
        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {tab === 'turns' && (<div className="space-y-2">
            <button onClick={() => setShowAdd(!showAdd)} className="px-3 py-1 bg-[#3b82f6] hover:bg-[#2563eb] rounded text-xs mb-2">+ 添加记忆</button>
            {showAdd && (<div className="bg-[#0f172a] rounded p-3 space-y-2 mb-3 border border-[#475569]">
              <input value={addForm.user_message} onChange={e => setAddForm({ ...addForm, user_message: e.target.value })} placeholder="用户消息" className="w-full bg-[#1e293b] border border-[#475569] rounded px-2 py-1 text-sm outline-none" />
              <input value={addForm.assistant_response} onChange={e => setAddForm({ ...addForm, assistant_response: e.target.value })} placeholder="助手回复" className="w-full bg-[#1e293b] border border-[#475569] rounded px-2 py-1 text-sm outline-none" />
              <button onClick={handleAdd} className="px-3 py-1 bg-green-600 hover:bg-green-700 rounded text-xs">保存</button>
            </div>)}
            {turns.length === 0 && <p className="text-sm text-[#64748b]">暂无对话记录</p>}
            {turns.map(t => (<div key={t.id} className="bg-[#0f172a] rounded p-3 border border-[#334155]/50 text-sm">
              <div className="flex justify-between items-start mb-2">
                <span className="text-[10px] text-[#64748b]">#{t.id} · {fmtTime(t.created_at)} {t.summarized ? '📋' : ''}</span>
                <div className="flex gap-1">
                  {editingId === t.id ? <button onClick={saveEdit} className="text-[10px] text-green-400 hover:text-green-300">保存</button>
                    : <button onClick={() => startEdit(t)} className="text-[10px] text-blue-400 hover:text-blue-300">编辑</button>}
                  <button onClick={() => handleDelete(t.id)} className="text-[10px] text-red-400 hover:text-red-300">删除</button>
                </div>
              </div>
              {editingId === t.id ? (<>
                <textarea value={editData.user_message} onChange={e => setEditData({ ...editData, user_message: e.target.value })} rows={2} className="w-full bg-[#1e293b] border border-[#475569] rounded px-2 py-1 text-xs mb-1 outline-none resize-none" />
                <textarea value={editData.assistant_response} onChange={e => setEditData({ ...editData, assistant_response: e.target.value })} rows={2} className="w-full bg-[#1e293b] border border-[#475569] rounded px-2 py-1 text-xs outline-none resize-none" />
              </>) : (<>
                <div className="text-[#60a5fa] mb-1"><span className="text-[#64748b]">👤</span> {t.user_message.slice(0, 300)}</div>
                <div className="text-[#94a3b8]"><span className="text-[#64748b]">🤖</span> {t.assistant_response.slice(0, 300)}</div>
              </>)}
            </div>))}
          </div>)}
          {tab === 'summaries' && (<div className="space-y-2">
            {summaries.length === 0 && <p className="text-sm text-[#64748b]">暂无摘要（累积 ≥20 轮未摘要对话后自动生成）</p>}
            {summaries.map(s => (<div key={s.id} className="bg-[#0f172a] rounded p-3 border border-[#334155]/50 text-sm">
              <div className="flex justify-between mb-1">
                <span className="text-[10px] text-[#64748b]">#{s.id} · turns {s.turn_start_id}-{s.turn_end_id} · {fmtTime(s.created_at)}</span>
                <button onClick={() => handleDeleteSummary(s.id)} className="text-[10px] text-red-400 hover:text-red-300">删除</button>
              </div>
              <pre className="text-xs text-[#94a3b8] whitespace-pre-wrap">{s.content}</pre>
            </div>))}
          </div>)}
          {tab === 'graph' && <canvas ref={canvasRef} className="w-full rounded border border-[#334155]" />}
        </div>
      </div>
    </div>
  )
}

