import { useEffect, useRef, useState, useCallback } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../api'

type Message = {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  tokens?: number
  durationMs?: number
  agentName?: string
  channelSource?: { channelName: string; channelType: string; senderId: string }
}

type Conversation = {
  id: string  // 'web' or conversationId
  label: string
  channelType?: string
  channelName?: string
  senderId?: string
  lastMessage: string
  lastActiveAt: number
  unread: boolean
}

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

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function extractTokens(content: string): number | undefined {
  const m = content.match(/\[STREAM_META:tokens=(\d+)\]/)
  return m ? parseInt(m[1]) : undefined
}

function extractAgentName(content: string): string | undefined {
  const m = content.match(/\[AGENT_INFO:[^|]*\|([^\]]+)\]/)
  return m ? m[1] : undefined
}

const CHANNEL_ICONS: Record<string, string> = { feishu: '🔵', wecom: '🟢', dingtalk: '🔷', web: '🌐' }

// --- Content parsing ---

type Segment =
  | { type: 'text'; content: string }
  | { type: 'tool'; name: string; result?: string; fileOutput?: string }
  | { type: 'dispatch'; agentId: string; agentName: string; content: string; tools: { name: string; result?: string }[] }

function parseSegments(content: string): Segment[] {
  const re = /(\[TOOL_CALL:[^\]]+\]|\[TOOL_RESULT:[^\]]*\]|\[FILE_OUTPUT:[^\]]+\]|\[STREAM_META:[^\]]+\]|\[AGENT_INFO:[^\]]+\]|\[DISPATCH_START:[^\]]+\]|\[DISPATCH_END:[^\]]*\])/
  const parts = content.split(re)
  const segments: Segment[] = []
  let curTool: { name: string; result?: string; fileOutput?: string } | null = null
  let curDispatch: { agentId: string; agentName: string; content: string; tools: { name: string; result?: string }[] } | null = null

  for (const part of parts) {
    if (!part) continue

    const dsMatch = part.match(/^\[DISPATCH_START:([^|]*)\|([^\]]*)\]$/)
    if (dsMatch) {
      if (curTool) { segments.push({ type: 'tool', ...curTool }); curTool = null }
      curDispatch = { agentId: dsMatch[1], agentName: dsMatch[2], content: '', tools: [] }
      continue
    }
    if (part.startsWith('[DISPATCH_END:')) {
      if (curDispatch) { segments.push({ type: 'dispatch', ...curDispatch }); curDispatch = null }
      continue
    }

    if (curDispatch) {
      const tcMatch = part.match(/^\[TOOL_CALL:(.+)\]$/)
      if (tcMatch) { curDispatch.tools.push({ name: tcMatch[1] }); continue }
      const trMatch = part.match(/^\[TOOL_RESULT:([^|]*)\|?([^\]]*)\]$/)
      if (trMatch && curDispatch.tools.length > 0) {
        curDispatch.tools[curDispatch.tools.length - 1].result = trMatch[2] || ''
        continue
      }
      if (part.startsWith('[STREAM_META:') || part.startsWith('[AGENT_INFO:') || part.startsWith('[FILE_OUTPUT:')) continue
      curDispatch.content += part
      continue
    }

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
    if (part.startsWith('[AGENT_INFO:')) continue
    if (curTool) { segments.push({ type: 'tool', ...curTool }); curTool = null }
    segments.push({ type: 'text', content: part })
  }
  if (curTool) segments.push({ type: 'tool', ...curTool })
  if (curDispatch) segments.push({ type: 'dispatch', ...curDispatch })
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

// --- Dispatch block ---

