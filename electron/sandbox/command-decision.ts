import { effectiveSecuritySettings } from '../../shared/security-settings';
import { contextualPolicy } from './conversation-policy';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { listProjects } from '../store';
import type { ConversationMeta, SandboxOverrides } from '../../shared/types';
import { checkBashCommand } from './bash-policy';
import { commandForPolicy, routineCommand } from './shell-content';
import { preReviewBash, buildEvidence } from './pre-review';
import { runtimeAvailable } from './runtime';
import { boundedNetworkScope, type NetworkEndpoint } from './network-scope';
import { audit } from './audit-log';

export type CommandDecision = { decision: 'allow' | 'ask' | 'deny'; reason: string; input?: any; mode?: ExecutionMode; stage?: import('../../shared/types').AuditStage; category?: string };
export type ExecutionMode = 'project' | 'project-network' | 'build' | 'read' | 'full';
type Grant = { command: string; request: string; project: string; realProject: string; revision: string; evidence: string; expires: number; mode: ExecutionMode; endpoints?: NetworkEndpoint[]; convId?: string };
const grants = new Map<string, Grant>();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requestDigest = (input: any) => digest({command:input?.command, network:input?.network === true, networkReason:input?.networkReason, timeout:input?.timeout, networkTargets:input?.networkTargets});
const networkReviews = new Map<string, {request:string; project:string; convId:string; revision:string; evidence:string; expires:number; endpoints:NetworkEndpoint[]}>();

export async function commandPolicy(project: string): Promise<SandboxOverrides> {
  const active = contextualPolicy(project);
  if (active) return effectiveSecuritySettings({ ...active, fs: active.fs ?? {}, bash: active.bash ?? {} });
  const entry = (await listProjects()).find(p => resolve(p.path) === resolve(project));
  // Explicit empty sections prevent the active window's policy from leaking in.
  return effectiveSecuritySettings({ ...entry?.sandboxOverrides, fs: entry?.sandboxOverrides?.fs ?? {},
    bash: entry?.sandboxOverrides?.bash ?? {} });
}

async function issue(input: any, project: string, policy: SandboxOverrides, mode: ExecutionMode, expectedEvidence?: string, endpoints?: NetworkEndpoint[]): Promise<any> {
  const evidence = digest(await buildEvidence(project, String(input?.command ?? '')));
  if (expectedEvidence !== undefined && evidence !== expectedEvidence) throw new Error('构建脚本已变化，请重新审批');
  const realProject = await realpath(project);
  const now = Date.now();
  for (const [key, grant] of grants) if (grant.expires <= now) grants.delete(key);
  if (grants.size >= 256) grants.delete(grants.keys().next().value!);
  const token = randomBytes(24).toString('hex');
  grants.set(token, { command: String(input?.command ?? ''), request:requestDigest(input), project: resolve(project), realProject, evidence,
    revision: digest(policy), expires: now + 60_000, mode, endpoints });
  return { ...input, __sageApproval: token };
}

/** All callers use this classifier; text heuristics never become execution rights. */
export function classifyCommand(command: string, project: string, policy: SandboxOverrides): CommandDecision {
  policy = effectiveSecuritySettings(policy);
  if (policy.runtime?.fullAccess) return {decision:'allow',reason:'用户选择完全访问权限',mode:'full'};
  const candidate = routineCommand(command, project);
  const check = checkBashCommand(candidate, project, policy);
  if (!check.ok && !check.review) return { decision:'deny', reason:check.reason! };
  const allowedRule=(policy.bash?.allowed??[]).find(pattern=>new RegExp(pattern).test(candidate));
  if(allowedRule!==undefined)return {decision:'allow',reason:'命中 bash.allowed 命令允许规则：'+allowedRule,mode:'project'};
  if (policy.runtime?.autoApproveSandbox && runtimeAvailable()) return { decision: 'allow', reason: '命中 runtime.autoApproveSandbox=true（安全沙箱内命令自动允许）；禁止联网', mode: 'project' };
  if(!check.ok)return {decision:'ask',reason:check.reason!};
  const normalized = commandForPolicy(candidate).trim();
  if (policy.runtime?.autoApproveBuilds && runtimeAvailable() &&
      /^npm run build(?::(?:renderer|electron))?$/.test(candidate.trim())) {
    return { decision: 'allow', reason: '命中 runtime.autoApproveBuilds=true：npm run build 本地构建；仅允许写入构建产物目录，禁止联网', mode: 'build' };
  }
  if (/^(?:pwd|echo|printf)(?:\s|$)/.test(normalized) && !/[<>]/.test(normalized)) {
    return { decision: 'allow', reason: '命中内置只读规则：pwd / echo / printf（无重定向）' };
  }
  if (/^(?:ls|cat|head|tail|wc|stat)(?:\s|$)/.test(normalized) && !/[<>]/.test(normalized)) {
    return { decision: 'allow', reason: '命中内置只读命令规则：ls / cat / head / tail / wc / stat（无重定向）；只读沙箱' };
  }
  if (/^git\s+(?:status|diff|log)(?:\s|$)/.test(normalized) && !/--(?:output|ext-diff|textconv)|[<>]/.test(normalized)) {
    return { decision: 'allow', reason: '命中内置 Git 查询规则：git status / diff / log（禁止输出文件和外部执行参数）' };
  }
  return { decision: 'ask', reason: '需要确认命令副作用或脚本授权' };
}

