/**
 * Context management for API-mode agentic loops.
 *
 * Modeled after Claude Code / Qoder auto-compact strategies:
 *
 *   Layer 1 (system):    Never dropped. May be appended with a summary of
 *                        older turns when they get evicted.
 *   Layer 2 (recent):    The last N complete turns are kept verbatim (full
 *                        tool_use + tool_result payloads).
 *   Layer 3 (mid):       Older turns keep their structure (tool_use IDs
 *                        preserved for API contract) but tool_result content
 *                        is truncated to a short skeleton.
 *   Layer 4 (evicted):   Turns that fall beyond the token budget get folded
 *                        into a summary block appended to the system prompt.
 *
 * Invariants preserved on every pass:
 *   - Every tool_use MUST have its matching tool_result in the outgoing array
 *     (we only evict complete turns, never split a pair).
 *   - The first message MUST be role='user' and NOT a bare tool_result.
 *   - Roles alternate (Anthropic requires this).
 *
 * A "turn" is defined as: a `user` message whose content is plain text or
 * text+images (NOT tool_result), plus every subsequent message up to but
 * excluding the next such user message.  This corresponds to one round of
 * human input → assistant tool-use exchange.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ContextCompactionAudit } from '../shared/types';

// ─── Tunables ────────────────────────────────────────────────────────────

/** Approximate bytes-per-token for character-based estimation. */
export const CHARS_PER_TOKEN = 3.0;
/** Soft budget for the outgoing serialized body. Anthropic rejects at ~6MB. */
const DEFAULT_MAX_BODY_CHARS = 3_500_000;
/** Approximate token budget when compacting (Claude's context is 200k). */
const DEFAULT_MAX_TOKENS = 120_000;
/** How many full turns from the end we always keep verbatim. */
const DEFAULT_KEEP_RECENT_TURNS = 3;
/** Byte cap applied to every tool_result in outgoing messages. */
const TOOL_RESULT_CHAR_CAP = 30_000;
/** More aggressive cap for tool_results in mid-tier turns. */
const MID_TIER_CHAR_CAP = 3_000;
/** Cap for text blocks. */
const TEXT_BLOCK_CHAR_CAP = 20_000;

export interface ManagedContext {
  messages: Anthropic.MessageParam[];
  system: string;
  /** Diagnostics — how many older turns got summarized into `system`. */
  summarizedTurns: number;
  /** Approximate token count of the outgoing payload. */
  estimatedTokens: number;
  /** Auto strategy decision diagnostics for request monitoring. */
  strategyDecision?: { mode: 'conservative'|'balanced'|'aggressive'; reason: string; contentKind: 'chat'|'code'|'writing'|'other'; score: number };
}

export interface ContextManagerOptions {
  extension?: string;
  project?: string;
  maxBodyChars?: number;
  maxTokens?: number;
  keepRecentTurns?: number;
  /**
   * P2 fix: 压缩模式预设（保守/均衡/激进），覆盖下方单项参数。
   * 单项参数（maxBodyChars 等）指定时优先于模式预设。
   */
  mode?: 'auto' | 'conservative' | 'balanced' | 'aggressive';
  /** 摘要生成策略，用于审计记录；未传时按是否有 LLM 摘要器推断。 */
  summaryStrategy?: 'auto' | 'truncate' | 'llm';
  /**
   * P3: 可选的 LLM 摘要生成器。
   * 当提供时，evicted 轮次会用 LLM 生成更智能的摘要；不提供则走简单截断。
   * 入参是被 evict 的消息数组，出参是摘要字符串。
   */
  llmSummarizer?: (turn: Anthropic.MessageParam[]) => Promise<string>;
  /** 每次实际发生自动整理后写入会话审计。 */
  onAudit?: (event: Omit<ContextCompactionAudit, 'id' | 'at'>) => void | Promise<void>;
}

/**
 * 预设模式参数表。
 * conservative: 保留更多历史，更晚触发压缩（大模型 / 大上下文场景）
 * balanced:     默认均衡（适合大多数场景）
 * aggressive:   激进压缩（长对话 / 低 token 预算场景）
 */
const MODE_PRESETS: Record<string, { maxBodyChars: number; maxTokens: number; keepRecentTurns: number }> = {
  conservative: { maxBodyChars: 5_000_000, maxTokens: 160_000, keepRecentTurns: 5 },
  balanced:     { maxBodyChars: 3_500_000, maxTokens: 120_000, keepRecentTurns: 3 },
  aggressive:   { maxBodyChars: 2_000_000, maxTokens: 80_000,  keepRecentTurns: 2 },
};