function DispatchBlock({ agentName, content, tools }: { agentName: string; content: string; tools: { name: string; result?: string }[] }) {
  const [expanded, setExpanded] = useState(true)
  const hasContent = !!(content.trim())
  return (
    <div className="my-2 border border-[#3b82f6]/30 rounded-lg overflow-hidden bg-[#0f172a]/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 text-xs hover:bg-[#1e293b] transition-colors"
      >
        <span className={`text-[10px] transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>▶</span>
        <span className="text-[#3b82f6]">◈</span>
        <span className="text-[#3b82f6] font-medium">{agentName}</span>
        <span className="text-[#64748b]">正在执行</span>
        {!expanded && hasContent && <span className="text-[#475569] ml-auto truncate max-w-[300px] text-[10px]">{content.trim().slice(0, 80)}</span>}
      </button>
      {expanded && (
        <div className="px-3 pb-2 border-t border-[#334155]/30">
          {tools.map((t, i) => (
            <div key={i} className="flex items-center gap-2 text-[10px] text-[#64748b] py-0.5">
              <span className="text-[#3b82f6]">⚙️</span>
              <span className="font-mono">{t.name}</span>
              {t.result && <span className="truncate max-w-[200px]">{t.result.slice(0, 50)}</span>}
            </div>
          ))}
          {hasContent && (
            <div className="mt-1 chat-md text-sm">
              <Markdown remarkPlugins={[remarkGfm]}>{content.trim()}</Markdown>
            </div>
          )}
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
          : seg.type === 'dispatch'
            ? <DispatchBlock key={i} agentName={seg.agentName} content={seg.content} tools={seg.tools} />
            : <div key={i} className="chat-md">
                <Markdown remarkPlugins={[remarkGfm]}>{seg.content}</Markdown>
              </div>
      )}
    </>
  )
}

// --- Channel source badge ---

function ChannelBadge({ source }: { source: { channelName: string; channelType: string; senderId: string } }) {
  const icon = CHANNEL_ICONS[source.channelType] || '📨'
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#334155]/50 text-[10px] text-[#94a3b8]">
      <span>{icon}</span>
      <span>{source.channelName}</span>
      <span className="text-[#475569]">·</span>
      <span className="text-[#64748b] font-mono">{source.senderId.slice(-6)}</span>
    </span>
  )
}

// --- Conversation sidebar ---

function ConversationList({
  conversations,
  activeId,
  onSelect,
}: {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
}) {
  return (
    <div className="w-56 shrink-0 border-r border-[#334155] bg-[#0f172a] flex flex-col h-full">
      <div className="px-3 py-2.5 border-b border-[#334155] text-xs text-[#64748b] font-medium">会话列表</div>
      <div className="flex-1 overflow-auto">
        {conversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => onSelect(conv.id)}
            className={`w-full text-left px-3 py-2.5 border-b border-[#334155]/30 transition-colors ${
              activeId === conv.id ? 'bg-[#1e293b]' : 'hover:bg-[#1e293b]/50'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm">{CHANNEL_ICONS[conv.channelType || 'web'] || '💬'}</span>
              <span className={`text-xs font-medium truncate ${activeId === conv.id ? 'text-[#f1f5f9]' : 'text-[#94a3b8]'}`}>
                {conv.label}
              </span>
              {conv.unread && <span className="w-1.5 h-1.5 rounded-full bg-[#3b82f6] shrink-0 ml-auto" />}
            </div>
            <div className="mt-1 text-[10px] text-[#475569] truncate">{conv.lastMessage || '暂无消息'}</div>
            <div className="mt-0.5 text-[10px] text-[#334155]">{formatRelativeTime(conv.lastActiveAt)}</div>
          </button>
        ))}
        {conversations.length === 0 && (
          <div className="px-3 py-6 text-xs text-[#475569] text-center">暂无会话</div>
        )}
      </div>
    </div>
  )
}

// --- Main component ---

