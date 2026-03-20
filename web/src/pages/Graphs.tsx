import { useCallback, useEffect, useMemo, useState, memo } from 'react'
import {
  ReactFlow,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  Handle,
  Position,
  Controls,
  Background,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api } from '../api'

// ─── Custom Agent Node ───

type AgentNodeData = { label: string; agentName: string; agentId: string }

const AgentNode = memo(({ data }: NodeProps<Node<AgentNodeData>>) => (
  <div className="bg-[#1e293b] border-2 border-[#3b82f6] rounded-lg px-4 py-3 min-w-[140px] shadow-lg shadow-blue-500/10">
    <Handle type="target" position={Position.Top} className="!bg-[#3b82f6] !w-3 !h-3 !border-2 !border-[#0f172a]" />
    <div className="text-xs font-bold text-[#f1f5f9]">{data.label || '未命名'}</div>
    <div className="text-[10px] text-[#94a3b8] mt-0.5">{data.agentName}</div>
    <Handle type="source" position={Position.Bottom} className="!bg-[#3b82f6] !w-3 !h-3 !border-2 !border-[#0f172a]" />
  </div>
))

const nodeTypes = { agent: AgentNode }

// ─── Graph Editor (inner, needs ReactFlowProvider) ───

function GraphEditor({ agents, onSave, initial }: {
  agents: any[]
  onSave: (data: { name: string; description: string; nodes: any[]; edges: any[] }) => void
  initial?: { name: string; description: string; nodes: any[]; edges: any[] } | null
}) {
  const [nodes, setNodes] = useState<Node[]>(() => {
    if (!initial?.nodes) return []
    return initial.nodes.map((n: any, i: number) => {
      const agent = agents.find((a: any) => a.id === n.agentId)
      return {
        id: n.id,
        type: 'agent' as const,
        position: { x: 100 + (i % 3) * 200, y: 60 + Math.floor(i / 3) * 120 },
        data: { label: n.label || agent?.name || '?', agentName: agent?.name || '?', agentId: n.agentId },
      }
    })
  })
  const [edges, setEdges] = useState<Edge[]>(() => {
    if (!initial?.edges) return []
    return initial.edges.map((e: any, i: number) => ({
      id: e.id || `e${i}`,
      source: e.from,
      target: e.to,
      animated: true,
      style: { stroke: '#3b82f6' },
    }))
  })
  const [name, setName] = useState(initial?.name ?? '')
  const [desc, setDesc] = useState(initial?.description ?? '')
  const { screenToFlowPosition } = useReactFlow()

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)), [],
  )
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)), [],
  )
  const onConnect: OnConnect = useCallback(
    (conn) => setEdges((eds) => addEdge({ ...conn, animated: true, style: { stroke: '#3b82f6' } }, eds)), [],
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const agentId = e.dataTransfer.getData('application/nmclaw-agent')
    if (!agentId) return
    const agent = agents.find((a: any) => a.id === agentId)
    if (!agent) return

    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const id = `n_${Date.now()}`
    setNodes((nds) => [...nds, {
      id,
      type: 'agent',
      position,
      data: { label: agent.name, agentName: agent.name, agentId: agent.id },
    }])
  }, [agents, screenToFlowPosition])

  const handleSave = () => {
    if (!name.trim() || nodes.length === 0) return
    onSave({
      name: name.trim(),
      description: desc.trim(),
      nodes: nodes.map((n) => ({ id: n.id, agentId: (n.data as AgentNodeData).agentId, label: (n.data as AgentNodeData).label })),
      edges: edges.map((e) => ({ from: e.source, to: e.target, condition: '' })),
    })
    setNodes([])
    setEdges([])
    setName('')
    setDesc('')
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="shrink-0 px-4 py-2 border-b border-[#334155] flex items-center gap-3 bg-[#1e293b]">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Graph 名称"
          className="bg-[#0f172a] border border-[#475569] rounded px-2 py-1 text-xs w-36 focus:border-[#3b82f6] outline-none" />
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="描述 (可选)"
          className="bg-[#0f172a] border border-[#475569] rounded px-2 py-1 text-xs flex-1 focus:border-[#3b82f6] outline-none" />
        <button onClick={handleSave} disabled={!name.trim() || nodes.length === 0}
          className="px-3 py-1 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded text-xs transition-colors">
          {initial ? '保存修改' : '保存 Graph'}
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Agent sidebar (drag source) */}
        <div className="w-40 shrink-0 border-r border-[#334155] bg-[#0f172a] p-2 overflow-auto">
          <p className="text-[10px] text-[#64748b] uppercase tracking-wide mb-2">拖拽 Agent 到画布</p>
          {agents.map((a: any) => (
            <div key={a.id} draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/nmclaw-agent', a.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              className="px-2 py-1.5 mb-1 bg-[#1e293b] border border-[#334155] rounded text-xs cursor-grab hover:border-[#3b82f6] transition-colors">
              <div className="font-medium text-[#f1f5f9]">{a.name}</div>
              <div className="text-[10px] text-[#64748b] truncate">{a.id}</div>
            </div>
          ))}
          {agents.length === 0 && <p className="text-[10px] text-[#475569]">无可用 Agent</p>}
        </div>

        {/* Canvas */}
        <div className="flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDragOver={onDragOver}
            onDrop={onDrop}
            fitView
            defaultEdgeOptions={{ animated: true, style: { stroke: '#3b82f6' } }}
            proOptions={{ hideAttribution: true }}
            style={{ background: '#0f172a' }}
          >
            <Controls className="!bg-[#1e293b] !border-[#334155] !shadow-none [&>button]:!bg-[#1e293b] [&>button]:!border-[#334155] [&>button]:!fill-[#94a3b8] [&>button:hover]:!bg-[#334155]" />
            <Background color="#334155" gap={20} size={1} />
          </ReactFlow>
        </div>
      </div>
    </div>
  )
}

