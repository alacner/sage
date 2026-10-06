import { claudeThinkingOptions } from '../shared/model-thinking';
import { relayFetch, type RelayTransport } from './relay-tls';
import {connectionKey, optionalKeyFetch} from './optional-api-key';
import { runHooks, hooksEnabled } from './hooks-runner';
import {runEngineTask} from './engine-task';
import {selectedEngine} from './engine-registry';
import { redactSettingsSecrets } from './settings-redaction';
/**
 * Direct Anthropic API bridge for plan-mode operations.
 *
 * When an API key is configured in settings, plan-mode calls (spec generation,
 * retro analysis, wiki generation, etc.) route through this module instead of
 * spawning the `claude` CLI subprocess.
 *
 * This module also implements `runClaudeAPIAgentic` — an agentic tool-use
 * loop against the Messages API, used by conv-engine when the Claude CLI is
 * not available. It provides Read/Write/Edit/Glob/Grep/Bash/WebFetch tools
 * defined in api-tool-defs.ts and executed via api-tool-executor.ts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readSettings } from './main';
import { runClaude, type RunClaudeOptions, type RunClaudeResult } from './claude-bridge';
import { getToolDefinitions, ASKUSER_EMPTY_RETRY_MSG, normalizeToolName, normalizeAskUserInput } from './api-tool-defs';
import { executeTool } from './api-tool-executor';
import { buildSystemPrompt } from './api-system-prompt';
import { buildSkillIndex } from './skills';
import { manageContext } from './context-manager';
import { beginRecord } from './request-monitor';
import { runOpenAIAPI } from './openai-api-bridge';
import { getApiHeaders } from './utils/api-user-agent';
import { RawCaptureHub, type RawCapture } from './utils/raw-capture';
import { decryptSecret } from './sandbox/secrets';
import type { UsageStats, MonitorContext, Interjection } from '../shared/types';
import { runtimeConfig } from '../shared/runtime-config';
import { applyCachedModelCost, getModelPriceCache } from './model-price-cache';

/** Anthropic extended thinking uses a token budget rather than a named effort. */

