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

// ─── Custom Code Node ───

type CodeNodeData = { label: string; code: string }

const CodeNode = memo(({ data }: NodeProps<Node<CodeNodeData>>) => (
  <div className="bg-[#1e293b] border-2 border-[#eab308] rounded-lg px-4 py-3 min-w-[140px] shadow-lg shadow-yellow-500/10">
    <Handle type="target" position={Position.Top} className="!bg-[#eab308] !w-3 !h-3 !border-2 !border-[#0f172a]" />
    <div className="text-xs font-bold text-[#fbbf24]">⚡ {data.label || 'Code'}</div>
    <div className="text-[10px] text-[#94a3b8] mt-0.5 font-mono truncate max-w-[140px]">
      {data.code ? data.code.split('\n')[0].slice(0, 30) : '(空)'}
    </div>
    <Handle type="source" position={Position.Bottom} className="!bg-[#eab308] !w-3 !h-3 !border-2 !border-[#0f172a]" />
  </div>
))

const nodeTypes = { agent: AgentNode, code: CodeNode }

// ─── Code Editor Modal ───

function CodeEditorModal({ code, onSave, onClose }: { code: string; onSave: (c: string) => void; onClose: () => void }) {
  const [val, setVal] = useState(code)
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#1e293b] border border-[#334155] rounded-lg w-[500px] p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold">编辑 Code 节点</h3>
        <p className="text-[10px] text-[#64748b]">变量 input 为上游输出(string)，必须 return 结果</p>
        <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={10}
          className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-2 text-xs font-mono focus:border-[#eab308] outline-none resize-none" />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 text-xs text-[#94a3b8] border border-[#475569] rounded hover:text-[#f1f5f9]">取消</button>
          <button onClick={() => { onSave(val); onClose() }} className="px-3 py-1 text-xs bg-[#eab308] text-black rounded hover:bg-[#facc15]">保存</button>
        </div>
      </div>
    </div>
  )
}

// ─── Edge Condition Modal ───

function EdgeConditionModal({ condition, onSave, onClose }: { condition: string; onSave: (c: string) => void; onClose: () => void }) {
  const [val, setVal] = useState(condition)
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#1e293b] border border-[#334155] rounded-lg w-[400px] p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-bold">编辑连线条件</h3>
        <div className="text-[10px] text-[#64748b] space-y-1">
          <p>留空 = 无条件通过</p>
          <p>js:expression — JS 表达式，变量 output</p>
          <p>regex:/pattern/flags — 正则匹配</p>
          <p>contains:关键词 — 包含匹配</p>
          <p>else — 其他条件都不满足时激活</p>
        </div>
        <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="例: js:output.includes('是')"
          className="w-full bg-[#0f172a] border border-[#475569] rounded px-3 py-1.5 text-xs font-mono focus:border-[#3b82f6] outline-none" />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 text-xs text-[#94a3b8] border border-[#475569] rounded hover:text-[#f1f5f9]">取消</button>
          <button onClick={() => { onSave(val); onClose() }} className="px-3 py-1 text-xs bg-[#3b82f6] rounded hover:bg-[#2563eb]">保存</button>
        </div>
      </div>
    </div>
  )
}

// ─── Graph Editor (inner, needs ReactFlowProvider) ───

