import { openAIThinkingOptions } from '../shared/model-thinking';
import { relayFetch, type RelayTransport } from './relay-tls';
import {connectionKey, optionalKeyFetch} from './optional-api-key';
import { runHooks, hooksEnabled } from './hooks-runner';
import { redactSettingsSecrets } from './settings-redaction';
/**
 * OpenAI-compatible Chat Completions API bridge.
 *
 * Mirrors claude-api-bridge.ts for providers that expose the OpenAI chat
 * completions protocol (OpenAI, OpenRouter, Together, Groq, etc.).
 */

import OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import { readSettings } from './main';
import { getToolDefinitions, ASKUSER_EMPTY_RETRY_MSG, normalizeAskUserInput, normalizeToolName } from './api-tool-defs';
import { executeTool } from './api-tool-executor';
import { buildSystemPrompt } from './api-system-prompt';
import { buildSkillIndex } from './skills';
import { beginRecord } from './request-monitor';
import { manageContext } from './context-manager';
import { RawCaptureHub, type RawCapture } from './utils/raw-capture';
import { getApiHeaders } from './utils/api-user-agent';
import { decryptSecret } from './sandbox/secrets';
import { CHARS_PER_TOKEN } from './context-manager';
import type { UsageStats, MonitorContext, Interjection } from '../shared/types';
import { runtimeConfig } from '../shared/runtime-config';
import { applyCachedModelCost, getModelPriceCache } from './model-price-cache';

/** Only recognised providers receive non-standard thinking parameters. */

/** Model-specific input limits (characters). Leave safety margin for tools/system/JSON overhead. */
export function getModelInputLimit(model: string): number {
  const m = model.toLowerCase();
  // Qwen models (Alibaba) — 983616 char hard limit, leave ~280K buffer
  if (m.includes('qwen')) return 700_000;
  // DeepSeek
  if (m.includes('deepseek')) return 800_000;
  // GLM (Zhipu)
  if (m.includes('glm')) return 600_000;
  // GPT-4 and similar
  if (m.includes('gpt-4')) return 900_000;
  // GPT-3.5
  if (m.includes('gpt-3')) return 700_000;
  // Default: conservative limit
  return 800_000;
}

/**
 * 检测是否是阿里云（通义千问）provider。
 * 阿里云对 assistant + tool_calls 消息有特殊要求：content 必须为 null（不能同时存在）。
 * 其他 OpenAI 兼容 provider 相反：content 必须存在（即使是空字符串）。
 */
function isQwenProvider(baseUrl?: string, model?: string): boolean {
  const s = `${baseUrl || ''} ${model || ''}`.toLowerCase();
  return s.includes('qwen') || s.includes('dashscope');
}

/**
 * Provider-specific 消息规范化。
 * - 阿里云：带 tool_calls 的 assistant 消息，content 必须为 null
 * - 其他 provider：content 必须存在（null → 空字符串）
 */
function normalizeMessagesForProvider(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  baseUrl?: string,
  model?: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const qwen = isQwenProvider(baseUrl, model);
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const am = m as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
      const hasToolCalls = !!(am.tool_calls && am.tool_calls.length > 0);
      if (qwen && hasToolCalls) {
        // 阿里云：带 tool_calls 时 content 必须不存在
        if (am.content !== null && am.content !== undefined) {
          return { ...am, content: null };
        }
        return m;
      }
      // 其他 provider：content 必须存在
      if (am.content === null || am.content === undefined) {
        return { ...am, content: '' };
      }
    }
    return m;
  });
}

export interface RunOpenAIAPIOptions {
  cwd: string;
  prompt: string;
  /** Optional conversation history for multi-turn chat. If provided, used instead of a single user message. */
  messages?: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_call_id?: string; name?: string }>;
  model?: string;
  /** 显式凭证（来自模型档案）。留空则回退到 settings（当前仅档案模式支持 openai）。 */
  apiKey?: string;
  baseUrl?: string;
  relayTransport?: RelayTransport;
  signal?: AbortSignal;
  onText?: (chunk: string) => void;
  onLog?: (line: string) => void;
  onSessionId?: (id: string) => void;
  /** 请求监控元数据（不影响行为）。 */
  monitor?: MonitorContext;
}

