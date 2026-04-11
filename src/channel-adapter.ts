/**
 * B1: Channel Adapter — 统一渠道抽象层
 * 所有 IM 渠道通过此接口接入，标准化消息格式
 */
import { streamTask } from './executor.js'
import { loadStore } from './store.js'
import type { ChannelConfig, ChatMessage } from './types.js'

// ─── 标准化消息格式 ───

export interface IncomingMessage {
  channelId: string
  channelType: string
  userId: string
  userName?: string
  content: string
  messageId: string
  conversationId: string
  isGroup: boolean
  mentionedBot?: boolean
  timestamp: number
}

// ─── 渠道适配器接口 ───

export interface ChannelAdapter {
  readonly type: string
  start(config: ChannelConfig): Promise<void>
  stop(channelId: string): Promise<void>
  getStatus(channelId: string): 'connected' | 'disconnected' | 'error'
  sendMessage(channelId: string, userId: string, content: string, opts?: SendOpts): Promise<void>
}

export interface SendOpts {
  conversationId?: string
  replyToMessageId?: string
  format?: 'text' | 'markdown'
}

// ─── 适配器注册表 ───

const adapters = new Map<string, ChannelAdapter>()

export function registerAdapter(type: string, adapter: ChannelAdapter): void {
  adapters.set(type, adapter)
  console.log(`[channel] registered adapter: ${type}`)
}

export function getAdapter(type: string): ChannelAdapter | undefined {
  return adapters.get(type)
}

export function listAdapters(): string[] {
  return [...adapters.keys()]
}

// ─── 对话历史缓存（per channel+user） ───

const conversationCache = new Map<string, ChatMessage[]>()
const MAX_HISTORY = 20

function getConversationKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`
}

function getHistory(channelId: string, userId: string): ChatMessage[] {
  return conversationCache.get(getConversationKey(channelId, userId)) || []
}

function pushHistory(channelId: string, userId: string, userMsg: string, assistantMsg: string): void {
  const key = getConversationKey(channelId, userId)
  const history = conversationCache.get(key) || []
  history.push({ role: 'user', content: userMsg })
  history.push({ role: 'assistant', content: assistantMsg })
  // 保留最近 MAX_HISTORY 轮
  while (history.length > MAX_HISTORY * 2) {
    history.shift()
    history.shift()
  }
  conversationCache.set(key, history)
}

// ─── 统一消息处理入口 ───

export async function processIncomingMessage(
  msg: IncomingMessage,
  channel: ChannelConfig,
): Promise<string> {
  const adapter = adapters.get(channel.type)
  if (!adapter) throw new Error(`No adapter for channel type: ${channel.type}`)

  const agentId = channel.agentId || 'genesis'
  const history = getHistory(msg.channelId, msg.userId)
  const messages: ChatMessage[] = [
    ...history,
    { role: 'user', content: msg.content },
  ]

  const channelCtx = {
    channelId: msg.channelId,
    channelType: channel.type,
    channelName: channel.name,
    userId: msg.userId,
    userName: msg.userName,
  }

  // 收集流式响应
  let fullResponse = ''
  for await (const chunk of streamTask(agentId, messages, channelCtx)) {
    // 过滤掉元数据标记
    if (chunk.startsWith('[STREAM_META:') || chunk.startsWith('[TOOL_CALL:') ||
        chunk.startsWith('[TOOL_RESULT:') || chunk.startsWith('[FILE_OUTPUT:') ||
        chunk.startsWith('[DISPATCH_START:') || chunk.startsWith('[DISPATCH_END:')) {
      continue
    }
    fullResponse += chunk
  }

  const trimmed = fullResponse.trim()
  if (trimmed) {
    pushHistory(msg.channelId, msg.userId, msg.content, trimmed)
  }

  return trimmed
}

// ─── 启动所有已启用渠道 ───

export async function startAllChannels(): Promise<void> {
  const store = loadStore()
  const channels = (store.channels || []) as ChannelConfig[]
  for (const ch of channels) {
    if (!ch.enabled) continue
    const adapter = adapters.get(ch.type)
    if (!adapter) {
      console.log(`[channel] no adapter for ${ch.type}, skipping ${ch.name}`)
      continue
    }
    try {
      await adapter.start(ch)
      console.log(`[channel] started ${ch.type}:${ch.name}`)
    } catch (e) {
      console.error(`[channel] failed to start ${ch.type}:${ch.name}:`, e)
    }
  }
}

export async function stopAllChannels(): Promise<void> {
  const store = loadStore()
  const channels = (store.channels || []) as ChannelConfig[]
  for (const ch of channels) {
    const adapter = adapters.get(ch.type)
    if (adapter) {
      try { await adapter.stop(ch.id) } catch { /* */ }
    }
  }
}