function GraphEditor({ agents, onSave, initial }: {
  agents: any[]
  onSave: (data: { name: string; description: string; nodes: any[]; edges: any[] }) => void
  initial?: { name: string; description: string; nodes: any[]; edges: any[] } | null
}) {
  const [nodes, setNodes] = useState<Node[]>(() => {
    if (!initial?.nodes) return []
    return initial.nodes.map((n: any, i: number) => {
      const isCode = n.type === 'code'
      const agent = !isCode ? agents.find((a: any) => a.id === n.agentId) : null
      return {
        id: n.id,
        type: isCode ? 'code' : 'agent',
        position: { x: 100 + (i % 3) * 200, y: 60 + Math.floor(i / 3) * 120 },
        data: isCode
          ? { label: n.label || 'Code', code: n.code || '' }
          : { label: n.label || agent?.name || '?', agentName: agent?.name || '?', agentId: n.agentId },
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
      style: { stroke: e.condition ? '#eab308' : '#3b82f6' },
      label: e.condition || undefined,
      labelStyle: { fill: '#eab308', fontSize: 10 },
      data: { condition: e.condition || '' },
    }))
  })
  const [name, setName] = useState(initial?.name ?? '')
  const [desc, setDesc] = useState(initial?.description ?? '')
  const { screenToFlowPosition } = useReactFlow()

  // Modal state
  const [editingCodeNodeId, setEditingCodeNodeId] = useState<string | null>(null)
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null)

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)), [],
  )
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)), [],
  )
  const onConnect: OnConnect = useCallback(
    (conn) => setEdges((eds) => addEdge({ ...conn, animated: true, style: { stroke: '#3b82f6' }, data: { condition: '' } }, eds)), [],
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const agentId = e.dataTransfer.getData('application/nmclaw-agent')
    const isCodeDrop = e.dataTransfer.getData('application/nmclaw-code')
    const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const id = `n_${Date.now()}`

    if (isCodeDrop) {
      setNodes((nds) => [...nds, {
        id,
        type: 'code',
        position,
        data: { label: 'Code', code: 'return input' },
      }])
      return
    }

    if (!agentId) return
    const agent = agents.find((a: any) => a.id === agentId)
    if (!agent) return
    setNodes((nds) => [...nds, {
      id,
      type: 'agent',
      position,
      data: { label: agent.name, agentName: agent.name, agentId: agent.id },
    }])
  }, [agents, screenToFlowPosition])

  const onNodeDoubleClick = useCallback((_: any, node: Node) => {
    if (node.type === 'code') setEditingCodeNodeId(node.id)
  }, [])

  const onEdgeClick = useCallback((_: any, edge: Edge) => {
    setEditingEdgeId(edge.id)
  }, [])

  const handleCodeSave = (code: string) => {
    if (!editingCodeNodeId) return
    setNodes((nds) => nds.map((n) =>
      n.id === editingCodeNodeId ? { ...n, data: { ...n.data, code } } : n
    ))
  }

  const handleConditionSave = (condition: string) => {
    if (!editingEdgeId) return
    setEdges((eds) => eds.map((e) =>
      e.id === editingEdgeId ? {
        ...e,
        data: { ...e.data, condition },
        label: condition || undefined,
        labelStyle: { fill: '#eab308', fontSize: 10 },
        style: { stroke: condition ? '#eab308' : '#3b82f6' },
      } : e
    ))
  }

  const handleSave = () => {
    if (!name.trim() || nodes.length === 0) return
    onSave({
      name: name.trim(),
      description: desc.trim(),
      nodes: nodes.map((n) => {
        if (n.type === 'code') {
          return { id: n.id, type: 'code', label: (n.data as CodeNodeData).label, code: (n.data as CodeNodeData).code }
        }
        return { id: n.id, type: 'agent', agentId: (n.data as AgentNodeData).agentId, label: (n.data as AgentNodeData).label }
      }),
      edges: edges.map((e) => ({ from: e.source, to: e.target, condition: (e.data as any)?.condition || '' })),
    })
    setNodes([])
    setEdges([])
    setName('')
    setDesc('')
  }

  const editingCodeNode = editingCodeNodeId ? nodes.find((n) => n.id === editingCodeNodeId) : null
  const editingEdge = editingEdgeId ? edges.find((e) => e.id === editingEdgeId) : null

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
        {/* Sidebar (drag source) */}
        <div className="w-40 shrink-0 border-r border-[#334155] bg-[#0f172a] p-2 overflow-auto">
          <p className="text-[10px] text-[#64748b] uppercase tracking-wide mb-2">Agent 节点</p>
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

          <p className="text-[10px] text-[#64748b] uppercase tracking-wide mt-3 mb-2">Code 节点</p>
          <div draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/nmclaw-code', '1')
              e.dataTransfer.effectAllowed = 'move'
            }}
            className="px-2 py-1.5 mb-1 bg-[#1e293b] border border-[#eab308]/50 rounded text-xs cursor-grab hover:border-[#eab308] transition-colors">
            <div className="font-medium text-[#fbbf24]">⚡ Code</div>
            <div className="text-[10px] text-[#64748b]">JS 转换节点</div>
          </div>

          <p className="text-[10px] text-[#475569] mt-3">双击 Code 节点编辑代码</p>
          <p className="text-[10px] text-[#475569]">单击连线编辑条件</p>
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
            onNodeDoubleClick={onNodeDoubleClick}
            onEdgeClick={onEdgeClick}
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

      {/* Code Editor Modal */}
      {editingCodeNode && (
        <CodeEditorModal
          code={(editingCodeNode.data as CodeNodeData).code || ''}
          onSave={handleCodeSave}
          onClose={() => setEditingCodeNodeId(null)}
        />
      )}

      {/* Edge Condition Modal */}
      {editingEdge && (
        <EdgeConditionModal
          condition={(editingEdge.data as any)?.condition || ''}
          onSave={handleConditionSave}
          onClose={() => setEditingEdgeId(null)}
        />
      )}
    </div>
  )
}

// ─── Graph Viewer (read-only view of saved graph) ───

function GraphViewer({ graph, agents }: { graph: any; agents: any[] }) {
  const viewNodes: Node[] = useMemo(() =>
    (graph.nodes ?? []).map((n: any, i: number) => {
      const isCode = n.type === 'code'
      const agent = !isCode ? agents.find((a: any) => a.id === n.agentId) : null
      return {
        id: n.id,
        type: isCode ? 'code' : 'agent',
        position: { x: 100 + (i % 3) * 200, y: 60 + Math.floor(i / 3) * 120 },
        data: isCode
          ? { label: n.label || 'Code', code: n.code || '' }
          : { label: n.label || agent?.name || '?', agentName: agent?.name || '?', agentId: n.agentId },
      }
    }), [graph, agents])

  const viewEdges: Edge[] = useMemo(() =>
    (graph.edges ?? []).map((e: any, i: number) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      animated: true,
      style: { stroke: e.condition ? '#eab308' : '#3b82f6' },
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
