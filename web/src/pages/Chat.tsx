import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

type Message = { role: 'user' | 'assistant'; content: string; timestamp: number; tokens?: number; durationMs?: number }

const CHAT_STORAGE_KEY = 'nmclaw_chat_messages'

function loadMessages(): Message[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY)
    if (!raw) return []
    return (JSON.parse(raw) as any[]).map((m) => ({ ...m, timestamp: m.timestamp || Date.now() }))
  } catch { return [] }
}

function saveMessages(msgs: Message[]) {
  localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(msgs))
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function extractTokens(content: string): number | undefined {
  const m = content.match(/\[STREAM_META:tokens=(\d+)\]/)
  return m ? parseInt(m[1]) : undefined
}

// --- Content parsing ---

type Segment =
  | { type: 'text'; content: string }
  | { type: 'tool'; name: string; result?: string; fileOutput?: string }

function parseSegments(content: string): Segment[] {
  const re = /(\[TOOL_CALL:[^\]]+\]|\[TOOL_RESULT:[^\]]*\]|\[FILE_OUTPUT:[^\]]+\]|\[STREAM_META:[^\]]+\])/
  const parts = content.split(re)
  const segments: Segment[] = []
  let curTool: { name: string; result?: string; fileOutput?: string } | null = null

  for (const part of parts) {
    if (!part) continue
    const tcMatch = part.match(/^\[TOOL_CALL:(.+)\]$/)
    if (tcMatch) {
      if (curTool) segments.push({ type: 'tool', ...curTool })
      curTool = { name: tcMatch[1] }
      continue
    }
    const trMatch = part.match(/^\[TOOL_RESULT:([^|]*)\|?([^\]]*)\]$/)
    if (trMatch && curTool) { curTool.result = trMatch[2] || ''; continue }
    const fMatch = part.match(/^\[FILE_OUTPUT:(.+)\]$/)
    if (fMatch) {
      if (curTool) curTool.fileOutput = fMatch[1]
      else segments.push({ type: 'tool', name: 'write_file', fileOutput: fMatch[1] })
      continue
    }
    if (part.startsWith('[STREAM_META:')) continue
    if (curTool) { segments.push({ type: 'tool', ...curTool }); curTool = null }
    segments.push({ type: 'text', content: part })
  }
  if (curTool) segments.push({ type: 'tool', ...curTool })
  return segments
}

// --- Collapsible tool block ---

function ToolBlock({ name, result, fileOutput }: { name: string; result?: string; fileOutput?: string }) {
  const [open, setOpen] = useState(false)
  const hasDetail = !!(result || fileOutput)
  return (
    <div className="my-2 bg-[#0f172a] border border-[#334155] rounded overflow-hidden">
      <button
        onClick={() => hasDetail && setOpen(!open)}
        className={`w-full px-3 py-1.5 flex items-center gap-2 text-xs text-[#94a3b8] ${hasDetail ? 'hover:bg-[#1e293b] cursor-pointer' : 'cursor-default'}`}
      >
        {hasDetail && <span className={`text-[10px] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>▶</span>}
        <span className="text-[#3b82f6]">⚙️</span>
        <span>调用工具: <span className="text-[#f1f5f9] font-mono">{name}</span></span>
        {result && !open && <span className="text-[#475569] ml-auto truncate max-w-[200px] text-[10px]">{result.slice(0, 60)}</span>}
      </button>
      {open && result && (
        <div className="px-3 py-2 border-t border-[#334155]/50 text-xs text-[#94a3b8] font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto">
          {result}
        </div>
      )}
      {fileOutput && (
        <div className={`px-3 py-1.5 ${open || !result ? 'border-t' : ''} border-[#22c55e]/20 flex items-center gap-2 text-xs`}>
          <span className="text-[#22c55e]">📄</span>
          <span className="text-[#22c55e]">文件已保存</span>
          <span className="text-[#f1f5f9] font-mono">{fileOutput}</span>
        </div>
      )}
    </div>
  )
}

function MessageContent({ content }: { content: string }) {
  const segments = parseSegments(content)
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'tool'
          ? <ToolBlock key={i} name={seg.name} result={seg.result} fileOutput={seg.fileOutput} />
          : <pre key={i} className="whitespace-pre-wrap break-words font-sans">{seg.content}</pre>
      )}
    </>
  )
}

