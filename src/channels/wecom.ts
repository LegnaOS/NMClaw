/**
 * B6: 企业微信智能机器人适配器 — WebSocket 长连接模式
 *
 * 协议: wss://openws.work.weixin.qq.com
 * 认证: BotID + Secret → aibot_subscribe
 * 心跳: WebSocket ping frame (30s)
 * 消息: aibot_msg_callback → aibot_respond_msg
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
  intentionalClose: boolean  // 区分主动关闭和意外断开
}

const activeConnections = new Map<string, WecomConnection>()

function makeReqId(): string { return nanoid(16) }

// ─── 协议消息 ───

function subscribeMsg(botId: string, secret: string) {
  return JSON.stringify({
    cmd: 'aibot_subscribe',
    headers: { req_id: makeReqId() },
    body: { bot_id: botId, secret },
  })
}

function respondMsg(reqId: string, content: string) {
  return JSON.stringify({
    cmd: 'aibot_respond_msg',
    headers: { req_id: reqId },
    body: { msgtype: 'markdown', markdown: { content } },
  })
}

function welcomeMsg(reqId: string, content: string) {
  return JSON.stringify({
    cmd: 'aibot_respond_welcome_msg',
    headers: { req_id: reqId },
    body: { msgtype: 'text', text: { content } },
  })
}

// ─── 连接管理 ───

function startHeartbeat(conn: WecomConnection) {
  // 企微长连接用 WebSocket ping frame 保活
  conn.heartbeatTimer = setInterval(() => {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.ping()
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

  // 标记旧连接为主动关闭，防止触发重连
  const old = activeConnections.get(channelConfig.id)
  if (old) {
    old.intentionalClose = true
    stopHeartbeat(old)
    try { old.ws.close() } catch {}
  }

  const ws = new WebSocket('wss://openws.work.weixin.qq.com')
  const conn: WecomConnection = {
    ws, status: 'disconnected', channelConfig, intentionalClose: false,
  }
  activeConnections.set(channelConfig.id, conn)

  ws.on('open', () => {
    console.log(`[wecom] WebSocket connected, subscribing...`)
    ws.send(subscribeMsg(cfg.botId, cfg.secret))
  })

  ws.on('pong', () => {
    // 心跳响应正常，不需要处理
  })

  ws.on('message', async (raw: Buffer) => {
    try {
      const data = JSON.parse(raw.toString())
      console.log(`[wecom] recv:`, JSON.stringify(data).slice(0, 200))

      // 订阅响应（可能带 cmd 也可能不带）
      if (data.errcode !== undefined) {
        if (data.errcode === 0) {
          conn.status = 'connected'
          startHeartbeat(conn)
          console.log(`[wecom] subscribed OK: ${channelConfig.name}`)
        } else {
          conn.status = 'error'
          console.error(`[wecom] subscribe failed: errcode=${data.errcode} errmsg=${data.errmsg}`)
        }
        return
      }

      // 消息回调
      if (data.cmd === 'aibot_msg_callback') {
        const body = data.body
        const reqId = data.headers?.req_id
        if (!reqId) return

        // 提取消息内容（支持 text 和 markdown）
        const content = body?.text?.content || body?.markdown?.content || ''
        if (!content.trim()) return

        const msg: IncomingMessage = {
          channelId: channelConfig.id,
          channelType: 'wecom',
          userId: body.from?.userid || body.from?.user_id || '',
          userName: body.from?.name || '',
          content: content.replace(/@\S+\s*/g, '').trim(),
          messageId: body.msgid || makeReqId(),
          conversationId: body.chatid || body.from?.userid || '',
          isGroup: body.chattype === 'group',
          mentionedBot: true,
          timestamp: Date.now(),
        }

        try {
          const response = await processIncomingMessage(msg, channelConfig)
          if (response && ws.readyState === WebSocket.OPEN) {
            ws.send(respondMsg(reqId, response))
          }
        } catch (e) {
          console.error('[wecom] process error:', e)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(respondMsg(reqId, '处理消息时出错，请稍后重试'))
          }
        }
        return
      }

      // 事件回调
      if (data.cmd === 'aibot_event_callback') {
        const reqId = data.headers?.req_id
        const eventType = data.body?.event?.eventtype
        if (eventType === 'enter_chat' && reqId && ws.readyState === WebSocket.OPEN) {
          ws.send(welcomeMsg(reqId, '你好！有什么可以帮你的吗？'))
        }
        return
      }
    } catch (e) {
      console.error('[wecom] message parse error:', e)
    }
  })

  ws.on('close', (code) => {
    stopHeartbeat(conn)
    conn.status = 'disconnected'
    console.log(`[wecom] closed (code: ${code}, intentional: ${conn.intentionalClose})`)

    // 只在非主动关闭且仍在注册表中时重连
    if (!conn.intentionalClose && activeConnections.get(channelConfig.id) === conn) {
      const delay = 5000 + Math.random() * 5000  // 5-10 秒随机延迟
      console.log(`[wecom] will reconnect in ${(delay / 1000).toFixed(1)}s...`)
      setTimeout(() => {
        // 再次检查，防止在等待期间被 stop() 清理
        if (activeConnections.get(channelConfig.id) === conn) {
          connectWecom(channelConfig).catch(e => console.error('[wecom] reconnect failed:', e))
        }
      }, delay)
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
      conn.intentionalClose = true
      stopHeartbeat(conn)
      activeConnections.delete(channelId)
      try { conn.ws.close() } catch {}
    }
  },

  getStatus(channelId: string): 'connected' | 'disconnected' | 'error' {
    return activeConnections.get(channelId)?.status || 'disconnected'
  },

  async sendMessage(channelId: string, userId: string, content: string): Promise<void> {
    const conn = activeConnections.get(channelId)
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return
    conn.ws.send(JSON.stringify({
      cmd: 'aibot_send_msg',
      headers: { req_id: makeReqId() },
      body: { chatid: userId, chat_type: 1, msgtype: 'markdown', markdown: { content } },
    }))
  },
}

registerAdapter('wecom', wecomAdapter)
