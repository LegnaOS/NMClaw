const BASE = '/api'

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? res.statusText)
  }
  return res.json()
}

export const api = {
  getStatus: () => request<any>('/status'),

  listModels: () => request<any[]>('/models'),
  addModel: (data: any) => request<any>('/models', { method: 'POST', body: JSON.stringify(data) }),
  modifyModel: (id: string, data: any) => request<any>(`/models/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  removeModel: (id: string) => request<any>(`/models/${id}`, { method: 'DELETE' }),

  listSkills: () => request<any[]>('/skills'),
  addSkill: (data: any) => request<any>('/skills', { method: 'POST', body: JSON.stringify(data) }),
  modifySkill: (id: string, data: any) => request<any>(`/skills/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  removeSkill: (id: string) => request<any>(`/skills/${id}`, { method: 'DELETE' }),
  uploadSkill: async (file: File) => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`${BASE}/skills/upload`, { method: 'POST', body: form })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error ?? res.statusText)
    }
    return res.json()
  },
  importSkillUrl: (url: string) => request<any>('/skills/import-url', { method: 'POST', body: JSON.stringify({ url }) }),

  listMcps: () => request<any[]>('/mcps'),
  addMcp: (data: any) => request<any>('/mcps', { method: 'POST', body: JSON.stringify(data) }),
  modifyMcp: (id: string, data: any) => request<any>(`/mcps/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  removeMcp: (id: string) => request<any>(`/mcps/${id}`, { method: 'DELETE' }),
  importMcpJson: (mcpServers: Record<string, any>) => request<any[]>('/mcps/import-json', { method: 'POST', body: JSON.stringify({ mcpServers }) }),

  listAgents: (all = false) => request<any[]>(`/agents${all ? '?all=true' : ''}`),
  getAgent: (id: string) => request<any>(`/agents/${id}`),
  createAgent: (data: any) => request<any>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  modifyAgent: (id: string, data: any) => request<any>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  destroyAgent: (id: string) => request<any>(`/agents/${id}`, { method: 'DELETE' }),

  listTasks: (limit = 20) => request<any[]>(`/tasks?limit=${limit}`),
  getTask: (id: string) => request<any>(`/tasks/${id}`),
  getTaskTrace: (id: string) => request<any[]>(`/tasks/${id}/trace`),
  dispatchTask: (data: any) => request<any>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  deleteTask: (id: string) => request<any>(`/tasks/${id}`, { method: 'DELETE' }),

  getBypass: () => request<any>('/bypass'),
  enableBypass: () => request<any>('/bypass/enable', { method: 'POST' }),
  disableBypass: () => request<any>('/bypass/disable', { method: 'POST' }),

  // Graphs
  listGraphs: () => request<any[]>('/graphs'),
  getGraph: (id: string) => request<any>(`/graphs/${id}`),
  createGraph: (data: any) => request<any>('/graphs', { method: 'POST', body: JSON.stringify(data) }),
  modifyGraph: (id: string, data: any) => request<any>(`/graphs/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  removeGraph: (id: string) => request<any>(`/graphs/${id}`, { method: 'DELETE' }),

  // ClawHub
  clawHubSearch: (q: string) => request<any[]>(`/clawhub/search?q=${encodeURIComponent(q)}`),
  clawHubInfo: (slug: string) => request<any>(`/clawhub/skills/${encodeURIComponent(slug)}`),
  clawHubInstall: (slug: string) => request<any>('/clawhub/install', { method: 'POST', body: JSON.stringify({ slug }) }),

  // CRON
  listCronJobs: () => request<any[]>('/cron'),
  addCronJob: (data: any) => request<any>('/cron', { method: 'POST', body: JSON.stringify(data) }),
  modifyCronJob: (id: string, data: any) => request<any>(`/cron/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  toggleCronJob: (id: string, enabled: boolean) => request<any>(`/cron/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  removeCronJob: (id: string) => request<any>(`/cron/${id}`, { method: 'DELETE' }),

  // Channels
  listChannels: () => request<any[]>('/channels'),
  addChannel: (data: any) => request<any>('/channels', { method: 'POST', body: JSON.stringify(data) }),
  modifyChannel: (id: string, data: any) => request<any>(`/channels/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  removeChannel: (id: string) => request<any>(`/channels/${id}`, { method: 'DELETE' }),
  sendChannelMessage: (id: string, text: string) => request<any>(`/channels/${id}/send`, { method: 'POST', body: JSON.stringify({ text }) }),
  startChannel: (id: string) => request<any>(`/channels/${id}/start`, { method: 'POST' }),
  stopChannel: (id: string) => request<any>(`/channels/${id}/stop`, { method: 'POST' }),
  getChannelStatus: (id: string) => request<any>(`/channels/${id}/status`),

  // Pairings
  listPairings: (channelId?: string) => request<any[]>(`/pairings${channelId ? `?channelId=${channelId}` : ''}`),
  approvePairing: (code: string) => request<any>(`/pairings/${code}/approve`, { method: 'POST' }),
  rejectPairing: (code: string) => request<any>(`/pairings/${code}/reject`, { method: 'POST' }),

  // Local MCP Scanner
  scanLocalMcps: () => request<any>('/local-mcps'),
  importLocalMcp: (data: any) => request<any>('/local-mcps/import', { method: 'POST', body: JSON.stringify(data) }),

  // Agent Memory
  getAgentMemory: (id: string, limit = 100, offset = 0) => request<any>(`/agents/${id}/memory?limit=${limit}&offset=${offset}`),
  addMemoryTurn: (id: string, data: { user_message: string; assistant_response: string }) =>
    request<any>(`/agents/${id}/memory/turns`, { method: 'POST', body: JSON.stringify(data) }),
  editMemoryTurn: (id: string, turnId: number, data: any) =>
    request<any>(`/agents/${id}/memory/turns/${turnId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteMemoryTurn: (id: string, turnId: number) =>
    request<any>(`/agents/${id}/memory/turns/${turnId}`, { method: 'DELETE' }),
  deleteMemorySummary: (id: string, sumId: number) =>
    request<any>(`/agents/${id}/memory/summaries/${sumId}`, { method: 'DELETE' }),
  clearAgentMemory: (id: string) => request<any>(`/agents/${id}/memory`, { method: 'DELETE' }),
  getMemoryGraph: (id: string) => request<any>(`/agents/${id}/memory/graph`),

  // Channel messages
  getChannelConversations: () => request<any[]>('/channel-conversations'),
  getChannelMessages: (conversationId?: string, limit = 50) => {
    const params = new URLSearchParams()
    if (conversationId) params.set('conversationId', conversationId)
    params.set('limit', String(limit))
    return request<any[]>(`/channel-messages?${params}`)
  },

  // Snapshots (记忆回溯)
  listSnapshots: (limit = 50, offset = 0) => request<{ items: any[]; total: number }>(`/snapshots?limit=${limit}&offset=${offset}`),
  getSnapshotDetail: (id: number) => request<any>(`/snapshots/${id}`),
  getSnapshotDiff: (id: number) => request<any>(`/snapshots/${id}/diff`),
  restoreSnapshot: (id: number) => request<any>(`/snapshots/${id}/restore`, { method: 'POST' }),
  getSnapshotConfig: () => request<{ enabled: boolean; maxVersions: number }>('/snapshots/config'),
  updateSnapshotConfig: (data: { enabled?: boolean; maxVersions?: number }) =>
    request<any>('/snapshots/config', { method: 'PATCH', body: JSON.stringify(data) }),

  // Chat (streaming) — always routes through Genesis Agent
  chat: async function* (messages: { role: string; content: string }[], signal?: AbortSignal): AsyncGenerator<string> {
    const res = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error ?? res.statusText)
    }
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') return
          if (data.startsWith('[ERROR]')) throw new Error(data.slice(8))
          try { yield JSON.parse(data) } catch { yield data }
        }
      }
    }
  },

  // Graph execution (streaming events)
  executeGraph: async function* (graphId: string, input: string): AsyncGenerator<any> {
    const res = await fetch(`${BASE}/graphs/${graphId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    })
    if (!res.ok) throw new Error('Graph execution failed')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try { yield JSON.parse(line.slice(6)) } catch {}
        }
      }
    }
  },
}
