import { openAIThinkingOptions, claudeThinkingOptions } from '../shared/model-thinking';
/**
 * 一次性文本补全：不创建对话、不落历史，直接调用当前生效模型返回纯文本。
 *
 * 模型解析沿用统一链路（对话级 > 项目级 > 全局，见 model-resolver），
 * 供渲染层「优化输入」等轻量文本处理功能使用。
 *
 * 上下文复用：提供对话元数据时，用与对话发送链路相同的构建器与
 * 「上下文窗口」治理（manageContext / compressOpenAIMessages）组装历史，
 * 补全请求看到的内容与对话当前窗口一致（含压缩摘要），
 * 从而结合语境做针对性优化，而非孤立改写单条输入。
 */

import { relayFetch } from './relay-tls';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { resolveModel, type ResolvedModel } from './model-resolver';
import { getApiHeaders } from './utils/api-user-agent';
import { manageContext, CHARS_PER_TOKEN } from './context-manager';
import { buildAnthropicHistory, buildOpenAIHistory, resolveContextOptions } from './conv-engine';
import { compressOpenAIMessages, getModelInputLimit } from './openai-api-bridge';
import { readSettings } from './main';
import type { ConversationMeta } from '../shared/types';

const COMPLETE_TIMEOUT_MS = 60_000;

/** 超时包装：避免模型挂起让渲染层按钮永远转圈。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`模型调用超时（>${ms / 1000}s）`)), ms);
    }),
  ]);
}

/**
 * 追加最终用户指令：尾部若已是 user 消息（如 tool_result 块），
 * 合并进同一条，满足 Anthropic user/assistant 严格交替约束。
 */
function appendAnthropicUser(
  messages: Anthropic.MessageParam[],
  prompt: string,
): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    const blocks: any[] = Array.isArray(last.content)
      ? [...(last.content as any[])]
      : [{ type: 'text', text: String(last.content) }];
    blocks.push({ type: 'text', text: prompt });
    return [...messages.slice(0, -1), { role: 'user', content: blocks }];
  }
  return [...messages, { role: 'user', content: prompt }];
}

/** OpenAI 协议无交替约束；尾部为纯文本 user 消息时合并，避免指令与历史割裂。 */
function appendOpenAIUser(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  prompt: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user' && typeof last.content === 'string') {
    return [...messages.slice(0, -1), { role: 'user', content: `${last.content}\n\n${prompt}` }];
  }
  return [...messages, { role: 'user', content: prompt }];
}

/**
 * 一次性补全。opts.signal 由调用方的 AbortController 提供，
 * 用于「优化输入」被用户取消时中止底层模型请求（否则请求会一直悬挂到超时）。
 */
export async function completeTextOnce(
  req: {
    prompt: string;
    selectedModel?: import("../shared/types").SelectedModel;
    followGlobal?: boolean;
    convMeta?: ConversationMeta | null;
    projectPath?: string;
  },
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const resolved: ResolvedModel | null = await resolveModel({
    task:req.prompt,
    selectedModel:req.selectedModel,
    followGlobal:req.followGlobal,
    convMeta: req.convMeta ?? undefined,
    projectPath: req.projectPath ?? req.convMeta?.projectPath,
  });
  if (!resolved) {
    throw new Error('未配置可用模型，请先在设置中选择默认模型');
  }

  // 上下文窗口复用：与对话发送链路同构建器、同治理口径组装历史消息，
  // 让补全（优化输入）看到对话当前窗口内的真实内容（含工具调用与压缩摘要）。
  let anthropicMessages: Anthropic.MessageParam[] | null = null;
  let anthropicSystem: string | undefined;
  let openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] | null = null;
  const meta = req.convMeta ?? undefined;
  if (meta && meta.messages.length > 0) {
    const settings = await readSettings();
    // 一次性补全不启用 LLM 摘要器，避免嵌套模型调用拖慢/套娃。
    const ctxOpts = resolveContextOptions(settings, meta, { withLlmSummarizer: false });
    if (resolved.protocol === 'openai') {
      const history = buildOpenAIHistory(meta.messages, undefined, undefined, undefined, meta.contextCompactionBoundary);
      // 与 openai-api-bridge agentic 循环同口径：字符上限 = 用户 token 上限换算或模型硬上限。
      const inputLimit = ctxOpts?.maxTokens
        ? Math.ceil(ctxOpts.maxTokens * CHARS_PER_TOKEN)
        : getModelInputLimit(resolved.model);
      const governed = JSON.stringify(history).length > inputLimit * 0.9
        ? compressOpenAIMessages(history, inputLimit, ctxOpts?.keepRecentTurns)
        : history;
      openaiMessages = appendOpenAIUser(governed, req.prompt);
    } else {
      const history = buildAnthropicHistory(meta.messages, undefined, undefined, undefined, meta.contextCompactionBoundary);
      const managed = await manageContext(history, '', ctxOpts ?? {});
      // 被 evict 轮次的摘要在 managed.system 里，一并带给模型。
      anthropicSystem = managed.system.trim() ? managed.system : undefined;
      anthropicMessages = appendAnthropicUser(managed.messages, req.prompt);
    }
  }

  if (resolved.protocol === 'openai') {
    const client = new OpenAI({ apiKey: resolved.apiKey, fetch:relayFetch(resolved.relayTransport), baseURL: resolved.baseUrl, defaultHeaders: await getApiHeaders('openai') });
    const resp = await withTimeout(
      client.chat.completions.create(
        {
          model: resolved.model,
          ...openAIThinkingOptions(resolved.thinkingModel??resolved.model,resolved.thinkingEffort),
          max_tokens: 4096,
          messages: openaiMessages ?? [{ role: 'user', content: req.prompt }],
        },
        opts?.signal ? { signal: opts.signal } : undefined,
      ),
      COMPLETE_TIMEOUT_MS,
    );
    return resp.choices[0]?.message?.content ?? '';
  }

  const client = new Anthropic({
    apiKey: resolved.apiKey, fetch:relayFetch(resolved.relayTransport),
    baseURL: resolved.baseUrl,
    defaultHeaders: await getApiHeaders('anthropic'),
  });
  const resp = await withTimeout(
    client.messages.create(
      {
        model: resolved.model,
        ...claudeThinkingOptions(resolved.thinkingModel??resolved.model,resolved.thinkingEffort),
        max_tokens: 16384,
        messages: anthropicMessages ?? [{ role: 'user', content: req.prompt }],
        ...(anthropicSystem ? { system: anthropicSystem } : {}),
      },
      opts?.signal ? { signal: opts.signal } : undefined,
    ),
    COMPLETE_TIMEOUT_MS,
  );
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
