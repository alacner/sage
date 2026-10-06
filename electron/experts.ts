import { attachToolResultImages } from '../shared/tool-result-images';
import { RESPONSE_STYLE } from '../shared/response-style';
import { assignUniqueExpertNames, expertNamesInPlan, expertTasksComplete } from '../shared/expert-task-tree';
import {prepareExpertsResume,taskResumeContext,hasUnfinishedTasks} from '../shared/experts-resume';
import { awaitAbortable } from './utils/await-abortable';
import { ReviewDenialCircuit } from './sandbox/review-circuit';
import { decideTool, approveTool, recordDecision } from './sandbox/tool-decision';
import { conversationExecutionEffort } from './conversation-execution';
import { withConversationPolicy } from './sandbox/conversation-policy';
import { randomBytes } from 'node:crypto';
import OpenAI from 'openai';
import { relayFetch } from './relay-tls';
import Anthropic from '@anthropic-ai/sdk';
import { runOpenAIAPIAgentic } from './openai-api-bridge';
import { runClaudeAPIAgentic } from './claude-api-bridge';
import { readSettings } from './main';
import { normalizeAskUserInput, ASKUSER_EMPTY_RETRY_MSG } from './api-tool-defs';
import { getApiHeaders } from './utils/api-user-agent';
import { decryptSecret } from './sandbox/secrets';
import type { ResolvedModel } from './model-resolver';
import type {
  ChatEventType,
  ChatMessage,
  ClarifyRequest,
  ConversationMeta,
  ExpertRole,
  ExpertTask,
  ExpertsPlan,
  PendingApproval,
  UsageStats,
  ExpertDefinitionConfig,
  Interjection,
} from '../shared/types';
import { WORKFLOW_LIMITS } from '../shared/runtime-config';
import {
  DEFAULT_EXPERT_DEFINITIONS,
  resolveExpertDefinition,
  DEFAULT_EXPERT_ROLE_IDS,
  resolveBuiltinExpertDefinition,
} from '../shared/expert-definitions';

/**
 * 专家团模式（Experts Mode，借鉴 Qoder Experts Mode）。
 *
 * 工作流：
 *   1. 项目经理（规划）：理解需求 → 分解为带专家分工的任务清单（JSON）
 *   2. 用户确认计划（可要求重新规划）
 *   3. 执行：按依赖关系调度，无依赖任务并行执行（并发上限 2）
 *      每个任务 = 一次带专家 system prompt 的 agentic 调用，
 *      执行过程流式写入对话消息（复用现有 chat 事件管道）
 *   4. 项目经理汇总所有任务结果，输出最终报告
 *
 * 权限/澄清管道与 sendMessage 完全同构（canUseTool → awaitPermission）。
 */

const newId = () => randomBytes(6).toString('base64url');

/**
 * Sandbox 硬约束检查（专家团模式）：在审批逻辑之前前置检查。
 * 与 conv-engine.ts 的 checkSandbox 同构，命中则直接拒绝。
 * @returns 拒绝原因字符串；返回 null 表示放行
 */
// ── 并行调度策略 ──────────────────────────────────────────────────────────
// 并发数要"考虑模型接口情况"：
//  - 官方 API（Anthropic / api.anthropic.com）：速率限额宽，默认 3 并发
//  - 第三方 OpenAI 兼容端点（代理/本地/网关）：限额未知，保守默认 2
//  - 运行时遇到 429/rate_limit 自动减半并等待重试（自适应降级）
//  - 用户可在设置 → 专家团里强制指定（1~8）
const DEFAULT_PARALLEL = WORKFLOW_LIMITS.defaultParallel;
const DEFAULT_PARALLEL_THIRD_PARTY = WORKFLOW_LIMITS.defaultParallelThirdParty;
const MIN_PARALLEL = WORKFLOW_LIMITS.minParallel;
const MAX_PARALLEL = WORKFLOW_LIMITS.maxParallel;
/** 并行上限。undefined = 自动（按 API 端点保守估计）；数字 = 用户强制。 */
export let expertsMaxParallel: number | undefined;
export function setExpertsMaxParallel(v: number | undefined): void {
  expertsMaxParallel = v && v > 0 ? Math.min(MAX_PARALLEL, Math.max(MIN_PARALLEL, Math.floor(v))) : undefined;
}
/** 遇到限流后的等待基数（指数回退的上限）。 */
const RATE_LIMIT_BACKOFF_MS = 15_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** 判断错误是否为限流类（429 / rate limit / quota）。 */
function isRateLimitError(err: any): boolean {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  return err?.status === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('quota') || msg.includes('too many requests');
}

/**
 * 判断错误是否为网络瞬态类（可重试）。
 * 与 retry.ts 的 isRetryableError 对齐：网络层错误、5xx、超时、连接重置等。
 * 排除：用户中止、认证错误（401/403）、永久错误（400/404）。
 */
function isNetworkError(err: any): boolean {
  if (!err) return false;
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  if (msg === 'aborted') return false;
  if (/\b(unauthorized|forbidden|invalid[_ ]?api[_ ]?key|401|403|400|404)\b/.test(msg)) {
    return false;
  }
  return /(network|fetch failed|socket hang up|econnreset|etimedout|enotfound|eai_again|certificate|timeout|503|504|529|overloaded|connection (reset|closed)|stream closed)/.test(msg);
}

/** 网络瞬态错误的最大重试次数（不含首次尝试）。 */
const NETWORK_MAX_RETRIES = WORKFLOW_LIMITS.networkMaxRetries;
/** 网络重试的基数等待（ms），指数退避。 */
const NETWORK_RETRY_BASE_MS = WORKFLOW_LIMITS.networkRetryBaseMs;

/** 根据模型端点估算安全并发数。 */
export function estimateParallel(resolved: ResolvedModel): number {
  if (expertsMaxParallel) return expertsMaxParallel;
  const base = resolved.baseUrl || '';
  const isOfficialAnthropic = resolved.protocol === 'anthropic' && (!base || base.includes('anthropic.com'));
  return isOfficialAnthropic ? DEFAULT_PARALLEL : DEFAULT_PARALLEL_THIRD_PARTY;
}
/** 重新规划的最大次数。 */
export const MAX_REPLANS = WORKFLOW_LIMITS.maxReplans;

/** 界面语言决定内置角色内容语言；用户覆盖项一旦存在即优先于内置默认。 */
let expertsEnglish = false;
export function setExpertsLanguage(language?: string): void {
  expertsEnglish = String(language ?? '').toLowerCase().startsWith('en');
}

/** 当前界面语言下的内置定义（英文缺省时回退中文视图）。 */
function builtinDef(role: string): ExpertDefinitionConfig {
  return resolveBuiltinExpertDefinition(role, expertsEnglish) ?? DEFAULT_EXPERT_DEFINITIONS[role] ?? DEFAULT_EXPERT_DEFINITIONS.fullstack;
}

/** 项目经理内置定义 + 主名（名字池第一个）。 */
function leadDef(): ExpertDefinitionConfig & { humanName: string } {
  const lead = builtinDef('lead');
  return { ...lead, humanName: lead.humanNames[0] };
}

