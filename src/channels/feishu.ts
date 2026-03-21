import { createHmac, randomInt } from 'node:crypto'
import * as Lark from '@larksuiteoapi/node-sdk'
import { loadStore, updateStore } from '../store.js'
import { streamTask } from '../executor.js'
import type { ChannelConfig, FeishuChannelConfig, ChatMessage, PairingRecord } from '../types.js'

// ═══════════════════════════════════
//  Lark SDK Client Management
// ═══════════════════════════════════

const clientCache = new Map<string, Lark.Client>()
const wsClients = new Map<string, Lark.WSClient>()
const monitorAborts = new Map<string, AbortController>()
// 记录每个渠道最后一次通信的 chat_id，用于主动发送
const lastChatIds = new Map<string, string>()
// 记录每个渠道最后一次通信的发送者 open_id，用于授权云空间文件
const lastSenderIds = new Map<string, string>()

function resolveDomain(domain?: string): Lark.Domain | string {
  if (domain === 'lark') return Lark.Domain.Lark
  return Lark.Domain.Feishu
}

function resolveApiBase(domain?: string): string {
  if (domain === 'lark') return 'https://open.larksuite.com/open-apis'
  return 'https://open.feishu.cn/open-apis'
}

function getClient(cfg: FeishuChannelConfig): Lark.Client {
  const key = cfg.appId || 'default'
  const cached = clientCache.get(key)
  if (cached) return cached

  if (!cfg.appId || !cfg.appSecret) throw new Error('飞书 appId/appSecret 未配置')

  const client = new Lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(cfg.domain),
  })
  clientCache.set(key, client)
  return client
}

// ═══════════════════════════════════
//  Token Cache (for Card Kit API)
// ═══════════════════════════════════

const tokenCache = new Map<string, { token: string; expiresAt: number }>()