function resolveOptions(options: ContextManagerOptions) {
  const preset = MODE_PRESETS[options.mode ?? 'balanced'] ?? MODE_PRESETS.balanced;
  return {
    maxBodyChars: options.maxBodyChars ?? preset.maxBodyChars,
    maxTokens: options.maxTokens ?? preset.maxTokens,
    keepRecentTurns: options.keepRecentTurns ?? preset.keepRecentTurns,
  };
}

/**
 * Manage the outgoing context for a Messages API call.
 *
 * Applies (in order): tool_result compaction, mid-tier compaction, and if
 * still over budget, evicts oldest complete turns and folds them into a
 * short summary appended to the system prompt.
 *
 * P3: made async to support optional LLM-based summarization.
 */
export async function manageContext(
  messages: Anthropic.MessageParam[],
  systemPrompt: string,
  options: ContextManagerOptions = {},
): Promise<ManagedContext> {
  if(options.extension&&options.project){
    const budget=options.maxBodyChars??Math.ceil((options.maxTokens??120000)*CHARS_PER_TOKEN);
    if(estimateBodyChars(messages,systemPrompt)>budget){
      const {compactWithExtension}=await import('./plugins/context-extension');
      const compressed=await compactWithExtension(options.project,options.extension,messages,budget);
      const result=await manageContext(compressed,systemPrompt,{...options,extension:undefined,onAudit:undefined});
      await options.onAudit?.({trigger:'automatic',mode:options.mode??'auto',summaryStrategy:options.summaryStrategy??'auto',reason:`extension:${options.extension}`,beforeBodyChars:estimateBodyChars(messages,systemPrompt),afterBodyChars:estimateBodyChars(result.messages,result.system),beforeEstimatedTokens:Math.ceil(estimateBodyChars(messages,systemPrompt)/CHARS_PER_TOKEN),afterEstimatedTokens:result.estimatedTokens,status:'compacted'});
      return result;
    }
  }
  const decision = options.mode === 'auto' ? chooseAutoStrategy(messages) : undefined;
  const { maxBodyChars, maxTokens, keepRecentTurns } = resolveOptions({...options, mode: decision?.mode ?? options.mode});
  const beforeBodyChars = estimateBodyChars(messages, systemPrompt);
  const beforeEstimatedTokens = Math.ceil(beforeBodyChars / CHARS_PER_TOKEN);
  const summaryStrategy = options.summaryStrategy ?? (options.llmSummarizer ? 'llm' : 'truncate');

  // 预算闸门：上下文未超出窗口（token/字节预算）时不做任何清理——
  // 截断/压缩/驱逐都会损失模型可见信息，只在真正超窗时才值得付出。
  const overBudget = beforeBodyChars > maxBodyChars || beforeEstimatedTokens > maxTokens;

  // Phase 1: universal tool_result / text truncation.
  let current = messages;
  let compactedMessages = 0;
  if (overBudget) {
    current = truncateOversizedBlocks(messages);
    compactedMessages = countChangedMessages(messages, current);

    const turnStarts = findTurnStarts(current);
    const totalTurns = turnStarts.length;

    // Phase 2: mid-tier compression on turns older than `keepRecentTurns`.
    if (totalTurns > keepRecentTurns) {
      const midCutoffIdx = turnStarts[totalTurns - keepRecentTurns];
      current = current.map((m, idx) => {
        if (idx >= midCutoffIdx) return m;
        const compacted = compactMessageAggressive(m);
        if (safeStringify(compacted) !== safeStringify(m)) compactedMessages++;
        return compacted;
      });
    }
  }

  let bodySize = estimateBodyChars(current, systemPrompt);
  let estTokens = Math.ceil(bodySize / CHARS_PER_TOKEN);
  let summarizedTurns = 0;
  let system = systemPrompt;

  // Phase 3: evict oldest turns and fold into a summary until under budget.
  if (bodySize > maxBodyChars || estTokens > maxTokens) {
    const summaryChunks: string[] = [];
    const starts = findTurnStarts(current);

    // Never touch the last `keepRecentTurns` turns.
    const maxEvictable = Math.max(0, starts.length - keepRecentTurns);

    let evictUpto = 0;
    for (let i = 0; i < maxEvictable; i++) {
      const start = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1] : current.length;
      const turn = current.slice(start, end);
      // P3: use LLM summarizer if provided, otherwise fall back to truncate
      const summary = options.llmSummarizer
        ? await options.llmSummarizer(turn)
        : summarizeTurn(turn);
      summaryChunks.push(summary);
      evictUpto = end;
      summarizedTurns++;

      const remaining = current.slice(evictUpto);
      const projectedSize = estimateBodyChars(remaining, systemPrompt) + summaryChunks.join('\n').length;
      if (projectedSize <= maxBodyChars && Math.ceil(projectedSize / CHARS_PER_TOKEN) <= maxTokens) {
        break;
      }
    }

    if (summarizedTurns > 0) {
      compactedMessages += evictUpto;
      current = current.slice(evictUpto);
      system = appendSummaryToSystem(systemPrompt, summaryChunks);
      bodySize = estimateBodyChars(current, system);
      estTokens = Math.ceil(bodySize / CHARS_PER_TOKEN);
    }
  }

  // Safety net: after eviction, ensure the first message is a valid user turn.
  current = repairLeadingMessage(current);

  const afterBodyChars = estimateBodyChars(current, system);
  const afterEstimatedTokens = Math.ceil(afterBodyChars / CHARS_PER_TOKEN);
  // 仅超窗且确实发生了清理时才记审计（未超窗不做清理，也不产生整理记录/时间线标记）
  const changed = overBudget && (compactedMessages > 0 || summarizedTurns > 0 || beforeBodyChars !== afterBodyChars);
  if (changed && options.onAudit) {
    await options.onAudit({
      trigger: 'automatic',
      mode: options.mode ?? decision?.mode ?? 'balanced',
      // 用户选 auto 时把底层真实解析结果一并存档，供审计查看「Auto → 实际」
      resolvedMode: decision?.mode ?? (options.mode && options.mode !== 'auto' ? options.mode : undefined),
      summaryStrategy,
      resolvedSummaryStrategy: options.summaryStrategy === 'auto' || options.summaryStrategy === undefined
        ? (options.llmSummarizer ? 'llm' : 'truncate')
        : options.summaryStrategy,
      contentKind: decision?.contentKind,
      reason: decision?.reason ?? `body=${beforeBodyChars}; tokens=${beforeEstimatedTokens}`,
      beforeBodyChars,
      afterBodyChars,
      beforeEstimatedTokens,
      afterEstimatedTokens,
      summarizedTurns,
      compactedMessages,
      keptRecentTurns: keepRecentTurns,
      status: 'compacted',
    });
  }

  return {
    messages: current,
    system,
    summarizedTurns,
    estimatedTokens: estTokens,
    strategyDecision: decision,
  };
}