let customExpertDefs: Partial<Record<string, ExpertDefinitionConfig>> = {};
let customLeadInfo: ExpertDefinitionConfig | undefined;

const EXPERT_ROLE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Normalize one persisted override against its built-in fallback.  Overrides
 * are deliberately kept in settings as sparse objects, while the runtime
 * always receives a complete definition.  `enabled:false` is meaningful and
 * must survive normalization so a built-in role can be disabled without
 * deleting it from the catalogue.
 */
function normalizeExpertDefinition(role: string, raw: unknown): ExpertDefinitionConfig | undefined {
  if (!EXPERT_ROLE_ID_RE.test(role) || !raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  // 自定义角色没有内置底稿，只有内置角色才与语言默认值合并。
  const merged: Partial<ExpertDefinitionConfig> = resolveExpertDefinition(role, value, expertsEnglish) ?? {};
  if (typeof merged.name !== 'string' || !merged.name.trim()) return undefined;
  if (typeof merged.desc !== 'string') return undefined;
  if (typeof merged.promptBody !== 'string') return undefined;
  if (!Array.isArray(merged.humanNames)) return undefined;
  const names = merged.humanNames
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim())
    .slice(0, 12);
  if (!names.length) return undefined;
  const icon = typeof merged.icon === 'string' && merged.icon.trim() ? merged.icon : '🧩';
  return {
    name: merged.name.trim(),
    humanNames: names,
    icon,
    desc: merged.desc,
    promptBody: merged.promptBody,
    enabled: value.enabled !== false,
  };
}

/**
 * 从设置加载专家定义与语言。状态消息等展示入口必须在拼接文案前调用，
 * 否则自定义成员名尚未加载，会回退内置名（如 Leo）。
 */
export async function refreshExpertSettings(): Promise<void> {
  const s = await readSettings();
  setExpertsLanguage(s.language);
  setExpertDefinitions(s.expertDefinitions);
}

export function setExpertDefinitions(defs: unknown): void {
  customLeadInfo = undefined;
  if (!defs || typeof defs !== 'object') { customExpertDefs = {}; return; }
  const next: typeof customExpertDefs = {};
  for (const role of Object.keys(defs as object)) {
    const definition = normalizeExpertDefinition(role, (defs as any)[role]);
    if (!definition) continue;
    if (role === 'lead') customLeadInfo = definition;
    else next[role] = definition;
  }
  customExpertDefs = next;
}
function expertDef(role: string) { return customExpertDefs[role] ?? builtinDef(role); }

/** 取角色的主名（名字池第一个），用于"角色级"泛指。 */
export function rolePrimaryName(role: ExpertRole): string {
  if (role === 'lead') return customLeadInfo?.humanNames[0] ?? leadDef().humanName;
  const def = expertDef(role);
  return def.humanNames[0];
}

/**
 * 当前启用专家的名字信号（角色标题 + 成员人名，含自定义）：
 * 供主进程「自动」档兜底判定——首句点名其一即走专家团。
 */
export function currentExpertNameSignals(): string[] {
  const roles = [...new Set([...DEFAULT_EXPERT_ROLE_IDS, ...Object.keys(customExpertDefs)])];
  const out: string[] = [];
  for (const role of roles) {
    const def = expertDef(role);
    if (!def || def.enabled === false) continue;
    if (def.name) out.push(def.name);
    for (const h of def.humanNames ?? []) if (h) out.push(h);
  }
  return [...new Set(out.filter((n) => n.length >= 2))];
}

/**
 * 任务实例的专家人名：优先用计划里已分配的 expertName，
 * 否则回退到角色主名。
 */
export function taskExpertName(task: Pick<ExpertTask, 'expert' | 'expertName'>): string {
  return task.expertName ?? rolePrimaryName(task.expert);
}

/**
 * 专家展示标签："研究员 Alex" / "项目经理 Leo"。
 * 传入 task 时用该任务实例的名字；只传 role 时用角色主名。
 */
export function expertLabel(role: ExpertRole, task?: Pick<ExpertTask, 'expert' | 'expertName'>): string {
  if (role === 'lead') return `${customLeadInfo?.name ?? leadDef().name} ${customLeadInfo?.humanNames[0] ?? leadDef().humanName}`;
  const def = expertDef(role);
  const name = task ? taskExpertName(task) : def.humanNames[0];
  return `${def.name} ${name}`;
}

/** 构造专家的完整 system prompt（注入具体人名）。 */
export function buildExpertPrompt(role: ExpertRole, name: string): string {
  const def = role === 'lead' ? (customLeadInfo ?? leadDef()) : expertDef(role);
  return expertsEnglish
    ? `You are ${name}, the ${def.name} of the expert team.\n${def.promptBody}\n\n${RESPONSE_STYLE}`
    : `你是 ${name}，专家团中的${def.name}。\n${def.promptBody}\n\n${RESPONSE_STYLE}`;
}

/**
 * 按消息 id 找到对应的专家实例标签（"全栈工程师 Sam · 修改前端"）。
 * 用于权限审批/澄清时区分是谁在请求——同角色并行时不会混淆。
 * 找不到（非专家消息/普通模式）返回 undefined。
 */
export function findExpertLabelByMsgId(meta: ConversationMeta, msgId: string): string | undefined {
  const msg = meta.messages.find((m) => m.id === msgId);
  if (!msg?.experts || msg.experts.kind !== 'task') return undefined;
  const task = meta.expertsPlan?.tasks.find((t) => t.id === msg.experts!.taskId);
  if (task) return `${expertLabel(task.expert, task)} · ${task.title}`;
  // plan 缺失时至少用消息内嵌的人名
  const name = msg.experts.expertName;
  const role = msg.experts.role;
  return name && role ? `${expertLabel(role)} ${name}` : undefined;
}

/** 专家团编排过程中的事件回调（由 ipc 层注入，复用 chat 事件管道）。 */
export interface ExpertsCallbacks {
  send: (msgId: string, type: ChatEventType, payload?: any) => void;
  awaitPermission: (req: PendingApproval) => Promise<{
    decision: 'allow' | 'deny';
    updatedInput?: any;
    message?: string;
  }>;
  onPermissionRequest?: (req: PendingApproval) => void;
  onPermissionResolved?: (requestId: string, decision: 'allowed' | 'denied') => void;
  awaitClarify?: (req: ClarifyRequest) => Promise<string>;
  onClarifyRequest?: (req: ClarifyRequest) => void;
  onClarifyResolved?: (requestId: string, answer: string) => void;
  /** 任务执行遇到限流（429）：调度器临时降低并发。waitMs 为本任务的重试等待。 */
  onRateLimited?: (waitMs: number) => void;
  /**
   * 插话注入函数：返回自上次调用以来的插话消息列表。
   * 在专家团各调用点的安全边界（规划/任务工具间隙/汇总）注入，
   * 不停止当前执行，供 agent 即时参考。
   */
  interject?: (target?: { taskId: string; parentTaskId?: string }) => Interjection[];
}

// ---------------------------------------------------------------------------
// Phase 1: 项目经理规划
// ---------------------------------------------------------------------------

