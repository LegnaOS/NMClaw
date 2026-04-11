/**
 * B7: 钉钉适配器 — Stream 模式长连接（无需公网 URL）
 */
import { registerAdapter, processIncomingMessage } from '../channel-adapter.js'
import type { ChannelAdapter, IncomingMessage } from '../channel-adapter.js'
import type { ChannelConfig } from '../types.js'

export interface DingtalkChannelConfig {
  appKey: string
  appSecret: string
  robotCode: string
  mode?: 'stream' | 'webhook'
}

const activeConnections = new Map<string, { ws: any; status: 'connected' | 'disconnected' | 'error' }>()

async function getAccessToken(appKey: string, appSecret: string): Promise<string> {
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey, appSecret }),
  })
  const data = await res.json() as any
  if (!data.accessToken) throw new Error(`DingTalk token error: ${JSON.stringify(data)}`)
  return data.accessToken
}

async function registerStream(token: string): Promise<string> {
  const res = await fetch('https://api.dingtalk.com/v1.0/gateway/connections/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({ subscriptions: [{ type: 'EVENT', topic: '/v1.0/im/bot/messages/get' }] }),
  })
  const data = await res.json() as any
  return data.endpoint || ''
}

function splitMessage(text: string, limit: number = 20000): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  for (let i = 0; i < text.length; i += limit) parts.push(text.slice(i, i + limit))
  return parts
}

async function replyMessage(token: string, sessionWebhook: string, content: string): Promise<void> {
  for (const part of splitMessage(content)) {
    await fetch(sessionWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { title: '回复', text: part } }),
    })
  }
}

const dingtalkAdapter: ChannelAdapter = {
  type: 'dingtalk',

  async start(channelConfig: ChannelConfig): Promise<void> {
    const cfg = channelConfig.config as DingtalkChannelConfig
    if (!cfg.appKey || !cfg.appSecret) throw new Error('DingTalk: appKey and appSecret required')

    const token = await getAccessToken(cfg.appKey, cfg.appSecret)
    const endpoint = await registerStream(token)
    if (!endpoint) throw new Error('DingTalk: failed to get stream endpoint')

    const { WebSocket } = await import('ws')
    const ws = new WebSocket(endpoint)
    const state = { ws, status: 'disconnected' as 'connected' | 'disconnected' | 'error' }
    activeConnections.set(channelConfig.id, state)

    ws.on('open', () => {
      state.status = 'connected'
      console.log(`[dingtalk] connected: ${channelConfig.name}`)
    })

    ws.on('message', async (raw: Buffer) => {
      try {
        const envelope = JSON.parse(raw.toString())
        // 回复 ACK
        if (envelope.headers?.messageId) {
          ws.send(JSON.stringify({ code: 200, headers: { contentType: 'application/json', messageId: envelope.headers.messageId }, message: 'OK' }))
        }

        const data = typeof envelope.data === 'string' ? JSON.parse(envelope.data) : envelope.data
        if (!data?.text?.content) return

        const msg: IncomingMessage = {
          channelId: channelConfig.id,
          channelType: 'dingtalk',
          userId: data.senderStaffId || data.senderId || '',
          userName: data.senderNick || '',
          content: (data.text.content || '').trim(),
          messageId: data.msgId || envelope.headers?.messageId || String(Date.now()),
          conversationId: data.conversationId || '',
          isGroup: data.conversationType === '2',
          mentionedBot: true,
          timestamp: Date.now(),
        }

        const response = await processIncomingMessage(msg, channelConfig)
        if (!response) return

        if (data.sessionWebhook) {
          await replyMessage(token, data.sessionWebhook, response)
        }
      } catch (e) {
        console.error('[dingtalk] message error:', e)
      }
    })

    ws.on('close', () => {
      state.status = 'disconnected'
      // 自动重连
      setTimeout(() => {
        if (activeConnections.has(channelConfig.id)) {
          console.log('[dingtalk] reconnecting...')
          dingtalkAdapter.start(channelConfig).catch(e => console.error('[dingtalk] reconnect failed:', e))
        }
      }, 5000)
    })

    ws.on('error', (e: Error) => { state.status = 'error'; console.error('[dingtalk] ws error:', e.message) })
  },

  async stop(channelId: string): Promise<void> {
    const conn = activeConnections.get(channelId)
    if (conn) {
      try { conn.ws.close() } catch { /* */ }
      activeConnections.delete(channelId)
    }
  },

  getStatus(channelId: string): 'connected' | 'disconnected' | 'error' {
    return activeConnections.get(channelId)?.status || 'disconnected'
  },

  async sendMessage(channelId: string, userId: string, content: string): Promise<void> {
    const store = (await import('../store.js')).loadStore()
    const ch = ((store.channels || []) as ChannelConfig[]).find(c => c.id === channelId)
    if (!ch) return
    const cfg = ch.config as DingtalkChannelConfig
    const token = await getAccessToken(cfg.appKey, cfg.appSecret)
    await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ robotCode: cfg.robotCode, userIds: [userId], msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: '消息', text: content }) }),
    })
  },
}

registerAdapter('dingtalk', dingtalkAdapter)
