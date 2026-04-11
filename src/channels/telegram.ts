/**
 * B3: Telegram 适配器 — grammy Long Polling（无需公网 URL）
 * 支持私聊 + 群聊（群聊需 @bot 提及或回复 bot 消息）
 */
import { Bot } from 'grammy'
import { registerAdapter, processIncomingMessage } from '../channel-adapter.js'
import type { ChannelAdapter, IncomingMessage, SendOpts } from '../channel-adapter.js'
import type { ChannelConfig } from '../types.js'

// ─── Telegram 渠道配置 ───

export interface TelegramChannelConfig {
  botToken: string
}

// ─── 活跃 Bot 实例管理 ───

const activeBots = new Map<string, { bot: Bot; status: 'connected' | 'disconnected' | 'error' }>()

// ─── 消息分片（Telegram 4096 字符限制） ───

const TG_MAX_LEN = 4096

function splitMessage(text: string): string[] {
  if (text.length <= TG_MAX_LEN) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= TG_MAX_LEN) {
      chunks.push(remaining)
      break
    }
    // 优先在换行处断开，其次空格，最后硬切
    let splitAt = remaining.lastIndexOf('\n', TG_MAX_LEN)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', TG_MAX_LEN)
    if (splitAt <= 0) splitAt = TG_MAX_LEN
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  return chunks
}

// ─── 安全发送（Markdown 失败自动回退纯文本） ───

async function safeSend(
  bot: Bot,
  chatId: number | string,
  text: string,
  replyTo?: number,
): Promise<number> {
  try {
    const sent = await bot.api.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
    })
    return sent.message_id
  } catch {
    const sent = await bot.api.sendMessage(chatId, text, {
      ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
    })
    return sent.message_id
  }
}

// ─── 适配器实现 ───

const telegramAdapter: ChannelAdapter = {
  type: 'telegram',

  async start(channelConfig: ChannelConfig): Promise<void> {
    const cfg = channelConfig.config as TelegramChannelConfig
    if (!cfg.botToken) throw new Error('Telegram: botToken required')

    if (activeBots.has(channelConfig.id)) {
      console.log(`[telegram] channel ${channelConfig.id} already running, skipping`)
      return
    }

    const bot = new Bot(cfg.botToken)
    const state = { bot, status: 'disconnected' as 'connected' | 'disconnected' | 'error' }
    activeBots.set(channelConfig.id, state)

    bot.on('message:text', async (ctx) => {
      try {
        const chat = ctx.chat
        const isGroup = chat.type === 'group' || chat.type === 'supergroup'
        const botInfo = bot.botInfo

        // 群聊：需要 @bot 提及或回复 bot 消息
        if (isGroup) {
          const mentioned = ctx.message.text?.includes(`@${botInfo.username}`)
          const isReply = ctx.message.reply_to_message?.from?.id === botInfo.id
          if (!mentioned && !isReply) return
        }

        // 去掉 @bot mention
        let content = ctx.message.text || ''
        if (botInfo.username) {
          content = content.replace(new RegExp(`@${botInfo.username}\\s*`, 'g'), '').trim()
        }
        if (!content) return

        const msg: IncomingMessage = {
          channelId: channelConfig.id,
          channelType: 'telegram',
          userId: String(ctx.from?.id || ''),
          userName: ctx.from?.first_name || ctx.from?.username || '',
          content,
          messageId: String(ctx.message.message_id),
          conversationId: String(chat.id),
          isGroup,
          mentionedBot: true,
          timestamp: Date.now(),
        }

        // 模拟流式：先发"思考中..."占位，完成后编辑为最终回复
        const thinking = await ctx.reply('思考中...', {
          reply_parameters: { message_id: ctx.message.message_id },
        })

        const response = await processIncomingMessage(msg, channelConfig)
        if (!response) {
          await ctx.api.deleteMessage(chat.id, thinking.message_id).catch(() => {})
          return
        }

        const parts = splitMessage(response)

        // 第一片：编辑"思考中"消息为最终内容
        try {
          await ctx.api.editMessageText(chat.id, thinking.message_id, parts[0], {
            parse_mode: 'Markdown',
          })
        } catch {
          // Markdown 解析失败，回退纯文本编辑
          await ctx.api.editMessageText(chat.id, thinking.message_id, parts[0]).catch(() => {})
        }

        // 后续分片：追加发送
        for (let i = 1; i < parts.length; i++) {
          await safeSend(bot, chat.id, parts[i])
        }
      } catch (e) {
        console.error('[telegram] message error:', e)
        ctx.reply('处理消息时出错，请稍后重试').catch(() => {})
      }
    })

    bot.catch((err) => {
      console.error('[telegram] bot error:', err.message || err)
      state.status = 'error'
    })

    // Long Polling 启动
    bot.start({
      onStart: () => {
        state.status = 'connected'
        console.log(`[telegram] connected: ${channelConfig.name}`)
      },
    })
  },

  async stop(channelId: string): Promise<void> {
    const state = activeBots.get(channelId)
    if (!state) return
    try { await state.bot.stop() } catch { /* */ }
    activeBots.delete(channelId)
  },

  getStatus(channelId: string): 'connected' | 'disconnected' | 'error' {
    return activeBots.get(channelId)?.status || 'disconnected'
  },

  async sendMessage(channelId: string, userId: string, content: string): Promise<void> {
    const state = activeBots.get(channelId)
    if (!state) return
    for (const part of splitMessage(content)) {
      await safeSend(state.bot, userId, part)
    }
  },
}

registerAdapter('telegram', telegramAdapter)