const VALID_ROLES = () => [...new Set([
  ...DEFAULT_EXPERT_ROLE_IDS.filter((role) => role !== 'lead'),
  ...Object.keys(customExpertDefs),
])].filter((role) => role !== 'lead' && expertDef(role).enabled !== false);

/**
 * Detect an explicit role assignment in the user's wording. Ordinary role
 * selection remains semantic, but a phrase such as
 * “让安全工程师（security）负责安全检查” is an explicit constraint and
 * should be repeated as a hard planning rule. Seeing an id in a path or code
 * sample alone must not force every task to that role.
 */
function explicitRoleHints(goal: string, roles: string[]): string[] {
  const stop = '[^\\n。！？!?；;]{0,48}';
  const assignmentWords = '(?:让|由|请|指定|安排|交给|使用|委托|assign|use)';
  const responsibilityWords = '(?:负责|执行|检查|审计|处理|完成|主导|review|audit|handle|implement|own)';
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  const hints: string[] = [];
  for (const role of roles) {
    const def = expertDef(role);
    // 双语内置名都参与匹配：界面语言之外的另一种语言写法也能识别。
    const otherName = resolveBuiltinExpertDefinition(role, !expertsEnglish)?.name;
    const labels = [role, def.name, ...(otherName && otherName !== def.name ? [otherName] : [])]
      .filter((value): value is string => !!value?.trim());
    const label = `(?:${labels.map(escaped).join('|')})`;
    const patterns = [
      new RegExp(`${assignmentWords}${stop}${label}${stop}${responsibilityWords}`, 'iu'),
      new RegExp(`${label}${stop}${responsibilityWords}`, 'iu'),
      new RegExp(`[（(\\[]\\s*${escaped(role)}\\s*[)）\\]]`, 'iu'),
    ];
    if (patterns.some((pattern) => pattern.test(goal))) hints.push(`${role}（${def.name}）：${def.desc}`);
  }
  return hints;
}

function buildPlanPrompt(goal: string, feedback?: string): string {
  const availableRoles = VALID_ROLES();
  const rolesDesc = availableRoles.map((r) => `- ${r}: ${expertDef(r).name}（${expertDef(r).humanNames[0]} 等）— ${expertDef(r).desc}`).join('\n');
  const explicitHints = explicitRoleHints(goal, availableRoles);
  return `你是专家团的项目经理（总指挥）${rolePrimaryName('lead')}。请把用户的需求分解为一份可执行的任务计划。

可用专家角色（分配任务时填写角色 id）：
${rolesDesc}

要求：
1. 只拆成完成目标所必需的任务，通常 1~4 个；单份文件的分析、评估或总结应由一个任务端到端完成
2. 每个任务必须是一个专家可独立完成的具体工作单元
   每项任务必须有不同且可验收的产出；禁止重复标题、重复描述或仅换措辞/角色的重复工作
   不要把“读取/分析文件”和“给该文件评分/总结”拆成两个任务，除非用户要求独立评审
3. 通过 dependsOn 表达依赖（引用任务 id）
4. **最大化并行**：只有存在真实的数据/产物依赖时才写 dependsOn；
   相互独立的任务一律不要加依赖（它们会被并行执行）。
   不要把任务串成一条不必要的链——能并行就并行，只在真正需要
   "先有 A 的结论才能做 B" 时才依赖。
5. 纯研究/简单任务不要硬拆，保持精简
6. **同一角色可承担多个任务**：只有存在多个明确不同的文件、模块或交付物时，
   可以把它们拆成多个任务并都分配给同一角色 id（如多个 fullstack）。
   系统会为每个任务实例自动安排不同的团队成员（如 Sam、Max），并行推进。
${explicitHints.length > 0 ? `7. **用户明确指定了角色（硬约束）**：\n${explicitHints.map((hint) => `   - ${hint}`).join('\n')}\n   与上述角色职责匹配的任务必须填写对应的角色 id；不能因为它是自定义角色就改分给 fullstack。只有明确不属于这些职责的任务才分配给其他角色。` : ''}
8. 只输出 JSON，不要任何其他文字

JSON 格式：
{
  "goal": "对用户目标的一句话概括",
  "tasks": [
    { "id": "t1", "title": "简短动宾短语", "description": "做什么、为什么、验收标准", "expert": "角色id", "dependsOn": [] }
  ]
}
${feedback ? `\n用户对上一版计划的修改意见（必须遵循）：\n${feedback}` : ''}

用户需求：
${goal}`;
}

/** 从模型输出里抠出 JSON（兼容代码块包裹）。 */
function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence ? fence[1] : text).trim();
  // 直接尝试整体解析；失败则截取第一个 { 到最后一个 }
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error('无法解析计划 JSON');
  }
}

/**
 * 项目经理生成执行计划（单轮调用，无工具）。
 */