function countChangedMessages(before: Anthropic.MessageParam[], after: Anthropic.MessageParam[]): number {
  const n = Math.min(before.length, after.length);
  let changed = Math.abs(before.length - after.length);
  for (let i = 0; i < n; i++) {
    if (safeStringify(before[i]) !== safeStringify(after[i])) changed++;
  }
  return changed;
}

function chooseAutoStrategy(messages: Anthropic.MessageParam[]): NonNullable<ManagedContext['strategyDecision']> {
  const text = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  const chars = text.length;
  const code = (text.match(/```|\b(function|const|class|import|interface|SELECT|npm|git)\b/g) ?? []).length;
  const writing = (text.match(/\b(文章|标题|段落|润色|改写|essay|article|draft|outline)\b/gi) ?? []).length;
  const tools = messages.reduce((n,m)=>n+(JSON.stringify(m.content).match(/tool_use|tool_result/g)??[]).length,0);
  const contentKind: NonNullable<ManagedContext['strategyDecision']>['contentKind'] = code >= 3 ? 'code' : writing >= 2 ? 'writing' : tools >= 6 ? 'other' : 'chat';
  const score = Math.round(chars / 1000) + tools * 2;
  const mode = chars >= 180000 || tools >= 14 ? 'aggressive' : contentKind === 'writing' && chars < 120000 ? 'conservative' : chars >= 90000 ? 'balanced' : 'conservative';
  return {mode: mode as 'conservative'|'balanced'|'aggressive', reason:`${contentKind}; chars=${chars}; tools=${tools}`, contentKind, score};
}

// ─── Turn identification ─────────────────────────────────────────────────

/**
 * A turn starts at every user message whose content is NOT a bare tool_result.
 * Returns the indices of such messages.
 */
function findTurnStarts(messages: Anthropic.MessageParam[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isTurnStart(messages[i])) out.push(i);
  }
  return out;
}

function isTurnStart(m: Anthropic.MessageParam): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  if (!Array.isArray(m.content)) return false;
  return !m.content.some((b: any) => b?.type === 'tool_result');
}

// ─── Block truncation ────────────────────────────────────────────────────

function truncateOversizedBlocks(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: truncateString(m.content, TEXT_BLOCK_CHAR_CAP) };
    }
    const blocks = (m.content as any[]).map((b: any) => truncateBlock(b, TOOL_RESULT_CHAR_CAP));
    return { role: m.role, content: blocks } as Anthropic.MessageParam;
  });
}

/**
 * Aggressive compaction for mid-tier turns: tool_results get chopped hard,
 * text stays but is capped. Everything preserves its tool_use_id / id fields.
 */
function compactMessageAggressive(m: Anthropic.MessageParam): Anthropic.MessageParam {
  if (typeof m.content === 'string') {
    return { role: m.role, content: truncateString(m.content, MID_TIER_CHAR_CAP) };
  }
  const blocks = (m.content as any[]).map((b: any) => truncateBlock(b, MID_TIER_CHAR_CAP));
  return { role: m.role, content: blocks } as Anthropic.MessageParam;
}

function truncateBlock(b: any, cap: number): any {
  if (!b || typeof b !== 'object') return b;
  if (b.type === 'tool_result') {
    const raw = typeof b.content === 'string' ? b.content : safeStringify(b.content);
    return { ...b, content: truncateString(raw, cap) };
  }
  if (b.type === 'text') {
    return { ...b, text: truncateString(b.text ?? '', cap) };
  }
  return b;
}

function truncateString(s: string, cap: number): string {
  if (typeof s !== 'string') s = String(s);
  if (s.length <= cap) return s;
  const head = Math.floor(cap * 0.7);
  const tail = Math.floor(cap * 0.2);
  return `${s.slice(0, head)}\n\n[... truncated ${s.length - head - tail} chars ...]\n\n${s.slice(-tail)}`;
}

function safeStringify(v: any): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ─── Turn summary generation ─────────────────────────────────────────────

/**
 * Produce a short deterministic summary of a set of consecutive messages
 * (one full turn). No LLM call — we distill the salient facts:
 *   - user's request text
 *   - tools invoked with argument summaries
 *   - a snippet of assistant text (if any)
 */
function summarizeTurn(turn: Anthropic.MessageParam[]): string {
  const parts: string[] = [];
  let userText = '';
  const toolUses: Array<{ name: string; summary: string }> = [];
  let asstText = '';

  for (const m of turn) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        if (!userText) userText = m.content;
      } else if (Array.isArray(m.content)) {
        for (const b of m.content as any[]) {
          if (b?.type === 'text' && !userText) userText = b.text ?? '';
        }
      }
    } else if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content as any[]) {
        if (b?.type === 'text') {
          asstText += (asstText ? ' ' : '') + (b.text ?? '');
        } else if (b?.type === 'tool_use') {
          toolUses.push({ name: b.name, summary: summarizeToolInput(b.input) });
        }
      }
    }
  }

  if (userText) parts.push(`User asked: ${clip(userText, 200)}`);
  if (toolUses.length > 0) {
    const grouped = toolUses.map((t) => `${t.name}(${t.summary})`).join(', ');
    parts.push(`Tools invoked: ${clip(grouped, 400)}`);
  }
  if (asstText) parts.push(`Assistant said: ${clip(asstText, 200)}`);

  return '- ' + parts.join('. ');
}

function summarizeToolInput(input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.command === 'string') return clip(input.command, 60);
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.query === 'string') return clip(input.query, 60);
  try { return clip(JSON.stringify(input), 60); } catch { return ''; }
}

function clip(s: string, n: number): string {
  if (typeof s !== 'string') return '';
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > n ? collapsed.slice(0, n) + '…' : collapsed;
}

function appendSummaryToSystem(systemPrompt: string, chunks: string[]): string {
  const summary = chunks.join('\n');
  return (
    systemPrompt +
    '\n\n---\n\n## Prior Conversation Summary\n\n' +
    'The following older turns were compacted to fit the context window. ' +
    'Refer to them as background — the user may still reference these actions.\n\n' +
    summary
  );
}

// ─── Body-size estimation & safety repair ────────────────────────────────

function estimateBodyChars(messages: Anthropic.MessageParam[], system: string): number {
  try {
    return JSON.stringify(messages).length + system.length;
  } catch {
    return system.length;
  }
}

/**
 * Ensure the outgoing messages start with a proper user turn.
 * If the first message is a bare tool_result (orphaned after eviction),
 * either drop it or convert it to a synthetic user text message.
 */
function repairLeadingMessage(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const first = messages[0];
  if (isTurnStart(first)) return messages;
  if (first.role === 'user' && Array.isArray(first.content)) {
    // Orphaned tool_result — replace with a synthetic user text message.
    const summary = (first.content as any[])
      .filter((b: any) => b?.type === 'tool_result')
      .map((b: any) => `[Orphaned tool result: ${clip(typeof b.content === 'string' ? b.content : safeStringify(b.content), 80)}]`)
      .join('\n');
    const rest = messages.slice(1);
    return [{ role: 'user', content: summary || '[context compacted]' }, ...rest];
  }
  if (first.role === 'assistant') {
    // Drop leading assistant messages — the API requires the first to be user.
    return repairLeadingMessage(messages.slice(1));
  }
  return messages;
}