/** Unified decision entry for ordinary conversations and expert tasks. */
async function evaluateCommand(input: any, meta: ConversationMeta, signal?: AbortSignal): Promise<CommandDecision> {
  if (signal?.aborted) return { decision: 'deny', reason: '操作已取消' };
  const policy = await commandPolicy(meta.projectPath);
  const result = classifyCommand(String(input?.command ?? ''), meta.projectPath, policy);
  if (!policy.runtime?.fullAccess && !runtimeAvailable()) return {decision:'deny',stage:'execution',reason:'当前运行时沙箱不可用，审批不能修复执行环境；操作未执行'};
  if (result.decision === 'deny') return {...result,stage:'direct-deny',category:/路径/.test(result.reason)?'文件保护':'命令规则'};
  if (input?.network === true && !policy.runtime?.fullAccess) {
    if (!policy.runtime?.networkApproval) return {decision:'deny', stage:'direct-deny', reason:'命令联网未开放。请在安全策略中启用“保留沙箱，联网单独审批”。'};
    if (typeof input.networkReason !== 'string' || !input.networkReason.trim() || input.networkReason.length > 4000) return {decision:'deny',reason:'联网申请必须通过 networkReason 提供用途、目标地址及发送的数据（最多 4000 字符）。'};
    let endpoints: NetworkEndpoint[];
    try { endpoints=await boundedNetworkScope(input.networkTargets,signal); } catch(e:any) { return {decision:'deny',stage:'execution',reason:e.message}; }
    const cleanTargets=(input.networkTargets as any[]).map(x=>({host:x.host,port:x.port}));
    input={...input,networkTargets:cleanTargets,__sageNetworkEndpoints:endpoints};
    const evidence = digest(await buildEvidence(meta.projectPath, String(input?.command ?? '')));
    const review = await preReviewBash('Bash', input, meta, policy, signal);
    audit({ts:new Date().toISOString(),source:'bash',tool:'Bash',stage:'ai-review',category:'单次联网预审',action:review.decision==='deny'?'deny':'review',projectPath:meta.projectPath,convId:meta.id,detail:{command:input.command,reason:`AI ${review.decision}：${review.reason}；仅限申请目标`}});
    if (signal?.aborted) return {decision:'deny',reason:'联网预审已取消'};
    if (review.decision === 'deny') return {...review,stage:'ai-review',category:'单次联网预审'};
    if (digest(await commandPolicy(meta.projectPath)) !== digest(policy) || digest(await buildEvidence(meta.projectPath, String(input?.command ?? ''))) !== evidence) return {decision:'deny',reason:'联网预审期间策略或脚本已变化，请重新申请'};
    if (review.decision === 'allow') return {...review,stage:'ai-review',input:await issue(input,meta.projectPath,policy,'project-network',evidence,endpoints)};
    for (const [id, r] of networkReviews) if (r.expires <= Date.now()) networkReviews.delete(id);
    if (networkReviews.size >= 256) networkReviews.delete(networkReviews.keys().next().value!);
    const token = randomBytes(24).toString('hex');
    networkReviews.set(token, {request:requestDigest(input),project:resolve(meta.projectPath),convId:meta.id,revision:digest(policy),evidence,expires:Date.now()+10*60_000,endpoints});
    return {decision:'ask',stage:'human-review',category:'单次联网审批',input:{...input,__sageNetworkReview:token},reason:`AI 预审待确认：${review.reason}\n用途：${input.networkReason}\n仅本次命令及其子进程可连接：${endpoints.map(e=>`${e.address}:${e.port}`).join(", ")}。文件隔离保留，不开放监听。请确认目标和数据用途；不确定时拒绝并补充说明。`};
  }
  if (result.decision === 'allow') return { ...result, stage:policy.runtime?.fullAccess?'full-access':'direct-allow', input: await issue(input, meta.projectPath, policy, result.mode ?? 'read') };
  if(!policy.review?.enabled)return {...result,stage:'human-review',reason:'AI 预审未开启，转人工审核'};
  const evidence = digest(await buildEvidence(meta.projectPath, String(input?.command ?? '')));
  const review = await preReviewBash('Bash', input, meta, policy, signal);
  if (signal?.aborted) return { decision: 'deny', reason: '操作已取消' };
  // A changed policy invalidates an in-flight model approval.
  if (digest(await commandPolicy(meta.projectPath)) !== digest(policy)) return { decision: 'ask', reason: '授权策略已变化，请重新审批' };
  if (digest(await buildEvidence(meta.projectPath, String(input?.command ?? ''))) !== evidence) return { decision: 'ask', reason: '预审期间构建脚本已变化，请重新审批' };
  return review.decision === 'allow'
    ? { ...review, stage:'ai-review', input: await issue(input, meta.projectPath, policy, 'project', evidence) } : {...review,stage:'ai-review'};
}

