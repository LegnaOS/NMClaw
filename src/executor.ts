import OpenAI from 'openai'
import { createHash } from 'node:crypto'
import { getModel } from './model-registry.js'
import { listSkills } from './skill-registry.js'
import { getAgent, touchAgent } from './agent-manager.js'
import { getAllTools, getToolsForAgent, callTool, findToolMcp } from './mcp-runtime.js'
import { augmentMessageWithLinks } from './link-understanding.js'
import { loadMemoryContext, saveTurn } from './memory.js'
import type { ChatMessage, ChatResponse, ModelConfig } from './types.js'
import type { ToolDef } from './mcp-runtime.js'

const MAX_TOOL_ROUNDS = 10
const DISPATCH_CONTEXT_LIMIT = 4 // max recent messages to pass to worker (memory covers the rest)
const MAX_TOOL_RESULT_CHARS = 30000 // 工具结果大小上限，防止撑爆上下文

// ─── Response Dedup Cache ───
// 完全相同的 (agentId + messages) 在短时间内命中缓存，跳过 API 调用
const RESPONSE_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const RESPONSE_CACHE_MAX = 200

interface CachedResponse {
  response: ChatResponse
  timestamp: number
}

const responseCache = new Map<string, CachedResponse>()

function responseCacheKey(agentId: string, messages: ChatMessage[]): string {
  const raw = agentId + '|' + JSON.stringify(messages.map(m => ({ r: m.role, c: m.content })))
  return createHash('sha256').update(raw).digest('hex').slice(0, 24)
}

function getFromCache(key: string): ChatResponse | null {
  const entry = responseCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > RESPONSE_CACHE_TTL) {
    responseCache.delete(key)
    return null
  }
  return entry.response
}

function putToCache(key: string, response: ChatResponse): void {
  // LRU eviction: 超过上限时删除最旧的条目
  if (responseCache.size >= RESPONSE_CACHE_MAX) {
    const oldest = responseCache.keys().next().value
    if (oldest) responseCache.delete(oldest)
  }
  responseCache.set(key, { response, timestamp: Date.now() })
}

export function getCacheStats(): { size: number; maxSize: number; ttlMs: number } {
  return { size: responseCache.size, maxSize: RESPONSE_CACHE_MAX, ttlMs: RESPONSE_CACHE_TTL }
}

export type SpanEmitter = (span: {
  type: 'llm' | 'tool' | 'chain'
  name: string
  input?: string
  output?: string
  tokens?: number
  durationMs: number
  status: 'success' | 'error'
}) => void

function toolResultPreview(content: string): string {
  return content.replace(/[\n\r]+/g, ' ').replace(/[\[\]]/g, '').slice(0, 200)
}

/** 截断过大的工具结果，保留首尾各半 */
function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content
  const half = Math.floor(MAX_TOOL_RESULT_CHARS / 2)
  return content.slice(0, half) +
    `\n\n...[结果已截断，原始长度 ${content.length} 字符]...\n\n` +
    content.slice(-half)
}

// ─── 并发工具调度 ───

interface ToolCallItem {
  name: string
  arguments: Record<string, unknown>
  /** OpenAI tool_call_id（仅 OpenAI 路径使用） */
  callId?: string
}

interface ToolCallResult {
  call: ToolCallItem
  result: { content: string; isError?: boolean }
  durationMs: number
}

/** 将工具调用分区为可并行批次和必须串行的批次 */
function partitionToolCalls(calls: ToolCallItem[], tools: ToolDef[]): ToolCallItem[][] {
  if (calls.length <= 1) return [calls]
  const safe: ToolCallItem[] = []
  const batches: ToolCallItem[][] = []
  for (const tc of calls) {
    const def = tools.find(t => t.name === tc.name)
    // dispatch_to_agent 绝对串行；concurrencySafe === false 串行；其余并行
    if (tc.name === 'dispatch_to_agent' || def?.concurrencySafe === false) {
      if (safe.length > 0) { batches.push([...safe]); safe.length = 0 }
      batches.push([tc])
    } else {
      safe.push(tc)
    }
  }
  if (safe.length > 0) batches.unshift(safe) // 安全工具放最前面并行执行
  return batches
}

/** 并发执行一批工具调用（不含 dispatch） */
async function executeBatchConcurrently(
  batch: ToolCallItem[], tools: ToolDef[], signal?: AbortSignal,
): Promise<ToolCallResult[]> {
  const results = await Promise.allSettled(batch.map(async (tc): Promise<ToolCallResult> => {
    if (signal?.aborted) return { call: tc, result: { content: '已取消', isError: true }, durationMs: 0 }
    const start = Date.now()
    const mcpId = findToolMcp(tools, tc.name)
    if (!mcpId) return { call: tc, result: { content: `Tool not found: ${tc.name}`, isError: true }, durationMs: Date.now() - start }
    const r = await callTool(mcpId, tc.name, tc.arguments)
    return { call: tc, result: { content: truncateToolResult(r.content), isError: r.isError }, durationMs: Date.now() - start }
  }))
  return results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { call: batch[i], result: { content: `Error: ${(r as PromiseRejectedResult).reason}`, isError: true }, durationMs: 0 }
  )
}

