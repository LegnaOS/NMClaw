import { nanoid } from 'nanoid'
import { loadStore, updateStore } from './store.js'
import { executeTask } from './executor.js'
import { getAgent } from './agent-manager.js'
import type { GraphConfig, GraphNode, GraphEdge, GraphExecutionEvent } from './types.js'

// ─── CRUD ───

export function createGraph(input: { name: string; description: string; nodes: GraphNode[]; edges: GraphEdge[] }): GraphConfig {
  const graph: GraphConfig = {
    id: nanoid(12),
    name: input.name,
    description: input.description,
    nodes: input.nodes.map((n) => ({ ...n, id: n.id || nanoid(8) })),
    edges: input.edges.map((e) => ({ ...e, id: e.id || nanoid(8) })),
    createdAt: Date.now(),
  }
  updateStore((s) => {
    s.graphs = s.graphs ?? []
    s.graphs.push(graph)
  })
  return graph
}

export function listGraphs(): GraphConfig[] {
  const store = loadStore()
  return store.graphs ?? []
}

export function getGraph(id: string): GraphConfig | undefined {
  return listGraphs().find((g) => g.id === id)
}

export function removeGraph(id: string): boolean {
  let found = false
  updateStore((s) => {
    s.graphs = s.graphs ?? []
    const idx = s.graphs.findIndex((g) => g.id === id)
    if (idx >= 0) { s.graphs.splice(idx, 1); found = true }
  })
  return found
}

export function modifyGraph(id: string, patch: Partial<Pick<GraphConfig, 'name' | 'description' | 'nodes' | 'edges'>>): boolean {
  let found = false
  updateStore((s) => {
    s.graphs = s.graphs ?? []
    const g = s.graphs.find((x) => x.id === id)
    if (g) { Object.assign(g, patch); found = true }
  })
  return found
}

// ─── Execution ───

function findStartNodes(graph: GraphConfig): string[] {
  const targets = new Set(graph.edges.map((e) => e.to))
  return graph.nodes.filter((n) => !targets.has(n.id)).map((n) => n.id)
}

function evaluateCondition(condition: string | undefined, output: string): boolean {
  if (!condition) return true
  // Simple keyword match: "contains:keyword" or plain keyword
  const lower = output.toLowerCase()
  if (condition.startsWith('contains:')) {
    return lower.includes(condition.slice(9).trim().toLowerCase())
  }
  return lower.includes(condition.toLowerCase())
}

export async function executeGraph(
  graphId: string,
  input: string,
  onEvent: (event: GraphExecutionEvent) => void,
): Promise<Map<string, string>> {
  const graph = getGraph(graphId)
  if (!graph) throw new Error(`Graph ${graphId} not found`)

  const results = new Map<string, string>()
  const executed = new Set<string>()

  // Topological execution
  const startNodes = findStartNodes(graph)
  if (startNodes.length === 0) throw new Error('Graph has no start nodes (cycle detected?)')

  const queue = [...startNodes]

  while (queue.length > 0) {
    const nodeId = queue.shift()!
    if (executed.has(nodeId)) continue

    // Check all incoming edges are satisfied
    const inEdges = graph.edges.filter((e) => e.to === nodeId)
    const ready = inEdges.every((e) => executed.has(e.from))
    if (!ready) { queue.push(nodeId); continue }

    const node = graph.nodes.find((n) => n.id === nodeId)
    if (!node) continue

    const agent = getAgent(node.agentId)
    if (!agent) {
      onEvent({ type: 'node_error', nodeId, nodeLabel: node.label, error: `Agent ${node.agentId} not found` })
      executed.add(nodeId)
      continue
    }

    // Build node input: original input + outputs from upstream nodes
    const upstreamOutputs = inEdges
      .map((e) => { const out = results.get(e.from); return out ? `[${e.from}]: ${out}` : '' })
      .filter(Boolean)
      .join('\n\n')

    const nodeInput = upstreamOutputs
      ? `${input}\n\n--- 上游节点输出 ---\n${upstreamOutputs}`
      : input

    onEvent({ type: 'node_start', nodeId, nodeLabel: node.label, agentId: node.agentId })

    try {
      const result = await executeTask(node.agentId, nodeInput)
      results.set(nodeId, result.content)
      executed.add(nodeId)

      onEvent({
        type: 'node_complete', nodeId, nodeLabel: node.label,
        agentId: node.agentId, output: result.content, tokensUsed: result.tokensUsed,
      })

      // Enqueue downstream nodes whose conditions are met
      const outEdges = graph.edges.filter((e) => e.from === nodeId)
      for (const edge of outEdges) {
        if (!executed.has(edge.to) && evaluateCondition(edge.condition, result.content)) {
          if (!queue.includes(edge.to)) queue.push(edge.to)
        }
      }
    } catch (err) {
      executed.add(nodeId)
      onEvent({ type: 'node_error', nodeId, nodeLabel: node.label, error: err instanceof Error ? err.message : String(err) })
    }
  }

  onEvent({ type: 'graph_complete' })
  return results
}