export async function generateExpertsPlan(opts: {
  meta: ConversationMeta;
  goal: string;
  resolved: ResolvedModel;
  signal: AbortSignal;
  feedback?: string;
  /** 插话注入：规划前取出累积的插话，并入 goal 供项目经理参考。 */
  interject?: () => Interjection[];
}): Promise<ExpertsPlan> {
  const { meta, resolved, signal, feedback } = opts;
  await refreshExpertSettings();
  const availableRoles = VALID_ROLES();
  if (availableRoles.length === 0) {
    throw new Error('没有可用的专家角色，请至少启用一个内置角色或自定义角色。');
  }
  // 安全边界：把执行过程中累积的插话并入本轮目标
  let goal = opts.goal;
  if (opts.interject) {
    const injs = opts.interject();
    if (injs.length > 0) {
      goal += '\n\n[用户插话，请立即参考并调整计划] ' + injs.map((i) => i.text).join(' | ');
    }
  }
  const prompt = buildPlanPrompt(goal, feedback);
  const monitor = {
    source: 'conversation' as const,
    convId: meta.id,
    projectPath: meta.projectPath,
    label: `${meta.title} · 专家团规划`,
  };

  let text: string;
  if (resolved.protocol === 'openai') {
    const client = new OpenAI({
      apiKey: decryptSecret(resolved.apiKey) || 'not-needed',
      baseURL: resolved.baseUrl || undefined,
      fetch:relayFetch(resolved.relayTransport),
      defaultHeaders: await getApiHeaders('openai'),
    });
    const resp = await client.chat.completions.create(
      {
        model: resolved.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      },
      { signal },
    );
    text = resp.choices[0]?.message?.content ?? '';
  } else {
    const client = new Anthropic({
      apiKey: decryptSecret(resolved.apiKey),
      baseURL: resolved.baseUrl || undefined,
      fetch:relayFetch(resolved.relayTransport),
      defaultHeaders: await getApiHeaders('anthropic'),
    });
    const resp = await client.messages.create(
      {
        model: resolved.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal },
    );
    text = resp.content
      .filter((b: any): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
  void monitor; // monitor 标签仅用于语义占位（单轮调用未走桥接层录制）

  const parsed = extractJson(text);
  const tasksRaw = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  if (tasksRaw.length === 0) throw new Error('计划中没有任务');

  // 模型偶尔会重复生成同一项工作。合并完全相同的任务，并将重复项
  // 的依赖引用转到保留任务，避免重复执行及悬空依赖。
  const candidates: Array<{ raw: any; sourceId: string; expert: string; title: string; description: string }> = tasksRaw.slice(0, 8).map((raw: any, i: number) => ({
    raw,
    sourceId: String(raw?.id ?? `t${i + 1}`),
    expert: availableRoles.includes(raw?.expert) ? raw.expert : availableRoles[0],
    title: String(raw?.title ?? `任务 ${i + 1}`).trim().slice(0, 80),
    description: String(raw?.description ?? '').trim().slice(0, 2000),
  }));
  const canonical = (value: string) => value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const seen = new Map<string, number>();
  const sourceToTask = new Map<string, number>();
  const unique: typeof candidates = [];
  for (const candidate of candidates) {
    const key = `${candidate.expert}\n${canonical(candidate.title)}\n${canonical(candidate.description)}`;
    let target: number;
    const existing = seen.get(key);
    if (existing === undefined) {
      target = unique.length;
      seen.set(key, target);
      unique.push(candidate);
    } else target = existing;
    sourceToTask.set(candidate.sourceId, target);
  }

  const tasks: ExpertTask[] = unique.map((t, i) => {
    return {
      id: `t${i + 1}`,
      title: t.title,
      description: t.description,
      expert: t.expert,
      dependsOn: Array.isArray(t.raw?.dependsOn) ? [] : undefined, // 依赖在下方规范化
      status: 'pending' as const,
    };
  });

  // 规范化依赖：通过原始 ID 映射到去重后的任务，只保留前向安全引用。
  unique.forEach((candidate, i) => {
    if (Array.isArray(candidate.raw?.dependsOn)) {
      tasks[i].dependsOn = [...new Set<string>(candidate.raw.dependsOn
        .map((d: any) => sourceToTask.get(String(d)))
        .filter((target: number | undefined): target is number => target !== undefined && target < i)
        .map((target: number) => `t${target + 1}`))];
      if (tasks[i].dependsOn!.length === 0) tasks[i].dependsOn = undefined;
    }
  });

  // ── 为每个任务实例分配人名 ──
  // 同一角色被分派多个任务时，按出现顺序从名字池依次取不同名字，
  // 让「Sam 的任务」「Max 的任务」在拆解/调度/汇报中清晰可辨。
  const roleCounters: Partial<Record<ExpertRole, number>> = {};
  for (const task of tasks) {
    // Use the normalized override too; otherwise a custom name pool would be
    // ignored while the plan is being materialized.
    const def = task.expert === 'lead' ? (customLeadInfo ?? leadDef()) : expertDef(task.expert);
    const pool = def.humanNames;
    const idx = roleCounters[task.expert] ?? 0;
    roleCounters[task.expert] = idx + 1;
    task.expertName = idx < pool.length ? pool[idx] : `${pool[pool.length - 1]}-${idx + 1}`;
  }

  return {
    id: newId(),
    goal: String(parsed?.goal ?? goal).slice(0, 200),
    tasks,
    status: 'draft',
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Phase 2: 任务执行
// ---------------------------------------------------------------------------

/**
 * 专家团最大嵌套深度：1 = 顶层专家团，2 = 子团队。
 * 子团队成员不再提供 DecomposeTask 工具，防止无限递归拆解。
 */
export const MAX_EXPERTS_DEPTH = WORKFLOW_LIMITS.maxExpertsDepth;

/** 子团队（嵌套计划）的并发上限：比顶层更保守，避免父子叠加打爆限流。 */
const NESTED_PARALLEL_CAP = 2;

function accUsage(total: UsageStats | undefined, add?: UsageStats): UsageStats | undefined {
  if (!add) return total;
  if (!total) return { ...add };
  return {
    inputTokens: total.inputTokens + add.inputTokens,
    outputTokens: total.outputTokens + add.outputTokens,
    cacheReadTokens: total.cacheReadTokens + add.cacheReadTokens,
    cacheCreationTokens: total.cacheCreationTokens + add.cacheCreationTokens,
    costUsd: total.costUsd + add.costUsd,
  };
}

function buildTaskPrompt(meta: ConversationMeta, plan: ExpertsPlan, task: ExpertTask): string {
  const doneResults = plan.tasks
    .filter((t) => t.status === 'done' && t.result && t.id !== task.id)
    .map((t) => `### ${t.title}（负责：${expertLabel(t.expert, t)}）\n${(t.result ?? '').slice(0, 1500)}`)
    .join('\n\n');

  return `## 项目信息
项目路径：${meta.projectPath}

## 总体目标
${plan.goal}

## 你的任务
**${plan.tasks.indexOf(task) + 1}. ${task.title}**（任务 ID：${task.id}）
${task.description}
${doneResults ? `\n## 其他专家的已完成产出（供参考）\n${doneResults}` : ''}

## 要求
1. 按当前安全与授权策略完成任务；工具调用必须通过审批
2. 完成后输出简洁总结：做了什么、修改/新增了哪些文件、关键结论
3. 如遇到无法继续的阻塞，明确说明阻塞原因
${/\bpdf\b|\.pdf|PDF文件|PDF 内容|PDF内容/i.test(`${plan.goal}\n${task.title}\n${task.description}`) ? `
## PDF 文件处理方式
- 用户说明文件在项目目录时，先在项目路径内定位实际 PDF 文件；只读取与当前目标相关的文件。
- 优先使用可用的本地 PDF 文本提取工具（如 pdftotext 或已安装的 Python PDF 库），必要时再渲染页面检查视觉设计。
- 不要通过 AppleScript、Swift UI 自动化、打开桌面应用或浏览器来“读取”文件；这类 UI 操作不可靠，也与直接检查项目文件无关。
- 若工具缺失或文件未找到，报告具体情况和尝试过的只读方法，不要反复尝试替代 UI 自动化。` : ''}`;
}

/**
 * 执行单个专家任务：一次 agentic 调用，流式事件写入对话消息。
 */
async function runExpertTask(opts: Parameters<typeof runExpertTaskWithPolicy>[0]): Promise<void> {
  return withConversationPolicy(opts.meta, () => runExpertTaskWithPolicy(opts));
}
async function runExpertTaskWithPolicy(opts: {
  meta: ConversationMeta;
  plan: ExpertsPlan;
  task: ExpertTask;
  resolved: ResolvedModel;
  signal: AbortSignal;
  cb: ExpertsCallbacks;
  /** 任务执行的嵌套深度：1 = 顶层专家团（默认），2 = 子团队。 */
  depth?: number;
  /** 嵌套执行时的父任务 id（depth > 1 时存在，UI 据此定位 subPlan）。 */
  parentTaskId?: string;
  /** 任务状态流转通知（嵌套计划落盘 / meta_update 用）。 */
  onProgress?: () => void;
}): Promise<void> {
  const { meta, plan, task, resolved, signal, cb } = opts;
  const depth = opts.depth ?? 1;
  const expertName = taskExpertName(task);
  const recovery = taskResumeContext(meta,task);
  if(task.subPlan&&hasUnfinishedTasks(task.subPlan)){
    await executeExpertsPlan({meta,plan:task.subPlan,resolved,signal,cb,depth:depth+1,parentTaskId:task.id,onProgress:opts.onProgress});
    if(signal.aborted)return;
  }


  const msg: ChatMessage = {
    id: newId(),
    role: 'assistant',
    content: '',
    toolCalls: [],
    ts: new Date().toISOString(),
    pending: true,
    experts: {
      kind: 'task',
      taskId: task.id,
      role: task.expert,
      expertName,
      ...(depth > 1 ? { depth, parentTaskId: opts.parentTaskId } : {}),
    },
  };
  task.msgId = msg.id;
  meta.messages.push(msg);
  cb.send(msg.id, 'message_start', { message: msg });
  opts.onProgress?.();

  const systemPrompt = `${buildExpertPrompt(task.expert, expertName)}

通用规则：
- 你正在「专家团模式」下执行一个被分配的任务，聚焦任务本身，不要偏离范围
- 所有输出使用中文${depth < MAX_EXPERTS_DEPTH ? `
- 如果执行中发现任务范围明显过大、包含多个彼此独立的工作单元，
  可以调用一次 DecomposeTask 工具把它交给子团队并行处理，拿到汇总结果后
  再由你整合收尾。任务本身不大时不要使用（拆解有额外成本）。` : ''}`;

  // 权限管道：与 sendMessage 同构（canUseTool → awaitPermission）
  const reviewCircuit=new ReviewDenialCircuit();
  const canUseTool = async (
    toolName: string,
    input: any,
    toolUseId: string,
  ): Promise<{ allowed: boolean; updatedInput?: any; message?: string }> => {
    if(reviewCircuit.isStopped)return {allowed:false,message:'安全审查熔断已停止本轮后续工具调用；请调整请求或等待新一轮。'};
    if (toolName === 'AskUser' || toolName === 'Skill' || toolName.endsWith('__AskUser') || toolName.endsWith('__Skill') || toolName === 'DecomposeTask' || toolName.endsWith('__DecomposeTask')) {
      const call = msg.toolCalls?.find((c) => c.id === toolUseId);
      if (call) call.approval = 'allowed';
      recordDecision(toolName.replace(/^mcp__sage__/,''),input,meta,'allow','direct-allow','内置交互或技能工具');
      return { allowed: true, updatedInput: input };
    }
    // Shared staged decision pipeline.
    const review = await decideTool(toolName, input, meta, signal);
    const reviewedCall = msg.toolCalls?.find(c => c.id === toolUseId);
    const circuit=reviewCircuit.record(review.decision,review.stage==='ai-review');
    if(circuit?.stopped&&review.decision==='deny')review.reason+=`\n安全审查熔断：连续拒绝 ${circuit.consecutive} 次或最近 50 次中拒绝 ${circuit.denials} 次，本轮后续工具调用将被停止。`;
    if (reviewedCall && review?.decision === 'deny') {
      reviewedCall.approvalReason = review.reason;
      reviewedCall.approvalStage = 'stage' in review ? review.stage : undefined;
      reviewedCall.aborted = signal.aborted;
    }
    if (review?.decision === 'deny') {const call=msg.toolCalls?.find(c=>c.id===toolUseId);if(call)call.approval='denied';return {allowed:false,message:review.reason};}
    if (signal.aborted) return { allowed: false, message: '操作已取消' };
    if (review?.decision === 'allow') {
      const call = msg.toolCalls?.find((c) => c.id === toolUseId);
      if (call) call.approval = 'allowed';
      return { allowed: true, updatedInput: review.input };
    }
    const requestId = newId();
    const req: PendingApproval = { requestId, msgId: msg.id, toolName, input: review.input ?? input, toolUseID: toolUseId, description: review?.reason };
    cb.onPermissionRequest?.(req);
    try {
      const r = await awaitAbortable(() => cb.awaitPermission(req), signal);
      if (r.decision === 'allow') {
        if (signal.aborted) throw new Error('操作已取消');
        r.updatedInput = await approveTool(toolName, r.updatedInput ?? req.input, meta);
      }
      if (signal.aborted) throw new Error('操作已取消');
      recordDecision(toolName.replace(/^mcp__sage__/,''),r.updatedInput??input,meta,r.decision==='allow'?'allow':'deny','human-review',r.message??(r.decision==='allow'?(req.input?.network===true?'用户批准仅本次命令联网，保留文件沙箱':'用户批准本次操作'):'用户拒绝本次操作'));
      cb.onPermissionResolved?.(requestId, r.decision === 'allow' ? 'allowed' : 'denied');
      const call = msg.toolCalls?.find((c) => c.id === toolUseId);
      if (call) {
        call.approval = r.decision === 'allow' ? 'allowed' : 'denied';
        call.approvalStage = 'human-review';
        call.approvalReason = r.message ?? (r.decision === 'allow' ? (req.input?.network === true ? '用户批准仅本次命令联网，保留文件沙箱' : '用户批准本次操作') : '用户拒绝本次操作');
      }
      return r.decision === 'allow'
        ? { allowed: true, updatedInput: r.updatedInput ?? input }
        : { allowed: false, message: r.message ?? '用户拒绝了这次工具调用' };
    } catch (err: any) {
      if (reviewedCall) {
        reviewedCall.approval = 'denied';
        reviewedCall.aborted = !!signal.aborted;
        reviewedCall.approvalStage = 'human-review';
        reviewedCall.approvalReason = err?.message ?? '审核未完成';
      }
      recordDecision(toolName.replace(/^mcp__sage__/,''),input,meta,signal.aborted?'cancel':'deny','human-review',err?.message??'审核取消');
      cb.onPermissionResolved?.(requestId, 'denied');
      return { allowed: false, message: err?.message ?? 'aborted' };
    }
  };

  const askUser = cb.awaitClarify
    ? async (input: any): Promise<string> => {
        // 规范化 input：部分模型会把 options 序列化成 JSON 字符串
        const norm = normalizeAskUserInput(input);
        if (!norm.question) return ASKUSER_EMPTY_RETRY_MSG;
        const requestId = newId();
        const req: ClarifyRequest = {
          requestId,
          msgId: msg.id,
          question: norm.question || '(无问题内容)',
          options: norm.options,
          multiSelect: norm.multiSelect,
          questions: norm.questions,
          reason: norm.reason,
        };
        cb.onClarifyRequest?.(req);
        try {
          const answer = await cb.awaitClarify!(req);
          cb.onClarifyResolved?.(requestId, answer);
          return answer.trim() || '(用户未回答，请按你的最佳判断继续)';
        } catch (err: any) {
          cb.onClarifyResolved?.(requestId, '');
          return `(澄清被取消: ${err?.message ?? 'aborted'})`;
        }
      }
    : undefined;

  // ── 嵌套拆解管道（专家团嵌套专家团） ──
  // 专家执行中发现任务需要再拆解时调用 DecomposeTask：
  // 系统为这个任务生成子计划 → 子团队并行执行 → 聚合结果作为 tool_result 回填，
  // 专家继续整合收尾。仅顶层任务提供（depth < MAX），子团队成员不可再拆。
  const decompose =
    depth < MAX_EXPERTS_DEPTH
      ? async (input: any, hookContext?: string): Promise<string> => {
          const reason = String(input?.reason ?? '').trim() || '(未说明原因)';
          const focus = String(input?.focus ?? '').trim() || task.title;
          if (signal.aborted) return '(任务已中止，无法拆解)';

          // 状态消息：让用户看到"谁发起了再拆解"
          const statusMsg: ChatMessage = {
            id: newId(),
            role: 'assistant',
            content: expertsEnglish ? `Splitting into subtasks…\nReason: ${reason}` : `正在拆分子任务…\n原因：${reason}`,
            ts: new Date().toISOString(),
            experts: { kind: 'status', role: task.expert, expertName, depth: depth + 1, parentTaskId: task.id },
          };
          meta.messages.push(statusMsg);
          cb.send(statusMsg.id, 'message_start', { message: statusMsg });
          cb.send(statusMsg.id, 'message_end', { message: statusMsg });

          try {
            // Lead 规划逻辑复用：子目标 = 父任务上下文 + 拆解焦点
            const subPlan = await generateExpertsPlan({
              meta,
              goal:
                `这是上级任务「${task.title}」的进一步拆解，子团队必须严格聚焦以下范围。\n\n` +
                `子团队工作范围：${focus}\n拆解原因：${reason}\n\n` +
                // SubagentStart 钩子补充的上下文（hooks.json 外部命令产出，无则空）
                (hookContext ? `钩子补充信息（子团队需遵守）：\n${hookContext}\n\n` : '') +
                `原任务描述：\n${task.description}`,
              resolved,
              signal,
            });
            // 嵌套计划免确认直接执行（父计划已经用户确认过）
            assignUniqueExpertNames(subPlan.tasks, expertNamesInPlan(meta.expertsPlan ?? plan), t => (t.expert === 'lead' ? (customLeadInfo ?? leadDef()) : expertDef(t.expert)).humanNames);
            subPlan.status = 'confirmed';
            task.subPlan = subPlan;
            opts.onProgress?.();

            const noteMsg: ChatMessage = {
              id: newId(),
              role: 'assistant',
              content: expertsEnglish ? `Subteam plan ready (${subPlan.tasks.length} subtasks). Starting parallel execution.` : `子团队计划已生成（${subPlan.tasks.length} 个子任务），开始并行执行。`,
              ts: new Date().toISOString(),
              experts: { kind: 'status', role: task.expert, expertName, depth: depth + 1, parentTaskId: task.id },
            };
            meta.messages.push(noteMsg);
            cb.send(noteMsg.id, 'message_start', { message: noteMsg });
            cb.send(noteMsg.id, 'message_end', { message: noteMsg });

            await executeExpertsPlan({
              meta,
              plan: subPlan,
              resolved,
              signal,
              cb,
              onProgress: opts.onProgress,
              depth: depth + 1,
              parentTaskId: task.id,
              parallelCap: NESTED_PARALLEL_CAP,
            });

            // 聚合子任务结果回填给专家
            const agg = subPlan.tasks
              .map((t) => {
                const who = `${expertLabel(t.expert, t)}`;
                const state = t.status === 'done' ? '✅ 完成' : '❌ 失败/中止';
                return `### ${t.title}（${who}）[${state}]\n${(t.result ?? '(无结果)').slice(0, 2000)}`;
              })
              .join('\n\n');
            return (
              `子团队执行完毕，共 ${subPlan.tasks.length} 个子任务：\n\n${agg}\n\n` +
              `请基于以上结果继续完成你自己的任务（整合、收尾、输出总结）。`
            );
          } catch (err: any) {
            if (signal.aborted) return '(拆解被中止)';
            return `(子团队组建失败: ${err?.message ?? String(err)}。请继续自行完成任务。)`;
          }
        }
      : undefined;

  const onText = (chunk: string) => {
    msg.content += chunk;
    cb.send(msg.id, 'text', { chunk });
  };
  const onToolUse = (info: { id: string; name: string; input: any }) => {
    const call = {
      id: info.id,
      name: info.name,
      input: info.input,
      // 记录发起时刻的正文长度：UI 按此把正文与工具卡按时间顺序交错渲染
      contentOffset: msg.content.length,
    };
    msg.toolCalls = msg.toolCalls ?? [];
    msg.toolCalls.push(call);
    cb.send(msg.id, 'tool_use', { call });
    return opts.onProgress?.();
  };
  const onToolResult = (info: import('../shared/types').ToolResultInfo) => {
    const call = msg.toolCalls?.find((c) => c.id === info.id);
    if (call) { call.result = info.result; if(info.fileChanges)call.fileChanges=info.fileChanges; if (info.isError !== undefined) call.isError = info.isError; }
    const imageChanged = call && call.name === 'Desktop' && !signal?.aborted && attachToolResultImages(msg, info.id, info.images);
    cb.send(msg.id, 'tool_result', { callId: info.id, result: info.result, call, images: imageChanged ? msg.images : undefined });
    return opts.onProgress?.();
  };

  const baseOpts = {
    cwd: meta.projectPath,
    signal,
    model: resolved.model,
    apiKey: decryptSecret(resolved.apiKey),
    baseUrl: resolved.baseUrl,
    relayTransport:resolved.relayTransport,
    thinkingEffort: conversationExecutionEffort(meta) ?? resolved.thinkingEffort ?? 'low',
    thinkingModel: resolved.thinkingModel,
    monitor: {
      source: 'conversation' as const,
      convId: meta.id,
      messageId: msg.id,
      projectPath: meta.projectPath,
      label: `${meta.title} · ${expertLabel(task.expert, task)} · ${task.title}`,
    },
    canUseTool,
    askUser,
    decompose,
    // 插话注入：专家任务 agentic 循环在工具调用间隙取出插话消息
    interject: () => cb.interject?.({ taskId: task.id, parentTaskId: opts.parentTaskId }) ?? [],
    onText,
    onToolUse,
    onToolResult,
  };

  try {
    const prompt = buildTaskPrompt(meta, plan, task) + recovery + (task.subPlan ? '\n已有子任务状态：'+JSON.stringify(task.subPlan.tasks.map(t=>({title:t.title,status:t.status,result:t.result}))).slice(0,12000) : '');

    // ── 限流重试包裹：429 时等待后重试（并发控制见 executeExpertsPlan） ──
    const runOnce = async () => {
      return resolved.protocol === 'openai'
        ? await runOpenAIAPIAgentic({
            ...baseOpts,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
          })
        : await runClaudeAPIAgentic({
            ...baseOpts,
            // Claude 桥接内部有自己的 system prompt（工具规范），
            // 专家角色设定并入用户消息首部。
            messages: [{ role: 'user', content: `${systemPrompt}\n\n---\n\n${prompt}` }],
          });
    };

    let attempt = 0;
    let netRetry = 0;
    let r;
    for (;;) {
      attempt++;
      // 重试前清空已流式写入的部分内容，避免重试后内容重复
      if (attempt > 1) {
        msg.content = '';
        msg.toolCalls = [];
      }
      let thrown: any = null;
      try {
        r = await runOnce();
      } catch (err) {
        thrown = err;
      }

      // 中止：不重试，直接退出
      if (signal.aborted) {
        if (thrown) throw thrown;
        break;
      }

      // 限流判定：抛出的异常 或 桥接层返回的 error（两者都要覆盖）
      const errMsg = thrown ?? r?.error;
      if (errMsg && isRateLimitError(errMsg) && attempt <= 3) {
        const wait = Math.min(RATE_LIMIT_BACKOFF_MS, 3000 * attempt);
        cb.onRateLimited?.(wait);
        await sleep(wait, signal);
        if (signal.aborted) { if (thrown) throw thrown; break; }
        continue;
      }

      // 网络瞬态错误重试：ECONNRESET / ETIMEDOUT / fetch failed / 503 等。
      // 与限流重试独立计数，网络抖动后指数退避重试最多 NETWORK_MAX_RETRIES 次。
      if (errMsg && isNetworkError(errMsg) && netRetry < NETWORK_MAX_RETRIES) {
        netRetry++;
        const wait = Math.min(NETWORK_RETRY_BASE_MS * Math.pow(2, netRetry - 1), 10_000);
        console.warn(`[experts] 网络错误，第 ${netRetry}/${NETWORK_MAX_RETRIES} 次重试（${wait}ms）：${String(errMsg).slice(0, 120)}`);
        await sleep(wait, signal);
        if (signal.aborted) { if (thrown) throw thrown; break; }
        continue;
      }

      if (thrown) throw thrown;
      break;
    }

    // 中止收尾：重试等待中被 abort，r 可能未产生
    if (!r) {
      msg.pending = false;
      msg.error = msg.error ?? '任务被中止';
      task.status = 'error';
      task.result = task.result ?? msg.error;
      msg.ts = new Date().toISOString();
      cb.send(msg.id, 'message_end', { message: msg });
      return;
    }

    msg.pending = false;
    if (r.error) {
      msg.error = r.error;
      task.status = 'error';
      task.result = `执行失败：${r.error}`;
      cb.send(msg.id, 'error', { error: r.error });
    } else {
      if (!msg.content.trim() && r.text) msg.content = r.text;
      task.status = 'done';
      // 结果摘要：取输出末尾 1200 字符（专家被要求最后输出总结）
      task.result = msg.content.slice(-1200);
    }
    if (r.usage) meta.totalUsage = accUsage(meta.totalUsage, r.usage);
    msg.usage = r.usage;
    // 消息级统计归属：记录本轮实际使用的 provider/model（与 conv-engine 一致）。
    // 复合类型双算：selectedProviderId（用户选中的复合维度）+ providerId（实际成员）。
    if (r.usage && resolved) {
      msg.providerId = resolved.providerId;
      msg.modelId = resolved.model;
      msg.providerName = resolved.providerName;
      msg.selectedProviderId = resolved.selectedProviderId;
      msg.selectedModelId = resolved.selectedModelId;
    }
    msg.ts = new Date().toISOString();
    cb.send(msg.id, 'message_end', { message: msg });
  } catch (err: any) {
    msg.pending = false;
    msg.error = err?.message ?? String(err);
    task.status = 'error';
    task.result = `执行失败：${msg.error}`;
    msg.ts = new Date().toISOString();
    cb.send(msg.id, 'error', { error: msg.error });
    cb.send(msg.id, 'message_end', { message: msg });
  }
}