export interface RunClaudeAPIOptions {
  cwd: string;
  prompt: string;
  /** Optional conversation history for multi-turn chat. If provided, used instead of a single user message. */
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  permissionMode?: 'plan';
  model?: string;
  /** 显式凭证（来自模型档案）。留空则回退到 settings。 */
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

export interface RunClaudeAPIResult {
  text: string;
  error?: string;
  sessionId?: string;
}

/**
 * Call Anthropic Messages API with streaming.
 * Returns the same shape as runClaude() (minus exitCode) so spec-engine
 * and loop-engine don't need branching.
 */
export async function runClaudeAPI(opts: RunClaudeAPIOptions): Promise<RunClaudeAPIResult> {
  const settings = await readSettings();

  // 兜底：任何来源的 key 都过一遍 decryptSecret（对明文幂等），
  // 绝不允许 aes:/enc: 密文被当 API key 发出。
  const apiKey = decryptSecret(connectionKey(opts.apiKey, opts.baseUrl, settings.anthropicApiKey));

  let client: Anthropic;
  const hub = new RawCaptureHub(relayFetch(opts.relayTransport));
  try {
    client = new Anthropic({
      apiKey: apiKey || 'not-needed',
      baseURL: opts.baseUrl || settings.anthropicBaseUrl || undefined,
      timeout: runtimeConfig(settings.runtimeConfig).apiRequestTimeoutMs,
      defaultHeaders: await getApiHeaders('anthropic'),
      fetch: optionalKeyFetch(apiKey, hub.fetch),
    });
  } catch (err: any) {
    return { text: '', error: redactSettingsSecrets(`failed to create Anthropic client: ${err?.message ?? err}`) };
  }

  const model = opts.model || settings.model || 'claude-sonnet-4-20250514';

  const messages: Anthropic.MessageParam[] = opts.messages && opts.messages.length > 0
    ? opts.messages.map((m) => ({ role: m.role, content: m.content }))
    : [{ role: 'user', content: opts.prompt }];

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
    const stream = client.messages.stream(
      {
        model,
        max_tokens: 16384,
        messages,
      },
      { signal: abortController.signal },
    );

    stream.on('message', (msg) => {
      responseId = msg.id;
      opts.onSessionId?.(msg.id);
    });

    stream.on('text', (textDelta) => {
      collected += textDelta;
      opts.onText?.(textDelta);
    });

    stream.on('error', (err) => {
      opts.onLog?.(redactSettingsSecrets(`[API stream error] ${err.message}`));
    });

    await stream.done();
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
    return {
      text: collected,
      error: errText,
      sessionId: responseId,
    };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Return true when API key is configured and API path should be used. */
export async function isAPIModeAvailable(): Promise<boolean> {
  const settings = await readSettings();
  return !!settings.anthropicApiKey;
}

/**
 * Unified plan-mode call router.
 * - Non-plan modes always use CLI (runClaude).
 * - Plan mode respects preferredBackend setting:
 *   - 'cli' → always CLI
 *   - 'api' or forceApi → always API
 *   - 'auto' → API if key configured, else CLI
 */
export async function runPlanMode(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const settings=await readSettings();
  const useAPI=opts.forceApi || await selectedEngine()==='api';
  if(!useAPI)return runEngineTask(opts);
  if(opts.permissionMode!=='plan'){const result=await (await import('./spec-engine')).runTaskModel({...opts,onText:opts.onText??(()=>{})});return {...result,exitCode:result.error?1:0};}
  if (useAPI) {
    const protocol = opts.protocol || settings.apiProtocol || 'anthropic';
    if (protocol === 'openai') {
      const r = await runOpenAIAPI({
        cwd: opts.cwd,
        prompt: opts.prompt,
        model: opts.model,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        relayTransport: opts.relayTransport,
        signal: opts.signal,
        onText: opts.onText,
        onLog: opts.onLog,
        onSessionId: opts.onSessionId,
        monitor: opts.monitor,
      });
      return {
        text: r.text,
        exitCode: r.error ? 1 : 0,
        error: r.error,
        sessionId: r.sessionId,
      };
    }
    const r = await runClaudeAPI({
      cwd: opts.cwd,
      prompt: opts.prompt,
      permissionMode: 'plan',
      model: opts.model,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      relayTransport: opts.relayTransport,
      signal: opts.signal,
      onText: opts.onText,
      onLog: opts.onLog,
      onSessionId: opts.onSessionId,
      monitor: opts.monitor,
    });
    return {
      text: r.text,
      exitCode: r.error ? 1 : 0,
      error: r.error,
      sessionId: r.sessionId,
    };
  }
  throw Error('No engine selected');
}

// ═════════════════════════════════════════════════════════════════════════
// Agentic API mode: multi-turn tool-use loop
// ═════════════════════════════════════════════════════════════════════════

export interface RunClaudeAPIAgenticOptions {
  cwd: string;
  /** Scheduled delivery requires a completed final response, never a truncated/tool-only turn. */
  requireFinalResponse?: boolean;
  /** Full conversation history in Anthropic MessageParam format. */
  messages: Anthropic.MessageParam[];
  signal?: AbortSignal;
  model?: string;
  /** 显式凭证（来自模型档案）。留空则回退到 settings。 */
  apiKey?: string;
  baseUrl?: string;
  relayTransport?: RelayTransport;
  /** 对话选择的思考强度。 */
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
   * 透传给 context-manager.ts 的 manageContext。
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

export interface RunClaudeAPIAgenticResult {
  text: string;
  /** Text from the terminal model response only; text keeps the full execution transcript. */
  finalText?: string;
  error?: string;
  usage?: UsageStats;
  /** 最后一次单请求的 usage（上下文占用口径；usage 是全轮累加，不能拿来判断窗口占比）。 */
  lastUsage?: UsageStats;
  /** 最后一次迭代的真实构建上下文估算（manageContext 产出），供计量条与整理后刷新。 */
  lastEstimatedTokens?: number;
  sessionId?: string;
}

/**
 * Run a multi-turn conversation with tool-use against the Messages API.
 *
 * Each iteration:
 *   1. Stream a completion (text deltas emitted via onText)
 *   2. If stop_reason === 'tool_use', enumerate tool_use blocks
 *   3. For each: permission check → execute → emit onToolUse/onToolResult
 *   4. Append tool_result blocks as the next user message
 *   5. Loop until the model produces a text-only end_turn response
 *
 * Context governance runs before every request via manageContext():
 * older turns get compacted and eventually summarized into the system
 * prompt so the outgoing body stays under API limits.
 */
export async function runClaudeAPIAgentic(
  opts: RunClaudeAPIAgenticOptions,
): Promise<RunClaudeAPIAgenticResult> {
  const settings = await readSettings();
  const runtime = runtimeConfig(settings.runtimeConfig);
  // 兜底：同上，密文绝不允许被当 API key 发出。
  const apiKey = decryptSecret(connectionKey(opts.apiKey, opts.baseUrl, settings.anthropicApiKey));

  let client: Anthropic;
  const hub = new RawCaptureHub(relayFetch(opts.relayTransport));
  try {
    client = new Anthropic({
      apiKey: apiKey || 'not-needed',
      baseURL: opts.baseUrl || settings.anthropicBaseUrl || undefined,
      timeout: runtime.apiRequestTimeoutMs,
      defaultHeaders: await getApiHeaders('anthropic'),
      fetch: optionalKeyFetch(apiKey, hub.fetch),
    });
  } catch (err: any) {
    return { text: '', error: redactSettingsSecrets(`failed to create Anthropic client: ${err?.message ?? err}`) };
  }

  const model = opts.model || settings.model || 'claude-sonnet-4-20250514';
  const skillIndex = await buildSkillIndex(opts.cwd);
  const tools = getToolDefinitions().filter((t) => {
    // 未接澄清管道时不下发 AskUser，避免模型调用后无人应答；
    // 项目没有 skill 时不下发 Skill（与 CLI 原生路径行为一致）；
    // 未接嵌套拆解管道时不下发 DecomposeTask（仅专家团任务执行时提供）。
    if (t.name === 'ScheduledTask') return !!opts.askUser && !!opts.allowScheduledTasks;
      if (t.name === 'AskUser') return !!opts.askUser;
    if (t.name === 'Skill') return !!skillIndex;
    if (t.name === 'DecomposeTask') return !!opts.decompose;
    return true;
  }).concat(opts.mcpTools ?? []);
  const system = buildSystemPrompt(opts.cwd, skillIndex, opts.memoryContext);

  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (opts.signal) {
    if (opts.signal.aborted) abortController.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  const messages: Anthropic.MessageParam[] = [...opts.messages];
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
  // 当前迭代打开的监控记录句柄，供 catch/abort 精确收尾。
  let iterRec: ReturnType<typeof beginRecord> | null = null;
  // 当前迭代的 HTTP 原始数据捕获容器（与 iterRec 一一对应）。
  let iterRaw: RawCapture | null = null;

  try {
    for (let iter = 0; iter < runtime.maxAgenticIterations; iter++) {
      if (abortController.signal.aborted) {
        return { text: collectedText, error: 'aborted', usage: totalUsage, lastUsage, lastEstimatedTokens, sessionId: lastResponseId };
      }

      // Context governance: apply layered compaction + summarization so the
      // outgoing body stays under Anthropic body/token limits.
   const managed = await manageContext(messages, system, opts.contextOptions);
   lastEstimatedTokens = managed.estimatedTokens;
   if (managed.strategyDecision) console.info('[context-auto]', JSON.stringify(managed.strategyDecision));

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
          system: managed.system,
          messages: managed.messages,
          toolNames: tools.map((t) => t.name),
          maxTokens: 16384,
          model,
          iteration: iter,
        },
      });

      let iterText = '';
      iterRaw = hub.begin();
      const thinking = claudeThinkingOptions(opts.thinkingModel ?? model, opts.thinkingEffort);
      const stream = client.messages.stream(
        {
          model,
          max_tokens: 16384,
          system: managed.system,
          messages: managed.messages,
          tools,
          ...thinking,
        } as any,
        { signal: abortController.signal },
      );

      stream.on('text', (delta) => {
        collectedText += delta;
        iterText += delta;
        opts.onText(delta);
      });

      const finalMessage = await stream.finalMessage();
      lastResponseId = finalMessage.id;
      opts.onSessionId?.(finalMessage.id);

      // Accumulate usage
      const u = finalMessage.usage;
      const iterUsage: UsageStats = {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
        costUsd: 0,
      };
      if (u) {
        // Keep the monitor record priced independently. A turn may contain
        // several iterations with different models or price snapshots.
        applyCachedModelCost(model, iterUsage);
        totalUsage.inputTokens += iterUsage.inputTokens;
        totalUsage.outputTokens += iterUsage.outputTokens;
        totalUsage.cacheReadTokens += iterUsage.cacheReadTokens;
        totalUsage.cacheCreationTokens += iterUsage.cacheCreationTokens;
        applyCachedModelCost(model, totalUsage);
        // Anthropic excludes cache reads/writes from input_tokens; context occupancy includes all three.
        lastUsage = { ...iterUsage, inputTokens: iterUsage.inputTokens + iterUsage.cacheReadTokens + iterUsage.cacheCreationTokens };
      }

      // 收尾本次迭代记录：捕获文本 + tool_use 块 + usage + stop_reason + HTTP 原始数据
      const toolUses = finalMessage.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      await iterRaw.bodyDone;
      iterRec.finish({
        response: {
          text: iterText,
          stopReason: finalMessage.stop_reason ?? undefined,
          toolUses,
          sessionId: finalMessage.id,
        },
        usage: iterUsage,
        status: 'success',
        rawRequest: iterRaw.request,
        rawResponse: iterRaw.response,
      });
      iterRec = null;
      iterRaw = null;

      // Append assistant response to history
      messages.push({
        role: 'assistant',
        content: finalMessage.content,
      });

      if (finalMessage.stop_reason !== 'tool_use') {
        if (opts.requireFinalResponse && (toolUses.length > 0 || (finalMessage.stop_reason && !['end_turn', 'stop_sequence'].includes(finalMessage.stop_reason)))) {
          return { text: collectedText, error: `Scheduled task did not finish with a complete final response (${finalMessage.stop_reason ?? 'unexpected tool response'})`, usage: totalUsage, lastUsage, lastEstimatedTokens, sessionId: lastResponseId };
        }
        return { text: collectedText, finalText: iterText, usage: totalUsage, lastUsage, lastEstimatedTokens, sessionId: lastResponseId };
      }

      // Process each tool_use block: permission check + execute
      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
      for (const block of finalMessage.content) {
        if (block.type !== 'tool_use') continue;
        if (abortController.signal.aborted) break;

        // 归一化工具名：不同模型会把工具名变体化（如 AskUserQuestion → AskUser），
        // 否则 AskUser 挂起分支精确匹配失败，落到 executor 报 Unknown tool。
        const toolName = normalizeToolName(block.name);

        // Emit onToolUse so the UI shows the tool card
        await opts.onToolUse({ id: block.id, name: toolName, input: block.input });

        // Models can emit tools omitted from the request, especially from history.
        if ((toolName === 'AskUser' && !opts.askUser) || (toolName === 'ScheduledTask' && (!opts.askUser || !opts.allowScheduledTasks))) {
          const result = 'This run cannot request interactive clarification or change scheduled tasks. Execute only the already-confirmed instructions. If required information is missing, report the missing information and stop; do not create another schedule or claim user confirmation.';
          await opts.onToolResult({id:block.id,result,isError:true});
          toolResultBlocks.push({type:'tool_result',tool_use_id:block.id,content:result,is_error:true});
          continue;
        }

        // 澄清工具：跳过权限门，直接挂起等用户回答
        if ((toolName === 'AskUser' || toolName === 'ScheduledTask') && opts.askUser) {
          // 空问题防御：question 为空时不挂起（否则甩空卡片给用户），
          // 退回 is_error 结果逼模型补全问题后重新调用。
          const normalized = normalizeAskUserInput(toolName === 'ScheduledTask' ? {scheduledTask:block.input} : block.input);
          if (!normalized.question) {
            await opts.onToolResult({ id: block.id, result: ASKUSER_EMPTY_RETRY_MSG });
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: ASKUSER_EMPTY_RETRY_MSG,
              is_error: true,
            });
            continue;
          }
          let answer: string;
          try {
            answer = await opts.askUser(normalized);
          } catch (err: any) {
            answer = `(澄清被取消: ${err?.message ?? 'aborted'})`;
          }
          await opts.onToolResult({ id: block.id, result: answer });
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: answer,
          });
          continue;
        }

