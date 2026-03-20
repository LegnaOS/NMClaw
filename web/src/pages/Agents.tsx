import { useEffect, useState } from 'react'
import { api } from '../api'

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h`
  return `${Math.floor(ms / 60000)}m`
}

const STATE_STYLES: Record<string, { dot: string; text: string; bg: string }> = {
  active: { dot: 'bg-green-400', text: 'text-green-400', bg: 'bg-green-500/10' },
  idle: { dot: 'bg-yellow-400', text: 'text-yellow-400', bg: 'bg-yellow-500/10' },
  pending_destroy: { dot: 'bg-red-400', text: 'text-red-400', bg: 'bg-red-500/10' },
  destroyed: { dot: 'bg-gray-500', text: 'text-gray-500', bg: 'bg-gray-500/10' },
}

const STATE_LABELS: Record<string, string> = {
  active: '运行中',
  idle: '已停用',
  pending_destroy: '待销毁',
  destroyed: '已销毁',
}

type FormData = {
  name: string; description: string; modelId: string; skillIds: string[]; mcpIds: string[]
  systemPrompt: string; ttlDays: string; idleHours: string
}

const emptyForm: FormData = {
  name: '', description: '', modelId: '', skillIds: [], mcpIds: [],
  systemPrompt: '', ttlDays: '7', idleHours: '24',
}

export default function Agents() {
  const [agents, setAgents] = useState<any[]>([])
  const [models, setModels] = useState<any[]>([])
  const [skills, setSkills] = useState<any[]>([])
  const [mcps, setMcps] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [selected, setSelected] = useState<any>(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<FormData>({ ...emptyForm })

  const load = () => {
    Promise.all([api.listAgents(true), api.listModels(), api.listSkills(), api.listMcps()])
      .then(([a, m, s, mc]) => {
        setAgents(a); setModels(m); setSkills(s); setMcps(mc)
        if (selected) {
          const fresh = a.find((x: any) => x.id === selected.id)
          if (fresh) setSelected(fresh)
        }
      })
  }
  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    await api.createAgent({
      name: form.name, description: form.description, modelId: form.modelId,
      skillIds: form.skillIds, mcpIds: form.mcpIds,
      systemPrompt: form.systemPrompt || undefined,
      ttl: parseInt(form.ttlDays) * 86400000,
      idleTimeout: parseInt(form.idleHours) * 3600000,
    })
    setForm({ ...emptyForm }); setShowForm(false); load()
  }

  const handleDestroy = async (id: string) => {
    if (!confirm('确认销毁此 Agent?')) return
    await api.destroyAgent(id); load()
    if (selected?.id === id) { setSelected(null); setEditing(false) }
  }

  const startEdit = () => {
    if (!selected) return
    setForm({
      name: selected.name,
      description: selected.description,
      modelId: selected.modelId,
      skillIds: [...selected.skillIds],
      mcpIds: [...selected.mcpIds],
      systemPrompt: selected.systemPrompt ?? '',
      ttlDays: String(Math.round(selected.lifecycle.ttl / 86400000)),
      idleHours: String(Math.round(selected.lifecycle.idleTimeout / 3600000)),
    })
    setEditing(true); setShowForm(false)
  }

  const handleSave = async () => {
    if (!selected) return
    await api.modifyAgent(selected.id, {
      name: form.name, description: form.description, modelId: form.modelId,
      skillIds: form.skillIds, mcpIds: form.mcpIds, systemPrompt: form.systemPrompt,
      lifecycle: {
        ttl: parseInt(form.ttlDays) * 86400000,
        idleTimeout: parseInt(form.idleHours) * 3600000,
      },
    })
    setEditing(false); load()
  }

  const toggleState = async (agent: any) => {
    const newState = agent.state === 'active' ? 'idle' : 'active'
    await api.modifyAgent(agent.id, { state: newState })
    load()
  }

  const toggleArray = (arr: string[], val: string) =>
    arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val]

  const now = Date.now()

  // Shared form fields component
  const renderFormFields = () => (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-[#94a3b8] mb-1">Agent 名称</label>
          <input value={form.name} onChange={e => setForm({...form, name: e.target.value})}
            placeholder="数据分析员" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
        </div>
        <div>
          <label className="block text-xs text-[#94a3b8] mb-1">模型</label>
          <select value={form.modelId} onChange={e => setForm({...form, modelId: e.target.value})}
            className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none">
            <option value="">选择模型...</option>
            {models.map(m => <option key={m.id} value={m.id}>{m.name} [{m.provider}]</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="block text-xs text-[#94a3b8] mb-1">职责描述</label>
        <input value={form.description} onChange={e => setForm({...form, description: e.target.value})}
          placeholder="负责处理数据清洗和分析任务" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
      </div>
      {skills.length > 0 && (
        <div>
          <label className="block text-xs text-[#94a3b8] mb-1">技能</label>
          <div className="flex flex-wrap gap-1.5">
            {skills.map(s => (
              <button key={s.id} onClick={() => setForm({...form, skillIds: toggleArray(form.skillIds, s.id)})}
                className={`px-2 py-0.5 rounded text-xs transition-colors ${
                  form.skillIds.includes(s.id) ? 'bg-[#3b82f6] text-white' : 'bg-[#334155] text-[#94a3b8] hover:bg-[#475569]'
                }`}>{s.name}</button>
            ))}
          </div>
        </div>
      )}
      {mcps.length > 0 && (
        <div>
          <label className="block text-xs text-[#94a3b8] mb-1">MCP</label>
          <div className="flex flex-wrap gap-1.5">
            {mcps.map(m => (
              <button key={m.id} onClick={() => setForm({...form, mcpIds: toggleArray(form.mcpIds, m.id)})}
                className={`px-2 py-0.5 rounded text-xs transition-colors ${
                  form.mcpIds.includes(m.id) ? 'bg-[#3b82f6] text-white' : 'bg-[#334155] text-[#94a3b8] hover:bg-[#475569]'
                }`}>{m.name}</button>
            ))}
          </div>
        </div>
      )}
      <div>
        <label className="block text-xs text-[#94a3b8] mb-1">系统提示词 (可选)</label>
        <textarea value={form.systemPrompt} onChange={e => setForm({...form, systemPrompt: e.target.value})}
          rows={3} className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none resize-none" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-[#94a3b8] mb-1">TTL (天)</label>
          <input type="number" value={form.ttlDays} onChange={e => setForm({...form, ttlDays: e.target.value})}
            className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
        </div>
        <div>
          <label className="block text-xs text-[#94a3b8] mb-1">空闲超时 (小时)</label>
          <input type="number" value={form.idleHours} onChange={e => setForm({...form, idleHours: e.target.value})}
            className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
        </div>
      </div>
    </>
  )

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Agent 管理</h2>
        <button onClick={() => { setShowForm(!showForm); setSelected(null); setEditing(false); setForm({ ...emptyForm }) }}
          className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] rounded-md text-sm transition-colors">
          {showForm ? '取消' : '+ 创建 Agent'}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155] space-y-3">
          {renderFormFields()}
          <button onClick={handleCreate} disabled={!form.name || !form.modelId}
            className="px-4 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-md text-sm transition-colors">
            确认创建
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Agent list */}
        <div className="lg:col-span-2 bg-[#1e293b] rounded-lg border border-[#334155]">
          {agents.length === 0 ? (
            <p className="text-sm text-[#64748b] p-4">暂无 Agent</p>
          ) : (
            <div className="divide-y divide-[#334155]/50">
              {agents.map(a => {
                const style = STATE_STYLES[a.state] ?? STATE_STYLES.destroyed
                const ttlLeft = a.lifecycle.ttl - (now - a.createdAt)
                const model = models.find(m => m.id === a.modelId)
                return (
                  <div key={a.id} onClick={() => { setSelected(a); setShowForm(false); setEditing(false) }}
                    className={`p-3 cursor-pointer hover:bg-[#334155]/30 transition-colors ${selected?.id === a.id ? 'bg-[#334155]/50' : ''}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${style.dot}`} />
                        <span className="text-sm font-medium">{a.name}</span>
                        <span className="text-xs text-[#64748b] font-mono">{a.id}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${style.bg} ${style.text}`}>
                          {STATE_LABELS[a.state] ?? a.state}
                        </span>
                        {(a.state === 'active' || a.state === 'idle') && (
                          <button onClick={(e) => { e.stopPropagation(); toggleState(a) }}
                            className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                              a.state === 'active'
                                ? 'text-yellow-400 hover:bg-yellow-500/10'
                                : 'text-green-400 hover:bg-green-500/10'
                            }`}>
                            {a.state === 'active' ? '停用' : '激活'}
                          </button>
                        )}
                        {a.state !== 'destroyed' && (
                          <button onClick={(e) => { e.stopPropagation(); handleDestroy(a.id) }}
                            className="text-xs text-red-400 hover:text-red-300">销毁</button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-[#64748b]">
                      <span>{model?.name ?? '?'}</span>
                      <span>技能: {a.skillIds.length}</span>
                      <span>MCP: {a.mcpIds.length}</span>
                      {a.state !== 'destroyed' && <span>TTL: {formatDuration(Math.max(0, ttlLeft))}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Detail / Edit panel */}
        {selected && (
          <div className="bg-[#1e293b] rounded-lg border border-[#334155] p-4 space-y-3">
            {editing ? (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold">编辑 Agent</h3>
                  <button onClick={() => setEditing(false)} className="text-xs text-[#64748b] hover:text-[#94a3b8]">取消</button>
                </div>
                {renderFormFields()}
                <button onClick={handleSave} disabled={!form.name || !form.modelId}
                  className="px-4 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-md text-sm transition-colors">
                  保存修改
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold">{selected.name}</h3>
                  {selected.state !== 'destroyed' && (
                    <button onClick={startEdit}
                      className="text-xs text-[#3b82f6] hover:text-[#60a5fa] transition-colors">编辑</button>
                  )}
                </div>
                <div className="space-y-2 text-xs">
                  <div><span className="text-[#94a3b8]">ID:</span> <span className="font-mono">{selected.id}</span></div>
                  <div><span className="text-[#94a3b8]">状态:</span> <span className={STATE_STYLES[selected.state]?.text}>{STATE_LABELS[selected.state] ?? selected.state}</span></div>
                  <div><span className="text-[#94a3b8]">描述:</span> {selected.description}</div>
                  <div><span className="text-[#94a3b8]">模型:</span> {models.find(m => m.id === selected.modelId)?.name ?? '?'}</div>
                  {selected.skillIds.length > 0 && (
                    <div>
                      <span className="text-[#94a3b8]">技能:</span>{' '}
                      {selected.skillIds.map((sid: string) => {
                        const sk = skills.find(s => s.id === sid)
                        return <span key={sid} className="inline-block px-1.5 py-0.5 rounded bg-[#334155] text-[#94a3b8] mr-1 mb-1">{sk?.name ?? sid}</span>
                      })}
                    </div>
                  )}
                  {selected.mcpIds.length > 0 && (
                    <div>
                      <span className="text-[#94a3b8]">MCP:</span>{' '}
                      {selected.mcpIds.map((mid: string) => {
                        const mc = mcps.find(m => m.id === mid)
                        return <span key={mid} className="inline-block px-1.5 py-0.5 rounded bg-[#334155] text-[#94a3b8] mr-1 mb-1">{mc?.name ?? mid}</span>
                      })}
                    </div>
                  )}
                  <div><span className="text-[#94a3b8]">TTL:</span> {formatDuration(selected.lifecycle.ttl)}</div>
                  <div><span className="text-[#94a3b8]">空闲超时:</span> {formatDuration(selected.lifecycle.idleTimeout)}</div>
                  <div><span className="text-[#94a3b8]">上次活跃:</span> {formatDuration(now - selected.lastActiveAt)} 前</div>
                  <div><span className="text-[#94a3b8]">创建时间:</span> {new Date(selected.createdAt).toLocaleString()}</div>
                  {selected.systemPrompt && (
                    <div>
                      <span className="text-[#94a3b8]">系统提示词:</span>
                      <pre className="mt-1 bg-[#0f172a] rounded p-2 text-[#64748b] overflow-x-auto max-h-32">{selected.systemPrompt}</pre>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
