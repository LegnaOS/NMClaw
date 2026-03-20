import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { getModel } from './model-registry.js'
import { listSkills } from './skill-registry.js'
import { getAgent, touchAgent } from './agent-manager.js'
import { getAllTools, getToolsForAgent, callTool, findToolMcp } from './mcp-runtime.js'
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
  const { agent, model, systemPrompt } = buildSystemPrompt(agentId)
  const tools = await getToolsForAgent(agent.mcpIds)

  if (model.provider === 'anthropic') {
    yield* streamAnthropicWithTools(model, systemPrompt, messages, tools)
  } else {
    yield* streamOpenAIWithTools(model, systemPrompt, messages, tools)
  }
}

async function* streamAnthropicWithTools(
  model: ModelConfig, system: string, messages: ChatMessage[], tools: ToolDef[],
): AsyncGenerator<string> {
  const params = model.config.defaultParams ?? {}
  const anthropicMsgs: any[] = messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  let totalTokens = 0
  const baseUrl = (model.config.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')
  const apiKey = getApiKey(model)

  // ── Build tool descriptions into system prompt (proxy strips native tool_use) ──
  const toolDesc = tools.map((t) => {
    const schema = t.inputSchema as any
    const props = schema?.properties
      ? Object.entries(schema.properties).map(([k, v]: [string, any]) => `    ${k}: ${v.type}${v.description ? ' — ' + v.description : ''}`).join('\n')
      : '    (无参数)'
    const required = schema?.required?.length ? `  必填: ${schema.required.join(', ')}` : ''
    return `- ${t.name}: ${t.description || ''}\n  参数:\n${props}${required ? '\n' + required : ''}`
  }).join('\n')

  const toolSystemPrompt = [
    system,
    '',
    '═══ 工具调用协议 ═══',
    '你拥有以下工具。当需要调用工具时，必须严格使用以下 XML 格式输出（可一次调用多个）：',
    '',
    '<tool_call>',
    '{"name": "工具名", "input": {"参数名": "值"}}',
    '</tool_call>',
    '',
    '规则：',
    '- 每个工具调用必须是独立的 <tool_call>...</tool_call> 块',
    '- input 必须是合法 JSON',
    '- 调用工具前可以输出思考文本',
    '- 输出工具调用后立即停止，等待结果',
    '',
    '可用工具：',
    toolDesc,
  ].join('\n')

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let data: any
    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: model.name,
          max_tokens: (params.max_tokens as number) ?? 4096,
          system: toolSystemPrompt,
          messages: anthropicMsgs,
          ...(params.temperature != null ? { temperature: params.temperature as number } : {}),
        }),
      })
      data = await res.json()
      if (!res.ok) {
        yield `\n\n[Error: ${data?.error?.message || res.statusText}]`
        break
      }
    } catch (err) {
      yield `\n\n[Error: ${err instanceof Error ? err.message : err}]`
      break
    }

    const content: any[] = data.content || []
    const text = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
    const roundTokens = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)
    totalTokens += roundTokens
    console.log(`[stream-anthropic] round=${round} text-length=${text.length}`)

    // ── Parse <tool_call> blocks from text ──
    const toolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
    const toolCalls: { name: string; input: Record<string, unknown> }[] = []
    let m
    while ((m = toolCallRegex.exec(text)) !== null) {
      try { toolCalls.push(JSON.parse(m[1])) } catch { /* skip malformed */ }
    }

    // ── Yield text without <tool_call> blocks ──
    const cleanText = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
    if (cleanText) yield cleanText

    if (toolCalls.length === 0) {
      console.log(`[stream-anthropic] no tool calls found, done`)
      break
    }

    console.log(`[stream-anthropic] found ${toolCalls.length} tool call(s): ${toolCalls.map(tc => tc.name).join(', ')}`)

    // ── Execute tools ──
    const resultParts: string[] = []
    for (const tc of toolCalls) {
      yield `[TOOL_CALL:${tc.name}]`

      // Special handling: dispatch_to_agent streams worker output in real-time
      if (tc.name === 'dispatch_to_agent') {
        const targetId = (tc.input as any)?.agentId as string
        const prompt = (tc.input as any)?.prompt as string
        if (!targetId || !prompt) {
          yield `[TOOL_RESULT:${tc.name}|Error: 缺少 agentId 或 prompt]`
          resultParts.push(`[${tc.name}] Error: 缺少 agentId 或 prompt`)
          continue
        }
        const targetAgent = getAgent(targetId)
        const agentName = targetAgent?.name || targetId

        yield `[DISPATCH_START:${targetId}|${agentName}]`
        let workerOutput = ''
        try {
          for await (const chunk of streamTask(targetId, [{ role: 'user' as const, content: prompt }])) {
            // Forward tool markers from worker so UI can show worker's tool usage
            if (chunk.startsWith('[TOOL_CALL:') || chunk.startsWith('[TOOL_RESULT:') ||
                chunk.startsWith('[FILE_OUTPUT:')) {
              yield chunk
              continue
            }
            // Skip meta markers
            if (chunk.startsWith('[STREAM_META:') || chunk.startsWith('[AGENT_INFO:') ||
                chunk.startsWith('[DISPATCH_START:') || chunk.startsWith('[DISPATCH_END:')) continue
            const clean = chunk.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
            if (clean) {
              workerOutput += clean
              yield clean
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
        resultParts.push(`[${agentName} 的回复]\n${workerOutput.trim() || '(无回复)'}`)
        continue
      }

      const mcpId = findToolMcp(tools, tc.name)
      if (!mcpId) {
        resultParts.push(`[${tc.name}] Error: 工具未找到`)
        continue
      }
      try {
        const result = await callTool(mcpId, tc.name, tc.input || {})
        if (tc.name === 'write_file' && (tc.input as any)?.path && !result.isError) {
          yield `[FILE_OUTPUT:${(tc.input as any).path}]`
        }
        yield `[TOOL_RESULT:${tc.name}|${toolResultPreview(result.content)}]`
        resultParts.push(`[${tc.name}] ${result.isError ? 'Error: ' : ''}${result.content}`)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        yield `[TOOL_RESULT:${tc.name}|Error: ${errMsg}]`
        resultParts.push(`[${tc.name}] Error: ${errMsg}`)
      }
    }

    // ── Feed results back as text messages ──
    anthropicMsgs.push({ role: 'assistant', content: text })
    anthropicMsgs.push({ role: 'user', content: `工具执行结果：\n\n${resultParts.join('\n\n')}` })
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
