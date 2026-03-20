import { nanoid } from 'nanoid'
import { updateStore, loadStore } from './store.js'
import type { TraceSpan, Task } from './types.js'

export function createTask(agentId: string, prompt: string): Task {
  const task: Task = {
    id: nanoid(12),
    agentId,
    prompt,
    status: 'pending',
    createdAt: Date.now(),
  }
  updateStore((s) => s.tasks.push(task))
  return task
}

export function updateTask(taskId: string, patch: Partial<Pick<Task, 'status' | 'output' | 'error' | 'tokensUsed' | 'completedAt'>>): void {
  updateStore((s) => {
    const task = s.tasks.find((t) => t.id === taskId)
    if (task) Object.assign(task, patch)
  })
}

export function addSpan(span: Omit<TraceSpan, 'spanId'>): TraceSpan {
  const full: TraceSpan = { spanId: nanoid(12), ...span }
  updateStore((s) => s.traces.push(full))
  return full
}

export function getTaskTrace(taskId: string): TraceSpan[] {
  return loadStore().traces.filter((t) => t.taskId === taskId)
}

export function listTasks(limit = 20): Task[] {
  return loadStore().tasks.slice(-limit)
}

export function getTask(taskId: string): Task | undefined {
  return loadStore().tasks.find((t) => t.id === taskId)
}

export function deleteTask(taskId: string): boolean {
  let found = false
  updateStore((s) => {
    const idx = s.tasks.findIndex((t) => t.id === taskId)
    if (idx >= 0) { s.tasks.splice(idx, 1); found = true }
    // Also remove associated traces
    s.traces = s.traces.filter((t) => t.taskId !== taskId)
  })
  return found
}
