import { loadStore, updateStore } from './store.js'
import { dispatch } from './genesis.js'

export interface CronJob {
  id: string
  name: string
  schedule: string  // cron expression: "*/5 * * * *"
  agentId: string
  prompt: string
  enabled: boolean
  lastRun?: number
  createdAt: number
}

let timer: ReturnType<typeof setInterval> | null = null

function parseCron(expr: string | undefined): { minute: number[]; hour: number[]; dom: number[]; month: number[]; dow: number[] } | null {
  if (!expr) return null
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const parse = (field: string, min: number, max: number): number[] => {
    if (field === '*') return Array.from({ length: max - min + 1 }, (_, i) => i + min)
    const vals: number[] = []
    for (const seg of field.split(',')) {
      const stepMatch = seg.match(/^(\*|\d+-\d+)\/(\d+)$/)
      if (stepMatch) {
        let start = min, end = max
        if (stepMatch[1] !== '*') {
          const [a, b] = stepMatch[1].split('-').map(Number)
          start = a; end = b
        }
        const step = parseInt(stepMatch[2])
        for (let i = start; i <= end; i += step) vals.push(i)
      } else if (seg.includes('-')) {
        const [a, b] = seg.split('-').map(Number)
        for (let i = a; i <= b; i++) vals.push(i)
      } else {
        vals.push(parseInt(seg))
      }
    }
    return vals.filter((v) => v >= min && v <= max)
  }
  try {
    return {
      minute: parse(parts[0], 0, 59),
      hour: parse(parts[1], 0, 23),
      dom: parse(parts[2], 1, 31),
      month: parse(parts[3], 1, 12),
      dow: parse(parts[4], 0, 6),
    }
  } catch { return null }
}

function shouldRun(job: CronJob, now: Date): boolean {
  const parsed = parseCron(job.schedule)
  if (!parsed) return false
  return (
    parsed.minute.includes(now.getMinutes()) &&
    parsed.hour.includes(now.getHours()) &&
    parsed.dom.includes(now.getDate()) &&
    parsed.month.includes(now.getMonth() + 1) &&
    parsed.dow.includes(now.getDay())
  )
}

async function tick() {
  const store = loadStore()
  const jobs: CronJob[] = (store as any).cronJobs || []
  const now = new Date()

  for (const job of jobs) {
    if (!job.enabled) continue
    if (job.lastRun && now.getTime() - job.lastRun < 55000) continue // debounce within same minute
    if (!shouldRun(job, now)) continue

    console.log(`[CRON] Running: ${job.name} → agent:${job.agentId}`)
    try {
      await dispatch(job.agentId, job.prompt)
    } catch (err) {
      console.error(`[CRON] Failed: ${job.name}:`, err)
    }
    updateStore((s) => {
      const jobs: CronJob[] = (s as any).cronJobs || []
      const j = jobs.find((j) => j.id === job.id)
      if (j) j.lastRun = now.getTime()
    })
  }
}

export function startCron() {
  if (timer) return
  timer = setInterval(tick, 60000) // check every minute
  console.log('✓ CRON 调度器已启动')
}

export function stopCron() {
  if (timer) { clearInterval(timer); timer = null }
}

export function listCronJobs(): CronJob[] {
  const store = loadStore()
  return (store as any).cronJobs || []
}

export function addCronJob(data: Omit<CronJob, 'id' | 'createdAt'>): CronJob {
  const job: CronJob = {
    ...data,
    id: `cron_${Date.now().toString(36)}`,
    createdAt: Date.now(),
  }
  updateStore((s) => {
    if (!(s as any).cronJobs) (s as any).cronJobs = []
    ;(s as any).cronJobs.push(job)
  })
  return job
}

export function removeCronJob(id: string): boolean {
  let found = false
  updateStore((s) => {
    const jobs: CronJob[] = (s as any).cronJobs || []
    const idx = jobs.findIndex((j) => j.id === id)
    if (idx >= 0) { jobs.splice(idx, 1); found = true }
  })
  return found
}

export function updateCronJob(id: string, data: Partial<Pick<CronJob, 'name' | 'schedule' | 'agentId' | 'prompt' | 'enabled'>>): CronJob | null {
  let result: CronJob | null = null
  updateStore((s) => {
    const jobs: CronJob[] = (s as any).cronJobs || []
    const j = jobs.find((j) => j.id === id)
    if (!j) return
    if (data.name != null) j.name = data.name
    if (data.schedule != null) j.schedule = data.schedule
    if (data.agentId != null) j.agentId = data.agentId
    if (data.prompt != null) j.prompt = data.prompt
    if (data.enabled != null) j.enabled = data.enabled
    result = { ...j }
  })
  return result
}

export function toggleCronJob(id: string, enabled: boolean): boolean {
  let found = false
  updateStore((s) => {
    const jobs: CronJob[] = (s as any).cronJobs || []
    const j = jobs.find((j) => j.id === id)
    if (j) { j.enabled = enabled; found = true }
  })
  return found
}
