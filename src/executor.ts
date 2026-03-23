import OpenAI from 'openai'
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

// ─── XML Tool Protocol (works through proxy that strips native tools) ───

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

async function rawAnthropicRequest(
  model: ModelConfig, system: string, messages: any[], maxTokens: number, temperature?: number,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const apiKey = getApiKey(model)
  const baseUrl = model.config.baseUrl || 'https://api.anthropic.com'

  const body: any = {
    model: model.name,
    max_tokens: maxTokens,
    system,
    messages,
  }
  if (temperature != null) body.temperature = temperature

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Anthropic API error ${res.status}: ${err}`)
  }

  const data = await res.json() as any
  const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
  return {
    text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
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
  const { agent, model, systemPrompt } = buildSystemPrompt(agentId)
  const tools = await getToolsForAgent(agent.mcpIds)
  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }]

  if (model.provider === 'anthropic') {
    return callAnthropicWithTools(model, systemPrompt, messages, tools, onSpan)
  }
  return callOpenAIWithTools(model, systemPrompt, messages, tools, onSpan)
}

async function callAnthropicWithTools(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[], onSpan?: SpanEmitter,
): Promise<ChatResponse> {
  const params = model.config.defaultParams ?? {}
  const maxTokens = (params.max_tokens as number) ?? 4096
  const temperature = params.temperature as number | undefined
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

    // Process tool calls
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
      onSpan?.({ type: 'tool', name: tc.name, input: JSON.stringify(tc.arguments).slice(0, 300), output: callResult.content.slice(0, 500), durationMs: Date.now() - toolStart, status: callResult.isError ? 'error' : 'success' })
      toolResultTexts.push(`<tool_result name="${tc.name}"${callResult.isError ? ' error="true"' : ''}>${callResult.content}</tool_result>`)
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
      onSpan?.({ type: 'tool', name: fn.name, input: fn.arguments.slice(0, 300), output: result.content.slice(0, 500), durationMs: Date.now() - toolStart, status: result.isError ? 'error' : 'success' })
      openaiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result.content })
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

export async function* streamTask(agentId: string, messages: ChatMessage[], channelCtx?: ChannelContext): AsyncGenerator<string> {
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
    ? streamAnthropicWithTools(model, finalSystem, augmentedMessages, tools, channelCtx)
    : streamOpenAIWithTools(model, finalSystem, augmentedMessages, tools, channelCtx)

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
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[], channelCtx?: ChannelContext,
): AsyncGenerator<string> {
  const params = model.config.defaultParams ?? {}
  const maxTokens = (params.max_tokens as number) ?? 4096
  const temperature = params.temperature as number | undefined
  const fullSystem = buildToolSystemPrompt(system, tools)
  const anthropicMsgs: any[] = messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  let totalTokens = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let result
    try {
      result = await rawAnthropicRequest(model, fullSystem, anthropicMsgs, maxTokens, temperature)
    } catch (err) {
      yield `\n\n[Error: ${err instanceof Error ? err.message : err}]`
      break
    }

    totalTokens += result.inputTokens + result.outputTokens

    const toolCalls = parseToolCalls(result.text)
    const cleanText = stripToolCallTags(result.text)

    console.log(`[stream-anthropic] round=${round} text=${cleanText.length}chars tools=${toolCalls.length}`)

    // If no tool calls, yield text and done
    if (toolCalls.length === 0) {
      if (cleanText) yield cleanText
      break
    }

    // Has tool calls — suppress narration text (model shouldn't talk while calling tools)
    const hasDispatch = toolCalls.some(tc => tc.name === 'dispatch_to_agent')

    // Execute tools
    const toolResultTexts: string[] = []
    for (const tc of toolCalls) {
      yield `[TOOL_CALL:${tc.name}]`

      // Special handling: dispatch_to_agent streams worker output in real-time
      if (tc.name === 'dispatch_to_agent') {
        const targetId = tc.arguments.agentId as string
        const prompt = tc.arguments.prompt as string
        if (!targetId || !prompt) {
          yield `[TOOL_RESULT:${tc.name}|Error: 缺少 agentId 或 prompt]`
          toolResultTexts.push(`<tool_result name="${tc.name}" error="true">缺少 agentId 或 prompt</tool_result>`)
          continue
        }
        const targetAgent = getAgent(targetId)
        const agentName = targetAgent?.name || targetId

        yield `[DISPATCH_START:${targetId}|${agentName}]`
        let workerOutput = ''
        try {
          // Pass only recent context — worker's long-term memory fills the rest
          const recentCtx = messages.slice(-DISPATCH_CONTEXT_LIMIT)
          const workerMessages: ChatMessage[] = [
            ...recentCtx,
            { role: 'user' as const, content: prompt },
          ]
          for await (const chunk of streamTask(targetId, workerMessages, channelCtx)) {
            if (chunk.startsWith('[TOOL_CALL:') || chunk.startsWith('[TOOL_RESULT:') ||
                chunk.startsWith('[FILE_OUTPUT:')) {
              yield chunk
              continue
            }
            if (chunk.startsWith('[STREAM_META:') || chunk.startsWith('[AGENT_INFO:') ||
                chunk.startsWith('[DISPATCH_START:') || chunk.startsWith('[DISPATCH_END:')) continue
            if (chunk) {
              workerOutput += chunk
              yield chunk
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          workerOutput = `执行失败: ${errMsg}`
          yield workerOutput
        }
        yield `[DISPATCH_END:${agentName}]`

        const summary = (workerOutput.trim() || '(无回复)').slice(0, 200)
        yield `[TOOL_RESULT:${tc.name}|${toolResultPreview(summary)}]`
        toolResultTexts.push(`<tool_result name="${tc.name}">${workerOutput.trim() || '(无回复)'}</tool_result>`)
        continue
      }

      const mcpId = findToolMcp(tools, tc.name)
      if (!mcpId) {
        yield `[TOOL_RESULT:${tc.name}|Error: 工具未找到]`
        toolResultTexts.push(`<tool_result name="${tc.name}" error="true">Tool not found: ${tc.name}</tool_result>`)
        continue
      }
      try {
        const callResult = await callTool(mcpId, tc.name, tc.arguments)
        if ((tc.name === 'write_file' || tc.name === 'send_file') && tc.arguments.path && !callResult.isError) {
          yield `[FILE_OUTPUT:${tc.arguments.path}]`
        }
        yield `[TOOL_RESULT:${tc.name}|${toolResultPreview(callResult.content)}]`
        toolResultTexts.push(`<tool_result name="${tc.name}"${callResult.isError ? ' error="true"' : ''}>${callResult.content}</tool_result>`)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        yield `[TOOL_RESULT:${tc.name}|Error: ${errMsg}]`
        toolResultTexts.push(`<tool_result name="${tc.name}" error="true">Error: ${errMsg}</tool_result>`)
      }
    }

    // Dispatch completed — break loop, don't let Genesis summarize
    if (hasDispatch) {
      console.log(`[stream-anthropic] dispatch completed, breaking loop`)
      break
    }

    // Feed tool results back as XML
    anthropicMsgs.push({ role: 'assistant', content: result.text })
    anthropicMsgs.push({ role: 'user', content: toolResultTexts.join('\n') })
  }
  if (totalTokens > 0) yield `[STREAM_META:tokens=${totalTokens}]`
}

async function* streamOpenAIWithTools(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[], _channelCtx?: ChannelContext,
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
      yield `\n\n[Error: ${err instanceof Error ? err.message : err}]`
      break
    }

    let finishReason = ''
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue

      if (choice.delta?.content) {
        yield choice.delta.content
      }

      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (!toolCalls.has(tc.index)) {
            toolCalls.set(tc.index, { id: tc.id || '', name: tc.function?.name || '', arguments: '' })
          }
          const existing = toolCalls.get(tc.index)!
          if (tc.id) existing.id = tc.id
          if (tc.function?.name) existing.name = tc.function.name
          if (tc.function?.arguments) existing.arguments += tc.function.arguments
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason
      // Capture usage from final chunk
      const usage = (chunk as any).usage
      if (usage) totalTokens += (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
    }

    if (finishReason !== 'tool_calls' || toolCalls.size === 0) break

    // Build assistant message with tool calls
    const assistantMsg: any = {
      role: 'assistant',
      content: null,
      tool_calls: [...toolCalls.values()].map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    }
    openaiMsgs.push(assistantMsg)

    // Process each tool call
    for (const tc of toolCalls.values()) {
      yield `[TOOL_CALL:${tc.name}]`
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.arguments) } catch { /* empty */ }

      // Special handling: dispatch_to_agent streams worker output with conversation history
      if (tc.name === 'dispatch_to_agent') {
        const targetId = args.agentId as string
        const prompt = args.prompt as string
        if (!targetId || !prompt) {
          openaiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: '缺少 agentId 或 prompt' })
          yield `[TOOL_RESULT:${tc.name}|Error: 缺少 agentId 或 prompt]`
          continue
        }
        const targetAgent = getAgent(targetId)
        const agentName = targetAgent?.name || targetId

        yield `[DISPATCH_START:${targetId}|${agentName}]`
        let workerOutput = ''
        try {
          // Pass only recent context — worker's long-term memory fills the rest
          const recentCtx = messages.slice(-DISPATCH_CONTEXT_LIMIT)
          const workerMessages: ChatMessage[] = [
            ...recentCtx,
            { role: 'user' as const, content: prompt },
          ]
          for await (const chunk of streamTask(targetId, workerMessages, _channelCtx)) {
            if (chunk.startsWith('[TOOL_CALL:') || chunk.startsWith('[TOOL_RESULT:') ||
                chunk.startsWith('[FILE_OUTPUT:')) {
              yield chunk
              continue
            }
            if (chunk.startsWith('[STREAM_META:') || chunk.startsWith('[AGENT_INFO:') ||
                chunk.startsWith('[DISPATCH_START:') || chunk.startsWith('[DISPATCH_END:')) continue
            if (chunk) {
              workerOutput += chunk
              yield chunk
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          workerOutput = `执行失败: ${errMsg}`
          yield workerOutput
        }
        yield `[DISPATCH_END:${agentName}]`

        const summary = (workerOutput.trim() || '(无回复)').slice(0, 200)
        yield `[TOOL_RESULT:${tc.name}|${toolResultPreview(summary)}]`
        openaiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: workerOutput.trim() || '(无回复)' })
        continue
      }

      const mcpId = findToolMcp(tools, tc.name)
      if (!mcpId) {
        openaiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: `Tool not found: ${tc.name}` })
        continue
      }
      try {
        const result = await callTool(mcpId, tc.name, args)
        if ((tc.name === 'write_file' || tc.name === 'send_file') && args.path && !result.isError) {
          yield `[FILE_OUTPUT:${args.path}]`
        }
        yield `[TOOL_RESULT:${tc.name}|${toolResultPreview(result.content)}]`
        openaiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result.content })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        yield `[TOOL_RESULT:${tc.name}|Error: ${errMsg}]`
        openaiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: `Tool error: ${errMsg}` })
      }
    }
  }
  if (totalTokens > 0) yield `[STREAM_META:tokens=${totalTokens}]`
}
