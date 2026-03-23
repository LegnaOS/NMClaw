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
  const lower = output.toLowerCase()
  if (condition.startsWith('contains:')) {
    return lower.includes(condition.slice(9).trim().toLowerCase())
  }
  return lower.includes(condition.toLowerCase())
}

/** Build the prompt for a node based on its position in the DAG */
function buildNodeInput(
  originalInput: string,
  inEdges: GraphEdge[],
  results: Map<string, string>,
  nodeMap: Map<string, GraphNode>,
): string {
  // Start node: just the original input
  if (inEdges.length === 0) return originalInput

  // Collect upstream outputs with meaningful labels
  const upstreamParts = inEdges
    .map(e => {
      const label = nodeMap.get(e.from)?.label || e.from
      const out = results.get(e.from)
      return out ? `【${label}】的输出:\n${out}` : null
    })
    .filter(Boolean) as string[]

  if (upstreamParts.length === 0) return originalInput

  // Single upstream: output is the primary content
  if (upstreamParts.length === 1) {
    return `原始任务: ${originalInput}\n\n${upstreamParts[0]}\n\n请基于上游节点的输出继续处理。`
  }

  // Multiple upstream (aggregation): clearly separate each source
  return `原始任务: ${originalInput}\n\n以下是多个上游节点的输出，请综合处理:\n\n${upstreamParts.join('\n\n---\n\n')}`
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
  const failed = new Set<string>()
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]))
  const pending = new Set(graph.nodes.map(n => n.id))

  const startNodes = findStartNodes(graph)
  if (startNodes.length === 0) throw new Error('Graph has no start nodes (cycle detected?)')

  // Wave-based execution: each iteration finds all ready nodes and runs them in parallel
  while (pending.size > 0) {
    const ready: string[] = []
    for (const nodeId of pending) {
      const inEdges = graph.edges.filter(e => e.to === nodeId)
      // All predecessors must have finished (executed or failed)
      if (!inEdges.every(e => executed.has(e.from) || failed.has(e.from))) continue
      // At least one incoming edge must pass its condition (or no incoming edges)
      if (inEdges.length > 0) {
        const anyPass = inEdges.some(e => {
          const out = results.get(e.from)
          return out !== undefined && evaluateCondition(e.condition, out)
        })
        if (!anyPass) { pending.delete(nodeId); continue } // condition blocked, skip permanently
      }
      ready.push(nodeId)
    }

    if (ready.length === 0) break // no more nodes can run

    // Execute all ready nodes in parallel
    await Promise.all(ready.map(async (nodeId) => {
      pending.delete(nodeId)
      const node = nodeMap.get(nodeId)
      if (!node) { executed.add(nodeId); return }

      const agent = getAgent(node.agentId)
      if (!agent) {
        onEvent({ type: 'node_error', nodeId, nodeLabel: node.label, error: `Agent ${node.agentId} not found` })
        failed.add(nodeId)
        executed.add(nodeId)
        return
      }

      const inEdges = graph.edges.filter(e => e.to === nodeId)
      const nodeInput = buildNodeInput(input, inEdges, results, nodeMap)

      onEvent({ type: 'node_start', nodeId, nodeLabel: node.label, agentId: node.agentId })

      try {
        const result = await executeTask(node.agentId, nodeInput)
        results.set(nodeId, result.content)
        executed.add(nodeId)
        onEvent({
          type: 'node_complete', nodeId, nodeLabel: node.label,
          agentId: node.agentId, output: result.content, tokensUsed: result.tokensUsed,
        })
      } catch (err) {
        executed.add(nodeId)
        failed.add(nodeId)
        onEvent({ type: 'node_error', nodeId, nodeLabel: node.label, error: err instanceof Error ? err.message : String(err) })
      }
    }))
  }

  onEvent({ type: 'graph_complete' })
  return results
}
