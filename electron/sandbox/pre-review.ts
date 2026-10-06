import { claudeThinkingOptions, openAIThinkingOptions } from '../../shared/model-thinking';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { relayFetch } from '../relay-tls';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ConversationMeta, SandboxOverrides } from '../../shared/types';
import { resolveModel } from '../model-resolver';
import { beginRecord } from '../request-monitor';
import { parseReviewAssessment, REVIEW_INSTRUCTIONS_MAX_LENGTH, REVIEW_SYSTEM, reviewConversation, selectedReviewChecks, type ReviewAssessment } from './review-policy';
import { reportReview } from './review-status';
import { getApiHeaders } from '../utils/api-user-agent';
import { describeModelId } from '../../shared/model-id-label';

export type ReviewResult = Partial<Omit<ReviewAssessment, 'decision' | 'reason'>> & {
  decision: ReviewAssessment['decision'];
  reason: string;
  failure?: 'invalid_response' | 'cancelled' | 'provider' | 'timeout';
  checks?: string[];
};
interface ReviewContext {
  stage: string;
  startedAt: number;
  provider?: string;
  monitor?: ReturnType<typeof beginRecord>;
}
interface ReviewInput {
  command?: string;
  network?: boolean;
  networkReason?: string;
  networkTargets?: unknown;
  __sageNetworkEndpoints?: unknown;
  [key: string]: unknown;
}

export function parseReview(text: string): ReviewResult {
  return parseReviewAssessment(text) ?? { decision: 'ask', reason: 'AI 审查返回格式无效，操作尚未执行', failure: 'invalid_response' };
}

