import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

const emptyForm = { name: '', description: '', promptTemplate: '', requiredMcps: '' }

export default function Skills() {
  const [skills, setSkills] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState({ ...emptyForm })
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [importUrl, setImportUrl] = useState('')
  const [importingUrl, setImportingUrl] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => api.listSkills().then(setSkills)
  useEffect(() => { load() }, [])

  const cancelForm = () => { setShowForm(false); setEditId(null); setForm({ ...emptyForm }) }

  const handleAdd = async () => {
    await api.addSkill({
      ...form,
      requiredMcps: form.requiredMcps ? form.requiredMcps.split(',').map(s => s.trim()) : [],
    })
    cancelForm(); load()
  }

  const startEdit = (s: any) => {
    setEditId(s.id)
    setForm({
      name: s.name, description: s.description ?? '',
      promptTemplate: s.promptTemplate ?? '',
      requiredMcps: (s.requiredMcps ?? []).join(', '),
    })
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!editId) return
    await api.modifySkill(editId, {
      ...form,
      requiredMcps: form.requiredMcps ? form.requiredMcps.split(',').map(s => s.trim()) : [],
    })
    cancelForm(); load()
  }

  const handleRemove = async (id: string) => {
    if (!confirm('确认移除此技能?')) return
    await api.removeSkill(id)
    load()
  }

  const handleUpload = async (file: File) => {
    const ext = file.name.toLowerCase()
    if (!ext.endsWith('.zip') && !ext.endsWith('.tar.gz') && !ext.endsWith('.tgz') && !ext.endsWith('.tar') && !ext.endsWith('.md')) {
      setUploadError('不支持的格式，请上传 .zip / .tar.gz / .tgz / .md')
      return
    }
    setUploading(true)
    setUploadError('')
    try {
      await api.uploadSkill(file)
      load()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleUpload(file)
  }

  const handleImportUrl = async () => {
    const url = importUrl.trim()
    if (!url) return
    setImportingUrl(true)
    setUploadError('')
    try {
      await api.importSkillUrl(url)
      setImportUrl('')
      load()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : '导入失败')
    } finally {
      setImportingUrl(false)
    }
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">技能库</h2>
        <button onClick={() => { if (showForm) cancelForm(); else { setShowForm(true); setEditId(null); setForm({ ...emptyForm }) } }}
          className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] rounded-md text-sm transition-colors">
          {showForm && !editId ? '取消' : '+ 添加技能'}
        </button>
      </div>

      {showForm && (
        <div className="bg-[#1e293b] rounded-lg p-4 border border-[#334155] space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-[#94a3b8]">{editId ? '编辑技能' : '添加技能'}</p>
            <button onClick={cancelForm} className="text-xs text-[#64748b] hover:text-[#94a3b8]">取消</button>
          </div>
          {/* File upload zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
              dragOver ? 'border-[#3b82f6] bg-[#3b82f6]/10' : 'border-[#475569] hover:border-[#64748b]'
            }`}
          >
            <input ref={fileRef} type="file" accept=".zip,.tar.gz,.tgz,.tar,.md" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f) }} />
            <p className="text-sm text-[#94a3b8]">
              {uploading ? '上传解析中...' : '拖拽或点击上传技能包'}
            </p>
            <p className="text-[10px] text-[#64748b] mt-1">
              支持 .zip / .tar.gz / .tgz / .md — 压缩包内需包含 SKILL.md
            </p>
          </div>
          {/* URL import */}
          <div className="flex gap-2">
            <input value={importUrl} onChange={e => setImportUrl(e.target.value)}
              placeholder="从 URL 导入，如 https://evomap.ai/skill.md"
              onKeyDown={e => e.key === 'Enter' && handleImportUrl()}
              className="flex-1 bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none" />
            <button onClick={handleImportUrl} disabled={!importUrl.trim() || importingUrl}
              className="px-3 py-1.5 bg-[#10b981] hover:bg-[#059669] disabled:opacity-40 rounded-md text-sm transition-colors whitespace-nowrap">
              {importingUrl ? '导入中...' : '从 URL 导入'}
            </button>
          </div>

          {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-[#334155]" />
            <span className="text-[10px] text-[#64748b]">或手动填写</span>
            <div className="flex-1 h-px bg-[#334155]" />
          </div>

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
          <button onClick={editId ? handleSave : handleAdd} disabled={!form.name} className="px-4 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-md text-sm transition-colors">
            {editId ? '保存修改' : '确认添加'}
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
                  <div className="space-x-2">
                    <button onClick={() => startEdit(s)} className="text-xs text-[#3b82f6] hover:text-[#60a5fa]">编辑</button>
                    <button onClick={() => handleRemove(s.id)} className="text-xs text-red-400 hover:text-red-300">删除</button>
                  </div>
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
