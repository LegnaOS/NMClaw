/**
 * B6: 企业微信适配器 — WebSocket 长连接模式（无需公网 URL）
 */
import { registerAdapter, processIncomingMessage } from '../channel-adapter.js'
import type { ChannelAdapter, IncomingMessage } from '../channel-adapter.js'
import type { ChannelConfig } from '../types.js'

export interface WecomChannelConfig {
  corpId: string
  botId: string
  secret: string
}

const activeConnections = new Map<string, { ws: any; status: 'connected' | 'disconnected' | 'error' }>()

async function getAccessToken(corpId: string, secret: string): Promise<string> {
  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`)
  const data = await res.json() as any
  if (data.errcode !== 0) throw new Error(`WeChat Work token error: ${data.errmsg}`)
  return data.access_token
}

function splitMessage(text: string, limit: number = 2048): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  for (let i = 0; i < text.length; i += limit) parts.push(text.slice(i, i + limit))
  return parts
}

const wecomAdapter: ChannelAdapter = {
  type: 'wecom',

  async start(channelConfig: ChannelConfig): Promise<void> {
    const cfg = channelConfig.config as WecomChannelConfig
    if (!cfg.corpId || !cfg.secret) throw new Error('WeChat Work: corpId and secret required')

    const token = await getAccessToken(cfg.corpId, cfg.secret)

    // 获取 WebSocket 回调连接地址
    const callbackRes = await fetch('https://qyapi.weixin.qq.com/cgi-bin/callback/get_callback_url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    })

    // 企微 WebSocket 长连接
    const { WebSocket } = await import('ws')
    const wsUrl = `wss://open.work.weixin.qq.com/connect/bot/${cfg.botId}`
    const ws = new WebSocket(wsUrl)

    const state = { ws, status: 'disconnected' as 'connected' | 'disconnected' | 'error' }
    activeConnections.set(channelConfig.id, state)

    ws.on('open', () => {
      state.status = 'connected'
      console.log(`[wecom] connected: ${channelConfig.name}`)
    })

    ws.on('message', async (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString())
        if (data.MsgType !== 'text') return

        const msg: IncomingMessage = {
          channelId: channelConfig.id,
          channelType: 'wecom',
          userId: data.FromUserName || data.From || '',
          userName: data.FromUserName,
          content: data.Content || data.text?.content || '',
          messageId: data.MsgId || String(Date.now()),
          conversationId: data.FromUserName || '',
          isGroup: !!data.GroupId,
          timestamp: Date.now(),
        }

        const response = await processIncomingMessage(msg, channelConfig)
        if (!response) return

        // 通过 API 回复
        const replyToken = await getAccessToken(cfg.corpId, cfg.secret)
        for (const part of splitMessage(response)) {
          await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${replyToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              touser: msg.userId,
              msgtype: 'markdown',
              agentid: cfg.botId,
              markdown: { content: part },
            }),
          })
        }
      } catch (e) {
        console.error('[wecom] message error:', e)
      }
    })

    ws.on('close', () => { state.status = 'disconnected' })
    ws.on('error', (e: Error) => { state.status = 'error'; console.error('[wecom] ws error:', e.message) })
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
    const cfg = ch.config as WecomChannelConfig
    const token = await getAccessToken(cfg.corpId, cfg.secret)
    for (const part of splitMessage(content)) {
      await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touser: userId, msgtype: 'markdown', agentid: cfg.botId, markdown: { content: part } }),
      })
    }
  },
}

registerAdapter('wecom', wecomAdapter)
