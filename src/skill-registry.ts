import { nanoid } from 'nanoid'
import { loadStore, updateStore } from './store.js'
import type { SkillConfig } from './types.js'

export function addSkill(input: {
  name: string
  description: string
  promptTemplate: string
  requiredMcps?: string[]
  compatibleModels?: string[]
  inputSchema?: Record<string, unknown>
}): SkillConfig {
  const skill: SkillConfig = {
    id: nanoid(12),
    name: input.name,
    description: input.description,
    promptTemplate: input.promptTemplate,
    requiredMcps: input.requiredMcps ?? [],
    compatibleModels: input.compatibleModels ?? ['*'],
    inputSchema: input.inputSchema,
    createdAt: Date.now(),
  }
  updateStore((s) => {
    s.skills.push(skill)
    // Auto-bind to Genesis — 确保 Genesis 始终拥有最高权限
    const genesis = s.agents.find((a) => a.id === 'genesis')
    if (genesis && !genesis.skillIds.includes(skill.id)) {
      genesis.skillIds.push(skill.id)
    }
  })
  return skill
}

export function removeSkill(id: string): boolean {
  let found = false
  updateStore((s) => {
    const idx = s.skills.findIndex((sk) => sk.id === id)
    if (idx >= 0) {
      s.skills.splice(idx, 1)
      found = true
    }
  })
  return found
}

export function modifySkill(id: string, patch: Partial<Pick<SkillConfig, 'name' | 'description' | 'promptTemplate' | 'requiredMcps' | 'compatibleModels' | 'enabled'>>): boolean {
  let found = false
  updateStore((s) => {
    const sk = s.skills.find((x) => x.id === id)
    if (sk) { Object.assign(sk, patch); found = true }
  })
  return found
}

export function listSkills(): SkillConfig[] {
  return loadStore().skills
}

export function getSkill(id: string): SkillConfig | undefined {
  return loadStore().skills.find((sk) => sk.id === id)
}