export async function decideCommand(input: any, meta: ConversationMeta, signal?: AbortSignal): Promise<CommandDecision> {
  const result = await evaluateCommand(input, meta, signal);
  audit({ ts: new Date().toISOString(), source: 'bash', tool: 'Bash', stage:result.stage, category:result.category,
    action: signal?.aborted ? 'cancel' : result.decision === 'deny' ? 'deny' : result.decision === 'ask' ? 'review' : 'approve',
    projectPath: meta.projectPath, convId: meta.id,
    detail: { command: String(input?.command ?? ''), reason: result.reason },
  });
  return result;
}

/** Only the application's human-approval callback may mint a manual grant. */
export async function approveCommand(input: any, meta: ConversationMeta): Promise<any> {
  const policy = await commandPolicy(meta.projectPath);
  const result = classifyCommand(String(input?.command ?? ''), meta.projectPath, policy);
  if (result.decision === 'deny') throw new Error(result.reason);
  if (input?.network === true && !policy.runtime?.fullAccess) {
    const token = input.__sageNetworkReview;
    const review = networkReviews.get(token);
    networkReviews.delete(token);
    if (!policy.runtime?.networkApproval || !review || review.expires <= Date.now() || review.project !== resolve(meta.projectPath) || review.convId !== meta.id || review.request !== requestDigest(input) || review.revision !== digest(policy)) throw Error('联网预审已失效，请重新申请');
    return issue(input, meta.projectPath, policy, 'project-network', review.evidence, review.endpoints);
  }
  return issue(input, meta.projectPath, policy, policy.runtime?.fullAccess ? 'full' : 'project');
}

/** Executor consumes the same decision, never reclassifies an approved heuristic. */
export async function consumeCommand(input: any, project: string): Promise<ExecutionMode> {
  const token = input?.__sageApproval;
  const grant = typeof token === 'string' ? grants.get(token) : undefined;
  if (typeof token === 'string') grants.delete(token);
  if (!grant || grant.expires <= Date.now() || grant.command !== String(input?.command ?? '') || grant.request !== requestDigest(input) ||
      grant.project !== resolve(project) || grant.revision !== digest(await commandPolicy(project)) ||
      grant.realProject !== await realpath(project) || grant.evidence !== digest(await buildEvidence(project, String(input?.command ?? '')))) {
    throw new Error('命令审批不存在、已使用、已过期或命令/策略已变化，请重新审批');
  }
  // Never trust an endpoint list supplied by a tool caller. Replace it from the consumed grant.
  if(grant.mode==='project-network' && (!grant.endpoints?.length || grant.endpoints.some(e=>!Number.isInteger(e.port)||!e.address)))throw Error('联网授权缺少固定目标');
  input.__sageNetworkEndpoints=grant.endpoints?.map(e=>({...e}));
  return grant.mode;
}
