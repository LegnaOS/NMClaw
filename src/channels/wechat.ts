/**
 * B8: 微信公众号适配器 — 被动回复 + 客服消息异步回复
 */
import { createHash } from 'node:crypto'
import { registerAdapter, processIncomingMessage } from '../channel-adapter.js'
import type { ChannelAdapter, IncomingMessage } from '../channel-adapter.js'
import type { ChannelConfig } from '../types.js'

export interface WechatChannelConfig {
  appId: string
  appSecret: string
  token: string
  encodingAESKey?: string
  callbackUrl?: string
}

const activeChannels = new Map<string, { status: 'connected' | 'disconnected' | 'error' }>()
let tokenCache: { token: string; expiresAt: number } | null = null

async function getAccessToken(appId: string, appSecret: string): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token
  const res = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`)
  const data = await res.json() as any
  if (!data.access_token) throw new Error(`WeChat token error: ${JSON.stringify(data)}`)
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 }
  return data.access_token
}

function splitMessage(text: string, limit: number = 600): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  for (let i = 0; i < text.length; i += limit) parts.push(text.slice(i, i + limit))
  return parts
}

/** 验证微信签名 */
export function verifySignature(token: string, signature: string, timestamp: string, nonce: string): boolean {
  const arr = [token, timestamp, nonce].sort()
  const hash = createHash('sha1').update(arr.join('')).digest('hex')
  return hash === signature
}

/** 解析微信 XML 消息 */
export function parseWechatXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {}
  const regex = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>|<(\w+)>(.*?)<\/\3>/g
  let match
  while ((match = regex.exec(xml)) !== null) {
    const key = match[1] || match[3]
    const value = match[2] || match[4]
    if (key && value) result[key] = value
  }
  return result
}

/** 构建微信 XML 回复 */
export function buildReplyXml(toUser: string, fromUser: string, content: string): string {
  return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[${fromUser}]]></FromUserName>
<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`
}

/** 通过客服消息接口异步发送（突破 5 秒限制） */
async function sendCustomerMessage(appId: string, appSecret: string, userId: string, content: string): Promise<void> {
  const token = await getAccessToken(appId, appSecret)
  for (const part of splitMessage(content)) {
    await fetch(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: userId, msgtype: 'text', text: { content: part } }),
    })
  }
}

// 待处理消息队列（微信被动回复有 5 秒限制，超时用客服消息）
const pendingMessages = new Map<string, { channelConfig: ChannelConfig; msg: IncomingMessage }>()

/** 处理微信消息（由 server.ts 的 webhook 路由调用） */
export async function handleWechatMessage(channelConfig: ChannelConfig, xmlBody: string): Promise<string> {
  const data = parseWechatXml(xmlBody)
  if (data.MsgType !== 'text') return 'success'

  const msg: IncomingMessage = {
    channelId: channelConfig.id,
    channelType: 'wechat',
    userId: data.FromUserName || '',
    content: data.Content || '',
    messageId: data.MsgId || String(Date.now()),
    conversationId: data.FromUserName || '',
    isGroup: false,
    timestamp: Date.now(),
  }

  // 异步处理，先返回空回复（避免 5 秒超时）
  const cfg = channelConfig.config as WechatChannelConfig
  processIncomingMessage(msg, channelConfig).then(response => {
    if (response) {
      sendCustomerMessage(cfg.appId, cfg.appSecret, msg.userId, response).catch(e =>
        console.error('[wechat] send error:', e)
      )
    }
  }).catch(e => console.error('[wechat] process error:', e))

  return 'success'
}

const wechatAdapter: ChannelAdapter = {
  type: 'wechat',

  async start(channelConfig: ChannelConfig): Promise<void> {
    const cfg = channelConfig.config as WechatChannelConfig
    if (!cfg.appId || !cfg.appSecret || !cfg.token) {
      throw new Error('WeChat: appId, appSecret, and token required')
    }
    // 验证 token 有效性
    await getAccessToken(cfg.appId, cfg.appSecret)
    activeChannels.set(channelConfig.id, { status: 'connected' })
    console.log(`[wechat] ready: ${channelConfig.name} (webhook mode, waiting for messages)`)
  },

  async stop(channelId: string): Promise<void> {
    activeChannels.delete(channelId)
  },

  getStatus(channelId: string): 'connected' | 'disconnected' | 'error' {
    return activeChannels.get(channelId)?.status || 'disconnected'
  },

  async sendMessage(channelId: string, userId: string, content: string): Promise<void> {
    const store = (await import('../store.js')).loadStore()
    const ch = ((store.channels || []) as ChannelConfig[]).find(c => c.id === channelId)
    if (!ch) return
    const cfg = ch.config as WechatChannelConfig
    await sendCustomerMessage(cfg.appId, cfg.appSecret, userId, content)
  },
}

registerAdapter('wechat', wechatAdapter)
