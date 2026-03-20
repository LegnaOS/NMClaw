import { confirm } from '@inquirer/prompts'
import { loadStore } from './store.js'
import type { BypassConfig, CostTier, PermissionAction } from './types.js'

const COST_ORDER: CostTier[] = ['free', 'low', 'medium', 'high']

/**
 * Request user permission for an action.
 * Returns true if allowed (either bypassed or user confirmed).
 */
export async function requestPermission(
  action: PermissionAction,
  description: string,
  context?: { costTier?: CostTier; readOnly?: boolean }
): Promise<boolean> {
  const bypass = loadStore().bypass

  // Check bypass rules
  if (bypass.enabled && !bypass.neverBypass.includes(action)) {
    if (shouldBypass(bypass, action, context)) {
      return true
    }
  }

  // Ask user
  return confirm({
    message: `[权限请求] ${description}\n  操作: ${action}\n  确认执行?`,
    default: true,
  })
}

function shouldBypass(
  bypass: BypassConfig,
  action: PermissionAction,
  context?: { costTier?: CostTier; readOnly?: boolean }
): boolean {
  if (action === 'agent:create' && bypass.rules.autoCreateMaxCostTier && context?.costTier) {
    const maxIdx = COST_ORDER.indexOf(bypass.rules.autoCreateMaxCostTier)
    const curIdx = COST_ORDER.indexOf(context.costTier)
    return curIdx <= maxIdx
  }

  if (action === 'task:dispatch' && bypass.rules.autoDispatchReadOnly && context?.readOnly) {
    return true
  }

  return false
}