        // 嵌套拆解工具（专家团模式）：跳过权限门，交给上层生成子团队计划
        if (toolName === 'DecomposeTask' && opts.decompose) {
          // Hooks：SubagentStart（可补充上下文，不能阻止启动）/ SubagentStop（补充信息）
          const hooksOn = await hooksEnabled();
          let subContext = '';
          if (hooksOn) {
            const role = String((block.input as any)?.role ?? (block.input as any)?.expert ?? 'subagent');
            const h0 = await runHooks('SubagentStart', { projectPath: opts.cwd, convId: opts.monitor?.convId, enabled: true, subject: role, payloadExtra: { agent_type: role } });
            if (h0.additionalContext) subContext = h0.additionalContext;
          }
          let answer: string;
          try {
            answer = await opts.decompose(block.input, subContext);
          } catch (err: any) {
            answer = `(子团队执行失败: ${err?.message ?? String(err)})`;
          }
          if (hooksOn) {
            const role = String((block.input as any)?.role ?? (block.input as any)?.expert ?? 'subagent');
            await runHooks('SubagentStop', { projectPath: opts.cwd, convId: opts.monitor?.convId, enabled: true, subject: role, payloadExtra: { agent_type: role, response: answer.slice(0, 4000) } });
          }
          await opts.onToolResult({ id: block.id, result: answer });
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: answer,
          });
          continue;
        }

        // Permission gate
        let decision;
        try {
          decision = await opts.canUseTool(toolName, block.input, block.id);
        } catch (err: any) {
          decision = { allowed: false, message: err?.message ?? 'permission check failed' };
        }

        if (!decision.allowed) {
          const msg = decision.message ?? '用户拒绝了这次工具调用';
          await opts.onToolResult({ id: block.id, result: msg, isError: true });
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: msg,
            is_error: true,
          });
          continue;
        }

        // Execute the tool locally (with dedup cache for retry safety)
        const effectiveInput = decision.updatedInput ?? block.input;
        const cacheKey = toolName !== 'Desktop' && opts.toolResultCache
          ? `${toolName}:${JSON.stringify({ ...effectiveInput, __sageApproval: undefined })}`
          : '';
        const cached = toolName === 'Desktop' ? undefined : opts.toolResultCache?.get(cacheKey);
        const mcpResult = cached === undefined ? await opts.executeMcpTool?.(toolName, effectiveInput) : undefined;
        const execResult = cached !== undefined
          ? { result: cached, isError: false }
          : mcpResult ?? await executeTool(toolName, effectiveInput, opts.cwd, opts.signal, opts.monitor?.convId);
        if (toolName !== 'Desktop' && cached === undefined && !execResult.isError && opts.toolResultCache) {
          opts.toolResultCache.set(cacheKey, execResult.result);
        }
        await opts.onToolResult({ id: block.id, result: execResult.result, isError: execResult.isError, fileChanges: 'fileChanges' in execResult ? execResult.fileChanges : undefined, images: toolName === 'Desktop' && 'images' in execResult ? execResult.images : undefined });
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: execResult.result,
          is_error: execResult.isError,
        });
      }

      // ── 插话注入：在下一个安全执行边界（工具结果之后、下次请求之前）
      // 把用户插话的消息注入到 messages，供 agent 在下一轮请求时参考。
      // 不停止当前执行，agent 看到后可以据此调整后续行为。
      //
      // 注意：Anthropic API 要求 user/assistant 严格交替，不能推两条连续的
      // user 消息，否则 400。因此把插话作为 text block 合并进工具结果的
      // 那条 user 消息里。
      const interjectionBlocks: Anthropic.ContentBlockParam[] = [];
      if (opts.interject && toolResultBlocks.length > 0) {
        for (const inj of await opts.interject()) {
          interjectionBlocks.push({
            type: 'text',
            text: `[用户插话，请立即参考并调整后续行为] ${inj.text}`,
          });
          // 插话中的图片与文字同属一个整体：一并作为 image block 注入
          for (const img of inj.images ?? []) {
            interjectionBlocks.push({
              type: 'image',
              source: { type: 'base64', media_type: img.mimeType as 'image/png', data: img.dataBase64 },
            });
          }
        }
      }

      if (toolResultBlocks.length === 0) {
        // A scheduled tool-only response is not a completed recipient result.
        return { text: collectedText, ...(opts.requireFinalResponse ? { error: 'Scheduled task returned a tool response without executable tool calls' } : {}), usage: totalUsage, lastUsage, lastEstimatedTokens, sessionId: lastResponseId };
      }

      // Append tool results (+ 插话 text blocks) as the next user message
      messages.push({ role: 'user', content: [...toolResultBlocks, ...interjectionBlocks] });
    }

    // Hit the iteration cap
    return {
      text: collectedText + '\n\n[reached max agentic iterations]',
      ...(opts.requireFinalResponse ? { error: 'Scheduled task reached the maximum tool iterations before a final response' } : {}),
      usage: totalUsage,
      lastUsage,
      sessionId: lastResponseId,
    };
  } catch (err: any) {
    if (opts.signal?.aborted || abortController.signal.aborted) {
      iterRec?.abort();
      return { text: collectedText, error: 'aborted', usage: totalUsage, lastUsage, lastEstimatedTokens, sessionId: lastResponseId };
    }
    const status = err?.status ?? err?.statusCode;
    const detail = err?.error?.message ?? err?.message ?? String(err);
    const errText = redactSettingsSecrets(status ? `HTTP ${status}: ${detail}` : detail);
    if (iterRec) {
      // 错误场景（如 401）把网关返回体一并落录，便于排查鉴权问题。
      await iterRaw?.bodyDone;
      iterRec.fail(errText, { rawRequest: iterRaw?.request, rawResponse: iterRaw?.response });
    }
    return {
      text: collectedText,
      error: errText,
      usage: totalUsage,
      lastUsage,
      lastEstimatedTokens,
      sessionId: lastResponseId,
    };
  } finally {
    if(opts.monitor?.convId)await (await import('./browser-agent')).releaseConversationBrowser(opts.cwd, opts.monitor.convId);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