async function getTenantToken(cfg: FeishuChannelConfig): Promise<string> {
  const key = cfg.appId || 'default'
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const apiBase = resolveApiBase(cfg.domain)
  const res = await fetch(`${apiBase}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  })
  const data = await res.json() as any
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`飞书 token 获取失败: ${data.msg}`)
  }
  const token = data.tenant_access_token as string
  const expire = (data.expire as number) || 7200
  tokenCache.set(key, { token, expiresAt: Date.now() + (expire - 300) * 1000 })
  return token
}

// ═══════════════════════════════════
//  Streaming Card (Card Kit API)
// ═══════════════════════════════════

class StreamingCard {
  private cardId = ''
  private messageId = ''
  private sequence = 0
  private currentText = ''
  private closed = false
  private lastUpdateTime = 0
  private pendingText: string | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private cfg: FeishuChannelConfig,
    private client: Lark.Client,
  ) {}

  async start(chatId: string, replyToMessageId?: string): Promise<void> {
    const token = await getTenantToken(this.cfg)
    const apiBase = resolveApiBase(this.cfg.domain)

    // Create streaming card entity
    const cardJson = {
      schema: '2.0',
      config: {
        streaming_mode: true,
        summary: { content: '[生成中...]' },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 1 } },
      },
      body: {
        elements: [
          { tag: 'markdown', content: '⏳ 思考中...', element_id: 'content' },
        ],
      },
    }

    const createRes = await fetch(`${apiBase}/cardkit/v1/cards`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'card_json', data: JSON.stringify(cardJson) }),
    })
    const createData = await createRes.json() as any
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`创建卡片失败: ${createData.msg}`)
    }
    this.cardId = createData.data.card_id
    const cardContent = JSON.stringify({ type: 'card', data: { card_id: this.cardId } })

    // Send card as message
    let sendRes: any
    if (replyToMessageId) {
      sendRes = await this.client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { msg_type: 'interactive', content: cardContent },
      })
    } else {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: cardContent },
      })
    }
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`发送卡片失败: ${sendRes.msg}`)
    }
    this.messageId = sendRes.data.message_id
    this.sequence = 1
    console.log(`[feishu] 流式卡片已创建: cardId=${this.cardId}`)
  }

  async update(text: string): Promise<void> {
    if (this.closed || !this.cardId) return
    const merged = this.currentText + text
    if (merged === this.currentText) return

    // Throttle: max 10 updates/sec
    const now = Date.now()
    if (now - this.lastUpdateTime < 100) {
      this.pendingText = merged
      return
    }
    this.pendingText = null
    this.lastUpdateTime = now

    this.queue = this.queue.then(async () => {
      if (this.closed) return
      this.currentText = merged
      this.sequence += 1
      const token = await getTenantToken(this.cfg)
      const apiBase = resolveApiBase(this.cfg.domain)
      await fetch(`${apiBase}/cardkit/v1/cards/${this.cardId}/elements/content/content`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: this.currentText,
          sequence: this.sequence,
          uuid: `s_${this.cardId}_${this.sequence}`,
        }),
      }).catch((e) => console.error(`[feishu] 卡片更新失败:`, e))
    })
    await this.queue
  }

  async close(finalText?: string): Promise<void> {
    if (this.closed || !this.cardId) return
    this.closed = true
    await this.queue

    // Flush pending text
    const text = finalText || this.pendingText || this.currentText
    if (text && text !== this.currentText) {
      this.sequence += 1
      const token = await getTenantToken(this.cfg)
      const apiBase = resolveApiBase(this.cfg.domain)
      await fetch(`${apiBase}/cardkit/v1/cards/${this.cardId}/elements/content/content`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: text,
          sequence: this.sequence,
          uuid: `s_${this.cardId}_${this.sequence}`,
        }),
      }).catch(() => {})
    }

    // Close streaming mode
    this.sequence += 1
    const token = await getTenantToken(this.cfg)
    const apiBase = resolveApiBase(this.cfg.domain)
    const summary = (text || this.currentText).replace(/\n/g, ' ').trim().slice(0, 50)
    await fetch(`${apiBase}/cardkit/v1/cards/${this.cardId}/settings`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        settings: JSON.stringify({
          config: { streaming_mode: false, summary: { content: summary || '回复完成' } },
        }),
        sequence: this.sequence,
        uuid: `c_${this.cardId}_${this.sequence}`,
      }),
    }).catch((e) => console.error(`[feishu] 关闭流式卡片失败:`, e))

    console.log(`[feishu] 流式卡片已关闭: cardId=${this.cardId}`)
  }
}

// ═══════════════════════════════════
//  Channel Message Log (in-memory)
// ═══════════════════════════════════

export interface ChannelMessage {
  id: string
  conversationId: string  // channelId:senderId
  channelId: string
  channelName: string
  channelType: string
  senderId: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

const channelMessageLog: ChannelMessage[] = []
const MAX_CHANNEL_MESSAGES = 500

function recordChannelMessage(msg: Omit<ChannelMessage, 'id'>): void {
  channelMessageLog.push({ ...msg, id: `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` })
  if (channelMessageLog.length > MAX_CHANNEL_MESSAGES) {
    channelMessageLog.splice(0, channelMessageLog.length - MAX_CHANNEL_MESSAGES)
  }
  // Notify SSE subscribers
  for (const cb of channelMessageSubscribers) cb()
}

export function getChannelMessages(channelId?: string, limit = 50): ChannelMessage[] {
  const filtered = channelId ? channelMessageLog.filter(m => m.channelId === channelId) : channelMessageLog
  return filtered.slice(-limit)
}

export interface ChannelConversation {
  conversationId: string
  channelId: string
  channelName: string
  channelType: string
  senderId: string
  lastMessage: string
  lastActiveAt: number
  messageCount: number
}

export function getChannelConversations(): ChannelConversation[] {
  const map = new Map<string, ChannelConversation>()
  for (const msg of channelMessageLog) {
    const existing = map.get(msg.conversationId)
    if (!existing) {
      map.set(msg.conversationId, {
        conversationId: msg.conversationId,
        channelId: msg.channelId,
        channelName: msg.channelName,
        channelType: msg.channelType,
        senderId: msg.senderId,
        lastMessage: msg.content.slice(0, 80),
        lastActiveAt: msg.timestamp,
        messageCount: 1,
      })
    } else {
      existing.lastMessage = msg.content.slice(0, 80)
      existing.lastActiveAt = msg.timestamp
      existing.messageCount++
    }
  }
  return [...map.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

// SSE subscriber for real-time updates
const channelMessageSubscribers = new Set<() => void>()
export function subscribeChannelMessages(cb: () => void): () => void {
  channelMessageSubscribers.add(cb)
  return () => channelMessageSubscribers.delete(cb)
}

// ═══════════════════════════════════
//  Message Handling
// ═══════════════════════════════════

const processedEvents = new Set<string>()

function dedup(eventId: string): boolean {
  if (!eventId) return false
  if (processedEvents.has(eventId)) return true
  processedEvents.add(eventId)
  if (processedEvents.size > 1000) {
    const arr = [...processedEvents]
    for (let i = 0; i < arr.length - 500; i++) processedEvents.delete(arr[i])
  }
  return false
}

function stripBotMention(text: string): string {
  return text.replace(/@_user_\d+/g, '').trim()
}

// ═══════════════════════════════════
//  Access Control & Pairing
// ═══════════════════════════════════

function generatePairingCode(): string {
  return String(randomInt(100000, 999999))
}

function isUserAllowed(cfg: FeishuChannelConfig, userId: string): boolean {
  if (cfg.groupPolicy !== 'allowlist') return true
  return (cfg.allowedUsers || []).includes(userId)
}

function getPendingPairing(channelId: string, userId: string): PairingRecord | undefined {
  const store = loadStore()
  return (store.pairings || []).find(
    (p) => p.channelId === channelId && p.userId === userId && p.status === 'pending',
  )
}

function createPairing(channelId: string, userId: string, userName?: string): PairingRecord {
  const existing = getPendingPairing(channelId, userId)
  if (existing) return existing

  const record: PairingRecord = {
    code: generatePairingCode(),
    channelId,
    userId,
    userName,
    status: 'pending',
    createdAt: Date.now(),
  }
  updateStore((s) => {
    if (!s.pairings) s.pairings = []
    s.pairings.push(record)
  })
  return record
}

export function listPairings(channelId?: string): PairingRecord[] {
  const store = loadStore()
  const all = store.pairings || []
  return channelId ? all.filter((p) => p.channelId === channelId) : all
}

export function approvePairing(code: string): boolean {
  let approved = false
  let channelId = ''
  let userId = ''
  updateStore((s) => {
    const p = (s.pairings || []).find((r) => r.code === code && r.status === 'pending')
    if (!p) return
    p.status = 'approved'
    p.approvedAt = Date.now()
    channelId = p.channelId
    userId = p.userId
    approved = true
  })
  // Add user to channel's allowedUsers
  if (approved && channelId && userId) {
    updateStore((s) => {
      const ch = (s.channels || []).find((c) => c.id === channelId)
      if (!ch) return
      const cfg = ch.config as FeishuChannelConfig
      if (!cfg.allowedUsers) cfg.allowedUsers = []
      if (!cfg.allowedUsers.includes(userId)) cfg.allowedUsers.push(userId)
    })
  }
  return approved
}

export function rejectPairing(code: string): boolean {
  let rejected = false
  updateStore((s) => {
    const p = (s.pairings || []).find((r) => r.code === code && r.status === 'pending')
    if (!p) return
    p.status = 'rejected'
    rejected = true
  })
  return rejected
}

async function replyText(client: Lark.Client, messageId: string, text: string): Promise<void> {
  await client.im.message.reply({
    path: { message_id: messageId },
    data: { msg_type: 'text', content: JSON.stringify({ text }) },
  }).catch((e) => console.error(`[feishu] 回复失败:`, e))
}

/** Check access control, returns true if message should be processed */
async function checkAccess(
  channel: ChannelConfig,
  cfg: FeishuChannelConfig,
  messageId: string,
  senderId: string,
  senderName?: string,
): Promise<boolean> {
  if (cfg.groupPolicy !== 'allowlist') return true
  if (isUserAllowed(cfg, senderId)) return true

  // User not in allowlist — generate pairing code
  const client = getClient(cfg)
  const pairing = createPairing(channel.id, senderId, senderName)
  await replyText(client, messageId, [
    `🔐 你还未获得使用权限`,
    ``,
    `你的配对码: ${pairing.code}`,
    ``,
    `请将此配对码发送给管理员进行审批。`,
    `审批通过后即可正常对话。`,
  ].join('\n'))

  console.log(`[feishu] 未授权用户 ${senderId} 请求配对，code=${pairing.code}`)
  return false
}

async function processMessage(
  channel: ChannelConfig,
  cfg: FeishuChannelConfig,
  chatId: string,
  messageId: string,
  userText: string,
  senderId: string,
): Promise<void> {
  const useStreaming = cfg.streaming !== false && cfg.appId && cfg.appSecret
  const convId = `${channel.id}:${senderId}`
  const msgBase = { conversationId: convId, channelId: channel.id, channelName: channel.name, channelType: channel.type, senderId }

  // 记住最后一个 chat_id 和 sender_id，用于主动发送和云空间授权
  if (chatId) lastChatIds.set(channel.id, chatId)
  if (senderId) lastSenderIds.set(channel.id, senderId)

  // Record user message
  recordChannelMessage({ ...msgBase, role: 'user', content: userText, timestamp: Date.now() })

  // Build messages with conversation history
  const history = channelMessageLog
    .filter(m => m.conversationId === convId)
    .slice(-20) // keep last 20 messages for context
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  // history already includes the just-recorded user message
  const messages: ChatMessage[] = history

  if (useStreaming) {
    // Streaming card reply
    const client = getClient(cfg)
    const card = new StreamingCard(cfg, client)
    try {
      await card.start(chatId, messageId)
      let fullText = ''
      const channelCtx = { channelId: channel.id, channelName: channel.name, channelType: channel.type }
      for await (const chunk of streamTask(channel.agentId, messages, channelCtx)) {
        if (chunk.startsWith('[TOOL_CALL:') || chunk.startsWith('[TOOL_RESULT:') ||
            chunk.startsWith('[STREAM_META:') || chunk.startsWith('[FILE_OUTPUT:') ||
            chunk.startsWith('[AGENT_INFO:')) continue
        const clean = chunk.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        if (clean) {
          fullText += clean
          await card.update(clean)
        }
      }
      await card.close(fullText || '(无回复内容)')
      recordChannelMessage({ ...msgBase, role: 'assistant', content: fullText || '(无回复内容)', timestamp: Date.now() })
    } catch (err) {
      console.error(`[feishu] 流式回复失败:`, err)
      const errText = `处理失败: ${err instanceof Error ? err.message : err}`
      await card.close(errText)
      recordChannelMessage({ ...msgBase, role: 'assistant', content: errText, timestamp: Date.now() })
    }
  } else {
    // Fallback: collect full response then reply as text
    let fullResponse = ''
    try {
      const channelCtxFallback = { channelId: channel.id, channelName: channel.name, channelType: channel.type }
      for await (const chunk of streamTask(channel.agentId, messages, channelCtxFallback)) {
        if (chunk.startsWith('[TOOL_CALL:') || chunk.startsWith('[TOOL_RESULT:') ||
            chunk.startsWith('[STREAM_META:') || chunk.startsWith('[FILE_OUTPUT:') ||
            chunk.startsWith('[AGENT_INFO:')) continue
        fullResponse += chunk
      }
    } catch (err) {
      fullResponse = `处理失败: ${err instanceof Error ? err.message : err}`
    }
    fullResponse = fullResponse.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
    if (!fullResponse) fullResponse = '(无回复内容)'

    // Reply via SDK
    if (cfg.appId && cfg.appSecret) {
      const client = getClient(cfg)
      await client.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text: fullResponse }) },
      }).catch((e) => console.error(`[feishu] 回复失败:`, e))
    }
    recordChannelMessage({ ...msgBase, role: 'assistant', content: fullResponse, timestamp: Date.now() })
  }
}

// ═══════════════════════════════════
//  WebSocket Monitor (Lark SDK)
// ═══════════════════════════════════

/** Pre-flight check: call the WS endpoint directly to get the real error message */
async function preflightWsCheck(cfg: FeishuChannelConfig): Promise<{ ok: boolean; code?: number; msg?: string }> {
  const domain = cfg.domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
  const url = `${domain}/callback/ws/endpoint`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', locale: 'zh' },
      body: JSON.stringify({ AppID: cfg.appId, AppSecret: cfg.appSecret }),
    })
    const json = await res.json() as any
    if (json.code !== 0) {
      console.error(`[feishu-ws] 预检失败: code=${json.code}, msg=${json.msg}`)
      return { ok: false, code: json.code, msg: json.msg }
    }
    console.log(`[feishu-ws] 预检通过，WebSocket URL 已获取`)
    return { ok: true }
  } catch (err) {
    console.error(`[feishu-ws] 预检请求异常:`, err)
    return { ok: false, msg: err instanceof Error ? err.message : String(err) }
  }
}

export async function startFeishuMonitor(channel: ChannelConfig): Promise<{ ok: boolean; error?: string }> {
  const cfg = channel.config as FeishuChannelConfig
  if (cfg.mode !== 'websocket' || !cfg.appId || !cfg.appSecret) {
    const msg = `渠道 ${channel.name} 不是 WebSocket 模式或缺少凭证，跳过`
    console.warn(`[feishu] ${msg}`)
    return { ok: false, error: msg }
  }

  // Stop existing monitor if any
  stopFeishuMonitor(channel.id)

  // Pre-flight check to get real error messages
  const check = await preflightWsCheck(cfg)
  if (!check.ok) {
    const hint = check.code === 1000040350
      ? '已达连接上限，请先断开其他使用相同 App 的 WebSocket 连接（如 OpenClaw）'
      : check.code === 1000040345
        ? '连接被拒绝。请确认：1) 飞书开发者后台已开启「使用长连接接收事件」 2) 没有其他程序正在使用相同 App 的 WebSocket 连接'
        : `飞书返回错误 code=${check.code}`
    const error = `${hint}（原始消息: ${check.msg || '无'}）`
    console.error(`[feishu-ws] ${error}`)
    return { ok: false, error }
  }

  const abort = new AbortController()
  monitorAborts.set(channel.id, abort)

  const eventDispatcher = new Lark.EventDispatcher({
    encryptKey: cfg.encryptKey,
    verificationToken: cfg.verificationToken,
  })

  // Register message event handler
  eventDispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      try {
        const event = data as any

        const message = event?.message || event?.event?.message
        if (!message) return

        // Dedup by message_id (most reliable) then event_id as fallback
        const messageId = message.message_id || ''
        const eventId = data?.event_id || data?.header?.event_id || messageId
        if (dedup(eventId || messageId)) return

        // Only handle text messages for now
        if (message.message_type !== 'text') return

        let userText = ''
        try {
          const content = JSON.parse(message.content)
          userText = content.text || ''
        } catch { return }

        userText = stripBotMention(userText)
        if (!userText) return

        const chatId = message.chat_id || ''
        const sender = event?.sender?.sender_id?.open_id || 'unknown'
        const chatType = message.chat_type || '' // 'p2p' or 'group'

        console.log(`[feishu-ws] 收到消息 from=${sender} chat=${chatType} msgId=${messageId}: ${userText.slice(0, 100)}`)

        // requireMention: in group chats, skip if bot not mentioned
        if (cfg.requireMention && chatType === 'group') {
          const rawContent = message.content || ''
          if (!rawContent.includes('@_user_')) {
            return // not mentioned, ignore
          }
        }

        // Access control check
        const allowed = await checkAccess(channel, cfg, messageId, sender)
        if (!allowed) return

        // Process async
        processMessage(channel, cfg, chatId, messageId, userText, sender).catch((err) => {
          console.error(`[feishu-ws] 处理消息失败:`, err)
        })
      } catch (err) {
        console.error(`[feishu-ws] 事件处理异常:`, err)
      }
    },
  })

  // Start WebSocket connection
  const wsClient = new Lark.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: resolveDomain(cfg.domain),
    loggerLevel: Lark.LoggerLevel.info,
  })

  wsClients.set(channel.id, wsClient)
  wsClient.start({ eventDispatcher })
  console.log(`[feishu-ws] 渠道 "${channel.name}" WebSocket 已启动`)
  return { ok: true }
}

export function stopFeishuMonitor(channelId: string): void {
  const abort = monitorAborts.get(channelId)
  if (abort) {
    abort.abort()
    monitorAborts.delete(channelId)
  }
  wsClients.delete(channelId)
  console.log(`[feishu-ws] 渠道 ${channelId} 已停止`)
}

/** Start all enabled WebSocket channels on server boot */
export async function startAllFeishuMonitors(): Promise<void> {
  const channels = listChannels().filter(
    (c) => c.enabled && c.type === 'feishu' && (c.config as FeishuChannelConfig).mode === 'websocket',
  )
  for (const ch of channels) {
    try {
      const result = await startFeishuMonitor(ch)
      if (!result.ok) console.error(`[feishu] 启动渠道 "${ch.name}" 失败: ${result.error}`)
    } catch (err) {
      console.error(`[feishu] 启动渠道 "${ch.name}" 异常:`, err)
    }
  }
  if (channels.length > 0) {
    console.log(`[feishu] 已处理 ${channels.length} 个 WebSocket 渠道`)
  }
}

// ═══════════════════════════════════
//  Webhook (send-only, kept for backward compat)
// ═══════════════════════════════════

function genWebhookSign(secret: string, timestamp: string): string {
  const str = `${timestamp}\n${secret}`
  return createHmac('sha256', str).update('').digest('base64')
}

export async function sendWebhookMessage(channel: ChannelConfig, text: string): Promise<void> {
  const cfg = channel.config as FeishuChannelConfig
  if (!cfg.webhookUrl) throw new Error('webhookUrl 未配置')

  const body: any = { msg_type: 'text', content: { text } }
  if (cfg.webhookSecret) {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    body.timestamp = timestamp
    body.sign = genWebhookSign(cfg.webhookSecret, timestamp)
  }

  const res = await fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json() as any
  if (data.code !== 0 && data.StatusCode !== 0) {
    console.error(`[feishu-webhook] 发送失败:`, data)
  }
}

// ═══════════════════════════════════
//  Legacy webhook callback (backward compat for mode=app)
// ═══════════════════════════════════

export async function handleFeishuEvent(channelId: string, body: any): Promise<any> {
  if (body.type === 'url_verification') return { challenge: body.challenge }

  const store = loadStore()
  const channel = (store.channels || []).find((c) => c.id === channelId)
  if (!channel || !channel.enabled) return { code: 0 }

  const cfg = channel.config as FeishuChannelConfig
  const header = body.header
  const event = body.event
  if (!header || !event) return { code: 0 }

  const eventId = header.event_id
  if (dedup(eventId)) return { code: 0 }
  if (header.event_type !== 'im.message.receive_v1') return { code: 0 }

  const message = event.message
  if (!message || message.message_type !== 'text') return { code: 0 }

  let userText = ''
  try {
    const content = JSON.parse(message.content)
    userText = content.text || ''
  } catch { return { code: 0 } }

  userText = stripBotMention(userText)
  if (!userText) return { code: 0 }

  const chatId = message.chat_id || ''
  const messageId = message.message_id
  const sender = event.sender?.sender_id?.open_id || 'unknown'
  console.log(`[feishu-callback] 收到消息 from=${sender}: ${userText.slice(0, 100)}`)

  processMessage(channel, cfg, chatId, messageId, userText, sender).catch((err) => {
    console.error(`[feishu-callback] 处理消息失败:`, err)
  })

  return { code: 0 }
}

// ═══════════════════════════════════
//  Channel CRUD
// ═══════════════════════════════════

export function listChannels(): ChannelConfig[] {
  const store = loadStore()
  return store.channels || []
}

export function getChannel(id: string): ChannelConfig | undefined {
  return listChannels().find((c) => c.id === id)
}

export function addChannel(data: Omit<ChannelConfig, 'id' | 'createdAt'>): ChannelConfig {
  const channel: ChannelConfig = {
    ...data,
    id: `ch_${Date.now().toString(36)}`,
    createdAt: Date.now(),
  }
  updateStore((s) => {
    if (!s.channels) s.channels = []
    s.channels.push(channel)
  })

  // Auto-start WebSocket monitor if enabled
  const cfg = channel.config as FeishuChannelConfig
  if (channel.enabled && channel.type === 'feishu' && cfg.mode === 'websocket') {
    startFeishuMonitor(channel).catch((e) => console.error(`[feishu] 自动启动失败:`, e))
  }

  return channel
}

export function modifyChannel(id: string, data: Partial<Omit<ChannelConfig, 'id' | 'createdAt'>>): ChannelConfig | null {
  let result: ChannelConfig | null = null
  updateStore((s) => {
    const ch = (s.channels || []).find((c) => c.id === id)
    if (!ch) return
    if (data.name != null) ch.name = data.name
    if (data.type != null) ch.type = data.type
    if (data.enabled != null) ch.enabled = data.enabled
    if (data.agentId != null) ch.agentId = data.agentId
    if (data.config != null) ch.config = data.config
    result = { ...ch }
  })

  // Restart or stop monitor based on new state
  if (result) {
    const ch = result as ChannelConfig
    const cfg = ch.config as FeishuChannelConfig
    if (ch.type === 'feishu' && cfg.mode === 'websocket') {
      if (ch.enabled) {
        startFeishuMonitor(ch).catch((e) => console.error(`[feishu] 重启失败:`, e))
      } else {
        stopFeishuMonitor(ch.id)
      }
    }
  }

  return result
}

export function removeChannel(id: string): boolean {
  stopFeishuMonitor(id)
  let found = false
  updateStore((s) => {
    const channels = s.channels || []
    const idx = channels.findIndex((c) => c.id === id)
    if (idx >= 0) { channels.splice(idx, 1); found = true }
  })
  return found
}

// ═══════════════════════════════════
//  Send to channel (cron, platform tools, etc.)
// ═══════════════════════════════════

export async function sendToChannel(channelId: string, text: string): Promise<void> {
  const channel = getChannel(channelId)
  if (!channel) throw new Error(`Channel ${channelId} not found`)

  const cfg = channel.config as FeishuChannelConfig

  if (channel.type === 'feishu') {
    if (cfg.mode === 'webhook' && cfg.webhookUrl) {
      await sendWebhookMessage(channel, text)
    } else if (cfg.appId && cfg.appSecret) {
      // WebSocket/App mode: can't send proactively without a chat_id
      // TODO: store last chat_id per channel for proactive messaging
      console.warn(`[feishu] WebSocket 模式主动发送需要 chat_id，暂不支持`)
    }
  }
}

/** Get monitor status for a channel */
export function getFeishuMonitorStatus(channelId: string): 'running' | 'stopped' {
  return wsClients.has(channelId) ? 'running' : 'stopped'
}


// ═══════════════════════════════════
//  Send file to channel
// ═══════════════════════════════════

export async function sendFileToChannel(channelId: string, filePath: string): Promise<string> {
  const fs = await import('node:fs')
  const path = await import('node:path')

  const channel = getChannel(channelId)
  if (!channel) throw new Error(`渠道 ${channelId} 不存在`)

  const cfg = channel.config as FeishuChannelConfig
  if (!cfg.appId || !cfg.appSecret) throw new Error('飞书 appId/appSecret 未配置，无法发送文件')

  const chatId = lastChatIds.get(channelId)
  if (!chatId) throw new Error('该渠道尚无对话记录，无法确定发送目标。请先在飞书中与机器人对话后再尝试发送文件。')

  const absPath = path.resolve(filePath)
  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${absPath}`)
  const stat = fs.statSync(absPath)
  if (stat.isDirectory()) throw new Error('不支持发送目录，请指定文件路径')

  const fileName = path.basename(absPath)
  const fileSizeMB = (stat.size / 1024 / 1024).toFixed(1)
  const IM_FILE_LIMIT = 30 * 1024 * 1024 // 飞书 im.file.create 限制 30MB

  const senderId = lastSenderIds.get(channelId)

  if (stat.size <= IM_FILE_LIMIT) {
    // ── 小文件：IM 直传 ──
    return await sendFileViaIM(cfg, channel, chatId, absPath, fileName, fileSizeMB)
  } else {
    // ── 大文件：云空间分片上传 → 授权 → 发消息通知 ──
    return await sendFileViaDrive(cfg, channel, chatId, absPath, fileName, fileSizeMB, stat.size, senderId)
  }
}