/** 公共 dispatch_to_agent 流式处理 */
async function* streamDispatch(
  tc: ToolCallItem, messages: ChatMessage[], channelCtx?: ChannelContext, signal?: AbortSignal,
): AsyncGenerator<string, string> {
  const targetId = tc.arguments.agentId as string
  const prompt = tc.arguments.prompt as string
  if (!targetId || !prompt) {
    yield `[TOOL_RESULT:${tc.name}|Error: 缺少 agentId 或 prompt]`
    return '缺少 agentId 或 prompt'
  }
  const targetAgent = getAgent(targetId)
  const agentName = targetAgent?.name || targetId

  yield `[DISPATCH_START:${targetId}|${agentName}]`
  let workerOutput = ''
  try {
    const recentCtx = messages.slice(-DISPATCH_CONTEXT_LIMIT)
    const workerMessages: ChatMessage[] = [...recentCtx, { role: 'user' as const, content: prompt }]
    for await (const chunk of streamTask(targetId, workerMessages, channelCtx, signal)) {
      if (chunk.startsWith('[TOOL_CALL:') || chunk.startsWith('[TOOL_RESULT:') || chunk.startsWith('[FILE_OUTPUT:')) {
        yield chunk; continue
      }
      if (chunk.startsWith('[STREAM_META:') || chunk.startsWith('[AGENT_INFO:') ||
          chunk.startsWith('[DISPATCH_START:') || chunk.startsWith('[DISPATCH_END:')) continue
      if (chunk) { workerOutput += chunk; yield chunk }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    workerOutput = `执行失败: ${errMsg}`
    yield workerOutput
  }
  yield `[DISPATCH_END:${agentName}]`
  const summary = (workerOutput.trim() || '(无回复)').slice(0, 200)
  yield `[TOOL_RESULT:${tc.name}|${toolResultPreview(summary)}]`
  return workerOutput.trim() || '(无回复)'
}

function buildSystemPrompt(agentId: string) {
  const agent = getAgent(agentId)
  if (!agent) throw new Error(`Agent ${agentId} not found`)
  if (agent.state === 'destroyed') throw new Error(`Agent ${agentId} is destroyed`)

  const model = getModel(agent.modelId)
  if (!model) throw new Error(`Model ${agent.modelId} not found`)

  const parts: string[] = []
  if (agent.systemPrompt) parts.push(agent.systemPrompt)

  // Include ALL skills from the shared pool
  const allSkills = listSkills()
  for (const skill of allSkills) {
    parts.push(`[Skill: ${skill.name}]\n${skill.promptTemplate}`)
  }

  touchAgent(agentId)
  return { agent, model, systemPrompt: parts.join('\n\n---\n\n') }
}

function getApiKey(model: ModelConfig): string {
  if (model.provider === 'ollama') return 'ollama'
  // 优先直接配置的 apiKey，其次环境变量
  if (model.config.apiKey) return model.config.apiKey
  const key = model.config.apiKeyEnv ? process.env[model.config.apiKeyEnv] : undefined
  if (!key) throw new Error(`API key 未配置：请在模型设置中填写 API Key，或设置环境变量 ${model.config.apiKeyEnv ?? '(未指定)'}`)
  return key
}

// ─── XML Tool Protocol (fallback for proxies that strip native tools) ───

function buildToolSystemPrompt(baseSystem: string, tools: ToolDef[]): string {
  if (tools.length === 0) return baseSystem

  const toolDescs = tools.map(t => {
    const params = JSON.stringify(t.inputSchema)
    return `<tool name="${t.name}">\n<description>${t.description}</description>\n<parameters>${params}</parameters>\n</tool>`
  }).join('\n')

  return `${baseSystem}

<available_tools>
${toolDescs}
</available_tools>

To use a tool, output exactly this format:
<tool_call>{"name": "tool_name", "arguments": {...}}</tool_call>

You may output multiple <tool_call> blocks in one response. After execution, results appear in <tool_result> tags. Do not explain or narrate tool calls — just output the <tool_call> block directly.`
}

function parseToolCalls(text: string): { name: string; arguments: Record<string, unknown> }[] {
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g
  const calls: { name: string; arguments: Record<string, unknown> }[] = []
  let match
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim())
      calls.push({ name: parsed.name, arguments: parsed.arguments ?? {} })
    } catch { /* skip malformed */ }
  }
  return calls
}

function stripToolCallTags(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
}

// ─── Anthropic Native tool_use (参考 Claude Code 架构) ───
// 使用 Anthropic API 原生 tool_use 而非 XML protocol
// 优势：减少 ~500-2000 tokens system prompt、结构化解析更可靠、配合 prompt caching 更高效
// 回退：ModelConfig.config.defaultParams.xmlToolProtocol = true 可切回 XML 模式

/** 是否使用原生 tool_use（默认 true，除非显式设置 xmlToolProtocol） */
function useNativeToolUse(model: ModelConfig): boolean {
  return !(model.config.defaultParams as any)?.xmlToolProtocol
}

