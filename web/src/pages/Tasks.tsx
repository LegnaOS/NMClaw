import { useEffect, useState } from 'react'
import { api } from '../api'

const TYPE_STYLES: Record<string, { color: string; icon: string; label: string }> = {
  dispatch: { color: 'text-[#94a3b8]', icon: '▶', label: 'Dispatch' },
  llm: { color: 'text-[#3b82f6]', icon: '◈', label: 'LLM' },
  tool: { color: 'text-[#22c55e]', icon: '⚙', label: 'Tool' },
  chain: { color: 'text-[#a855f7]', icon: '◇', label: 'Chain' },
}

function SpanNode({ span, traceStart, totalDuration }: { span: any; traceStart: number; totalDuration: number }) {
  const [open, setOpen] = useState(false)
  const style = TYPE_STYLES[span.type] || TYPE_STYLES.chain
  const offsetPct = totalDuration > 0 ? ((span.timestamp - traceStart) / totalDuration) * 100 : 0
  const widthPct = totalDuration > 0 ? Math.max((span.durationMs / totalDuration) * 100, 1) : 100
  const isError = span.status === 'error'

  return (
    <div className="border-l-2 border-[#334155] ml-2 pl-3 py-1">
      <button onClick={() => setOpen(!open)} className="w-full text-left group">
        <div className="flex items-center gap-2 text-xs">
          <span className={`text-[10px] transition-transform duration-100 ${open ? 'rotate-90' : ''}`}>▶</span>
          <span className={`${style.color} font-medium`}>{style.icon} {style.label}</span>
          <span className="text-[#f1f5f9] font-mono">{span.name || span.action}</span>
          <span className={`ml-auto ${isError ? 'text-red-400' : 'text-[#64748b]'}`}>{span.durationMs}ms</span>
          {span.tokensUsed > 0 && <span className="text-[#64748b]">{span.tokensUsed}t</span>}
          {isError && <span className="text-red-400">✗</span>}
          {span.status === 'success' && span.type !== 'dispatch' && <span className="text-[#22c55e]">✓</span>}
        </div>
        {/* Waterfall bar */}
        <div className="mt-1 h-1.5 bg-[#1e293b] rounded-full overflow-hidden relative">
          <div
            className={`absolute h-full rounded-full ${isError ? 'bg-red-500/60' : span.type === 'llm' ? 'bg-[#3b82f6]/60' : span.type === 'tool' ? 'bg-[#22c55e]/60' : 'bg-[#a855f7]/40'}`}
            style={{ left: `${offsetPct}%`, width: `${widthPct}%` }}
          />
        </div>
      </button>
      {open && (
        <div className="mt-1 ml-4 space-y-1 text-[11px]">
          {span.input && (
            <div className="bg-[#0f172a] rounded p-2">
              <span className="text-[#64748b]">Input: </span>
              <span className="text-[#94a3b8] font-mono break-all">{span.input}</span>
            </div>
          )}
          {span.output && (
            <div className="bg-[#0f172a] rounded p-2 max-h-40 overflow-auto">
              <span className="text-[#64748b]">Output: </span>
              <pre className="text-[#94a3b8] font-mono whitespace-pre-wrap break-all inline">{span.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Tasks() {
  const [tasks, setTasks] = useState<any[]>([])
  const [agents, setAgents] = useState<any[]>([])
  const [trace, setTrace] = useState<any[]>([])
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const [showDispatch, setShowDispatch] = useState(false)
  const [form, setForm] = useState({ prompt: '', agentId: '' })
  const [dispatching, setDispatching] = useState(false)

  const load = () => {
    Promise.all([api.listTasks(50), api.listAgents()])
      .then(([t, a]) => { setTasks(t); setAgents(a) })
  }
  useEffect(() => { load() }, [])

  const handleDispatch = async () => {
    setDispatching(true)
    try {
      await api.dispatchTask({ prompt: form.prompt, agentId: form.agentId || undefined })
      setForm({ prompt: '', agentId: '' })
      setShowDispatch(false)
      load()
    } finally { setDispatching(false) }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除此任务及其追踪数据?')) return
    await api.deleteTask(id)
    if (selectedTask === id) { setSelectedTask(null); setTrace([]) }
    load()
  }

  const showTrace = async (taskId: string) => {
    setSelectedTask(taskId)
    const spans = await api.getTaskTrace(taskId)
    setTrace(spans)
  }

  const statusStyle = (s: string) => {
    if (s === 'completed') return 'text-green-400'
    if (s === 'failed') return 'text-red-400'
    if (s === 'running') return 'text-yellow-400'
    return 'text-gray-400'
  }
  const statusIcon = (s: string) => {
    if (s === 'completed') return '✓'
    if (s === 'failed') return '✗'
    if (s === 'running') return '⟳'
    return '…'
  }

  // Build trace tree
  const traceStart = trace.length > 0 ? Math.min(...trace.map((s) => s.timestamp)) : 0
  const traceEnd = trace.length > 0 ? Math.max(...trace.map((s) => s.timestamp + s.durationMs)) : 0
  const totalDuration = traceEnd - traceStart

  // Separate root spans and child spans
  const rootSpans = trace.filter((s) => !s.parentSpanId)
  const childSpans = trace.filter((s) => s.parentSpanId)

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">任务管理</h2>
        <button onClick={() => setShowDispatch(!showDispatch)}
          className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] rounded-md text-sm transition-colors">
          {showDispatch ? '取消' : '+ 派发任务'}
        </button>
      </div>

      {showDispatch && (
        <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155] space-y-3">
          <div>
            <label className="block text-xs text-[#94a3b8] mb-1">任务描述</label>
            <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              rows={3} placeholder="请帮我分析这份数据..."
              className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none resize-none" />
          </div>
          <div>
            <label className="block text-xs text-[#94a3b8] mb-1">指定 Agent (可选)</label>
            <select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}
              className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none">
              <option value="">自动匹配 (创世Agent调度)</option>
              {agents.filter((a) => a.state !== 'destroyed').map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <button onClick={handleDispatch} disabled={!form.prompt || dispatching}
            className="px-4 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-md text-sm transition-colors">
            {dispatching ? '执行中...' : '派发'}
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Task list */}
        <div className="lg:col-span-2 bg-[#1e293b] rounded-lg border border-[#334155]">
          {tasks.length === 0 ? (
            <p className="text-sm text-[#64748b] p-4">暂无任务</p>
          ) : (
            <div className="divide-y divide-[#334155]/50 max-h-[70vh] overflow-auto">
              {[...tasks].reverse().map((t) => {
                const agent = agents.find((a) => a.id === t.agentId)
                return (
                  <div key={t.id} onClick={() => showTrace(t.id)}
                    className={`p-3 cursor-pointer hover:bg-[#334155]/30 transition-colors ${selectedTask === t.id ? 'bg-[#334155]/50 border-l-2 border-l-[#3b82f6]' : ''}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`text-sm shrink-0 ${statusStyle(t.status)}`}>{statusIcon(t.status)}</span>
                        <span className="text-sm truncate">{t.prompt}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {t.tokensUsed > 0 && <span className="text-[10px] text-[#64748b]">{t.tokensUsed}t</span>}
                        <button onClick={(e) => { e.stopPropagation(); handleDelete(t.id) }}
                          className="text-[10px] text-red-400/50 hover:text-red-400 px-1">✕</button>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[10px] text-[#64748b]">
                      <span>{agent?.name ?? t.agentId}</span>
                      <span>{new Date(t.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Trace panel — LangSmith style */}
        <div className="lg:col-span-3 bg-[#1e293b] rounded-lg border border-[#334155]">
          <div className="px-4 py-3 border-b border-[#334155] flex items-center justify-between">
            <p className="text-sm font-medium">执行追踪</p>
            {totalDuration > 0 && (
              <span className="text-[10px] text-[#64748b]">总耗时 {totalDuration}ms · {trace.length} spans</span>
            )}
          </div>
          {!selectedTask ? (
            <p className="text-sm text-[#64748b] p-4">点击任务查看追踪</p>
          ) : trace.length === 0 ? (
            <p className="text-sm text-[#64748b] p-4">无追踪数据</p>
          ) : (
            <div className="p-3 space-y-1 max-h-[60vh] overflow-auto">
              {/* Root spans */}
              {rootSpans.map((span) => (
                <div key={span.spanId}>
                  <SpanNode span={span} traceStart={traceStart} totalDuration={totalDuration} />
                  {/* Child spans under this root */}
                  {childSpans.filter((c) => c.parentSpanId === span.spanId).map((child) => (
                    <div key={child.spanId} className="ml-4">
                      <SpanNode span={child} traceStart={traceStart} totalDuration={totalDuration} />
                    </div>
                  ))}
                </div>
              ))}
              {/* Orphan child spans (parent not in rootSpans) */}
              {childSpans.filter((c) => !rootSpans.some((r) => r.spanId === c.parentSpanId)).map((span) => (
                <div key={span.spanId} className="ml-4">
                  <SpanNode span={span} traceStart={traceStart} totalDuration={totalDuration} />
                </div>
              ))}
            </div>
          )}

          {/* Task output */}
          {selectedTask && (() => {
            const task = tasks.find((t) => t.id === selectedTask)
            if (!task?.output && !task?.error) return null
            return (
              <div className="p-3 border-t border-[#334155]">
                <p className="text-xs text-[#94a3b8] mb-1">最终输出:</p>
                <pre className="text-xs text-[#f1f5f9] bg-[#0f172a] rounded p-3 whitespace-pre-wrap break-words max-h-48 overflow-auto">
                  {task.output ?? task.error}
                </pre>
              </div>
            )
          })()}
        </div>
      </div>
    </div>
  )
}
