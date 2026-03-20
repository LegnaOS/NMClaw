import { useEffect, useState } from 'react'
import { api } from '../api'

const PROVIDERS = ['anthropic', 'openai', 'deepseek', 'ollama', 'other']
const COST_TIERS = ['free', 'low', 'medium', 'high']

export default function Models() {
  const [models, setModels] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', provider: 'anthropic', capabilities: '', costTier: 'medium', apiKeyEnv: '', baseUrl: '' })

  const load = () => api.listModels().then(setModels)
  useEffect(() => { load() }, [])

  const handleAdd = async () => {
    await api.addModel({
      ...form,
      capabilities: form.capabilities.split(',').map(s => s.trim()).filter(Boolean),
    })
    setForm({ name: '', provider: 'anthropic', capabilities: '', costTier: 'medium', apiKeyEnv: '', baseUrl: '' })
    setShowForm(false)
    load()
  }

  const handleRemove = async (id: string) => {
    if (!confirm('确认移除此模型?')) return
    await api.removeModel(id)
    load()
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">模型库</h2>
        <button onClick={() => setShowForm(!showForm)} className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] rounded-md text-sm transition-colors">
          {showForm ? '取消' : '+ 添加模型'}
        </button>
      </div>

      {showForm && (
        <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155] space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">模型名称</label>
              <input value={form.name} onChange={e => setForm({...form, name: e.target.value})}
                placeholder="claude-sonnet-4-6" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">提供商</label>
              <select value={form.provider} onChange={e => setForm({...form, provider: e.target.value})}
                className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none">
                {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">能力标签 (逗号分隔)</label>
              <input value={form.capabilities} onChange={e => setForm({...form, capabilities: e.target.value})}
                placeholder="reasoning,coding" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">成本等级</label>
              <select value={form.costTier} onChange={e => setForm({...form, costTier: e.target.value})}
                className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none">
                {COST_TIERS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">API Key 环境变量</label>
              <input value={form.apiKeyEnv} onChange={e => setForm({...form, apiKeyEnv: e.target.value})}
                placeholder="ANTHROPIC_API_KEY" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">Base URL (可选)</label>
              <input value={form.baseUrl} onChange={e => setForm({...form, baseUrl: e.target.value})}
                placeholder="https://api.deepseek.com/v1" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
            </div>
          </div>
          <button onClick={handleAdd} disabled={!form.name} className="px-4 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-md text-sm transition-colors">
            确认添加
          </button>
        </div>
      )}

      {/* Model list */}
      <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
        {models.length === 0 ? (
          <p className="text-sm text-[#64748b] p-4">暂无模型</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#334155] text-[#94a3b8] text-xs uppercase">
                <th className="text-left p-3">ID</th>
                <th className="text-left p-3">名称</th>
                <th className="text-left p-3">提供商</th>
                <th className="text-left p-3">能力</th>
                <th className="text-left p-3">成本</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {models.map(m => (
                <tr key={m.id} className="border-b border-[#334155]/50 hover:bg-[#334155]/30">
                  <td className="p-3 font-mono text-xs text-[#64748b]">{m.id}</td>
                  <td className="p-3">{m.name}</td>
                  <td className="p-3"><span className="px-1.5 py-0.5 bg-[#334155] rounded text-xs">{m.provider}</span></td>
                  <td className="p-3 text-xs text-[#94a3b8]">{m.capabilities.join(', ')}</td>
                  <td className="p-3">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      m.costTier === 'high' ? 'bg-red-500/20 text-red-400' :
                      m.costTier === 'medium' ? 'bg-yellow-500/20 text-yellow-400' :
                      m.costTier === 'low' ? 'bg-green-500/20 text-green-400' :
                      'bg-gray-500/20 text-gray-400'
                    }`}>{m.costTier}</span>
                  </td>
                  <td className="p-3 text-right">
                    <button onClick={() => handleRemove(m.id)} className="text-xs text-red-400 hover:text-red-300">删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
