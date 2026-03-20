import { useEffect, useState } from 'react'
import { api } from '../api'

function StatCard({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155]">
      <p className="text-xs text-[#94a3b8] uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
    </div>
  )
}

function AgentRow({ agent }: { agent: any }) {
  const stateColors: Record<string, string> = {
    active: 'text-green-400',
    idle: 'text-yellow-400',
    pending_destroy: 'text-red-400',
    destroyed: 'text-gray-500',
  }
  const stateLabels: Record<string, string> = {
    active: 'Active',
    idle: 'Idle',
    pending_destroy: 'Pending',
    destroyed: 'Destroyed',
  }
  const now = Date.now()
  const ttlLeft = agent.lifecycle.ttl - (now - agent.createdAt)
  const hours = Math.max(0, Math.floor(ttlLeft / 3600000))
  const days = Math.floor(hours / 24)

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-[#334155]/50">
      <div className="flex items-center gap-3">
        <span className={`text-sm font-medium ${stateColors[agent.state] ?? 'text-gray-400'}`}>
          {stateLabels[agent.state] ?? agent.state}
        </span>
        <span className="text-sm text-[#f1f5f9]">{agent.name}</span>
        <span className="text-xs text-[#64748b] font-mono">{agent.id}</span>
      </div>
      <div className="text-xs text-[#64748b]">
        TTL: {days > 0 ? `${days}d` : `${hours}h`}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [status, setStatus] = useState<any>(null)
  const [agents, setAgents] = useState<any[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.getStatus(), api.listAgents(true)])
      .then(([s, a]) => { setStatus(s); setAgents(a) })
      .catch((e) => setError(e.message))
  }, [])

  if (error) return <div className="text-red-400 p-6">Error: {error}</div>
  if (!status) return <div className="text-[#94a3b8] p-6">Loading...</div>

  return (
    <div className="space-y-6 p-6">
      <h2 className="text-xl font-bold">控制面板</h2>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Active Agents" value={status.agents.active} color="text-green-400" />
        <StatCard label="Idle Agents" value={status.agents.idle} color="text-yellow-400" />
        <StatCard label="模型" value={status.models} color="text-blue-400" />
        <StatCard label="技能" value={status.skills} color="text-purple-400" />
      </div>

      {/* Bypass status */}
      <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155]">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Bypass 模式</p>
            <p className="text-xs text-[#94a3b8] mt-0.5">
              {status.bypass.enabled ? '已开启 — 部分操作将跳过用户确认' : '已关闭 — 所有操作需要用户确认'}
            </p>
          </div>
          <button
            onClick={async () => {
              if (status.bypass.enabled) await api.disableBypass()
              else await api.enableBypass()
              const s = await api.getStatus()
              setStatus(s)
            }}
            className={`px-3 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${
              status.bypass.enabled
                ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                : 'bg-gray-500/20 text-gray-400 hover:bg-gray-500/30'
            }`}>
            {status.bypass.enabled ? 'ON — 点击关闭' : 'OFF — 点击开启'}
          </button>
        </div>
      </div>

      {/* Agent list */}
      <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
        <div className="px-4 py-3 border-b border-[#334155]">
          <p className="text-sm font-medium">Agent 列表</p>
        </div>
        <div className="p-2">
          {agents.length === 0 ? (
            <p className="text-sm text-[#64748b] p-3">暂无 Agent</p>
          ) : (
            agents.map((a) => <AgentRow key={a.id} agent={a} />)
          )}
        </div>
      </div>

      {/* Recent tasks */}
      {status.recentTasks?.length > 0 && (
        <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
          <div className="px-4 py-3 border-b border-[#334155]">
            <p className="text-sm font-medium">最近任务</p>
          </div>
          <div className="p-2">
            {status.recentTasks.map((t: any) => (
              <div key={t.id} className="flex items-center justify-between py-2 px-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className={t.status === 'completed' ? 'text-green-400' : t.status === 'failed' ? 'text-red-400' : 'text-yellow-400'}>
                    {t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : '⟳'}
                  </span>
                  <span className="text-[#f1f5f9] truncate max-w-md">{t.prompt}</span>
                </div>
                <span className="text-xs text-[#64748b]">{t.tokensUsed ? `${t.tokensUsed}t` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