// --- Main component ---

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>(loadMessages)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { if (!streaming) saveMessages(messages) }, [messages, streaming])
  useEffect(() => { if (editingIdx !== null) editRef.current?.focus() }, [editingIdx])

  const sendWithHistory = async (history: Message[]) => {
    setStreaming(true)
    const startTime = Date.now()
    const assistantMsg: Message = { role: 'assistant', content: '', timestamp: Date.now() }
    setMessages([...history, assistantMsg])

    try {
      for await (const chunk of api.chat(history.map((m) => ({ role: m.role, content: m.content })))) {
        assistantMsg.content += chunk
        const tokens = extractTokens(assistantMsg.content)
        if (tokens) assistantMsg.tokens = tokens
        assistantMsg.durationMs = Date.now() - startTime
        setMessages([...history, { ...assistantMsg }])
      }
      assistantMsg.durationMs = Date.now() - startTime
      setMessages([...history, { ...assistantMsg }])
    } catch (err) {
      assistantMsg.content += `\n\n[Error: ${err instanceof Error ? err.message : err}]`
      assistantMsg.durationMs = Date.now() - startTime
      setMessages([...history, { ...assistantMsg }])
    } finally {
      setStreaming(false)
      inputRef.current?.focus()
    }
  }

  const send = async () => {
    const text = input.trim()
    if (!text || streaming) return
    const userMsg: Message = { role: 'user', content: text, timestamp: Date.now() }
    const history = [...messages, userMsg]
    setMessages(history)
    setInput('')
    await sendWithHistory(history)
  }

  const handleEdit = async (idx: number) => {
    const text = editText.trim()
    if (!text || streaming) return
    const before = messages.slice(0, idx)
    const editedMsg: Message = { role: 'user', content: text, timestamp: Date.now() }
    const history = [...before, editedMsg]
    setMessages(history)
    setEditingIdx(null)
    setEditText('')
    await sendWithHistory(history)
  }

  const startEdit = (idx: number) => {
    if (streaming || messages[idx]?.role !== 'user') return
    setEditingIdx(idx)
    setEditText(messages[idx].content)
  }

  const cancelEdit = () => { setEditingIdx(null); setEditText('') }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const handleEditKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEdit(idx) }
    if (e.key === 'Escape') cancelEdit()
  }

  const isStreamingLast = (i: number, msg: Message) =>
    msg.role === 'assistant' && streaming && i === messages.length - 1

  return (
    <div className="flex flex-col h-full">
      <style>{`
        @keyframes breathing {
          0%, 100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); border-color: #334155; }
          50% { box-shadow: 0 0 12px 2px rgba(59,130,246,0.15); border-color: #3b82f6; }
        }
        .bubble-breathing { animation: breathing 2s ease-in-out infinite; }
      `}</style>
      <div className="shrink-0 px-6 py-3 border-b border-[#334155] flex items-center justify-between bg-[#1e293b]">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-bold">创世 Agent</h2>
          <span className="text-xs text-[#94a3b8]">Genesis — 平台内核调度</span>
        </div>
        <button
          onClick={() => { setMessages([]); localStorage.removeItem(CHAT_STORAGE_KEY); setEditingIdx(null) }}
          className="text-xs text-[#64748b] hover:text-[#94a3b8] px-2 py-1"
        >清空</button>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-[#475569]">
              <p className="text-4xl mb-3">◈</p>
              <p className="text-sm">与创世 Agent 对话</p>
              <p className="text-xs mt-2 text-[#64748b]">Genesis 会自动将请求路由到最合适的 Worker Agent</p>
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'user' && editingIdx === i ? (
              <div className="max-w-[75%] w-full">
                <textarea ref={editRef} value={editText} onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => handleEditKeyDown(e, i)} rows={3}
                  className="w-full bg-[#0f172a] border border-[#3b82f6] rounded-lg px-4 py-2.5 text-sm outline-none resize-none" />
                <div className="flex gap-2 mt-1 justify-end">
                  <button onClick={cancelEdit} className="text-xs text-[#64748b] hover:text-[#94a3b8] px-2 py-1">取消</button>
                  <button onClick={() => handleEdit(i)} disabled={!editText.trim()}
                    className="text-xs bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 px-3 py-1 rounded transition-colors">重新发送</button>
                </div>
              </div>
            ) : (
              <div className="max-w-[75%]">
                <div
                  onDoubleClick={() => startEdit(i)}
                  className={`rounded-lg px-4 py-2.5 text-sm ${
                    msg.role === 'user'
                      ? 'bg-[#3b82f6] text-white cursor-pointer hover:bg-[#2563eb] transition-colors'
                      : `bg-[#1e293b] border border-[#334155] text-[#f1f5f9]${isStreamingLast(i, msg) ? ' bubble-breathing' : ''}`
                  }`}
                  title={msg.role === 'user' ? '双击编辑' : undefined}
                >
                  <MessageContent content={msg.content} />
                </div>
                <div className={`flex items-center gap-2 mt-1 text-[10px] text-[#475569] ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <span>{formatTime(msg.timestamp)}</span>
                  {msg.role === 'assistant' && msg.durationMs != null && msg.durationMs > 0 && (
                    <span>· {msg.durationMs >= 1000 ? `${(msg.durationMs / 1000).toFixed(1)}s` : `${msg.durationMs}ms`}</span>
                  )}
                  {msg.tokens != null && msg.tokens > 0 && <span>· {msg.tokens} tokens</span>}
                </div>
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 px-6 py-3 border-t border-[#334155] bg-[#1e293b]">
        <div className="flex gap-2 items-end">
          <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown} placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            disabled={streaming} rows={1}
            className="flex-1 bg-[#0f172a] border border-[#475569] rounded-lg px-4 py-2.5 text-sm focus:border-[#3b82f6] outline-none resize-none disabled:opacity-40 max-h-32"
            style={{ minHeight: '42px' }} />
          <button onClick={send} disabled={!input.trim() || streaming}
            className="px-4 py-2.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-lg text-sm transition-colors shrink-0">
            {streaming ? '...' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}
