import { useEffect, useState } from 'react'
import { api } from '../api'

const SCHEDULE_PRESETS = [
  { label: '每5分钟', value: '*/5 * * * *' },
  { label: '每小时', value: '0 * * * *' },
  { label: '每天9点', value: '0 9 * * *' },
  { label: '每天18点', value: '0 18 * * *' },
  { label: '工作日9点', value: '0 9 * * 1-5' },
]

const emptyForm = { name: '', schedule: '*/5 * * * *', agentId: '', prompt: '' }

export default function Cron() {
  const [jobs, setJobs] = useState<any[]>([])
  const [agents, setAgents] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm)

  const load = () => {
    api.listCronJobs().then(setJobs).catch(() => setJobs([]))
    api.listAgents().then(setAgents)
  }
  useEffect(() => { load() }, [])

  const cancelForm = () => { setShowForm(false); setEditId(null); setForm(emptyForm) }

  const startEdit = (job: any) => {
    setEditId(job.id)
    setForm({ name: job.name, schedule: job.schedule || '', agentId: job.agentId, prompt: job.prompt })
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!form.name || !form.agentId || !form.prompt) return
    if (editId) {
      await api.modifyCronJob(editId, form)
    } else {
      await api.addCronJob(form)
    }
    cancelForm()
    load()
  }

  const handleToggle = async (id: string, enabled: boolean) => {
    await api.toggleCronJob(id, !enabled)
    load()
  }

  const handleRemove = async (id: string) => {
    if (!confirm('确认删除此定时任务?')) return
    await api.removeCronJob(id)
    load()
  }

  const formatLastRun = (ts?: number) => {
    if (!ts) return '从未执行'
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  const activeAgents = agents.filter((a: any) => a.state !== 'destroyed')

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">定时任务</h2>
          <p className="text-xs text-[#64748b] mt-1">CRON 调度 — 定时触发 Agent 执行任务</p>
        </div>
        <button onClick={() => showForm ? cancelForm() : setShowForm(true)}
          className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] rounded-md text-sm transition-colors">
          {showForm ? '取消' : '+ 新建定时任务'}
        </button>
      </div>

      {showForm && (
        <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155] space-y-3">
          <div className="text-xs text-[#94a3b8] mb-1">{editId ? '编辑定时任务' : '新建定时任务'}</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">任务名称</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="每日天气播报" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">执行 Agent</label>
              <select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}
                className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none">
                <option value="">选择 Agent</option>
                {activeAgents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-[#94a3b8] mb-1">调度表达式 (CRON)</label>
            <div className="flex gap-2 items-center">
              <input value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })}
                placeholder="*/5 * * * *" className="flex-1 bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm font-mono focus:border-[#3b82f6] outline-none" />
              <div className="flex gap-1">
                {SCHEDULE_PRESETS.map((p) => (
                  <button key={p.value} onClick={() => setForm({ ...form, schedule: p.value })}
                    className={`px-2 py-1 rounded text-[10px] transition-colors ${form.schedule === p.value ? 'bg-[#3b82f6] text-white' : 'bg-[#334155] text-[#94a3b8] hover:bg-[#475569]'}`}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="block text-xs text-[#94a3b8] mb-1">执行 Prompt</label>
            <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder="查询今天北京的天气，并生成简报" rows={2}
              className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none resize-none" />
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={!form.name || !form.agentId || !form.prompt}
              className="px-4 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-md text-sm transition-colors">
              {editId ? '保存' : '创建'}
            </button>
            {editId && <button onClick={cancelForm} className="px-4 py-1.5 bg-[#334155] hover:bg-[#475569] rounded-md text-sm transition-colors">取消</button>}
          </div>
        </div>
      )}

      <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
        {jobs.length === 0 ? (
          <p className="text-sm text-[#64748b] p-4">暂无定时任务 — 点击「新建定时任务」创建</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#334155] text-[#94a3b8] text-xs uppercase">
                <th className="text-left p-3">状态</th>
                <th className="text-left p-3">名称</th>
                <th className="text-left p-3">调度</th>
                <th className="text-left p-3">Agent</th>
                <th className="text-left p-3">上次执行</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job: any) => {
                const agent = agents.find((a: any) => a.id === job.agentId)
                return (
                  <tr key={job.id} className="border-b border-[#334155]/50 hover:bg-[#334155]/30">
                    <td className="p-3">
                      <button onClick={() => handleToggle(job.id, job.enabled)}
                        className={`w-8 h-4 rounded-full relative transition-colors ${job.enabled ? 'bg-[#22c55e]' : 'bg-[#475569]'}`}>
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${job.enabled ? 'left-4' : 'left-0.5'}`} />
                      </button>
                    </td>
                    <td className="p-3">{job.name}</td>
                    <td className="p-3 font-mono text-xs text-[#94a3b8]">{job.schedule || job.cron || '-'}</td>
                    <td className="p-3 text-xs">{agent?.name || job.agentId}</td>
                    <td className="p-3 text-xs text-[#64748b]">{formatLastRun(job.lastRun)}</td>
                    <td className="p-3 text-right space-x-2">
                      <button onClick={() => startEdit(job)} className="text-xs text-[#3b82f6] hover:text-[#60a5fa]">编辑</button>
                      <button onClick={() => handleRemove(job.id)} className="text-xs text-red-400 hover:text-red-300">删除</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-[#1e293b] rounded-lg border border-[#334155] p-4">
        <p className="text-xs text-[#94a3b8]">CRON 表达式格式: <code className="font-mono text-[#f1f5f9]">分 时 日 月 周</code></p>
        <p className="text-xs text-[#64748b] mt-1">示例: <code className="font-mono">*/5 * * * *</code> = 每5分钟, <code className="font-mono">0 9 * * 1-5</code> = 工作日9点</p>
      </div>
    </div>
  )
}