/**
 * 执行整份计划：依赖调度 + 真并行。
 *
 * 调度器模型：
 *  - 维护「运行集合 + 就绪队列」，任一任务完成立即补位，不做批次等待
 *  - 并发上限 = estimateParallel(resolved)（官方 Anthropic 3，第三方保守 2，
 *    用户可在设置里强制覆盖）
 *  - 自适应降级：任务遇到 429 时并发上限临时减半（冷却 20s 后恢复）
 *  - 依赖未满足的任务保持 pending，等依赖 done/error 后自动进入就绪队列
 */
export async function executeExpertsPlan(opts: {
  meta: ConversationMeta;
  plan: ExpertsPlan;
  resolved: ResolvedModel;
  signal: AbortSignal;
  cb: ExpertsCallbacks;
  /** 每个任务状态流转后的通知（ipc 层用来发 meta_update + 落盘）。 */
  onProgress?: () => void;
  /** 任务执行的嵌套深度（默认 1 = 顶层；嵌套子计划传 depth+1）。 */
  depth?: number;
  /** 嵌套执行时的父任务 id（depth > 1 时传入，透传给任务消息标记）。 */
  parentTaskId?: string;
  /** 并发上限覆盖（子团队用更保守的值，避免父子并发叠加打爆限流）。 */
  parallelCap?: number;
}): Promise<void> {
  const { meta, plan, resolved, signal, cb, onProgress } = opts;
  await refreshExpertSettings();
  const depth = opts.depth ?? 1;

  const baseParallel = Math.min(estimateParallel(resolved), opts.parallelCap ?? Number.MAX_SAFE_INTEGER);
  let limit = baseParallel;
  let cooldownUntil = 0;

  cb.onRateLimited = (waitMs) => {
    // 限流自适应：并发减半，冷却期 = 本次重试等待 × 1.5
    limit = Math.max(MIN_PARALLEL, Math.floor(limit / 2));
    cooldownUntil = Date.now() + Math.max(waitMs * 1.5, 10_000);
    console.warn(`[experts] 限流检测：并发降级为 ${limit}（${Math.round((cooldownUntil - Date.now()) / 1000)}s 后恢复）`);
  };

  const depsDone = (t: ExpertTask) =>
    (t.dependsOn ?? []).every((d) => {
      const dep = plan.tasks.find((x) => x.id === d);
      return dep && dep.status === 'done';
    });

  const running = new Set<string>();
  const inflight: Promise<void>[] = [];

  const launch = (task: ExpertTask) => {
    task.status = 'running';
    running.add(task.id);
    onProgress?.();
    const p = runExpertTask({ meta, plan, task, resolved, signal, cb, depth, parentTaskId: opts.parentTaskId, onProgress })
      .catch((err) => {
        // runExpertTask 内部已兜底，这里防御性处理
        task.status = 'error';
        task.result = task.result ?? `执行失败：${err?.message ?? err}`;
      })
      .finally(() => {
        running.delete(task.id);
        inflight.splice(inflight.indexOf(p), 1);
        onProgress?.();
      });
    inflight.push(p);
  };

  while (!signal.aborted) {
    // 冷却期结束 → 逐步恢复并发上限
    if (cooldownUntil && Date.now() >= cooldownUntil && limit < baseParallel) {
      limit = Math.min(baseParallel, limit + 1);
      cooldownUntil = limit < baseParallel ? Date.now() + 10_000 : 0;
    }

    // 补齐空闲槽位：依赖已满足的 pending 任务
    while (running.size < limit) {
      const next = plan.tasks.find((t) => t.status === 'pending' && depsDone(t));
      if (!next) break;
      launch(next);
    }

    if (inflight.length === 0) {
      // 无任务在跑：要么全部完成，要么剩余任务依赖无法满足（死锁防御）
      const stuck = plan.tasks.filter((t) => t.status === 'pending');
      if (stuck.length > 0) {
        for (const t of stuck) {
          t.status = 'error';
          t.result = '依赖无法满足，任务被跳过';
        }
        onProgress?.();
      }
      break;
    }

    // 等待任意一个任务完成，然后回到循环补位（真正的流水线并行）
    await Promise.race(inflight);
  }

  // 收尾：等待残余 in-flight（abort 时它们会很快终止）
  if (inflight.length > 0) {
    await Promise.allSettled(inflight);
  }

  if (depth > 1 && !signal.aborted && expertTasksComplete(plan.tasks)) {
    plan.status = 'done';
    onProgress?.();
  }

  // 中止收尾：未执行的任务标记取消
  if (signal.aborted) {
    for (const t of plan.tasks) {
      if (t.status === 'pending' || t.status === 'running') {
        t.status = 'error';
        t.result = t.result ?? '任务被中止';
      }
    }
  }
}