/** Bounded, project-local evidence only. Never follow a symlink outside the project. */
export async function buildEvidence(projectPath: string, command = '') {
  const root = await realpath(projectPath);
  const files: Record<string, string> = {};
  let budget = 48_000;
  async function add(name: string, depth = 0) {
    if (files[name] !== undefined || Object.keys(files).length >= 12 || depth > 3) return;
    try {
      const path = await realpath(resolve(root, name));
      if (!path.startsWith(root + sep)) return;
      const info = await stat(path);
      if (!info.isFile() || info.size > budget) return;
      const content = await readFile(path, 'utf8');
      budget -= Buffer.byteLength(content);
      files[name] = content;
      if (/\.(?:[cm]?js|ts|sh)$/.test(name)) {
        for (const match of content.matchAll(/(?:require\s*\(|from\s+|import\s*\(|source\s+)[\s'"]*(\.{1,2}\/[\w./-]+)/g)) {
          const ref = resolve(dirname(path), match[1]);
          await add(ref.slice(root.length + 1) + (extname(ref) ? '' : '.js'), depth + 1);
        }
      }
    } catch { /* Missing evidence is explicitly uncertainty, never permission. */ }
  }
  await add('package.json');
  for (const match of command.matchAll(/(?:^|\s)['"]?([\w./-]+\.(?:[cm]?js|ts|sh))(?=['"]?(?:\s|$))/g)) await add(match[1]);
  try {
    const scripts = JSON.parse(files['package.json'] ?? '{}').scripts ?? {};
    for (const script of Object.values(scripts)) {
      if (typeof script !== 'string') continue;
      for (const match of script.matchAll(/(?:^|\s)([\w./-]+\.(?:[cm]?js|ts|sh))(?=\s|$)/g)) await add(match[1]);
    }
  } catch { /* Reviewer receives absent/invalid package evidence. */ }
  return files;
}

async function evaluateBash(
  input: ReviewInput, meta: ConversationMeta, policy: SandboxOverrides, context: ReviewContext,
  signal: AbortSignal, toolName = 'Bash',
): Promise<ReviewResult> {
  const command = toolName === 'Bash' ? String(input?.command ?? '') : JSON.stringify(input);
  const review = policy.review ?? {};
  const networkReview = toolName === 'Bash' && input?.network === true && policy.runtime?.networkApproval === true;
  const stage = (detail: string) => {
    context.stage = detail;
    reportReview({ state: 'reviewing', detail, startedAt: context.startedAt });
  };
  try {
    if (!networkReview && !review.enabled) return { decision: 'ask', reason: '智能审查未开启，未知操作需要人工确认' };
    const instructionLengths = [review.policy?.length ?? 0, review.brainPrompt?.length ?? 0, review.denyPolicy?.length ?? 0].filter(length => length > 0);
    const instructionsLength = instructionLengths.reduce((total, length) => total + length, 0) + Math.max(0, instructionLengths.length - 1) * 2;
    if (command.length > 24_000 || instructionsLength > REVIEW_INSTRUCTIONS_MAX_LENGTH || (review.denyPolicy?.length ?? 0) > 8_000 ||
        (review.brainPrompt?.length ?? 0) > 8_000) return { decision: 'ask', reason: '操作或授权说明超过审查长度限制' };
    stage('解析审查模型');
    const model = await resolveModel({ selectedModel: review.model, convMeta: meta, projectPath: meta.projectPath });
    if (signal.aborted) return { decision: 'ask', reason: '审查已取消', failure: 'cancelled' };
    if (!model) return { decision: 'ask', reason: '没有可用的 API 审查模型', failure: 'provider' };
    context.provider = `${model.providerName ?? model.protocol} / ${describeModelId(model.model)}`;
    stage('收集任务授权和脚本证据');
    const checks = selectedReviewChecks(review);
    // Field order mirrors the review sequence; presets and user rules use one request.
    const content = JSON.stringify({
      selectedChecks: checks.map(({ id, name, focus }) => ({ id, name, focus })),
      authorization: review.policy,
      denyAuthorization: review.denyPolicy,
      denyTakesPrecedence: true,
      ...(review.brainPrompt ? { supplementalReviewInstructions: review.brainPrompt } : {}),
      conversation: reviewConversation(meta),
      projectPath: meta.projectPath,
      boundary: {
        projectOnly: true,
        protectedPaths: ['.sage', '.ssh', '.aws', '.gnupg', '.git/hooks', '.git/config', '.codex', '.agents', '.github/workflows',
          ...(policy.fs?.denyWriteSegments ?? ['package.json', 'package-lock.json'])],
      },
      ...(toolName === 'Bash' ? {
        command, files: await buildEvidence(meta.projectPath, command),
        ...(networkReview ? { networkRequest: {
          reason: input.networkReason, targets: input.networkTargets, endpoints: input.__sageNetworkEndpoints,
          scope: 'Only pinned IP:port outbound connections; no listening; filesystem sandbox retained',
        } } : {}),
      } : { tool: toolName, input }),
    });
    if (signal.aborted) return { decision: 'ask', reason: '审查已取消', failure: 'cancelled' };
    context.monitor = beginRecord({
      source: 'conversation', mode: 'api', purpose: 'ai-review', projectPath: meta.projectPath, convId: meta.id,
      label: `AI ${toolName} 预审`, model: model.model,
      request: { model: model.model, maxTokens: 4096, prompt: '一次 AI 预审：已选检查项和自定义规则；正文不重复记录' },
    });
    stage('等待 AI 预审结果');
    if (signal.aborted) return { decision: 'ask', reason: '审查已取消', failure: 'cancelled' };
    const effort = review.model?.thinkingEffort ?? 'low';
    let text: string;
    if (model.protocol === 'openai') {
      const client = new OpenAI({ defaultHeaders: await getApiHeaders('openai'), apiKey: model.apiKey || 'not-needed', baseURL: model.baseUrl || undefined, fetch:relayFetch(model.relayTransport), maxRetries: 0 });
      const result = await client.chat.completions.create({
        model: model.model, ...openAIThinkingOptions(model.thinkingModel ?? model.model, effort),
        messages: [{ role: 'system', content: REVIEW_SYSTEM }, { role: 'user', content }],
        response_format: { type: 'json_object' }, max_completion_tokens: 4096,
      }, { signal });
      text = result.choices[0]?.message.content ?? '';
    } else {
      const client = new Anthropic({ apiKey: model.apiKey, baseURL: model.baseUrl || undefined, fetch:relayFetch(model.relayTransport), defaultHeaders: await getApiHeaders('anthropic'), maxRetries: 0 });
      const result = await client.messages.create({
        model: model.model, ...claudeThinkingOptions(model.thinkingModel ?? model.model, effort), max_tokens: 12288,
        system: REVIEW_SYSTEM, messages: [{ role: 'user', content }],
      }, { signal });
      text = result.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('');
    }
    return { ...parseReview(text), checks: checks.map(check => check.name) };
  } catch (error: unknown) {
    if (signal.aborted) return { decision: 'ask', reason: '审查已取消', failure: 'cancelled' };
    const statusCode = (error as { status?: unknown })?.status;
    const status = Number.isInteger(statusCode) ? `HTTP ${statusCode}` : '连接或服务错误';
    return { decision: 'ask', failure: 'provider', reason: `AI 审查调用失败（${context.provider ?? context.stage}，${status}），操作尚未执行；可重试或人工确认具体影响` };
  }
}

/** A single deadline covers model resolution, evidence reading and the one API request. */
export async function preReviewBash(
  toolName: string, input: ReviewInput, meta: ConversationMeta, policy: SandboxOverrides, signal?: AbortSignal, deadlineMs?: number,
): Promise<ReviewResult> {
  const configured = Number(policy.review?.timeoutSeconds);
  const timeoutMs = deadlineMs ?? (Number.isFinite(configured) && configured > 0 ? Math.max(10, Math.min(180, configured)) : 60) * 1000;
  const controller = new AbortController();
  const context: ReviewContext = { stage: '准备预审', startedAt: Date.now() };
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let wake: (() => void) | undefined;
  const aborted = new Promise<ReviewResult>(resolve => {
    wake = () => resolve(signal?.aborted
      ? { decision: 'ask', reason: '用户已取消预审', failure: 'cancelled' }
      : { decision: 'ask', failure: 'timeout', reason: `AI 预审超时（${timeoutMs / 1000} 秒；${context.provider ?? '模型尚未就绪'}；${context.stage}）。操作尚未执行，可仅本次允许或调整预审模型/超时。` });
    controller.signal.addEventListener('abort', wake, { once: true });
  });
  const timer = setTimeout(cancel, timeoutMs);
  if (signal?.aborted) cancel();
  let result: ReviewResult;
  try {
    result = await Promise.race([evaluateBash(input, meta, policy, context, controller.signal, toolName), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (wake) controller.signal.removeEventListener('abort', wake);
    controller.abort();
  }
  if (result.failure) context.monitor?.fail(result.reason);
  else context.monitor?.finish({ response: { text: JSON.stringify(result) } });
  reportReview({
    state: result.failure === 'timeout' ? 'timeout' : result.failure === 'cancelled' ? 'cancelled' : result.failure ? 'error'
      : result.decision === 'allow' ? 'approved' : result.decision === 'deny' ? 'denied' : 'waiting-human',
    detail: result.reason, startedAt: context.startedAt, finishedAt: Date.now(),
  });
  return result;
}
