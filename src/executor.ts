import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { getModel } from './model-registry.js'
import { listSkills } from './skill-registry.js'
import { getAgent, touchAgent } from './agent-manager.js'
import { getAllTools, callTool, findToolMcp } from './mcp-runtime.js'
import type { ChatMessage, ChatResponse, ModelConfig } from './types.js'
import type { ToolDef } from './mcp-runtime.js'

const MAX_TOOL_ROUNDS = 10

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
  const key = model.config.apiKeyEnv ? process.env[model.config.apiKeyEnv] : undefined
  if (!key) throw new Error(`API key not found in env: ${model.config.apiKeyEnv}`)
  return key
}

function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }))
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
  const { model, systemPrompt } = buildSystemPrompt(agentId)
  const tools = await getAllTools()
  const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }]

  if (model.provider === 'anthropic') {
    return callAnthropicWithTools(model, systemPrompt, messages, tools, onSpan)
  }
  return callOpenAIWithTools(model, systemPrompt, messages, tools, onSpan)
}

async function callAnthropicWithTools(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[], onSpan?: SpanEmitter,
): Promise<ChatResponse> {
  const client = new Anthropic({
    apiKey: getApiKey(model),
    ...(model.config.baseUrl ? { baseURL: model.config.baseUrl } : {}),
  })
  const params = model.config.defaultParams ?? {}
  const anthropicMsgs: any[] = messages.map((m) => ({ role: m.role, content: m.content }))
  let totalTokens = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const llmStart = Date.now()
    const response = await client.messages.create({
      model: model.name,
      max_tokens: (params.max_tokens as number) ?? 4096,
      system,
      messages: anthropicMsgs,
      ...(tools.length > 0 ? { tools: toAnthropicTools(tools) } : {}),
      ...(params.temperature != null ? { temperature: params.temperature as number } : {}),
    })

    const roundTokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)
    totalTokens += roundTokens

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    onSpan?.({ type: 'llm', name: model.name, input: messages[messages.length - 1]?.content?.slice(0, 300), output: text.slice(0, 500), tokens: roundTokens, durationMs: Date.now() - llmStart, status: 'success' })

    if (response.stop_reason !== 'tool_use') {
      return { content: text, tokensUsed: totalTokens }
    }

    // Process tool calls
    const toolResults: any[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const toolStart = Date.now()
      const mcpId = findToolMcp(tools, block.name)
      if (!mcpId) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Tool not found: ${block.name}`, is_error: true })
        onSpan?.({ type: 'tool', name: block.name, input: JSON.stringify(block.input).slice(0, 300), output: 'Tool not found', durationMs: Date.now() - toolStart, status: 'error' })
        continue
      }
      const result = await callTool(mcpId, block.name, block.input as Record<string, unknown>)
      onSpan?.({ type: 'tool', name: block.name, input: JSON.stringify(block.input).slice(0, 300), output: result.content.slice(0, 500), durationMs: Date.now() - toolStart, status: result.isError ? 'error' : 'success' })
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result.content, ...(result.isError ? { is_error: true } : {}) })
    }

    anthropicMsgs.push({ role: 'assistant', content: response.content })
    anthropicMsgs.push({ role: 'user', content: toolResults })
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
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.function.arguments) } catch { /* empty */ }
      const mcpId = findToolMcp(tools, tc.function.name)
      if (!mcpId) {
        openaiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: `Tool not found: ${tc.function.name}` })
        onSpan?.({ type: 'tool', name: tc.function.name, input: tc.function.arguments.slice(0, 300), output: 'Tool not found', durationMs: Date.now() - toolStart, status: 'error' })
        continue
      }
      const result = await callTool(mcpId, tc.function.name, args)
      onSpan?.({ type: 'tool', name: tc.function.name, input: tc.function.arguments.slice(0, 300), output: result.content.slice(0, 500), durationMs: Date.now() - toolStart, status: result.isError ? 'error' : 'success' })
      openaiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result.content })
    }
  }

  return { content: '[达到最大工具调用轮次]', tokensUsed: totalTokens }
}

// ═══════════════════════════════════
//  Streaming execution with tool use
// ═══════════════════════════════════

export async function* streamTask(agentId: string, messages: ChatMessage[]): AsyncGenerator<string> {
  const { model, systemPrompt } = buildSystemPrompt(agentId)
  const tools = await getAllTools()

  if (model.provider === 'anthropic') {
    yield* streamAnthropicWithTools(model, systemPrompt, messages, tools)
  } else {
    yield* streamOpenAIWithTools(model, systemPrompt, messages, tools)
  }
}

async function* streamAnthropicWithTools(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[],
): AsyncGenerator<string> {
  const client = new Anthropic({
    apiKey: getApiKey(model),
    ...(model.config.baseUrl ? { baseURL: model.config.baseUrl } : {}),
  })
  const params = model.config.defaultParams ?? {}
  const anthropicMsgs: any[] = messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  let totalTokens = 0

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let stream
    try {
      stream = await client.messages.create({
        model: model.name,
        max_tokens: (params.max_tokens as number) ?? 4096,
        system,
        messages: anthropicMsgs,
        ...(tools.length > 0 ? { tools: toAnthropicTools(tools) } : {}),
        ...(params.temperature != null ? { temperature: params.temperature as number } : {}),
        stream: true,
      })
    } catch (err) {
      yield `\n\n[Error: ${err instanceof Error ? err.message : err}]`
      break
    }

    let stopReason = ''
    const contentBlocks: any[] = []
    let currentBlock: any = null

    for await (const event of stream) {
      if (event.type === 'message_start') {
        const usage = (event as any).message?.usage
        if (usage) totalTokens += usage.input_tokens ?? 0
      } else if (event.type === 'content_block_start') {
        currentBlock = { ...event.content_block }
        if (currentBlock.type === 'tool_use') {
          currentBlock._inputJson = ''
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield event.delta.text
          if (currentBlock) currentBlock.text = (currentBlock.text || '') + event.delta.text
        } else if (event.delta.type === 'input_json_delta') {
          if (currentBlock) currentBlock._inputJson += event.delta.partial_json
        }
      } else if (event.type === 'content_block_stop') {
        if (currentBlock) {
          if (currentBlock.type === 'tool_use' && currentBlock._inputJson) {
            try { currentBlock.input = JSON.parse(currentBlock._inputJson) } catch { currentBlock.input = {} }
          }
          delete currentBlock._inputJson
          contentBlocks.push(currentBlock)
          currentBlock = null
        }
      } else if (event.type === 'message_delta') {
        stopReason = (event.delta as any).stop_reason || ''
        const usage = (event as any).usage
        if (usage) totalTokens += usage.output_tokens ?? 0
      }
    }

    if (stopReason !== 'tool_use' || contentBlocks.filter((b) => b.type === 'tool_use').length === 0) {
      break
    }

    // Process tool calls
    const toolUseBlocks = contentBlocks.filter((b) => b.type === 'tool_use')
    const toolResults: any[] = []

    for (const block of toolUseBlocks) {
      yield `[TOOL_CALL:${block.name}]`
      const mcpId = findToolMcp(tools, block.name)
      if (!mcpId) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Tool not found: ${block.name}`, is_error: true })
        continue
      }
      try {
        const result = await callTool(mcpId, block.name, block.input || {})
        if (block.name === 'write_file' && block.input?.path && !result.isError) {
          yield `[FILE_OUTPUT:${block.input.path}]`
        }
        yield `[TOOL_RESULT:${block.name}|${toolResultPreview(result.content)}]`
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        yield `[TOOL_RESULT:${block.name}|Error: ${errMsg}]`
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Tool error: ${errMsg}`, is_error: true })
      }
    }

    // Build messages for next round
    anthropicMsgs.push({
      role: 'assistant',
      content: contentBlocks.map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text || '' }
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} }
        return b
      }),
    })
    anthropicMsgs.push({ role: 'user', content: toolResults })
  }
  if (totalTokens > 0) yield `[STREAM_META:tokens=${totalTokens}]`
}

async function* streamOpenAIWithTools(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[],
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
      const mcpId = findToolMcp(tools, tc.name)
      if (!mcpId) {
        openaiMsgs.push({ role: 'tool', tool_call_id: tc.id, content: `Tool not found: ${tc.name}` })
        continue
      }
      try {
        const result = await callTool(mcpId, tc.name, args)
        if (tc.name === 'write_file' && args.path && !result.isError) {
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
