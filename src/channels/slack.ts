/**
 * Slack Channel Adapter — Socket Mode
 * Uses @slack/bolt for DM + channel message handling
 */
import { App } from '@slack/bolt'
import {
  registerAdapter,
  processIncomingMessage,
  type ChannelAdapter,
  type IncomingMessage,
} from '../channel-adapter.js'
import type { ChannelConfig } from '../types.js'

// ─── Config ───

export interface SlackChannelConfig {
  botToken: string
  appToken: string
  signingSecret: string
}

// ─── Active App instances keyed by channelId ───

const activeApps = new Map<string, App>()
const appStatus = new Map<string, 'connected' | 'disconnected' | 'error'>()

// ─── Message splitting (Slack block limit ~4000 chars) ───

const MAX_CHUNK = 4000

function splitMessage(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= MAX_CHUNK) {
      chunks.push(remaining)
      break
    }
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf('\n', MAX_CHUNK)
    if (splitAt <= 0) splitAt = MAX_CHUNK
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, '')
  }
  return chunks
}

// ─── Adapter ───

const slackAdapter: ChannelAdapter = {
  type: 'slack',

  async start(channel: ChannelConfig): Promise<void> {
    const cfg = channel.config as SlackChannelConfig
    if (!cfg.botToken || !cfg.appToken || !cfg.signingSecret) {
      throw new Error('Slack 渠道缺少 botToken / appToken / signingSecret')
    }

    // Stop existing instance if any
    if (activeApps.has(channel.id)) {
      await this.stop(channel.id)
    }

    const app = new App({
      token: cfg.botToken,
      appToken: cfg.appToken,
      signingSecret: cfg.signingSecret,
      socketMode: true,
    })

    // Handle all messages (DM + channel)
    app.message(async ({ message, say }) => {
      try {
        const msg = message as any

        // Skip bot messages, edits, deletes
        if (msg.bot_id || msg.subtype) return

        const text = (msg.text || '').trim()
        if (!text) return

        const isGroup = msg.channel_type === 'channel' || msg.channel_type === 'group'

        // In channels, require @bot mention
        if (isGroup && !text.includes(`<@`)) return

        // Strip bot mention from text
        const cleanText = text.replace(/<@[A-Z0-9]+>/g, '').trim()
        if (!cleanText) return

        const incoming: IncomingMessage = {
          channelId: channel.id,
          channelType: 'slack',
          userId: msg.user || 'unknown',
          content: cleanText,
          messageId: msg.ts || String(Date.now()),
          conversationId: `${channel.id}:${msg.user}`,
          isGroup,
          mentionedBot: text !== cleanText,
          timestamp: msg.ts ? parseFloat(msg.ts) * 1000 : Date.now(),
        }

        console.log(`[slack] 收到消息 from=${incoming.userId} group=${isGroup}: ${cleanText.slice(0, 100)}`)

        const response = await processIncomingMessage(incoming, channel)
        if (!response) return

        // Reply in thread, split long messages
        const threadTs = msg.thread_ts || msg.ts
        const chunks = splitMessage(response)
        for (const chunk of chunks) {
          await say({ text: chunk, thread_ts: threadTs })
        }
      } catch (err) {
        console.error(`[slack] 消息处理失败:`, err)
      }
    })

    await app.start()
    activeApps.set(channel.id, app)
    appStatus.set(channel.id, 'connected')
    console.log(`[slack] 渠道 "${channel.name}" Socket Mode 已启动`)
  },

  async stop(channelId: string): Promise<void> {
    const app = activeApps.get(channelId)
    if (app) {
      try {
        await app.stop()
      } catch (err) {
        console.error(`[slack] 停止渠道 ${channelId} 失败:`, err)
      }
      activeApps.delete(channelId)
    }
    appStatus.set(channelId, 'disconnected')
    console.log(`[slack] 渠道 ${channelId} 已停止`)
  },

  getStatus(channelId: string): 'connected' | 'disconnected' | 'error' {
    return appStatus.get(channelId) || 'disconnected'
  },

  async sendMessage(channelId: string, userId: string, content: string, opts?): Promise<void> {
    const app = activeApps.get(channelId)
    if (!app) throw new Error(`Slack 渠道 ${channelId} 未连接`)

    const chunks = splitMessage(content)
    for (const chunk of chunks) {
      await app.client.chat.postMessage({
        channel: userId,
        text: chunk,
        thread_ts: opts?.replyToMessageId,
      })
    }
  },
}

// ─── Auto-register on import ───

registerAdapter('slack', slackAdapter)