export interface RunOpenAIAPIResult {
  text: string;
  error?: string;
  sessionId?: string;
}

/**
 * Call an OpenAI-compatible Chat Completions endpoint with streaming.
 */
export async function runOpenAIAPI(opts: RunOpenAIAPIOptions): Promise<RunOpenAIAPIResult> {
  const settings = await readSettings();
  // 兜底：任何来源的 key 都过一遍 decryptSecret（对明文幂等），
  // 绝不允许 aes:/enc: 密文被当 API key 发出。
  const apiKey = decryptSecret(connectionKey(opts.apiKey, opts.baseUrl, settings.anthropicApiKey));

  const hub = new RawCaptureHub(relayFetch(opts.relayTransport));
  const client = new OpenAI({
    apiKey: apiKey || 'not-needed', // 本地服务（Ollama 等）不需要 API Key
    baseURL: opts.baseUrl || settings.anthropicBaseUrl || undefined,
    timeout: runtimeConfig(settings.runtimeConfig).apiRequestTimeoutMs,
    defaultHeaders: await getApiHeaders('openai'),
    fetch: optionalKeyFetch(apiKey, hub.fetch),
  });

  const model = opts.model || settings.model || 'gpt-4o';

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    opts.messages && opts.messages.length > 0
      ? opts.messages.map((m) => ({
          role: m.role as any,
          content: m.content ?? '',  // 默认兜底空字符串；provider-specific 规范化在发送前做
          tool_call_id: m.tool_call_id,
          name: m.name,
        }))
      : [{ role: 'user', content: opts.prompt }];

  // Provider-specific 规范化（阿里云 vs 其他）
  const normalizedMessages = normalizeMessagesForProvider(messages, opts.baseUrl, model);

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (opts.signal) {
    if (opts.signal.aborted) abortController.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  let collected = '';
  let responseId: string | undefined;

  const rec = beginRecord({
    source: opts.monitor?.source ?? 'other',
    mode: 'api',
    projectPath: opts.monitor?.projectPath ?? opts.cwd,
    convId: opts.monitor?.convId,
        messageId: opts.monitor?.messageId,
    specId: opts.monitor?.specId,
    label: opts.monitor?.label,
    model,
    request: { messages, maxTokens: 16384, model },
  });

  const rawCap = hub.begin();
  try {
    const stream = await client.chat.completions.create(
      {
        model,
        messages: normalizedMessages,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: abortController.signal },
    );

    for await (const chunk of stream) {
      responseId = chunk.id;
      opts.onSessionId?.(chunk.id);
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        collected += delta.content;
        opts.onText?.(delta.content);
      }
    }

    await rawCap.bodyDone;
    rec.finish({
      response: { text: collected, sessionId: responseId },
      status: 'success',
      rawRequest: rawCap.request,
      rawResponse: rawCap.response,
    });
    return { text: collected, sessionId: responseId };
  } catch (err: any) {
    if (opts.signal?.aborted) {
      rec.abort();
      return { text: collected, error: 'aborted', sessionId: responseId };
    }
    const status = err?.status ?? err?.statusCode;
    const detail = err?.error?.message ?? err?.message ?? String(err);
    const errText = redactSettingsSecrets(status ? `HTTP ${status}: ${detail}` : detail);
    // 错误场景下把原始请求/响应一并落录（含网关返回体），便于排查鉴权问题。
    await rawCap.bodyDone;
    rec.fail(errText, { rawRequest: rawCap.request, rawResponse: rawCap.response });
    return { text: collected, error: errText, sessionId: responseId };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Agentic API mode: multi-turn tool-use loop
// ═════════════════════════════════════════════════════════════════════════

export interface RunOpenAIAPIAgenticOptions {
  cwd: string;
  /** Scheduled delivery requires a completed final response, never a truncated/tool-only turn. */
  requireFinalResponse?: boolean;
  /** Full conversation history in OpenAI message format. */
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  signal?: AbortSignal;
  model?: string;
  /** 显式凭证（来自模型档案）。留空则回退到 settings。 */
  apiKey?: string;
  baseUrl?: string;
  relayTransport?: RelayTransport;
  /** 对话选择的思考强度。仅为已知支持的模型添加兼容参数。 */
  thinkingEffort?: import('../shared/types').ThinkingEffort;
  thinkingModel?: string;
  /** Permission check invoked before each tool execution. */
  canUseTool: (
    name: string,
    input: any,
    toolUseId: string,
  ) => Promise<{ allowed: boolean; updatedInput?: any; message?: string }>;
  onText: (chunk: string) => void;
  onToolUse: (info: { id: string; name: string; input: any }) => void;
  onToolResult: (info: import('../shared/types').ToolResultInfo) => void;
  onSessionId?: (id: string) => void;
  /**
   * 澄清管道：模型调用 AskUser 工具时挂起等待用户回答。
   * 返回值作为 tool_result 回填，循环无感继续。未提供时 AskUser 不可用。
   */
  askUser?: (input: any) => Promise<string>;
  allowScheduledTasks?: boolean;
  /**
   * 嵌套拆解管道（专家团模式）：模型调用 DecomposeTask 工具时，
   * 由上层生成并执行子团队计划，返回聚合结果作为 tool_result。
   * 未提供时 DecomposeTask 不下发（普通对话不可用）。
   */
  decompose?: (input: any, hookContext?: string) => Promise<string>;
  /** Tools discovered from enabled Sage MCP servers for this conversation. */
  mcpTools?: Anthropic.Tool[];
  executeMcpTool?: (name: string, input: unknown) => Promise<{ result: string; isError: boolean } | undefined>;
  /**
   * 插话注入函数：返回自上次调用以来的插话消息列表。
   * 在 agentic 循环的每个安全边界（工具结果之后、下次请求之前）调用，
   * 把插话内容注入到 messages 供 agent 参考。不停止当前执行。
   */
  interject?: () => Interjection[] | Promise<Interjection[]>;
  /**
   * 工具结果缓存（跨重试去重副作用）。
   * key = `${toolName}:${JSON.stringify(input)}`，value = 成功执行的结果字符串。
   * 当 withRetry 重试整个 agentic 循环时，已执行过的工具调用直接返回缓存结果，
   * 避免文件重复写入 / Bash 命令重复执行等非幂等副作用。
   */
  toolResultCache?: Map<string, string>;
  /**
   * P2 fix: 上下文压缩策略选项（mode / keepRecentTurns / maxTokens 等）。
   * 当前 OpenAI 路径使用内部 compressOpenAIMessages，仅参考 keepRecentTurns。
   */
  contextOptions?: import('./context-manager').ContextManagerOptions;
  /**
   * 记忆注入：由 memory.retrieveRelevantMemories() 生成的相关记忆文本段。
   * 非空时追加到 system prompt 末尾，供 agent 参考历史记忆。
   */
  memoryContext?: string;
  /** 请求监控元数据（不影响行为）。 */
  monitor?: MonitorContext;
}

export interface RunOpenAIAPIAgenticResult {
  text: string;
  /** Text from the terminal model response only; text keeps the full execution transcript. */
  finalText?: string;
  error?: string;
  usage?: UsageStats;
  /** 最后一次单请求的 usage（上下文占用口径；usage 是全轮累加，不能拿来判断窗口占比）。 */
  lastUsage?: UsageStats;
  /** 最后一次迭代的真实构建上下文估算（压缩后出体），供计量条与整理后刷新。 */
  lastEstimatedTokens?: number;
  sessionId?: string;
}

interface AccumulatedToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export async function runOpenAIAPIAgentic(
  opts: RunOpenAIAPIAgenticOptions,
): Promise<RunOpenAIAPIAgenticResult> {
  const settings = await readSettings();
  const runtime = runtimeConfig(settings.runtimeConfig);
  // 兜底：同上，密文绝不允许被当 API key 发出。
  const apiKey = decryptSecret(connectionKey(opts.apiKey, opts.baseUrl, settings.anthropicApiKey));

  const hub = new RawCaptureHub(relayFetch(opts.relayTransport));
  const client = new OpenAI({
    apiKey: apiKey || 'not-needed', // 本地服务（Ollama 等）不需要 API Key
    baseURL: opts.baseUrl || settings.anthropicBaseUrl || undefined,
    timeout: runtime.apiRequestTimeoutMs,
    defaultHeaders: await getApiHeaders('openai'),
    fetch: optionalKeyFetch(apiKey, hub.fetch),
  });

  const model = opts.model || settings.model || 'gpt-4o';
  const skillIndex = await buildSkillIndex(opts.cwd);
  const tools = toOpenAITools(
    // 未接澄清管道时不下发 AskUser，避免模型调用后无人应答；
    // 项目没有 skill 时不下发 Skill（与 CLI 原生路径行为一致）。
    getToolDefinitions().filter((t) => {
      if (t.name === 'ScheduledTask') return !!opts.askUser && !!opts.allowScheduledTasks;
      if (t.name === 'AskUser') return !!opts.askUser;
      if (t.name === 'Skill') return !!skillIndex;
      if (t.name === 'DecomposeTask') return !!opts.decompose;
      return true;
    }).concat(opts.mcpTools ?? []),
  );
  const system = buildSystemPrompt(opts.cwd, skillIndex, opts.memoryContext);

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (opts.signal) {
    if (opts.signal.aborted) abortController.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    ...opts.messages,
  ];
  const totalUsage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
  await getModelPriceCache();
  let collectedText = '';
  let lastResponseId: string | undefined;
  // 最近一次单请求的 usage：供 UI 显示当前上下文占用（区别于全轮累加的 totalUsage）。
  let lastUsage: UsageStats | undefined;
  let lastEstimatedTokens: number | undefined;
  let iterRec: ReturnType<typeof beginRecord> | null = null;
  // 当前迭代的 HTTP 原始数据捕获容器（与 iterRec 一一对应）。
  let iterRaw: RawCapture | null = null;

  try {
    for (let iter = 0; iter < runtime.maxAgenticIterations; iter++) {
      if (abortController.signal.aborted) {
        return { text: collectedText, error: 'aborted', usage: totalUsage, lastUsage, lastEstimatedTokens, sessionId: lastResponseId };
      }

      // Context governance: compress if exceeding the configured window.
      // 优先使用用户/对话级配置的 maxTokens（全局 contextWindowSize 会透传到这里）；
      // 未配置时才回退到模型硬编码上限，保证 UI 里选的 200k/400k/1M 真正生效。
      const userTokenLimit = opts.contextOptions?.maxTokens;
      const inputLimit = userTokenLimit
        ? Math.ceil(userTokenLimit * CHARS_PER_TOKEN)
        : getModelInputLimit(model);
      let managedMessages = messages;
      const bodySize = JSON.stringify(messages).length;
      lastEstimatedTokens = Math.ceil(bodySize / CHARS_PER_TOKEN);

      if (bodySize > inputLimit * 0.9) {
        // Aggressive compression: truncate older tool results and compress text,
        // then evict oldest complete turns if still over budget.
        if(opts.contextOptions?.extension){
          const {compactWithExtension}=await import('./plugins/context-extension');
          managedMessages=await compactWithExtension(opts.cwd,opts.contextOptions.extension,messages,inputLimit);
        }
        managedMessages = compressOpenAIMessages(managedMessages, inputLimit, opts.contextOptions?.keepRecentTurns);
        const afterBodySize = JSON.stringify(managedMessages).length;
        lastEstimatedTokens = Math.ceil(afterBodySize / CHARS_PER_TOKEN);
        if (afterBodySize !== bodySize) {
          await opts.contextOptions?.onAudit?.({
            trigger: 'automatic',
            mode: opts.contextOptions?.mode ?? 'auto',
            summaryStrategy: opts.contextOptions?.summaryStrategy ?? 'auto',
            // OpenAI 路径超窗固定 aggressive 本地压缩（无 LLM 摘要）：配置 auto 时存档真实行为
            resolvedMode: (opts.contextOptions?.mode ?? 'auto') === 'auto' ? 'aggressive' : undefined,
            resolvedSummaryStrategy: (opts.contextOptions?.summaryStrategy ?? 'auto') === 'auto' ? 'truncate' : undefined,
            contentKind: 'chat',
            reason: `openai body=${bodySize}; limit=${inputLimit}`,
            beforeBodyChars: bodySize,
            afterBodyChars: afterBodySize,
            beforeEstimatedTokens: Math.ceil(bodySize / CHARS_PER_TOKEN),
            afterEstimatedTokens: Math.ceil(afterBodySize / CHARS_PER_TOKEN),
            compactedMessages: Math.max(0, messages.length - managedMessages.length),
            keptRecentTurns: opts.contextOptions?.keepRecentTurns,
            status: 'compacted',
          });
        }
      }

      iterRec = beginRecord({
        source: opts.monitor?.source ?? 'other',
        mode: 'api',
        projectPath: opts.monitor?.projectPath ?? opts.cwd,
        convId: opts.monitor?.convId,
        messageId: opts.monitor?.messageId,
        specId: opts.monitor?.specId,
        label: opts.monitor?.label,
        model,
        request: {
          system,
          messages: managedMessages,
          toolNames: tools.map((t) => (t as any).function?.name).filter(Boolean),
          maxTokens: 16384,
          model,
          iteration: iter,
        },
      });

      let iterText = '';
      const toolCallBuffers: Record<number, AccumulatedToolCall> = {};
      let finishReason: string | undefined;

      iterRaw = hub.begin();
      // Provider-specific 规范化在发送前统一处理：
      // - 阿里云：带 tool_calls 的 assistant 消息 content 必须为 null
      // - 其他 provider：content 必须存在（null → 空字符串）
      const finalMessages = normalizeMessagesForProvider(managedMessages, opts.baseUrl, model);
      const thinking = openAIThinkingOptions(opts.thinkingModel ?? model, opts.thinkingEffort);
      const stream = await client.chat.completions.create(
        {
          model,
          messages: finalMessages,
          tools: tools.length > 0 ? (tools as any) : undefined,
          stream: true,
          stream_options: { include_usage: true },
          ...thinking,
        } as any,
        { signal: abortController.signal },
      ) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

      for await (const chunk of stream) {
        lastResponseId = chunk.id;
        opts.onSessionId?.(chunk.id);
        const choice = chunk.choices[0];
        const delta = choice?.delta;
        finishReason = choice?.finish_reason ?? finishReason;

        if (delta?.content) {
          collectedText += delta.content;
          iterText += delta.content;
          opts.onText(delta.content);
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallBuffers[idx]) toolCallBuffers[idx] = {};
            const buf = toolCallBuffers[idx];
            if (tc.id) buf.id = tc.id;
            if (tc.type) buf.type = tc.type;
            if (tc.function) {
              if (!buf.function) buf.function = {};
              if (tc.function.name) buf.function.name = (buf.function.name ?? '') + tc.function.name;
              if (tc.function.arguments) {
                buf.function.arguments = (buf.function.arguments ?? '') + tc.function.arguments;
              }
            }
          }
        }

        // OpenAI sends usage in the final chunk with choices=[]
        if (chunk.usage) {
          totalUsage.inputTokens += chunk.usage.prompt_tokens ?? 0;
          totalUsage.outputTokens += chunk.usage.completion_tokens ?? 0;
          totalUsage.cacheReadTokens += (chunk.usage as any).prompt_tokens_details?.cached_tokens ?? 0;
          applyCachedModelCost(model, totalUsage);
          lastUsage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            // OpenAI 兼容网关把缓存命中放在 prompt_tokens_details 里（prompt_tokens 已含）
            cacheReadTokens: (chunk.usage as any).prompt_tokens_details?.cached_tokens ?? 0,
            cacheCreationTokens: 0,
            costUsd: 0,
          };
          // Persist the cost for this individual request as well as the
          // conversation total, so analytics can sum actual calls later.
          applyCachedModelCost(model, lastUsage);
        }
      }

      // Finalize accumulated tool calls
      const toolCalls = Object.values(toolCallBuffers).filter(
        (tc): tc is Required<Pick<AccumulatedToolCall, 'id' | 'type' | 'function'>> & {
          id: string;
          type: string;
          function: { name: string; arguments: string };
        } => !!(tc.id && tc.type && tc.function?.name && tc.function?.arguments),
      );

      await iterRaw.bodyDone;
      iterRec.finish({
        response: {
          text: iterText,
          stopReason: finishReason ?? undefined,
          toolUses: toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            input: safeParse(tc.function.arguments),
          })),
          sessionId: lastResponseId,
        },
        status: 'success',
        rawRequest: iterRaw.request,
        rawResponse: iterRaw.response,
      });
      iterRec = null;
      iterRaw = null;

      // Append assistant message to history.
      // 默认永远提供 content（空字符串兜底）。
      // Provider-specific 规范化（阿里云 vs 其他）在发送前统一处理。
      const asstMessage: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: iterText || '',
      };
      if (toolCalls.length > 0) {
        asstMessage.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: tc.type as 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }
      messages.push(asstMessage);

      if (finishReason !== 'tool_calls' && finishReason !== 'function_call') {
        if (opts.requireFinalResponse && (toolCalls.length > 0 || (finishReason && finishReason !== 'stop'))) {
          return { text: collectedText, error: `Scheduled task did not finish with a complete final response (${finishReason ?? 'unexpected tool response'})`, usage: totalUsage, lastUsage, lastEstimatedTokens, sessionId: lastResponseId };
        }
        return { text: collectedText, finalText: iterText, usage: totalUsage, lastUsage, lastEstimatedTokens, sessionId: lastResponseId };
      }

      if (toolCalls.length === 0) {
        return { text: collectedText, ...(opts.requireFinalResponse ? { error: 'Scheduled task returned a tool response without executable tool calls' } : {}), usage: totalUsage, lastUsage, lastEstimatedTokens, sessionId: lastResponseId };
      }

      // Process each tool call: permission check + execute
      for (const tc of toolCalls) {
        if (abortController.signal.aborted) break;

        let input: any;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = {};
        }

        // 归一化工具名：不同模型会把工具名变体化（如 AskUserQuestion → AskUser），
        // 否则 AskUser 挂起分支精确匹配失败，落到 executor 报 Unknown tool。
        const toolName = normalizeToolName(tc.function.name);

        await opts.onToolUse({ id: tc.id, name: toolName, input });

        // Models can emit tools omitted from the request, especially from history.
        if ((toolName === 'AskUser' && !opts.askUser) || (toolName === 'ScheduledTask' && (!opts.askUser || !opts.allowScheduledTasks))) {
          const result = 'This run cannot request interactive clarification or change scheduled tasks. Execute only the already-confirmed instructions. If required information is missing, report the missing information and stop; do not create another schedule or claim user confirmation.';
          await opts.onToolResult({id:tc.id,result,isError:true});
          messages.push({role:'tool',tool_call_id:tc.id,content:result});
          continue;
        }

        // 澄清工具：跳过权限门，直接挂起等用户回答
        if ((toolName === 'AskUser' || toolName === 'ScheduledTask') && opts.askUser) {
          // 空问题防御：question 为空时不挂起（否则甩空卡片给用户），
          // 回填错误文案逼模型补全问题后重新调用。
          const normalized = normalizeAskUserInput(toolName === 'ScheduledTask' ? {scheduledTask:input} : input);
          if (!normalized.question || normalized.question === '(无问题内容)') {
            await opts.onToolResult({ id: tc.id, result: ASKUSER_EMPTY_RETRY_MSG });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: ASKUSER_EMPTY_RETRY_MSG });
            continue;
          }
          let answer: string;
          try {
            answer = await opts.askUser(normalized);
          } catch (err: any) {
            answer = `(澄清被取消: ${err?.message ?? 'aborted'})`;
          }
          await opts.onToolResult({ id: tc.id, result: answer });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: answer });
          continue;
        }

        // 嵌套拆解工具（专家团模式）：跳过权限门，交给上层生成子团队计划
        if (toolName === 'DecomposeTask' && opts.decompose) {
          // Hooks：SubagentStart（可补充上下文，不能阻止启动）/ SubagentStop（补充信息）
          const hooksOn = await hooksEnabled();
          let subContext = '';
          if (hooksOn) {
            const role = String((input as any)?.role ?? (input as any)?.expert ?? 'subagent');
            const h0 = await runHooks('SubagentStart', { projectPath: opts.cwd, convId: opts.monitor?.convId, enabled: true, subject: role, payloadExtra: { agent_type: role } });
            if (h0.additionalContext) subContext = h0.additionalContext;
          }
          let answer: string;
          try {
            answer = await opts.decompose(input, subContext);
          } catch (err: any) {
            answer = `(子团队执行失败: ${err?.message ?? String(err)})`;
          }
          if (hooksOn) {
            const role = String((input as any)?.role ?? (input as any)?.expert ?? 'subagent');
            await runHooks('SubagentStop', { projectPath: opts.cwd, convId: opts.monitor?.convId, enabled: true, subject: role, payloadExtra: { agent_type: role, response: answer.slice(0, 4000) } });
          }
          await opts.onToolResult({ id: tc.id, result: answer });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: answer });
          continue;
        }

        let decision;
        try {
          decision = await opts.canUseTool(toolName, input, tc.id);
        } catch (err: any) {
          decision = { allowed: false, message: err?.message ?? 'permission check failed' };
        }

        let toolFailed = !decision.allowed;
        let fileChanges: import('../shared/file-changes').FileChange[] | undefined;
        let images: import('../shared/types').ImageAttachment[] | undefined;
        const resultText = decision.allowed
          ? (() => {
              const effectiveInput = decision.updatedInput ?? input;
              const cacheKey = toolName !== 'Desktop' && opts.toolResultCache
                ? `${toolName}:${JSON.stringify({ ...effectiveInput, __sageApproval: undefined })}`
                : '';
              const cached = toolName === 'Desktop' ? undefined : opts.toolResultCache?.get(cacheKey);
              if (cached !== undefined) return cached;
              const mcpResult = opts.executeMcpTool?.(toolName, effectiveInput);
              if (mcpResult) return mcpResult.then((mcp) => {
                if (!mcp) return executeTool(toolName, effectiveInput, opts.cwd, opts.signal, opts.monitor?.convId).then((r) => {
                  toolFailed = !!r.isError;
                  fileChanges = r.fileChanges;
                if (toolName === 'Desktop') images = r.images;
                  if (toolName !== 'Desktop' && !r.isError && opts.toolResultCache) opts.toolResultCache.set(cacheKey, r.result);
                  return r.result;
                });
                toolFailed = mcp.isError;
                if (toolName !== 'Desktop' && !mcp.isError && opts.toolResultCache) opts.toolResultCache.set(cacheKey, mcp.result);
                return mcp.result;
              });
              return executeTool(toolName, effectiveInput, opts.cwd, opts.signal, opts.monitor?.convId).then((r) => {
                toolFailed = !!r.isError;
                fileChanges = r.fileChanges;
                if (toolName === 'Desktop') images = r.images;
                if (toolName !== 'Desktop' && !r.isError && opts.toolResultCache) {
                  opts.toolResultCache.set(cacheKey, r.result);
                }
                return r.result;
              });
            })()
          : (decision.message ?? '用户拒绝了这次工具调用');

        const resolved = await resultText;
        await opts.onToolResult({ id: tc.id, result: resolved, isError: toolFailed, fileChanges, images });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resolved,
        });
      }

      // ── 插话注入：在下一个安全执行边界（工具结果之后、下次请求之前）
      // 把用户插话的消息注入到 messages，供 agent 在下一轮请求时参考。
      // 不停止当前执行，agent 看到后可以据此调整后续行为。
      if (opts.interject) {
        for (const inj of await opts.interject()) {
          // 文字与图片同属一个整体：有图时拼成多模态 content 数组，否则保持纯文本
          if (inj.images && inj.images.length > 0) {
            messages.push({
              role: 'user',
              content: [
                { type: 'text', text: `[用户插话，请立即参考并调整后续行为] ${inj.text}` },
                ...inj.images.map((img) => ({ type: 'image_url' as const, image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` } })),
              ],
            });
          } else {
            messages.push({ role: 'user', content: `[用户插话，请立即参考并调整后续行为] ${inj.text}` });
          }
        }
      }
    }

    return {
      text: collectedText + '\n\n[reached max agentic iterations]',
      ...(opts.requireFinalResponse ? { error: 'Scheduled task reached the maximum tool iterations before a final response' } : {}),
      usage: totalUsage,
      lastUsage,
      lastEstimatedTokens,
      sessionId: lastResponseId,
    };
  } catch (err: any) {
    if (opts.signal?.aborted || abortController.signal.aborted) {
      iterRec?.abort();
      return { text: collectedText, error: 'aborted', usage: totalUsage, lastEstimatedTokens, sessionId: lastResponseId };
    }
    const status = err?.status ?? err?.statusCode;
    const detail = err?.error?.message ?? err?.message ?? String(err);
    const errText = redactSettingsSecrets(status ? `HTTP ${status}: ${detail}` : detail);
    if (iterRec) {
      // 错误场景（如 401）把网关返回体一并落录，便于排查鉴权问题。
      await iterRaw?.bodyDone;
      iterRec.fail(errText, { rawRequest: iterRaw?.request, rawResponse: iterRaw?.response });
    }
    return { text: collectedText, error: errText, usage: totalUsage, lastUsage, lastEstimatedTokens, sessionId: lastResponseId };
  } finally {
    if(opts.monitor?.convId)await (await import('./browser-agent')).releaseConversationBrowser(opts.cwd, opts.monitor.convId);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Compress OpenAI message history to fit within input limit.
 * Strategy:
 *   1. Keep the last `keepRecentTurns` complete turns verbatim.
 *   2. Truncate older turns aggressively (tool results / text capped).
 *   3. If still over budget, evict the oldest complete turns entirely.
 *
 * A "turn" starts at every user message and ends before the next user message.
 * We only evict complete turns to preserve tool_call_id / tool_call contracts.
 */
export function compressOpenAIMessages(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  inputLimit: number,
  keepRecentTurns?: number,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const TOOL_RESULT_CAP = 8_000; // Max chars for old tool results
  const TEXT_CAP = 12_000; // Max chars for old text content
  const TARGET = Math.ceil(inputLimit * 0.9);

  const turnStarts = findTurnStarts(messages);
  const recentCount = Math.min(keepRecentTurns ?? 6, turnStarts.length);
  if (recentCount <= 0) {
    // 没有完整轮次可保留，直接全部截断
    return messages.map((m) => truncateMessage(m, TEXT_CAP));
  }

  // 保留最近 N 轮 verbatim；其余视为可压缩/可丢弃的老轮次
  const recentStartIdx = turnStarts[turnStarts.length - recentCount];
  let oldMessages = messages.slice(0, recentStartIdx);
  const recentMessages = messages.slice(recentStartIdx);

  // 先对老轮次做 aggressive truncation
  oldMessages = oldMessages.map((m) => {
    if (m.role === 'tool') {
      return {
        ...m,
        content: typeof m.content === 'string'
          ? truncateString(m.content, TOOL_RESULT_CAP)
          : m.content,
      };
    }
    return truncateMessage(m, TEXT_CAP);
  });

  // 如果截断后仍超预算，从最早轮次开始整轮丢弃
  let result = [...oldMessages, ...recentMessages];
  while (oldMessages.length > 0 && estimateBodySize(result) > TARGET) {
    const firstTurnEnd = findNextTurnStart(oldMessages, 1);
    if (firstTurnEnd <= 0 || firstTurnEnd >= oldMessages.length) break;
    oldMessages = oldMessages.slice(firstTurnEnd);
    result = [...oldMessages, ...recentMessages];
  }

  return result;
}

/** Find indices of user messages (turn starts) in OpenAI message array. */
function findTurnStarts(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') out.push(i);
  }
  return out;
}

/** Find the index of the next turn start at or after `from`. Returns -1 if none. */
function findNextTurnStart(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[], from: number): number {
  for (let i = from; i < messages.length; i++) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

function estimateBodySize(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): number {
  try {
    return JSON.stringify(messages).length;
  } catch {
    return 0;
  }
}

function truncateMessage(
  msg: OpenAI.Chat.Completions.ChatCompletionMessageParam,
  cap: number,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (typeof msg.content === 'string') {
    return { ...msg, content: truncateString(msg.content, cap) };
  }
  // Array content (text blocks, tool calls, etc.) - keep as is
  return msg;
}

function truncateString(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const head = Math.floor(cap * 0.7);
  const tail = Math.floor(cap * 0.2);
  return `${s.slice(0, head)}\n\n[... truncated ${s.length - head - tail} chars ...]\n\n${s.slice(-tail)}`;
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Convert Anthropic-style tool definitions to OpenAI function tools. */
function toOpenAITools(tools: any[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: any } }> {
  return tools
    .filter((t) => t?.name)
    .map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
}