/**
 * 重试失败的专家团任务。
 *
 * 适用场景：网络中断 / API 瞬态错误（ECONNRESET、ETIMEDOUT、503 等）导致
 * 任务失败后，恢复网络，用户点击"重试失败任务"全量重跑所有 error 任务。
 *
 * 行为：
 *   - 收集 plan.tasks 中所有 status='error' 的任务（含子计划中的 error 任务），
 *     重置为 pending 并清除 result / error，复用 executeExpertsPlan 调度重跑。
 *   - 重跑期间保持原依赖关系不变；已完成的任务不重跑。
 *   - 所有失败任务都重跑成功 → 清除 hasFailedTasks 标记。
 *   - 仍有失败 → 保留 hasFailedTasks，用户可继续重试。
 *
 * 注意：依赖关系必须可满足。如果一个任务的依赖项中有 error 任务且该依赖
 * 也在本次重跑中，调度器会在依赖 done 后再启动它。
 */
export async function retryFailedExpertsTasks(opts: {
  meta: ConversationMeta;
  resolved: ResolvedModel;
  signal: AbortSignal;
  cb: ExpertsCallbacks;
  onProgress?: () => void;
}): Promise<{ retriedCount: number; remainingFailed: number }> {
  const { meta, resolved, signal, cb, onProgress } = opts;
  const plan = meta.expertsPlan;
  if (!plan) return { retriedCount: 0, remainingFailed: 0 };

  const retriedCount = prepareExpertsResume(plan);

  // 计划回到 running 状态
  plan.status = 'running';
  plan.hasFailedTasks = false;
  onProgress?.();

  await executeExpertsPlan({ meta, plan, resolved, signal, cb, onProgress });

  // 统计剩余失败任务
  const walkCountFailed = (tasks: ExpertTask[]): number =>
    tasks.reduce((sum, t) => sum + (t.status === 'error' ? 1 : 0) + (t.subPlan ? walkCountFailed(t.subPlan.tasks) : 0), 0);
  const remainingFailed = walkCountFailed(plan.tasks);
  plan.hasFailedTasks = remainingFailed > 0;
  if(!signal.aborted) await summarizeExpertsPlan({meta,plan,resolved,signal,cb});
  plan.status = 'done';
  onProgress?.();

  return { retriedCount, remainingFailed };
}