/** 构建 Anthropic 原生 tools 数组 */
function toAnthropicTools(tools: ToolDef[]): any[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}

/** 从 Anthropic 响应 content 数组中提取文本和工具调用 */
function parseNativeContent(content: any[]): {
  text: string
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[]
} {
  let text = ''
  const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = []
  for (const block of content) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} })
    }
  }
  return { text, toolCalls }
}

/** 构建 Anthropic 原生 tool_result 消息 */
function buildNativeToolResults(results: { toolUseId: string; content: string; isError?: boolean }[]): any {
  return {
    role: 'user',
    content: results.map(r => ({
      type: 'tool_result',
      tool_use_id: r.toolUseId,
      content: r.content,
      ...(r.isError ? { is_error: true } : {}),
    })),
  }
}

/** Anthropic 原生 API 请求（支持 tool_use） */
async function nativeAnthropicRequest(
  model: ModelConfig, system: string, messages: any[], tools: ToolDef[],
  maxTokens: number, temperature?: number, signal?: AbortSignal,
): Promise<{
  content: any[]; stopReason: string
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
}> {
  const apiKey = getApiKey(model)
  const baseUrl = model.config.baseUrl || 'https://api.anthropic.com'

  const { systemBlocks, cachedMessages } = applyAnthropicCacheControl(system, messages)

  const body: any = {
    model: model.name,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: cachedMessages,
  }
  if (tools.length > 0) body.tools = toAnthropicTools(tools)
  if (temperature != null) body.temperature = temperature

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic API error ${res.status}: ${err}`)
  }

  const data = await res.json() as any
  const cacheRead = data.usage?.cache_read_input_tokens ?? 0
  const cacheWrite = data.usage?.cache_creation_input_tokens ?? 0
  if (cacheRead > 0 || cacheWrite > 0) {
    console.log(`[anthropic-native] cache read=${cacheRead} write=${cacheWrite} input=${data.usage?.input_tokens ?? 0}`)
  }
  return {
    content: data.content ?? [],
    stopReason: data.stop_reason ?? 'end_turn',
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

/** Anthropic 原生 SSE 流式请求（支持 tool_use） */
async function* streamAnthropicNative(
  model: ModelConfig, system: string, messages: any[], tools: ToolDef[],
  maxTokens: number, temperature?: number, signal?: AbortSignal,
): AsyncGenerator<{ type: 'text'; text: string } | { type: 'tool_use_complete'; id: string; name: string; input: Record<string, unknown> } | { type: 'done'; stopReason: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> {
  const apiKey = getApiKey(model)
  const baseUrl = model.config.baseUrl || 'https://api.anthropic.com'

  const { systemBlocks, cachedMessages } = applyAnthropicCacheControl(system, messages)

  const body: any = {
    model: model.name,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: cachedMessages,
    stream: true,
  }
  if (tools.length > 0) body.tools = toAnthropicTools(tools)
  if (temperature != null) body.temperature = temperature

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic API error ${res.status}: ${err}`)
  }

  // 解析 SSE 流
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0
  let stopReason = 'end_turn'

  // 当前正在构建的 tool_use block
  const toolBlocks = new Map<number, { id: string; name: string; inputJson: string }>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (!data || data === '[DONE]') continue

      let event: any
      try { event = JSON.parse(data) } catch { continue }

      switch (event.type) {
        case 'message_start': {
          const u = event.message?.usage
          if (u) {
            inputTokens = u.input_tokens ?? 0
            cacheReadTokens = u.cache_read_input_tokens ?? 0
            cacheWriteTokens = u.cache_creation_input_tokens ?? 0
          }
          break
        }
        case 'content_block_start': {
          const block = event.content_block
          if (block?.type === 'tool_use') {
            toolBlocks.set(event.index, { id: block.id, name: block.name, inputJson: '' })
          }
          break
        }
        case 'content_block_delta': {
          const delta = event.delta
          if (delta?.type === 'text_delta' && delta.text) {
            yield { type: 'text', text: delta.text }
          } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
            const tb = toolBlocks.get(event.index)
            if (tb) tb.inputJson += delta.partial_json
          }
          break
        }
        case 'content_block_stop': {
          const tb = toolBlocks.get(event.index)
          if (tb) {
            let input: Record<string, unknown> = {}
            try { input = JSON.parse(tb.inputJson) } catch { /* empty */ }
            yield { type: 'tool_use_complete', id: tb.id, name: tb.name, input }
            toolBlocks.delete(event.index)
          }
          break
        }
        case 'message_delta': {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
          if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens
          break
        }
      }
    }
  }

  yield { type: 'done', stopReason, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

// ─── Anthropic Prompt Caching ───
// cache_control: { type: "ephemeral" } 让 Anthropic 缓存 system prompt 和对话前缀
// 多轮 tool loop 中，round 1+ 的 system prompt 命中缓存可节省 ~90% input token 费用
// 缓存 TTL 5 分钟，每次命中自动续期

function applyAnthropicCacheControl(system: string, messages: any[]): { systemBlocks: any[]; cachedMessages: any[] } {
  // System prompt 始终标记缓存（含 skills + tool XML，通常 >1024 tokens）
  const systemBlocks = [
    { type: 'text', text: system, cache_control: { type: 'ephemeral' } }
  ]

  // 多轮对话：在倒数第二条消息上标记缓存断点，让前缀命中缓存
  // Round 0: [user] — 不需要前缀缓存
  // Round 1+: [user, assistant, tool_results, ...] — 缓存到倒数第二条
  const cachedMessages = messages.map((m: any, i: number) => {
    if (messages.length >= 3 && i === messages.length - 2) {
      const content = typeof m.content === 'string'
        ? [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
        : m.content
      return { ...m, content }
    }
    return m
  })

  return { systemBlocks, cachedMessages }
}

async function rawAnthropicRequest(
  model: ModelConfig, system: string, messages: any[], maxTokens: number, temperature?: number, signal?: AbortSignal,
): Promise<{ text: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> {
  const apiKey = getApiKey(model)
  const baseUrl = model.config.baseUrl || 'https://api.anthropic.com'

  const { systemBlocks, cachedMessages } = applyAnthropicCacheControl(system, messages)

  const body: any = {
    model: model.name,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: cachedMessages,
  }
  if (temperature != null) body.temperature = temperature

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic API error ${res.status}: ${err}`)
  }

  const data = await res.json() as any
  const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
  const cacheRead = data.usage?.cache_read_input_tokens ?? 0
  const cacheWrite = data.usage?.cache_creation_input_tokens ?? 0
  if (cacheRead > 0 || cacheWrite > 0) {
    console.log(`[anthropic-cache] read=${cacheRead} write=${cacheWrite} input=${data.usage?.input_tokens ?? 0}`)
  }
  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

function toOpenAITools(tools: ToolDef[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))
}

// ═══════════════════════════════════
//  Non-streaming execution
// ═══════════════════════════════════

export async function executeTask(agentId: string, userPrompt: string, onSpan?: SpanEmitter): Promise<ChatResponse> {
  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }]

  // 响应去重缓存：完全相同的请求直接返回
  const cacheKey = responseCacheKey(agentId, messages)
  const cached = getFromCache(cacheKey)
  if (cached) {
    console.log(`[response-cache] hit for agent=${agentId} key=${cacheKey}`)
    return { ...cached, tokensUsed: 0 }
  }

  const { agent, model, systemPrompt } = buildSystemPrompt(agentId)
  const tools = await getToolsForAgent(agent.mcpIds)

  const result = model.provider === 'anthropic'
    ? await callAnthropicWithTools(model, systemPrompt, messages, tools, onSpan)
    : await callOpenAIWithTools(model, systemPrompt, messages, tools, onSpan)

  // 只缓存成功的、非截断的响应
  if (result.content && !result.content.startsWith('[达到最大工具调用轮次]')) {
    putToCache(cacheKey, result)
  }
  return result
}

async function callAnthropicWithTools(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[], onSpan?: SpanEmitter,
): Promise<ChatResponse> {
  const params = model.config.defaultParams ?? {}
  const maxTokens = (params.max_tokens as number) ?? 4096
  const temperature = params.temperature as number | undefined
  const native = useNativeToolUse(model)

  // XML 回退路径
  if (!native) {
    return callAnthropicWithToolsXml(model, system, messages, tools, maxTokens, temperature, onSpan)
  }

  // ─── 原生 tool_use 路径 ───
  const anthropicMsgs: any[] = messages.map((m) => ({ role: m.role, content: m.content }))
  let totalTokens = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const llmStart = Date.now()
    const result = await nativeAnthropicRequest(model, system, anthropicMsgs, tools, maxTokens, temperature)
    const roundTokens = result.inputTokens + result.outputTokens
    totalTokens += roundTokens

    const { text, toolCalls } = parseNativeContent(result.content)

    onSpan?.({ type: 'llm', name: model.name, input: messages[messages.length - 1]?.content?.slice(0, 300), output: text.slice(0, 500), tokens: roundTokens, durationMs: Date.now() - llmStart, status: 'success' })

    if (toolCalls.length === 0 || result.stopReason !== 'tool_use') {
      return { content: text, tokensUsed: totalTokens }
    }

    // 执行工具
    const toolResults: { toolUseId: string; content: string; isError?: boolean }[] = []
    for (const tc of toolCalls) {
      const toolStart = Date.now()
      const mcpId = findToolMcp(tools, tc.name)
      if (!mcpId) {
        toolResults.push({ toolUseId: tc.id, content: `Tool not found: ${tc.name}`, isError: true })
        onSpan?.({ type: 'tool', name: tc.name, input: JSON.stringify(tc.arguments).slice(0, 300), output: 'Tool not found', durationMs: Date.now() - toolStart, status: 'error' })
        continue
      }
      const callResult = await callTool(mcpId, tc.name, tc.arguments)
      const truncated = truncateToolResult(callResult.content)
      onSpan?.({ type: 'tool', name: tc.name, input: JSON.stringify(tc.arguments).slice(0, 300), output: truncated.slice(0, 500), durationMs: Date.now() - toolStart, status: callResult.isError ? 'error' : 'success' })
      toolResults.push({ toolUseId: tc.id, content: truncated, isError: callResult.isError })
    }

    // 原生格式：assistant content 保留原始数组，tool_result 用结构化格式
    anthropicMsgs.push({ role: 'assistant', content: result.content })
    anthropicMsgs.push(buildNativeToolResults(toolResults))
  }

  return { content: '[达到最大工具调用轮次]', tokensUsed: totalTokens }
}

/** XML tool protocol 回退路径（兼容 API 代理） */
async function callAnthropicWithToolsXml(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[],
  maxTokens: number, temperature?: number, onSpan?: SpanEmitter,
): Promise<ChatResponse> {
  const fullSystem = buildToolSystemPrompt(system, tools)
  const anthropicMsgs: any[] = messages.map((m) => ({ role: m.role, content: m.content }))
  let totalTokens = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const llmStart = Date.now()
    const result = await rawAnthropicRequest(model, fullSystem, anthropicMsgs, maxTokens, temperature)
    const roundTokens = result.inputTokens + result.outputTokens
    totalTokens += roundTokens

    const toolCalls = parseToolCalls(result.text)
    const cleanText = stripToolCallTags(result.text)

    onSpan?.({ type: 'llm', name: model.name, input: messages[messages.length - 1]?.content?.slice(0, 300), output: cleanText.slice(0, 500), tokens: roundTokens, durationMs: Date.now() - llmStart, status: 'success' })

    if (toolCalls.length === 0) {
      return { content: cleanText, tokensUsed: totalTokens }
    }

    const toolResultTexts: string[] = []
    for (const tc of toolCalls) {
      const toolStart = Date.now()
      const mcpId = findToolMcp(tools, tc.name)
      if (!mcpId) {
        toolResultTexts.push(`<tool_result name="${tc.name}" error="true">Tool not found: ${tc.name}</tool_result>`)
        onSpan?.({ type: 'tool', name: tc.name, input: JSON.stringify(tc.arguments).slice(0, 300), output: 'Tool not found', durationMs: Date.now() - toolStart, status: 'error' })
        continue
      }
      const callResult = await callTool(mcpId, tc.name, tc.arguments)
      const truncated = truncateToolResult(callResult.content)
      onSpan?.({ type: 'tool', name: tc.name, input: JSON.stringify(tc.arguments).slice(0, 300), output: truncated.slice(0, 500), durationMs: Date.now() - toolStart, status: callResult.isError ? 'error' : 'success' })
      toolResultTexts.push(`<tool_result name="${tc.name}"${callResult.isError ? ' error="true"' : ''}>${truncated}</tool_result>`)
    }

    anthropicMsgs.push({ role: 'assistant', content: result.text })
    anthropicMsgs.push({ role: 'user', content: toolResultTexts.join('\n') })
  }

  return { content: '[达到最大工具调用轮次]', tokensUsed: totalTokens }
}

async function callOpenAIWithTools(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[], onSpan?: SpanEmitter,
): Promise<ChatResponse> {
  const client = new OpenAI({
    apiKey: getApiKey(model),
    ...(model.config.baseUrl ? { baseURL: model.config.baseUrl } : {}),
  })
  const params = model.config.defaultParams ?? {}
  const openaiMsgs: any[] = [
    { role: 'system', content: system },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ]
  let totalTokens = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const llmStart = Date.now()
    const response = await client.chat.completions.create({
      model: model.name,
      messages: openaiMsgs,
      ...(tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
      max_tokens: (params.max_tokens as number) ?? 4096,
      ...(params.temperature != null ? { temperature: params.temperature as number } : {}),
    })

    const usage = response.usage
    const roundTokens = (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0)
    totalTokens += roundTokens

    const choice = response.choices[0]
    if (!choice) break

    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
      onSpan?.({ type: 'llm', name: model.name, output: (choice.message.content ?? '').slice(0, 500), tokens: roundTokens, durationMs: Date.now() - llmStart, status: 'success' })
      return { content: choice.message.content ?? '', tokensUsed: totalTokens }
    }

    onSpan?.({ type: 'llm', name: model.name, output: `[tool_calls: ${choice.message.tool_calls.length}]`, tokens: roundTokens, durationMs: Date.now() - llmStart, status: 'success' })

    // Process tool calls
    openaiMsgs.push(choice.message)
    for (const tc of choice.message.tool_calls) {
      const toolStart = Date.now()
      // Type narrowing: only function tool calls have .function
      const fn = (tc as any).function as { name: string; arguments: string } | undefined
      if (!fn) continue
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(fn.arguments) } catch { /* empty */ }
      const mcpId = findToolMcp(tools, fn.name)
      if (!mcpId) {
        openaiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: `Tool not found: ${fn.name}` })
        onSpan?.({ type: 'tool', name: fn.name, input: fn.arguments.slice(0, 300), output: 'Tool not found', durationMs: Date.now() - toolStart, status: 'error' })
        continue
      }
      const result = await callTool(mcpId, fn.name, args)
      const truncated = truncateToolResult(result.content)
      onSpan?.({ type: 'tool', name: fn.name, input: fn.arguments.slice(0, 300), output: truncated.slice(0, 500), durationMs: Date.now() - toolStart, status: result.isError ? 'error' : 'success' })
      openaiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: truncated })
    }
  }

  return { content: '[达到最大工具调用轮次]', tokensUsed: totalTokens }
}

// ═══════════════════════════════════
//  Streaming execution with tool use
// ═══════════════════════════════════

export interface ChannelContext {
  channelId: string
  channelName: string
  channelType: string
}

export async function* streamTask(agentId: string, messages: ChatMessage[], channelCtx?: ChannelContext, signal?: AbortSignal): AsyncGenerator<string> {
  const { agent, model, systemPrompt } = buildSystemPrompt(agentId)
  const tools = await getToolsForAgent(agent.mcpIds)

  // Inject channel context into system prompt so agent knows how to send files
  let finalSystem = systemPrompt
  if (channelCtx) {
    finalSystem += `\n\n---\n\n[渠道上下文] 当前用户通过「${channelCtx.channelName}」渠道（channelId: ${channelCtx.channelId}, 类型: ${channelCtx.channelType}）与你通信。` +
      `\n发送文件给用户时，必须使用 send_file_to_channel 工具，参数 channelId="${channelCtx.channelId}"。不要使用 send_file（那是 Web 专用工具）。`
  }

  // Long-term memory: load past interactions and inject into system prompt
  try {
    const memCtx = loadMemoryContext(agentId)
    if (memCtx) finalSystem += memCtx
  } catch (e) {
    console.error(`[memory] load failed for ${agentId}:`, e)
  }

  // Link Understanding: augment the last user message with fetched URL content
  const augmentedMessages = await augmentUserLinks(messages)

  // Collect full assistant response for memory persistence
  let fullResponse = ''
  const innerGen = model.provider === 'anthropic'
    ? streamAnthropicWithTools(model, finalSystem, augmentedMessages, tools, channelCtx, signal)
    : streamOpenAIWithTools(model, finalSystem, augmentedMessages, tools, channelCtx, signal)

  for await (const chunk of innerGen) {
    // Only collect visible text, skip meta/control tags
    if (chunk && !chunk.startsWith('[TOOL_CALL:') && !chunk.startsWith('[TOOL_RESULT:') &&
        !chunk.startsWith('[STREAM_META:') && !chunk.startsWith('[FILE_OUTPUT:') &&
        !chunk.startsWith('[AGENT_INFO:') && !chunk.startsWith('[DISPATCH_START:') &&
        !chunk.startsWith('[DISPATCH_END:')) {
      fullResponse += chunk
    }
    yield chunk
  }

  // Save this turn to long-term memory
  const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || ''
  if (lastUserMsg && fullResponse.trim()) {
    try {
      saveTurn(agentId, lastUserMsg, fullResponse.trim())
    } catch (e) {
      console.error(`[memory] save failed for ${agentId}:`, e)
    }
  }
}

/** Augment the last user message with content from any detected URLs */
async function augmentUserLinks(messages: ChatMessage[]): Promise<ChatMessage[]> {
  if (messages.length === 0) return messages
  const lastIdx = messages.length - 1
  const last = messages[lastIdx]
  if (last.role !== 'user' || !last.content) return messages

  try {
    const { augmented } = await augmentMessageWithLinks(last.content)
    if (augmented === last.content) return messages
    const copy = [...messages]
    copy[lastIdx] = { ...last, content: augmented }
    return copy
  } catch {
    return messages // fail-open: don't block on link fetch errors
  }
}

async function* streamAnthropicWithTools(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[], channelCtx?: ChannelContext, signal?: AbortSignal,
): AsyncGenerator<string> {
  const params = model.config.defaultParams ?? {}
  const maxTokens = (params.max_tokens as number) ?? 4096
  const temperature = params.temperature as number | undefined
  const native = useNativeToolUse(model)

  // XML 回退路径
  if (!native) {
    yield* streamAnthropicWithToolsXml(model, system, messages, tools, maxTokens, temperature, channelCtx, signal)
    return
  }

  // ─── 原生 tool_use 流式路径 ───
  const anthropicMsgs: any[] = messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  let totalTokens = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) break

    // 收集本轮的文本和工具调用
    let roundText = ''
    const roundToolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = []
    let stopReason = 'end_turn'
    let roundInputTokens = 0, roundOutputTokens = 0

    try {
      for await (const event of streamAnthropicNative(model, system, anthropicMsgs, tools, maxTokens, temperature, signal)) {
        if (event.type === 'text') {
          roundText += event.text
          // 原生流式：实时 yield 文本（仅在没有工具调用时才对用户可见，但先收集）
        } else if (event.type === 'tool_use_complete') {
          roundToolCalls.push({ id: event.id, name: event.name, arguments: event.input })
        } else if (event.type === 'done') {
          stopReason = event.stopReason
          roundInputTokens = event.inputTokens
          roundOutputTokens = event.outputTokens
          totalTokens += event.inputTokens + event.outputTokens
          if (event.cacheReadTokens > 0 || event.cacheWriteTokens > 0) {
            console.log(`[anthropic-native-stream] cache read=${event.cacheReadTokens} write=${event.cacheWriteTokens}`)
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) break
      yield `\n\n[Error: ${err instanceof Error ? err.message : err}]`
      break
    }

    console.log(`[stream-anthropic-native] round=${round} text=${roundText.length}chars tools=${roundToolCalls.length} stop=${stopReason}`)

    // 没有工具调用 → yield 文本并结束
    if (roundToolCalls.length === 0 || stopReason !== 'tool_use') {
      if (roundText) yield roundText
      break
    }

    // 有工具调用 → 并发调度
    const hasDispatch = roundToolCalls.some(tc => tc.name === 'dispatch_to_agent')

    const items: ToolCallItem[] = roundToolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments, callId: tc.id }))
    const batches = partitionToolCalls(items, tools)
    const toolResults: { toolUseId: string; content: string; isError?: boolean }[] = []

    for (const batch of batches) {
      if (signal?.aborted) break

      if (batch.length === 1 && batch[0].name === 'dispatch_to_agent') {
        const tc = batch[0]
        yield `[TOOL_CALL:${tc.name}]`
        let dispatchOutput = ''
        for await (const chunk of streamDispatch(tc, messages, channelCtx, signal)) {
          if (!chunk.startsWith('[DISPATCH_END:') && !chunk.startsWith('[TOOL_RESULT:') &&
              !chunk.startsWith('[DISPATCH_START:') && !chunk.startsWith('[TOOL_CALL:')) {
            dispatchOutput += chunk
          }
          yield chunk
        }
        toolResults.push({ toolUseId: tc.callId!, content: dispatchOutput.trim() || '(已委派执行)' })
        continue
      }

      for (const tc of batch) yield `[TOOL_CALL:${tc.name}]`
      const results = await executeBatchConcurrently(batch, tools, signal)
      for (const r of results) {
        if ((r.call.name === 'write_file' || r.call.name === 'send_file') && r.call.arguments.path && !r.result.isError) {
          yield `[FILE_OUTPUT:${r.call.arguments.path}]`
        }
        yield `[TOOL_RESULT:${r.call.name}|${toolResultPreview(r.result.content)}]`
        toolResults.push({ toolUseId: r.call.callId!, content: r.result.content, isError: r.result.isError })
      }
    }

    if (hasDispatch) {
      console.log(`[stream-anthropic-native] dispatch completed, breaking loop`)
      break
    }

    // 构建原生格式的消息继续对话
    // assistant content 需要包含原始的 text + tool_use blocks
    const assistantContent: any[] = []
    if (roundText) assistantContent.push({ type: 'text', text: roundText })
    for (const tc of roundToolCalls) {
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })
    }
    anthropicMsgs.push({ role: 'assistant', content: assistantContent })
    anthropicMsgs.push(buildNativeToolResults(toolResults))
  }
  if (totalTokens > 0) yield `[STREAM_META:tokens=${totalTokens}]`
}

/** XML tool protocol 流式回退路径 */
async function* streamAnthropicWithToolsXml(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[],
  maxTokens: number, temperature?: number, channelCtx?: ChannelContext, signal?: AbortSignal,
): AsyncGenerator<string> {
  const fullSystem = buildToolSystemPrompt(system, tools)
  const anthropicMsgs: any[] = messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  let totalTokens = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) break

    let result
    try {
      result = await rawAnthropicRequest(model, fullSystem, anthropicMsgs, maxTokens, temperature, signal)
    } catch (err) {
      if (signal?.aborted) break
      yield `\n\n[Error: ${err instanceof Error ? err.message : err}]`
      break
    }

    totalTokens += result.inputTokens + result.outputTokens
    const toolCalls = parseToolCalls(result.text)
    const cleanText = stripToolCallTags(result.text)

    console.log(`[stream-anthropic-xml] round=${round} text=${cleanText.length}chars tools=${toolCalls.length}`)

    if (toolCalls.length === 0) {
      if (cleanText) yield cleanText
      break
    }

    const hasDispatch = toolCalls.some(tc => tc.name === 'dispatch_to_agent')
    const items: ToolCallItem[] = toolCalls.map(tc => ({ name: tc.name, arguments: tc.arguments }))
    const batches = partitionToolCalls(items, tools)
    const toolResultTexts: string[] = []

    for (const batch of batches) {
      if (signal?.aborted) break

      if (batch.length === 1 && batch[0].name === 'dispatch_to_agent') {
        const tc = batch[0]
        yield `[TOOL_CALL:${tc.name}]`
        for await (const chunk of streamDispatch(tc, messages, channelCtx, signal)) {
          yield chunk
        }
        const targetId = tc.arguments.agentId as string
        const prompt = tc.arguments.prompt as string
        if (!targetId || !prompt) {
          toolResultTexts.push(`<tool_result name="${tc.name}" error="true">缺少 agentId 或 prompt</tool_result>`)
        } else {
          toolResultTexts.push(`<tool_result name="${tc.name}">(已委派执行)</tool_result>`)
        }
        continue
      }

      for (const tc of batch) yield `[TOOL_CALL:${tc.name}]`
      const results = await executeBatchConcurrently(batch, tools, signal)
      for (const r of results) {
        if ((r.call.name === 'write_file' || r.call.name === 'send_file') && r.call.arguments.path && !r.result.isError) {
          yield `[FILE_OUTPUT:${r.call.arguments.path}]`
        }
        yield `[TOOL_RESULT:${r.call.name}|${toolResultPreview(r.result.content)}]`
        toolResultTexts.push(`<tool_result name="${r.call.name}"${r.result.isError ? ' error="true"' : ''}>${r.result.content}</tool_result>`)
      }
    }

    if (hasDispatch) {
      console.log(`[stream-anthropic-xml] dispatch completed, breaking loop`)
      break
    }

    anthropicMsgs.push({ role: 'assistant', content: result.text })
    anthropicMsgs.push({ role: 'user', content: toolResultTexts.join('\n') })
  }
  if (totalTokens > 0) yield `[STREAM_META:tokens=${totalTokens}]`
}

async function* streamOpenAIWithTools(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[], _channelCtx?: ChannelContext, signal?: AbortSignal,
): AsyncGenerator<string> {
  const client = new OpenAI({
    apiKey: getApiKey(model),
    ...(model.config.baseUrl ? { baseURL: model.config.baseUrl } : {}),
  })
  const params = model.config.defaultParams ?? {}
  const openaiMsgs: any[] = [
    { role: 'system', content: system },
    ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ]
  let totalTokens = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) break

    let stream
    try {
      stream = await client.chat.completions.create({
        model: model.name,
        messages: openaiMsgs,
        ...(tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
        max_tokens: (params.max_tokens as number) ?? 4096,
        ...(params.temperature != null ? { temperature: params.temperature as number } : {}),
        stream: true,
        stream_options: { include_usage: true },
      })
    } catch (err) {
      if (signal?.aborted) break
      yield `\n\n[Error: ${err instanceof Error ? err.message : err}]`
      break
    }

    let finishReason = ''
    const streamedToolCalls = new Map<number, { id: string; name: string; arguments: string }>()

    for await (const chunk of stream) {
      if (signal?.aborted) break
      const choice = chunk.choices[0]
      if (!choice) continue

      if (choice.delta?.content) {
        yield choice.delta.content
      }

      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (!streamedToolCalls.has(tc.index)) {
            streamedToolCalls.set(tc.index, { id: tc.id || '', name: tc.function?.name || '', arguments: '' })
          }
          const existing = streamedToolCalls.get(tc.index)!
          if (tc.id) existing.id = tc.id
          if (tc.function?.name) existing.name = tc.function.name
          if (tc.function?.arguments) existing.arguments += tc.function.arguments
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason
      const usage = (chunk as any).usage
      if (usage) totalTokens += (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
    }

    if (finishReason !== 'tool_calls' || streamedToolCalls.size === 0) break

    // Build assistant message with tool calls
    const tcValues = [...streamedToolCalls.values()]
    const assistantMsg: any = {
      role: 'assistant',
      content: null,
      tool_calls: tcValues.map((tc) => ({
        id: tc.id, type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    }
    openaiMsgs.push(assistantMsg)

    // 构建 ToolCallItem 列表并分区调度
    const items: ToolCallItem[] = tcValues.map(tc => {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.arguments) } catch { /* empty */ }
      return { name: tc.name, arguments: args, callId: tc.id }
    })
    const batches = partitionToolCalls(items, tools)

    for (const batch of batches) {
      if (signal?.aborted) break

      // dispatch_to_agent 走流式处理
      if (batch.length === 1 && batch[0].name === 'dispatch_to_agent') {
        const tc = batch[0]
        yield `[TOOL_CALL:${tc.name}]`
        let dispatchOutput = ''
        for await (const chunk of streamDispatch(tc, messages, _channelCtx, signal)) {
          if (!chunk.startsWith('[DISPATCH_END:') && !chunk.startsWith('[TOOL_RESULT:') &&
              !chunk.startsWith('[DISPATCH_START:') && !chunk.startsWith('[TOOL_CALL:')) {
            dispatchOutput += chunk
          }
          yield chunk
        }
        openaiMsgs.push({ role: 'tool', tool_call_id: tc.callId, content: dispatchOutput.trim() || '(已委派执行)' })
        continue
      }

      // 普通工具：并发执行
      for (const tc of batch) yield `[TOOL_CALL:${tc.name}]`
      const results = await executeBatchConcurrently(batch, tools, signal)
      for (const r of results) {
        if ((r.call.name === 'write_file' || r.call.name === 'send_file') && r.call.arguments.path && !r.result.isError) {
          yield `[FILE_OUTPUT:${r.call.arguments.path}]`
        }
        yield `[TOOL_RESULT:${r.call.name}|${toolResultPreview(r.result.content)}]`
        openaiMsgs.push({ role: 'tool', tool_call_id: r.call.callId, content: r.result.content })
      }
    }
  }
  if (totalTokens > 0) yield `[STREAM_META:tokens=${totalTokens}]`
}
