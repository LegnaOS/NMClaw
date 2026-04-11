/**
 * B6: 企业微信智能机器人适配器 — WebSocket 长连接模式
 *
 * 协议文档: https://developer.work.weixin.qq.com/document/path/99110
 * WebSocket 地址: wss://openws.work.weixin.qq.com
 * 认证: BotID + Secret → aibot_subscribe
 * 心跳: 30 秒 ping/pong
 * 消息: aibot_msg_callback → aibot_respond_msg (支持流式)
 * 事件: aibot_event_callback → aibot_respond_welcome_msg
 */
import { WebSocket } from 'ws'
import { nanoid } from 'nanoid'
import { registerAdapter, processIncomingMessage } from '../channel-adapter.js'
import type { ChannelAdapter, IncomingMessage } from '../channel-adapter.js'
import type { ChannelConfig } from '../types.js'

export interface WecomChannelConfig {
  botId: string
  secret: string
}

interface WecomConnection {
  ws: WebSocket
  status: 'connected' | 'disconnected' | 'error'
  heartbeatTimer?: ReturnType<typeof setInterval>
  channelConfig: ChannelConfig
}

const activeConnections = new Map<string, WecomConnection>()

// ─── 协议消息构造 ───

function makeReqId(): string { return nanoid(16) }

function subscribeMsg(botId: string, secret: string) {
  return JSON.stringify({
    cmd: 'aibot_subscribe',
    headers: { req_id: makeReqId() },
    body: { bot_id: botId, secret },
  })
}

function pingMsg() {
  return JSON.stringify({
    cmd: 'ping',
    headers: { req_id: makeReqId() },
  })
}

function streamResponseMsg(reqId: string, streamId: string, content: string, finish: boolean) {
  return JSON.stringify({
    cmd: 'aibot_respond_msg',
    headers: { req_id: reqId },
    body: {
      msgtype: 'stream',
      stream: { id: streamId, finish, content },
    },
  })
}

function welcomeMsg(reqId: string, content: string) {
  return JSON.stringify({
    cmd: 'aibot_respond_welcome_msg',
    headers: { req_id: reqId },
    body: { msgtype: 'text', text: { content } },
  })
}

function sendMsg(chatId: string, chatType: number, content: string) {
  return JSON.stringify({
    cmd: 'aibot_send_msg',
    headers: { req_id: makeReqId() },
    body: {
      chatid: chatId,
      chat_type: chatType,
      msgtype: 'markdown',
      markdown: { content },
    },
  })
}

// ─── 连接管理 ───

function startHeartbeat(conn: WecomConnection) {
  conn.heartbeatTimer = setInterval(() => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(pingMsg())
    }
  }, 30_000)
}

function stopHeartbeat(conn: WecomConnection) {
  if (conn.heartbeatTimer) {
    clearInterval(conn.heartbeatTimer)
    conn.heartbeatTimer = undefined
  }
}

async function connectWecom(channelConfig: ChannelConfig): Promise<void> {
  const cfg = channelConfig.config as WecomChannelConfig
  if (!cfg.botId || !cfg.secret) throw new Error('企业微信: 需要 Bot ID 和 Secret')

  // 清理旧连接
  const old = activeConnections.get(channelConfig.id)
  if (old) { stopHeartbeat(old); try { old.ws.close() } catch {} }

  const ws = new WebSocket('wss://openws.work.weixin.qq.com')
  const conn: WecomConnection = { ws, status: 'disconnected', channelConfig }
  activeConnections.set(channelConfig.id, conn)

  ws.on('open', () => {
    console.log(`[wecom] WebSocket connected, subscribing...`)
    ws.send(subscribeMsg(cfg.botId, cfg.secret))
  })

  ws.on('message', async (raw: Buffer) => {
    try {
      const data = JSON.parse(raw.toString())

      // 订阅响应
      if (data.errcode !== undefined && !data.cmd) {
        if (data.errcode === 0) {
          conn.status = 'connected'
          startHeartbeat(conn)
          console.log(`[wecom] subscribed: ${channelConfig.name}`)
        } else {
          conn.status = 'error'
          console.error(`[wecom] subscribe failed: ${data.errmsg}`)
        }
        return
      }

      // 心跳响应
      if (!data.cmd) return

      // 消息回调
      if (data.cmd === 'aibot_msg_callback') {
        const body = data.body
        const reqId = data.headers?.req_id
        if (!body?.text?.content || !reqId) return

        const msg: IncomingMessage = {
          channelId: channelConfig.id,
          channelType: 'wecom',
          userId: body.from?.userid || '',
          content: (body.text.content || '').replace(/@\S+\s*/g, '').trim(),
          messageId: body.msgid || makeReqId(),
          conversationId: body.chatid || body.from?.userid || '',
          isGroup: body.chattype === 'group',
          mentionedBot: true,
          timestamp: Date.now(),
        }

        // 流式回复
        const streamId = makeReqId()

        // 先发"思考中"
        ws.send(streamResponseMsg(reqId, streamId, '思考中...', false))

        const response = await processIncomingMessage(msg, channelConfig)
        if (response) {
          // 发送最终内容
          ws.send(streamResponseMsg(reqId, streamId, response, true))
        } else {
          ws.send(streamResponseMsg(reqId, streamId, '（无回复）', true))
        }
        return
      }

      // 事件回调
      if (data.cmd === 'aibot_event_callback') {
        const body = data.body
        const reqId = data.headers?.req_id
        const eventType = body?.event?.eventtype

        if (eventType === 'enter_chat' && reqId) {
          ws.send(welcomeMsg(reqId, '你好！我是 AI 助手，有什么可以帮你的吗？'))
        }
        if (eventType === 'disconnected_event') {
          console.log(`[wecom] disconnected by server (new connection established elsewhere)`)
          conn.status = 'disconnected'
        }
        return
      }
    } catch (e) {
      console.error('[wecom] message parse error:', e)
    }
  })

  ws.on('close', (code) => {
    conn.status = 'disconnected'
    stopHeartbeat(conn)
    console.log(`[wecom] connection closed (code: ${code})`)

    // 自动重连（非主动关闭）
    if (activeConnections.has(channelConfig.id)) {
      setTimeout(() => {
        if (activeConnections.has(channelConfig.id)) {
          console.log('[wecom] reconnecting...')
          connectWecom(channelConfig).catch(e => console.error('[wecom] reconnect failed:', e))
        }
      }, 5000)
    }
  })

  ws.on('error', (e) => {
    conn.status = 'error'
    console.error('[wecom] ws error:', e.message)
  })
}

// ─── Adapter ───

const wecomAdapter: ChannelAdapter = {
  type: 'wecom',

  async start(channelConfig: ChannelConfig): Promise<void> {
    await connectWecom(channelConfig)
  },

  async stop(channelId: string): Promise<void> {
    const conn = activeConnections.get(channelId)
    if (conn) {
      stopHeartbeat(conn)
      activeConnections.delete(channelId) // 先删除，防止触发自动重连
      try { conn.ws.close() } catch {}
    }
  },

  getStatus(channelId: string): 'connected' | 'disconnected' | 'error' {
    return activeConnections.get(channelId)?.status || 'disconnected'
  },

  async sendMessage(channelId: string, userId: string, content: string): Promise<void> {
    const conn = activeConnections.get(channelId)
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return
    // 单聊: chat_type=1, chatid=userid
    conn.ws.send(sendMsg(userId, 1, content))
  },
}

registerAdapter('wecom', wecomAdapter)