// ─── Graph Viewer (read-only view of saved graph) ───

function GraphViewer({ graph, agents }: { graph: any; agents: any[] }) {
  const viewNodes: Node[] = useMemo(() =>
    (graph.nodes ?? []).map((n: any, i: number) => {
      const agent = agents.find((a: any) => a.id === n.agentId)
      return {
        id: n.id,
        type: 'agent',
        position: { x: 100 + (i % 3) * 200, y: 60 + Math.floor(i / 3) * 120 },
        data: { label: n.label || agent?.name || '?', agentName: agent?.name || '?', agentId: n.agentId },
      }
    }), [graph, agents])

  const viewEdges: Edge[] = useMemo(() =>
    (graph.edges ?? []).map((e: any, i: number) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      animated: true,
      style: { stroke: '#3b82f6' },
      label: e.condition || undefined,
      labelStyle: { fill: '#eab308', fontSize: 10 },
    })), [graph])

  return (
    <div className="h-64">
      <ReactFlow
        nodes={viewNodes}
        edges={viewEdges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        style={{ background: '#0f172a' }}
      >
        <Background color="#334155" gap={20} size={1} />
      </ReactFlow>
    </div>
  )
}

// ─── Main Page ───

export default function Graphs() {
  const [graphs, setGraphs] = useState<any[]>([])
  const [agents, setAgents] = useState<any[]>([])
  const [showEditor, setShowEditor] = useState(false)
  const [editingGraph, setEditingGraph] = useState<any>(null)
  const [selected, setSelected] = useState<any>(null)
  const [execInput, setExecInput] = useState('')
  const [execEvents, setExecEvents] = useState<any[]>([])
  const [executing, setExecuting] = useState(false)

  const load = () => {
    Promise.all([api.listGraphs(), api.listAgents()])
      .then(([g, a]) => { setGraphs(g); setAgents(a.filter((x: any) => x.state !== 'destroyed')) })
  }
  useEffect(() => { load() }, [])

  const handleSave = async (data: { name: string; description: string; nodes: any[]; edges: any[] }) => {
    if (editingGraph) {
      await api.modifyGraph(editingGraph.id, data)
    } else {
      await api.createGraph(data)
    }
    setShowEditor(false); setEditingGraph(null); load()
  }

  const startEdit = (g: any) => {
    setEditingGraph(g)
    setShowEditor(true)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除此 Graph?')) return
    await api.removeGraph(id)
    if (selected?.id === id) setSelected(null)
    load()
  }

  const handleExecute = async () => {
    if (!selected || !execInput.trim()) return
    setExecuting(true)
    setExecEvents([])
    try {
      for await (const event of api.executeGraph(selected.id, execInput)) {
        setExecEvents((prev) => [...prev, event])
      }
    } catch (err) {
      setExecEvents((prev) => [...prev, { type: 'node_error', error: String(err) }])
    } finally {
      setExecuting(false)
    }
  }

  if (showEditor) {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 px-6 py-3 border-b border-[#334155] flex items-center justify-between bg-[#1e293b]">
          <h2 className="text-sm font-bold">{editingGraph ? `编辑 Graph — ${editingGraph.name}` : 'Graph 编排 — 拖拽编辑器'}</h2>
          <button onClick={() => { setShowEditor(false); setEditingGraph(null) }}
            className="px-3 py-1 text-xs text-[#94a3b8] hover:text-[#f1f5f9] border border-[#475569] rounded transition-colors">
            返回列表
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <ReactFlowProvider>
            <GraphEditor agents={agents} onSave={handleSave} initial={editingGraph} />
          </ReactFlowProvider>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Agent Graph 编排</h2>
        <button onClick={() => { setShowEditor(true); setEditingGraph(null) }}
          className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] rounded-md text-sm transition-colors">
          + 创建 Graph
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Graph list */}
        <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
          <div className="px-4 py-3 border-b border-[#334155]">
            <p className="text-sm font-medium">Graph 列表</p>
          </div>
          {graphs.length === 0 ? (
            <p className="text-sm text-[#64748b] p-4">暂无 Graph</p>
          ) : (
            <div className="divide-y divide-[#334155]/50">
              {graphs.map((g) => (
                <div key={g.id} onClick={() => { setSelected(g); setExecEvents([]) }}
                  className={`p-3 cursor-pointer hover:bg-[#334155]/30 ${selected?.id === g.id ? 'bg-[#334155]/50' : ''}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium">{g.name}</span>
                      <span className="text-xs text-[#64748b] font-mono ml-2">{g.id}</span>
                    </div>
                    <div className="space-x-2">
                      <button onClick={(e) => { e.stopPropagation(); startEdit(g) }}
                        className="text-xs text-[#3b82f6] hover:text-[#60a5fa]">编辑</button>
                      <button onClick={(e) => { e.stopPropagation(); handleDelete(g.id) }}
                        className="text-xs text-red-400 hover:text-red-300">删除</button>
                    </div>
                  </div>
                  <p className="text-xs text-[#94a3b8] mt-0.5">{g.nodes?.length ?? 0} 节点, {g.edges?.length ?? 0} 连线</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Detail & execute panel */}
        <div className="bg-[#1e293b] rounded-lg border border-[#334155]">
          {!selected ? (
            <p className="text-sm text-[#64748b] p-4">选择一个 Graph 查看详情</p>
          ) : (
            <div className="space-y-0">
              <div className="px-4 py-3 border-b border-[#334155]">
                <h3 className="text-sm font-bold">{selected.name}</h3>
                {selected.description && <p className="text-xs text-[#94a3b8] mt-0.5">{selected.description}</p>}
              </div>

              {/* Visual preview */}
              <ReactFlowProvider>
                <GraphViewer graph={selected} agents={agents} />
              </ReactFlowProvider>

              {/* Execute */}
              <div className="p-4 border-t border-[#334155] space-y-2">
                <textarea value={execInput} onChange={(e) => setExecInput(e.target.value)}
                  placeholder="输入..." rows={2}
                  className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-sm focus:border-[#3b82f6] outline-none resize-none" />
                <button onClick={handleExecute} disabled={executing || !execInput.trim()}
                  className="px-3 py-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-40 rounded-md text-xs transition-colors">
                  {executing ? '执行中...' : '执行 Graph'}
                </button>
              </div>

              {/* Events */}
              {execEvents.length > 0 && (
                <div className="px-4 pb-4 space-y-1.5 max-h-60 overflow-auto">
                  {execEvents.map((ev, i) => (
                    <div key={i} className={`text-xs rounded p-2 ${
                      ev.type === 'node_complete' ? 'bg-green-500/10 border border-green-500/20' :
                      ev.type === 'node_error' ? 'bg-red-500/10 border border-red-500/20' :
                      ev.type === 'node_start' ? 'bg-blue-500/10 border border-blue-500/20' :
                      'bg-[#334155]'
                    }`}>
                      <span className="font-medium">
                        {ev.type === 'node_start' && `▶ ${ev.nodeLabel}`}
                        {ev.type === 'node_complete' && `✓ ${ev.nodeLabel}`}
                        {ev.type === 'node_error' && `✗ ${ev.nodeLabel ?? 'Error'}`}
                        {ev.type === 'graph_complete' && '✓ Graph 执行完成'}
                      </span>
                      {ev.output && <pre className="mt-1 text-[#94a3b8] whitespace-pre-wrap max-h-20 overflow-auto">{ev.output.slice(0, 500)}</pre>}
                      {ev.error && <p className="mt-1 text-red-400">{ev.error}</p>}
                      {ev.tokensUsed && <span className="text-[#64748b]"> ({ev.tokensUsed}t)</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
