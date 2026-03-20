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
): Promise<void> {
  const messages: ChatMessage[] = [{ role: 'user', content: userText }]
  const useStreaming = cfg.streaming !== false && cfg.appId && cfg.appSecret

  if (useStreaming) {
    // Streaming card reply
    const client = getClient(cfg)
    const card = new StreamingCard(cfg, client)
    try {
      await card.start(chatId, messageId)
      let fullText = ''
      for await (const chunk of streamTask(channel.agentId, messages)) {
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
    } catch (err) {
      console.error(`[feishu] 流式回复失败:`, err)
      await card.close(`处理失败: ${err instanceof Error ? err.message : err}`)
    }
  } else {
    // Fallback: collect full response then reply as text
    let fullResponse = ''
    try {
      for await (const chunk of streamTask(channel.agentId, messages)) {
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
        processMessage(channel, cfg, chatId, messageId, userText).catch((err) => {
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

  processMessage(channel, cfg, chatId, messageId, userText).catch((err) => {
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
