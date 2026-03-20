import { useEffect, useState } from 'react'
import { api } from '../api'

export default function Skills() {
  const [skills, setSkills] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', promptTemplate: '', requiredMcps: '' })

  const load = () => api.listSkills().then(setSkills)
  useEffect(() => { load() }, [])

  const handleAdd = async () => {
    await api.addSkill({
      ...form,
      requiredMcps: form.requiredMcps ? form.requiredMcps.split(',').map(s => s.trim()) : [],
    })
    setForm({ name: '', description: '', promptTemplate: '', requiredMcps: '' })
    setShowForm(false)
    load()
  }

  const handleRemove = async (id: string) => {
    if (!confirm('确认移除此技能?')) return
    await api.removeSkill(id)
    load()
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">技能库</h2>
        <button onClick={() => setShowForm(!showForm)} className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] rounded-md text-sm transition-colors">
          {showForm ? '取消' : '+ 添加技能'}
        </button>
      </div>

      {showForm && (
        <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155] space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">技能名称</label>
              <input value={form.name} onChange={e => setForm({...form, name: e.target.value})}
                placeholder="code-review" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">描述</label>
              <input value={form.description} onChange={e => setForm({...form, description: e.target.value})}
                placeholder="代码审查专家" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-[#94a3b8] mb-1">Prompt 模板</label>
            <textarea value={form.promptTemplate} onChange={e => setForm({...form, promptTemplate: e.target.value})}
              rows={4} placeholder="你是一个代码审查专家。请对以下代码进行审查：&#10;{{code}}"
              className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none resize-none" />
          </div>
          <div>
            <label className="block text-xs text-[#94a3b8] mb-1">依赖 MCP (逗号分隔, 可留空)</label>
            <input value={form.requiredMcps} onChange={e => setForm({...form, requiredMcps: e.target.value})}
              className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
          </div>
          <button onClick={handleAdd} disabled={!form.name} className="px-4 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-md text-sm transition-colors">
            确认添加
          </button>
        </div>
      )}

      <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
        {skills.length === 0 ? (
          <p className="text-sm text-[#64748b] p-4">暂无技能</p>
        ) : (
          <div className="divide-y divide-[#334155]/50">
            {skills.map(s => (
              <div key={s.id} className="p-4 hover:bg-[#334155]/30">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium">{s.name}</span>
                    <span className="text-xs text-[#64748b] font-mono ml-2">{s.id}</span>
                  </div>
                  <button onClick={() => handleRemove(s.id)} className="text-xs text-red-400 hover:text-red-300">删除</button>
                </div>
                <p className="text-xs text-[#94a3b8] mt-1">{s.description}</p>
                {s.promptTemplate && (
                  <pre className="text-xs text-[#64748b] mt-2 bg-[#0f172a] rounded p-2 overflow-x-auto max-h-20">{s.promptTemplate.slice(0, 200)}{s.promptTemplate.length > 200 ? '...' : ''}</pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