export default function Chat() {
  const [webMessages, setWebMessages] = useState<Message[]>(loadMessages)
  const [channelConvs, setChannelConvs] = useState<any[]>([])
  const [channelMessages, setChannelMessages] = useState<any[]>([])
  const [activeConv, setActiveConv] = useState('web')
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Current messages based on active conversation
  const isWeb = activeConv === 'web'
  const messages: Message[] = isWeb
    ? webMessages
    : channelMessages
        .filter((m: any) => m.conversationId === activeConv)
        .map((m: any) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          timestamp: m.timestamp,
          channelSource: { channelName: m.channelName, channelType: m.channelType, senderId: m.senderId },
        }))

  // Build conversation list
  const conversations: Conversation[] = [
    {
      id: 'web',
      label: 'Web 对话',
      channelType: 'web',
      lastMessage: webMessages.length > 0 ? webMessages[webMessages.length - 1].content.replace(/\[.*?\]/g, '').slice(0, 40) : '',
      lastActiveAt: webMessages.length > 0 ? webMessages[webMessages.length - 1].timestamp : Date.now(),
      unread: false,
    },
    ...channelConvs.map((c: any) => ({
      id: c.conversationId,
      label: `${c.channelName} · ${c.senderId.slice(-6)}`,
      channelType: c.channelType,
      channelName: c.channelName,
      senderId: c.senderId,
      lastMessage: c.lastMessage || '',
      lastActiveAt: c.lastActiveAt,
      unread: false,
    })),
  ]

  // Poll channel conversations
  const fetchChannelData = useCallback(async () => {
    try {
      const [convs, msgs] = await Promise.all([
        api.getChannelConversations(),
        api.getChannelMessages(undefined, 200),
      ])
      setChannelConvs(convs)
      setChannelMessages(msgs)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchChannelData()
    pollRef.current = setInterval(fetchChannelData, 5000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [fetchChannelData])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { if (!streaming) saveMessages(webMessages) }, [webMessages, streaming])
  useEffect(() => { if (editingIdx !== null) editRef.current?.focus() }, [editingIdx])

  const sendWithHistory = async (history: Message[]) => {
    const abort = new AbortController()
    abortRef.current = abort
    setStreaming(true)
    const startTime = Date.now()
    const assistantMsg: Message = { role: 'assistant', content: '', timestamp: Date.now() }
    setWebMessages([...history, assistantMsg])

    try {
      for await (const chunk of api.chat(history.map((m) => ({ role: m.role, content: m.content })), abort.signal)) {
        if (abort.signal.aborted) break
        assistantMsg.content += chunk
        const tokens = extractTokens(assistantMsg.content)
        if (tokens) assistantMsg.tokens = tokens
        const agent = extractAgentName(assistantMsg.content)
        if (agent) assistantMsg.agentName = agent
        assistantMsg.durationMs = Date.now() - startTime
        setWebMessages([...history, { ...assistantMsg }])
      }
      assistantMsg.durationMs = Date.now() - startTime
      setWebMessages([...history, { ...assistantMsg }])
    } catch (err) {
      if (!abort.signal.aborted) {
        assistantMsg.content += `\n\n[Error: ${err instanceof Error ? err.message : err}]`
        assistantMsg.durationMs = Date.now() - startTime
        setWebMessages([...history, { ...assistantMsg }])
      }
    } finally {
      abortRef.current = null
      setStreaming(false)
      inputRef.current?.focus()
    }
  }

  const stopStreaming = () => { abortRef.current?.abort() }

  const send = async () => {
    if (!isWeb) return // channel conversations are read-only in web UI
    const text = input.trim()
    if (!text || streaming) return
    const userMsg: Message = { role: 'user', content: text, timestamp: Date.now() }
    const history = [...webMessages, userMsg]
    setWebMessages(history)
    setInput('')
    await sendWithHistory(history)
  }

  const handleEdit = async (idx: number) => {
    if (!isWeb) return
    const text = editText.trim()
    if (!text || streaming) return
    const before = webMessages.slice(0, idx)
    const editedMsg: Message = { role: 'user', content: text, timestamp: Date.now() }
    const history = [...before, editedMsg]
    setWebMessages(history)
    setEditingIdx(null)
    setEditText('')
    await sendWithHistory(history)
  }

  const startEdit = (idx: number) => {
    if (!isWeb || streaming || messages[idx]?.role !== 'user') return
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
    isWeb && msg.role === 'assistant' && streaming && i === messages.length - 1

  const activeConvInfo = conversations.find(c => c.id === activeConv)

  return (
    <div className="flex h-full">
      <style>{`
        @keyframes breathing {
          0%, 100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); border-color: #334155; }
          50% { box-shadow: 0 0 12px 2px rgba(59,130,246,0.15); border-color: #3b82f6; }
        }
        .bubble-breathing { animation: breathing 2s ease-in-out infinite; }
      `}</style>

      {sidebarOpen && (
        <ConversationList
          conversations={conversations}
          activeId={activeConv}
          onSelect={(id) => { setActiveConv(id); setEditingIdx(null) }}
        />
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="shrink-0 px-4 py-3 border-b border-[#334155] flex items-center justify-between bg-[#1e293b]">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="text-[#64748b] hover:text-[#94a3b8] text-sm px-1"
              title={sidebarOpen ? '收起会话列表' : '展开会话列表'}
            >
              {sidebarOpen ? '◀' : '▶'}
            </button>
            <span className="text-sm">{CHANNEL_ICONS[activeConvInfo?.channelType || 'web']}</span>
            <h2 className="text-sm font-bold">{activeConvInfo?.label || '对话'}</h2>
            {isWeb && <span className="text-xs text-[#94a3b8]">Genesis — 平台内核调度</span>}
            {!isWeb && activeConvInfo?.channelName && (
              <span className="text-xs text-[#94a3b8]">来自 {activeConvInfo.channelName} 渠道</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!isWeb && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-[#334155] text-[#94a3b8]">只读</span>
            )}
            {isWeb && (
              <button
                onClick={() => { setWebMessages([]); localStorage.removeItem(CHAT_STORAGE_KEY); setEditingIdx(null) }}
                className="text-xs text-[#64748b] hover:text-[#94a3b8] px-2 py-1"
              >清空</button>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-[#475569]">
                <p className="text-4xl mb-3">{isWeb ? '◈' : CHANNEL_ICONS[activeConvInfo?.channelType || 'web']}</p>
                <p className="text-sm">{isWeb ? '与创世 Agent 对话' : '渠道对话记录'}</p>
                <p className="text-xs mt-2 text-[#64748b]">
                  {isWeb ? 'Genesis 会自动将请求路由到最合适的 Worker Agent' : '此会话来自外部渠道，仅供查看'}
                </p>
              </div>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'user' && isWeb && editingIdx === i ? (
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
                        ? `bg-[#3b82f6] text-white ${isWeb ? 'cursor-pointer hover:bg-[#2563eb]' : ''} transition-colors`
                        : `bg-[#1e293b] border border-[#334155] text-[#f1f5f9]${isStreamingLast(i, msg) ? ' bubble-breathing' : ''}`
                    }`}
                    title={msg.role === 'user' && isWeb ? '双击编辑' : undefined}
                  >
                    <MessageContent content={msg.content} />
                  </div>
                  <div className={`flex items-center gap-2 mt-1 text-[10px] text-[#475569] flex-wrap ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.channelSource && <ChannelBadge source={msg.channelSource} />}
                    {msg.role === 'assistant' && msg.agentName && (
                      <span className="text-[#3b82f6]">◈ {msg.agentName}</span>
                    )}
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

        {/* Input */}
        <div className="shrink-0 px-6 py-3 border-t border-[#334155] bg-[#1e293b]">
          {isWeb ? (
            <div className="flex gap-2 items-end">
              <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown} placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
                disabled={streaming} rows={1}
                className="flex-1 bg-[#0f172a] border border-[#475569] rounded-lg px-4 py-2.5 text-sm focus:border-[#3b82f6] outline-none resize-none disabled:opacity-40 max-h-32"
                style={{ minHeight: '42px' }} />
              <button onClick={streaming ? stopStreaming : send} disabled={!streaming && !input.trim()}
                className={`px-4 py-2.5 rounded-lg text-sm transition-colors shrink-0 ${streaming ? 'bg-red-500 hover:bg-red-600' : 'bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40'}`}>
                {streaming ? '停止' : '发送'}
              </button>
            </div>
          ) : (
            <div className="text-center text-xs text-[#475569] py-1">
              渠道会话为只读模式 · 消息通过 {activeConvInfo?.channelName || '外部渠道'} 收发
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