/** ≤30MB: 通过 IM 文件接口直接发送 */
async function sendFileViaIM(
  cfg: FeishuChannelConfig, channel: ChannelConfig, chatId: string,
  absPath: string, fileName: string, fileSizeMB: string,
): Promise<string> {
  const fs = await import('node:fs')
  const client = getClient(cfg)
  console.log(`[feishu] IM 直传: ${fileName} (${fileSizeMB}MB) → ${channel.name}`)

  const fileStream = fs.createReadStream(absPath)
  const uploadRes = await client.im.file.create({
    data: { file_type: 'stream', file_name: fileName, file: fileStream },
  }) as any

  if (uploadRes.code !== 0 || !uploadRes.data?.file_key) {
    throw new Error(`文件上传失败: ${uploadRes.msg || '未知错误'}`)
  }

  const sendRes = await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: uploadRes.data.file_key }),
    },
  }) as any

  if (sendRes.code !== 0) {
    throw new Error(`文件消息发送失败: ${sendRes.msg || '未知错误'}`)
  }
  return `文件 "${fileName}" (${fileSizeMB}MB) 已通过渠道 "${channel.name}" 发送成功`
}

/** >30MB: 分片上传到云空间，授权给用户，然后发消息通知 */
async function sendFileViaDrive(
  cfg: FeishuChannelConfig, _channel: ChannelConfig, chatId: string,
  absPath: string, fileName: string, fileSizeMB: string, fileSize: number,
  senderId?: string,
): Promise<string> {
  const fs = await import('node:fs')

  const apiBase = resolveApiBase(cfg.domain)
  const token = await getTenantToken(cfg)
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }

  // 自动获取云空间根文件夹 token（如果未手动配置）
  let folderToken = cfg.driveFolderToken
  if (!folderToken) {
    console.log(`[feishu] driveFolderToken 未配置，自动获取根文件夹...`)
    const rootRes = await fetch(`${apiBase}/drive/explorer/v2/root_folder/meta`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const rootData = await rootRes.json() as any
    if (rootData.code !== 0 || !rootData.data?.token) {
      throw new Error(
        `无法获取云空间根文件夹: code=${rootData.code}, msg=${rootData.msg}。` +
        `请确保应用已开启 drive:drive 权限，或在渠道配置中手动填写 driveFolderToken。`,
      )
    }
    folderToken = rootData.data.token as string
    console.log(`[feishu] 根文件夹 token: ${folderToken}`)
  }

  console.log(`[feishu] 大文件分片上传: ${fileName} (${fileSizeMB}MB) → 云空间 ${folderToken}`)

  // Step 1: 预上传 — 获取 upload_id 和分片策略
  const prepRes = await fetch(`${apiBase}/drive/v1/files/upload_prepare`, {
    method: 'POST', headers,
    body: JSON.stringify({
      file_name: fileName,
      parent_type: 'explorer',
      parent_node: folderToken,
      size: fileSize,
    }),
  })
  const prepData = await prepRes.json() as any
  if (prepData.code !== 0) {
    throw new Error(`分片预上传失败: code=${prepData.code}, msg=${prepData.msg}`)
  }
  const { upload_id, block_size, block_num } = prepData.data
  console.log(`[feishu] 预上传成功: upload_id=${upload_id}, block_size=${block_size}, block_num=${block_num}`)

  // Step 2: 逐片上传
  const fd = fs.openSync(absPath, 'r')
  try {
    for (let seq = 0; seq < block_num; seq++) {
      const offset = seq * block_size
      const chunkSize = Math.min(block_size, fileSize - offset)
      const buf = Buffer.alloc(chunkSize)
      fs.readSync(fd, buf, 0, chunkSize, offset)

      const formData = new FormData()
      formData.append('upload_id', upload_id)
      formData.append('seq', String(seq))
      formData.append('size', String(chunkSize))
      formData.append('file', new Blob([buf]), fileName)

      console.log(`[feishu] 上传分片 ${seq + 1}/${block_num} (${(chunkSize / 1024 / 1024).toFixed(1)}MB)`)

      const partRes = await fetch(`${apiBase}/drive/v1/files/upload_part`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      })
      const partData = await partRes.json() as any
      if (partData.code !== 0) {
        throw new Error(`分片 ${seq} 上传失败: code=${partData.code}, msg=${partData.msg}`)
      }
    }
  } finally {
    fs.closeSync(fd)
  }

  // Step 3: 完成上传
  const finishRes = await fetch(`${apiBase}/drive/v1/files/upload_finish`, {
    method: 'POST', headers,
    body: JSON.stringify({ upload_id, block_num }),
  })
  const finishData = await finishRes.json() as any
  if (finishData.code !== 0) {
    throw new Error(`分片上传完成失败: code=${finishData.code}, msg=${finishData.msg}`)
  }
  const fileToken = finishData.data?.file_token
  console.log(`[feishu] 云空间上传完成: file_token=${fileToken}`)

  // Step 4: 授权给发送者（open_id）— 否则用户无法访问应用上传的文件
  if (senderId && fileToken) {
    try {
      const permRes = await fetch(`${apiBase}/drive/v1/permissions/${fileToken}/members?type=file`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          member_type: 'openid',
          member_id: senderId,
          perm: 'view',
        }),
      })
      const permData = await permRes.json() as any
      if (permData.code === 0) {
        console.log(`[feishu] 已授权用户 ${senderId} 查看文件 ${fileToken}`)
      } else {
        console.warn(`[feishu] 授权失败: code=${permData.code}, msg=${permData.msg}`)
      }
    } catch (e) {
      console.warn(`[feishu] 授权请求异常:`, e)
    }
  } else if (!senderId) {
    console.warn(`[feishu] 无法授权: 未记录发送者 open_id，用户可能无法访问文件`)
  }

  // 发送消息通知用户，包含云空间文件直链
  const domain = cfg.domain === 'lark' ? 'https://larksuite.com' : 'https://feishu.cn'
  const fileUrl = fileToken
    ? `${domain}/file/${fileToken}`
    : `${domain}/drive/folder/${folderToken}`
  const client = getClient(cfg)
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({
        text: `📁 大文件已上传到云空间\n\n文件名: ${fileName}\n大小: ${fileSizeMB}MB\n\n点击查看和下载:\n${fileUrl}`,
      }),
    },
  }).catch((e) => console.error(`[feishu] 通知消息发送失败:`, e))

  return `大文件 "${fileName}" (${fileSizeMB}MB) 已上传到飞书云空间并已授权用户访问 (file_token: ${fileToken})`
}
