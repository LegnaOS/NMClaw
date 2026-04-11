/**
 * Discord Channel Adapter — discord.js Gateway 长连接
 * 支持 DM 私聊 + 服务器频道（需 @bot 提及）
 */
import { Client, GatewayIntentBits, Events } from 'discord.js'
import { registerAdapter, processIncomingMessage } from '../channel-adapter.js'
import type { ChannelAdapter, IncomingMessage, SendOpts } from '../channel-adapter.js'
import type { ChannelConfig } from '../types.js'

// ─── Discord 渠道配置 ───

export interface DiscordChannelConfig {
  botToken: string
  guildId?: string
}

// ─── 活跃客户端管理 ───

const activeClients = new Map<string, Client>()

// ─── 消息分片（Discord 2000 字符限制） ───

const DISCORD_MAX_LEN = 2000

function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_LEN) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LEN) {
      chunks.push(remaining)
      break
    }
    // 尽量在换行处断开
    let splitAt = remaining.lastIndexOf('\n', DISCORD_MAX_LEN)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', DISCORD_MAX_LEN)
    if (splitAt <= 0) splitAt = DISCORD_MAX_LEN
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  return chunks
}

// ─── 适配器实现 ───

const discordAdapter: ChannelAdapter = {
  type: 'discord',

  async start(channel: ChannelConfig): Promise<void> {
    const cfg = channel.config as DiscordChannelConfig
    if (!cfg.botToken) throw new Error('Discord botToken 未配置')

    if (activeClients.has(channel.id)) {
      console.log(`[discord] channel ${channel.id} already running, skipping`)
      return
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    })

    client.on(Events.MessageCreate, async (message) => {
      // 跳过 bot 消息
      if (message.author.bot) return

      const isDM = !message.guild
      // 服务器频道：必须 @bot 才回复
      if (!isDM) {
        if (!client.user || !message.mentions.has(client.user)) return
      }

      // 构建标准化消息
      const content = isDM
        ? message.content
        : message.content.replace(/<@!?\d+>/g, '').trim()

      if (!content) return

      const incoming: IncomingMessage = {
        channelId: channel.id,
        channelType: 'discord',
        userId: message.author.id,
        userName: message.author.username,
        content,
        messageId: message.id,
        conversationId: message.channelId,
        isGroup: !isDM,
        mentionedBot: !isDM,
        timestamp: message.createdTimestamp,
      }

      try {
        const response = await processIncomingMessage(incoming, channel)
        if (!response) return

        const chunks = splitMessage(response)
        for (let i = 0; i < chunks.length; i++) {
          if (i === 0) {
            await message.reply(chunks[i])
          } else {
            await message.channel.send(chunks[i])
          }
        }
      } catch (err) {
        console.error(`[discord] message handling error:`, err)
        try {
          await message.reply('处理消息时出错，请稍后重试。')
        } catch { /* 发送失败也忽略 */ }
      }
    })

    client.once(Events.ClientReady, (c) => {
      console.log(`[discord] bot online: ${c.user.tag}`)
    })

    await client.login(cfg.botToken)
    activeClients.set(channel.id, client)
    console.log(`[discord] channel ${channel.id} started`)
  },

  async stop(channelId: string): Promise<void> {
    const client = activeClients.get(channelId)
    if (!client) return
    client.destroy()
    activeClients.delete(channelId)
    console.log(`[discord] channel ${channelId} stopped`)
  },

  getStatus(channelId: string): 'connected' | 'disconnected' | 'error' {
    const client = activeClients.get(channelId)
    if (!client) return 'disconnected'
    // discord.js ws status: 0=READY, 1=CONNECTING, etc.
    return client.ws.status === 0 ? 'connected' : 'error'
  },

  async sendMessage(channelId: string, userId: string, content: string, opts?: SendOpts): Promise<void> {
    const client = activeClients.get(channelId)
    if (!client) throw new Error(`Discord channel ${channelId} not connected`)

    const targetChannelId = opts?.conversationId
    if (!targetChannelId) throw new Error('conversationId (Discord channel ID) required for sendMessage')

    const discordChannel = await client.channels.fetch(targetChannelId)
    if (!discordChannel || !discordChannel.isTextBased()) {
      throw new Error(`Cannot send to channel ${targetChannelId}`)
    }

    const chunks = splitMessage(content)
    for (const chunk of chunks) {
      await (discordChannel as any).send(chunk)
    }
  },
}

// ─── 模块级自动注册 ───

registerAdapter('discord', discordAdapter)
