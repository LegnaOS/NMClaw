import { useEffect, useState } from 'react'
import { api } from '../api'

const TRANSPORTS = ['stdio', 'sse', 'streamable-http']

const SOURCE_LABELS: Record<string, string> = {
  kiro: 'Kiro',
  codebuddy: 'CodeBuddy',
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
}

const TRANSPORT_COLORS: Record<string, string> = {
  builtin: 'bg-green-500/20 text-green-400',
  stdio: 'bg-blue-500/20 text-blue-400',
  sse: 'bg-purple-500/20 text-purple-400',
  'streamable-http': 'bg-yellow-500/20 text-yellow-400',
}

const emptyForm = { name: '', description: '', transport: 'stdio', command: '', args: '', url: '' }

export default function Mcps() {
  const [mcps, setMcps] = useState<any[]>([])
  const [localMcps, setLocalMcps] = useState<any[]>([])
  const [localSources, setLocalSources] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [showLocal, setShowLocal] = useState(false)
  const [showJsonImport, setShowJsonImport] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState('')
  const [importing, setImporting] = useState<string | null>(null)
  const [form, setForm] = useState({ ...emptyForm })

  const load = () => api.listMcps().then(setMcps)
  useEffect(() => { load() }, [])

  const cancelForm = () => { setShowForm(false); setEditId(null); setForm({ ...emptyForm }) }

  const scanLocal = async () => {
    setShowLocal(true)
    try {
      const data = await api.scanLocalMcps()
      setLocalMcps(data.entries || [])
      setLocalSources(data.sources || [])
    } catch { setLocalMcps([]) }
  }

  const handleAdd = async () => {
    await api.addMcp({
      ...form,
      args: form.args ? form.args.split(/\s+/) : [],
    })
    cancelForm(); load()
  }

  const startEdit = (m: any) => {
    setEditId(m.id)
    setForm({
      name: m.name, description: m.description ?? '',
      transport: m.transport, command: m.command ?? '',
      args: (m.args ?? []).join(' '), url: m.url ?? '',
    })
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!editId) return
    await api.modifyMcp(editId, {
      ...form,
      args: form.args ? form.args.split(/\s+/) : [],
    })
    cancelForm(); load()
  }

  const handleRemove = async (id: string) => {
    if (!confirm('确认移除此MCP?')) return
    await api.removeMcp(id)
    load()
  }

  const handleJsonImport = async () => {
    setJsonError('')
    try {
      const parsed = JSON.parse(jsonText)
      const mcpServers = parsed.mcpServers ?? parsed
      if (typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
        setJsonError('格式错误: 需要 { "mcpServers": { ... } } 或 { "name": { command, args } }')
        return
      }
      await api.importMcpJson(mcpServers)
      setShowJsonImport(false); setJsonText(''); load()
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'JSON 解析失败')
    }
  }

  const handleImport = async (entry: any) => {
    setImporting(entry.name)
    try {
      await api.importLocalMcp({
        name: entry.name,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        description: `从 ${SOURCE_LABELS[entry.source] || entry.source} 导入`,
      })
      load()
    } finally {
      setImporting(null)
    }
  }

  const isImported = (name: string) =>
    mcps.some((m) => m.name === name && m.transport === 'stdio')

  // Group MCPs by transport type
  const builtinMcps = mcps.filter((m) => m.transport === 'builtin')
  const externalMcps = mcps.filter((m) => m.transport !== 'builtin')

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">MCP 库</h2>
        <div className="flex gap-2">
          <button onClick={scanLocal}
            className="px-3 py-1.5 bg-[#334155] hover:bg-[#475569] rounded-md text-sm transition-colors">
            {showLocal ? '刷新扫描' : '扫描本地 MCP'}
          </button>
          <button onClick={() => setShowJsonImport(!showJsonImport)}
            className="px-3 py-1.5 bg-[#334155] hover:bg-[#475569] rounded-md text-sm transition-colors">
            JSON 导入
          </button>
          <button onClick={() => { if (showForm) cancelForm(); else { setShowForm(true); setEditId(null); setForm({ ...emptyForm }) } }}
            className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] rounded-md text-sm transition-colors">
            {showForm && !editId ? '取消' : '+ 添加 MCP'}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155] space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-[#94a3b8]">{editId ? '编辑 MCP' : '添加 MCP'}</p>
            <button onClick={cancelForm} className="text-xs text-[#64748b] hover:text-[#94a3b8]">取消</button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">MCP 名称</label>
              <input value={form.name} onChange={e => setForm({...form, name: e.target.value})}
                placeholder="filesystem" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">传输方式</label>
              <select value={form.transport} onChange={e => setForm({...form, transport: e.target.value})}
                className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none">
                {TRANSPORTS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-[#94a3b8] mb-1">描述</label>
            <input value={form.description} onChange={e => setForm({...form, description: e.target.value})}
              placeholder="读写本地文件系统" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
          </div>
          {form.transport === 'stdio' ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[#94a3b8] mb-1">启动命令</label>
                <input value={form.command} onChange={e => setForm({...form, command: e.target.value})}
                  placeholder="npx" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
              </div>
              <div>
                <label className="block text-xs text-[#94a3b8] mb-1">参数 (空格分隔)</label>
                <input value={form.args} onChange={e => setForm({...form, args: e.target.value})}
                  placeholder="-y @anthropic/mcp-filesystem" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs text-[#94a3b8] mb-1">服务 URL</label>
              <input value={form.url} onChange={e => setForm({...form, url: e.target.value})}
                placeholder="http://localhost:3001/mcp" className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
            </div>
          )}
          <button onClick={editId ? handleSave : handleAdd} disabled={!form.name} className="px-4 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-md text-sm transition-colors">
            {editId ? '保存修改' : '确认添加'}
          </button>
        </div>
      )}

      {/* JSON Import */}
      {showJsonImport && (
        <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155] space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-[#94a3b8]">JSON 导入 MCP (Claude Desktop / Cursor 格式)</p>
            <button onClick={() => { setShowJsonImport(false); setJsonText(''); setJsonError('') }} className="text-xs text-[#64748b] hover:text-[#94a3b8]">关闭</button>
          </div>
          <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} rows={8}
            placeholder={'{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@anthropic/mcp-filesystem"]\n    }\n  }\n}'}
            className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-2 text-xs font-mono focus:border-[#3b82f6] outline-none resize-none" />
          {jsonError && <p className="text-xs text-red-400">{jsonError}</p>}
          <button onClick={handleJsonImport} disabled={!jsonText.trim()}
            className="px-4 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-md text-sm transition-colors">
            导入
          </button>
        </div>
      )}

      {/* Local MCP scan results */}
      {showLocal && (
        <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
          <div className="px-4 py-3 border-b border-[#334155] flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">本地已安装 MCP</p>
              <p className="text-xs text-[#64748b] mt-0.5">
                扫描来源: {localSources.filter(s => s.exists).map(s => SOURCE_LABELS[s.source] || s.source).join(', ') || '无'}
              </p>
            </div>
            <button onClick={() => setShowLocal(false)} className="text-xs text-[#64748b] hover:text-[#94a3b8]">关闭</button>
          </div>
          {localMcps.length === 0 ? (
            <p className="text-sm text-[#64748b] p-4">未发现本地 MCP 配置</p>
          ) : (
            <div className="divide-y divide-[#334155]/50">
              {localMcps.map((entry) => {
                const imported = isImported(entry.name)
                return (
                  <div key={`${entry.source}-${entry.name}`} className="p-3 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{entry.name}</span>
                        <span className="px-1.5 py-0.5 rounded text-xs bg-[#334155] text-[#94a3b8]">
                          {SOURCE_LABELS[entry.source] || entry.source}
                        </span>
                        {entry.disabled && (
                          <span className="px-1.5 py-0.5 rounded text-xs bg-red-500/20 text-red-400">已禁用</span>
                        )}
                      </div>
                      <p className="text-xs text-[#64748b] mt-0.5 font-mono truncate">
                        {entry.command} {entry.args?.join(' ')}
                      </p>
                    </div>
                    <button
                      onClick={() => handleImport(entry)}
                      disabled={imported || importing === entry.name}
                      className="px-3 py-1 rounded text-xs transition-colors shrink-0 ml-3 disabled:opacity-40 bg-[#3b82f6] hover:bg-[#2563eb] disabled:hover:bg-[#3b82f6]"
                    >
                      {imported ? '已导入' : importing === entry.name ? '导入中...' : '导入'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Built-in MCPs */}
      {builtinMcps.length > 0 && (
        <div>
          <p className="text-xs text-[#94a3b8] mb-2 uppercase tracking-wider">内置工具</p>
          <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
            <div className="divide-y divide-[#334155]/50">
              {builtinMcps.map((m) => (
                <div key={m.id} className="p-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-sm">{m.name}</span>
                    <span className={`px-1.5 py-0.5 rounded text-xs ${TRANSPORT_COLORS.builtin}`}>builtin</span>
                    <span className="text-xs text-[#64748b]">{m.description}</span>
                  </div>
                  <span className="text-xs text-[#64748b] font-mono">{m.id}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* External MCPs */}
      <div>
        {builtinMcps.length > 0 && <p className="text-xs text-[#94a3b8] mb-2 uppercase tracking-wider">外部 MCP</p>}
        <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
          {externalMcps.length === 0 ? (
            <p className="text-sm text-[#64748b] p-4">暂无外部 MCP — 点击「扫描本地 MCP」导入已安装的 MCP</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#334155] text-[#94a3b8] text-xs uppercase">
                  <th className="text-left p-3">ID</th>
                  <th className="text-left p-3">名称</th>
                  <th className="text-left p-3">传输</th>
                  <th className="text-left p-3">命令</th>
                  <th className="text-left p-3">描述</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {externalMcps.map(m => (
                  <tr key={m.id} className="border-b border-[#334155]/50 hover:bg-[#334155]/30">
                    <td className="p-3 font-mono text-xs text-[#64748b]">{m.id}</td>
                    <td className="p-3">{m.name}</td>
                    <td className="p-3">
                      <span className={`px-1.5 py-0.5 rounded text-xs ${TRANSPORT_COLORS[m.transport] || 'bg-[#334155]'}`}>
                        {m.transport}
                      </span>
                    </td>
                    <td className="p-3 text-xs text-[#64748b] font-mono truncate max-w-[200px]">
                      {m.command} {m.args?.join(' ')}
                    </td>
                    <td className="p-3 text-xs text-[#94a3b8]">{m.description}</td>
                    <td className="p-3 text-right space-x-2">
                      <button onClick={() => startEdit(m)} className="text-xs text-[#3b82f6] hover:text-[#60a5fa]">编辑</button>
                      <button onClick={() => handleRemove(m.id)} className="text-xs text-red-400 hover:text-red-300">删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
