import { nanoid } from 'nanoid'
import { loadStore, updateStore } from './store.js'
import type { ModelConfig, CostTier } from './types.js'

export function addModel(input: {
  name: string
  provider: string
  capabilities: string[]
  costTier: CostTier
  apiKeyEnv?: string
  baseUrl?: string
  defaultParams?: Record<string, unknown>
}): ModelConfig {
  const model: ModelConfig = {
    id: nanoid(12),
    name: input.name,
    provider: input.provider,
    capabilities: input.capabilities,
    costTier: input.costTier,
    config: {
      apiKeyEnv: input.apiKeyEnv,
      baseUrl: input.baseUrl,
      defaultParams: input.defaultParams,
    },
    createdAt: Date.now(),
  }
  updateStore((s) => s.models.push(model))
  return model
}

export function removeModel(id: string): boolean {
  let found = false
  updateStore((s) => {
    const idx = s.models.findIndex((m) => m.id === id)
    if (idx >= 0) {
      s.models.splice(idx, 1)
      found = true
    }
  })
  return found
}

export function listModels(): ModelConfig[] {
  return loadStore().models
}

export function getModel(id: string): ModelConfig | undefined {
  return loadStore().models.find((m) => m.id === id)
}

export function findModelsByCapability(cap: string): ModelConfig[] {
  return loadStore().models.filter((m) => m.capabilities.includes(cap))
}
