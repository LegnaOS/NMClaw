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
  removeModel: (id: string) => request<any>(`/models/${id}`, { method: 'DELETE' }),

  listSkills: () => request<any[]>('/skills'),
  addSkill: (data: any) => request<any>('/skills', { method: 'POST', body: JSON.stringify(data) }),
  removeSkill: (id: string) => request<any>(`/skills/${id}`, { method: 'DELETE' }),

  listMcps: () => request<any[]>('/mcps'),
  addMcp: (data: any) => request<any>('/mcps', { method: 'POST', body: JSON.stringify(data) }),
  removeMcp: (id: string) => request<any>(`/mcps/${id}`, { method: 'DELETE' }),

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
  removeGraph: (id: string) => request<any>(`/graphs/${id}`, { method: 'DELETE' }),

  // ClawHub
  clawHubSearch: (q: string) => request<any[]>(`/clawhub/search?q=${encodeURIComponent(q)}`),
  clawHubInfo: (slug: string) => request<any>(`/clawhub/skills/${encodeURIComponent(slug)}`),
  clawHubInstall: (slug: string) => request<any>('/clawhub/install', { method: 'POST', body: JSON.stringify({ slug }) }),

  // CRON
  listCronJobs: () => request<any[]>('/cron'),
  addCronJob: (data: any) => request<any>('/cron', { method: 'POST', body: JSON.stringify(data) }),
  toggleCronJob: (id: string, enabled: boolean) => request<any>(`/cron/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  removeCronJob: (id: string) => request<any>(`/cron/${id}`, { method: 'DELETE' }),

  // Local MCP Scanner
  scanLocalMcps: () => request<any>('/local-mcps'),
  importLocalMcp: (data: any) => request<any>('/local-mcps/import', { method: 'POST', body: JSON.stringify(data) }),

  // Chat (streaming) — always routes through Genesis Agent
  chat: async function* (messages: { role: string; content: string }[]): AsyncGenerator<string> {
    const res = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
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
          yield data
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