// ---------------------------------------------------------------------------
// Phase 3: 项目经理汇总
// ---------------------------------------------------------------------------

/**
 * 项目经理汇总所有任务结果，生成最终报告（流式写入对话消息）。
 */
export async function summarizeExpertsPlan(opts: {
  meta: ConversationMeta;
  plan: ExpertsPlan;
  resolved: ResolvedModel;
  signal: AbortSignal;
  cb: ExpertsCallbacks;
}): Promise<ChatMessage> {
  const { meta, plan, resolved, signal, cb } = opts;

  const msg: ChatMessage = {
    id: newId(),
    role: 'assistant',
    content: '',
    ts: new Date().toISOString(),
    pending: true,
    experts: { kind: 'summary', role: 'lead' },
  };
  meta.messages.push(msg);
  cb.send(msg.id, 'message_start', { message: msg });

  const taskReports = plan.tasks
    .map((t) => {
      return `### 任务：${t.title}（负责：${expertLabel(t.expert, t)}）\n状态：${t.status}\n结果：\n${(t.result ?? '(无输出)').slice(0, 2000)}`;
    })
    .join('\n\n');

  let prompt = `你是专家团的项目经理 ${rolePrimaryName('lead')}。专家团已完成对用户需求的执行，请给出最终汇总报告。

## 用户目标
${plan.goal}

## 各任务执行情况
${taskReports}

## 要求
用中文输出简洁的汇总报告：
1. 一段话概括整体完成情况
2. 关键成果清单（做了什么、改了什么）
3. 未完成/失败项及建议（如有）
4. 后续建议（如有必要）
不要重复任务细节原文，提炼要点即可。`;

  // 安全边界：把执行过程中累积的插话并入汇总 prompt
  if (cb.interject) {
    const injs = cb.interject();
    if (injs.length > 0) {
      prompt += `\n\n[用户插话，请在汇总中体现] ${injs.map((i) => i.text).join(' | ')}`;
    }
  }

  try {
    if (resolved.protocol === 'openai') {
      const client = new OpenAI({
        apiKey: decryptSecret(resolved.apiKey) || 'not-needed',
        baseURL: resolved.baseUrl || undefined,
        fetch:relayFetch(resolved.relayTransport),
        defaultHeaders: await getApiHeaders('openai'),
      });
      const stream = await client.chat.completions.create(
        {
          model: resolved.model,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
        },
        { signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) {
          msg.content += delta;
          cb.send(msg.id, 'text', { chunk: delta });
        }
      }
    } else {
      const client = new Anthropic({
        apiKey: decryptSecret(resolved.apiKey),
        baseURL: resolved.baseUrl || undefined,
        fetch:relayFetch(resolved.relayTransport),
        defaultHeaders: await getApiHeaders('anthropic'),
      });
      const stream = client.messages.stream(
        {
          model: resolved.model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal },
      );
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          msg.content += event.delta.text;
          cb.send(msg.id, 'text', { chunk: event.delta.text });
        }
      }
    }
  } catch (err: any) {
    if (!msg.content.trim()) {
      msg.error = err?.message ?? String(err);
      cb.send(msg.id, 'error', { error: msg.error });
    }
  }

  // 兜底：模型没输出时用结构化清单
  if (!msg.content.trim()) {
    const done = plan.tasks.filter((t) => t.status === 'done').length;
    msg.content = `专家团执行完毕：${done}/${plan.tasks.length} 个任务完成。`;
  }

  msg.pending = false;
  msg.ts = new Date().toISOString();
  cb.send(msg.id, 'message_end', { message: msg });
  return msg;
}
