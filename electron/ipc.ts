import { captureFailedTurnAnchor, planFailedConversationRetry, type FailedTurnAnchor } from './conversation-retry';
import { emitMobileReminderChange } from './channels/relay-client';
import { createLinkDownloadHandler } from './link-download';
import { LinkDownloadChannel } from '../shared/link-download';
import { conversationReadState, recordConversationReply, acknowledgeConversationRead } from './conversation-read-state';
import { handleApprovalReply } from './conversational-approval';
import { runningBundleId } from './privacy-identity';
import { createMonitorBuffer } from '../shared/monitor-memory';
import { acknowledgeTerminal } from './terminal';
import { WeakValueCache } from '../shared/bounded-cache';
import { openScreenshotEditor, registerScreenshotEditor } from './screenshot-editor';
import {respondScheduledApproval} from './scheduled-approvals';
import { readPreviewImage } from './preview-image';
import { materializeFileImages } from './file-attachments';
import { readBrowserEvidence } from './browser-evidence';
import { isUpdateInstalling } from './update-install-gate';
import { expertInterjectionMatches } from '../shared/expert-task-tree';
import { projectPdfUrl, openPdfInExternalBrowser } from './pdf-open';
import { gitBranchAction } from './git-branch-actions';
import {canResumeExperts} from '../shared/experts-resume';
import { resolveLanguage } from '../shared/language';
import { resolveAutoMode } from '../shared/auto-mode';
import { builtinSettingValue } from '../shared/builtin-plugins';
import {gitBrowserRefs,gitBrowserCommit,gitBrowserFile,gitBrowserFetch,invalidateRefsCache} from './git-browser';
import { withConversationExecution } from './conversation-execution';
import { initializeConversationPolicy } from './sandbox/conversation-policy';
import { grantConversation } from './sandbox/tool-decision';
import { enabledSecurityProfiles, securitySnapshot } from '../shared/security-profiles';
import { ipcMain, BrowserWindow, app, webContents, clipboard, systemPreferences } from 'electron';
import { writeClipboardPng } from './clipboard-image';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { captureFeedbackScreenshot, submitFeedback, probeFeedbackService, type FeedbackSubmission } from './feedback';
import { probeRelayCertificate, relayFetch } from './relay-tls';
import { probeRelayApply } from './relay-apply';
import { getRelayStatusSnapshot, setRelayClientName } from './channels/relay-client';
import { startVoice, stopVoice, killVoiceForSender, feedVoiceAudio, diagVoice, helperPath } from './voice';
import {
  IpcChannels,
  type SpecMeta,
  type StreamEvent,
  type StreamEventType,
  type ChatEvent,
  type ChatEventType,
  type ConvListChangedPayload,
  type ChatMessage,
  type ConversationMeta,
  type ConversationMode,
  type ExpertsPlan,
  type ImageAttachment,
  type Interjection,
  type ScheduledTask,
  type ChannelConfig,
  type InboundEventPayload,
  type ContextCompactionAudit,
  type PrivacySignatureIdentity,
  type PendingApproval as ApprovalRequest,
  type ClarifyRequest,
} from '../shared/types';
import {
  saveSpecMeta,
  listSpecsForProject,
  readDoc,
  writeDoc,
  findSpecById,
  deleteSpec,
  saveConv,
  loadConv,
  convRoot,
  listConvsForProject,
  setConvArchived,
  searchConvs,
  findConvById,
  deleteConv,
  readSteering,
  writeSteering,
  readWiki,
  deleteWiki,
  readPhaseChat,
  readProjectStats,
  addUsageToProjectStats,
  addUsageToGlobalStats,
  incrProjectStatsCounter,
  listProjects,
  projectHasUnread,
  type SteeringKind,
} from './store';
import { completeTextOnce } from './text-complete';
import {
  newSpecMeta,
  generatePhase,
  executeSpec,
  retryTask,
  refreshTasksFromDoc,
  generateRetroSpec,
  generateOptimizationReport,
  generateProjectWiki,
  refinePhaseChat,
  markDownstreamStale,
} from './spec-engine';
import { newConversation, sendMessage, flushSaves, queueSave, forwardToChannels, broadcastToChannels } from './conv-engine';
import { listMemories, addMemory, updateMemory, deleteMemory, dedupeMemories, listConvMemoryCounts, type MemoryScope } from './memory';
import {
  generateExpertsPlan,
  executeExpertsPlan,
  summarizeExpertsPlan,
  retryFailedExpertsTasks,
  setExpertsMaxParallel,
  estimateParallel,
  expertLabel,
  findExpertLabelByMsgId,
  refreshExpertSettings,
  currentExpertNameSignals,
  MAX_REPLANS,
  type ExpertsCallbacks,
} from './experts';
import { resolveModel } from './model-resolver';
import { listRecords, clearRecords, loadProjectRecords } from './request-monitor';
import { readSettings, patchSettings } from './main';
import { getMcpEnvironmentVariable } from './mcp-environment';
import {
  listDir,
  readFile as readProjFile,
  readFileAsBase64,
  isImageFile,
  writeFile as writeProjFile,
  searchFiles,
  searchFileContents,
  statFile,
  mkdir as mkdirProj,
  createFile as createProjFile,
} from './files';
import {
  detectGitRepo,
  gitBranchList,
  gitCurrentBranch,
  gitCheckout,
  gitBranchCreate,
  gitBranchDelete,
  gitPull,
  gitPush,
  gitStatus,
  gitStage,
  gitUnstage,
  gitCommit,
  gitDiff,
  gitFileDiff,
  gitLog,
  gitLogGraph,
  gitShow,
  gitDiffFiles,
  discoverGitReposCached,
  invalidateDiscoverCache,
  gitInit,
} from './git-utils';
import {
  createTerminal,
  writeTerminal,
  resizeTerminal,
  disposeTerminal,
  disposeAllForWindow as disposeAllPtysForWindow,
} from './terminal';
import {
  listScheduledTasks,
  saveScheduledTasks,
  saveScheduledRun,
  listScheduledRuns,
  listChannels as listChannelsStore,
  saveChannels as saveChannelsStore,
  setProjectEnabledPlugins,
} from './store';
import { listChannels as listChannelPlugins, testChannel } from './channels/registry';
import { setTelegramWebhook, deleteTelegramWebhook } from './channels/telegram';
import {
  listChannelDiag, clearChannelDiag, channelDiagLogPath, subscribeChannelDiag,
} from './channels/diagnostics';
import { feishuConnectionStatus } from './channels/feishu-realtime';
import {
  startScheduler,
  setActiveWindow,
  loadTasksForProject,
  createScheduledTask,
  updateScheduledTask,
  pauseScheduledForConversation,
  deleteScheduledTask,
  runScheduledTaskNow,
  getRunsForProject,
  startInboundWebhook,
  stopInboundWebhook,
  generateWebhookPath,
  getInboundUrl,
  startRelay,
  stopRelay,
  syncRelayWebhookToken,
} from './scheduler';

/**
 * GetWindows closure: returns the window registry from main.ts.
 * Key = webContents.id, value = BrowserWindow.
 */
type GetWindows = () => Map<number, BrowserWindow>;

/** 本应用 bundle id（build.appId）：tccutil reset 需要按 bundle 精确清除；读取失败回退硬编码值 */
function getAppBundleId(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    if (pkg?.build?.appId) return String(pkg.build.appId);
  } catch { /* 打包态读不到 package.json 时走下方默认值 */ }
  return 'sage.app';
}

/**
 * 运行实例的真实 TCC 身份：macOS 按「哪个 app 在问」查授权，开发态问的是 Electron 宿主
 * （com.github.Electron）而不是 sage.app，所以探测/重置都不能直接用 build.appId。
 */
function getRunningBundleId(): string {
  return runningBundleId();
}

let signatureIdentityCache: PrivacySignatureIdentity | null = null;

/**
 * 本构建的签名身份稳定性。ad-hoc 签名下 codesign 默认把 DR 写成本次构建的 cdhash，
 * TCC 因此把每个新 dmg 当成全新应用——用户明明在系统设置里给过麦克风/语音识别授权，
 * 应用读回来却是 not-determined。afterSign 用 build/designated-requirement.txt 把 DR
 * 钉成 identifier，跨版本保持。结果进程内缓存（面板 focus 刷新会反复探测，不必每次起 codesign）。
 */
function getSignatureIdentity(): PrivacySignatureIdentity {
  if (signatureIdentityCache) return signatureIdentityCache;
  let requirement = '';
  let adhoc = false;
  try {
    const result = spawnSync('/usr/bin/codesign', ['-d', '-r-', '-vv', process.execPath], { encoding: 'utf8', timeout: 4000 });
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    requirement = (out.match(/designated =>[^\n]*/) ?? [''])[0].trim();
    adhoc = /Signature=adhoc|flags=0x[0-9a-f]*\(adhoc/.test(out);
  } catch { /* 读不到按未知，只影响提示文案不影响授权探测 */ }
  const bundleId = getRunningBundleId();
  signatureIdentityCache = { bundleId, devInstance: bundleId !== getAppBundleId(), requirement, stable: !!requirement && !/cdhash/.test(requirement), adhoc };
  return signatureIdentityCache;
}

interface AborterEntry {
  controller: AbortController;
  /** webContents.id of the window that initiated this operation. */
  senderId: number;
}
const aborters = new Map<string, AborterEntry>();

/**
 * In-flight one-shot completions (LlmComplete): requestId → AbortController.
 * Populated only when the renderer passes a requestId; removed on settle or
 * on LlmCompleteAbort so the map can't leak.
 */
const inflightCompletions = new Map<string, AbortController>();

/**
 * In-memory cache for conversation meta. Every ConvSend used to
 * `findConvById` (full disk re-read of the JSON, plus a `listProjects`
 * scan to locate which project owns the conv). Cache by id; entries
 * are shared by reference with conv-engine.sendMessage so mutations
 * inside the engine show up in the cache automatically.
 *
 * Invalidated on ConvDelete; populated/overwritten on ConvCreate /
 * ConvGet / ConvUpdateMeta / ConvSend miss.
 */
const convCache = new WeakValueCache<string, ConversationMeta>(128, id => convIsExecuting(id));
const convLoads = new Map<string, Promise<ConversationMeta | null>>();

const mobileDeletes=new Set<string>();
let emptyConversationLifecycle: import('./empty-conversation').EmptyConversationLifecycle | undefined;
let emptyConversationLifecycleLoading: Promise<import('./empty-conversation').EmptyConversationLifecycle> | undefined;
function emptyConversations() {
  return emptyConversationLifecycleLoading ??= import('./empty-conversation').then(({ EmptyConversationLifecycle }) =>
    emptyConversationLifecycle = new EmptyConversationLifecycle({
      directory: meta => path.join(convRoot(meta.projectPath), meta.id),
      current: getConvCached, flush: flushSaves,
      busy: id => convIsExecuting(id) || failedQueueItems.has(id)
        || [...pendingApprovals.values()].some(p => p.convId === id) || [...pendingClarifies.values()].some(p => p.convId === id),
      acquire: id => { if (mobileDeletes.has(id) || messageMutations.has(id)) return false; mobileDeletes.add(id); return true; },
      release: id => { mobileDeletes.delete(id); },
      windowAlive: id => { const win = windowsRef().get(id); return !!win && !win.isDestroyed() && !win.webContents.isDestroyed(); },
      deleted: meta => { convCache.delete(meta.id); broadcastConvListChanged(-1, { projectPath: meta.projectPath, convId: meta.id, reason: 'deleted' }); },
    }));
}

export async function deleteMobileConversation(id:string):Promise<void>{
  if(mobileDeletes.has(id))throw Error('对话正在删除');mobileDeletes.add(id);
  try{
    const meta=await getConvCached(id);if(!meta)throw Error('对话不存在');if(convIsExecuting(id))throw Error('请先停止当前执行再删除对话');
    const {assertMobileProjectStoragePath}=await import('./mobile-project-management');
    if(!/^[\w-]{1,200}$/.test(id))throw Error('对话标识无效');
    for(const root of ['.sage','.claude-gui'])for(const directory of ['chats','conversations'])await assertMobileProjectStoragePath(meta.projectPath,root+'/'+directory+'/'+id+'/meta.json');
    if(meta.totalUsage){await addUsageToProjectStats(meta.projectPath,meta.totalUsage);await addUsageToGlobalStats(meta.totalUsage);}
    await deleteConv(meta);convCache.delete(id);broadcastConvListChanged(-1,{projectPath:meta.projectPath,convId:id,reason:'deleted'});
  }finally{mobileDeletes.delete(id);}
}

export async function getConvCached(id: string): Promise<ConversationMeta | null> {
  const c = convCache.get(id);
  // A moved project can leave a live UI reference in the weak cache. Reload the
  // record from registered roots instead of saving/deleting in its old folder.
  // Active turns retain object ownership; relocation takes effect after they stop.
  if (c && (convIsExecuting(id) || (typeof c.projectPath === 'string' && existsSync(path.join(convRoot(c.projectPath), id, 'meta.json'))))) return c;
  if (c) convCache.delete(id);
  const pending = convLoads.get(id);
  if (pending) return pending;
  const load = findConvById(id).then(meta => {
    if (meta) convCache.set(id, meta);
    return meta;
  }).finally(() => convLoads.delete(id));
  convLoads.set(id, load);
  return load;
}

/**
 * 主进程短文案的语言口径：与渲染层同源（settings.language 未设置时跟随系统语言）。
 */
async function mainTextEn(): Promise<boolean> {
  return resolveLanguage((await readSettings()).language, app.getLocale()) === 'en';
}

/**
 * 归档对话只读：主进程兜底拒绝一切「写历史 / 触发执行」的请求。
 * 渲染层已把这些入口全部隐藏，这里防的是旧标签页、渠道入站与任何绕过 UI 的调用。
 * 文案跟随界面语言（主进程产出的用户可见文案不得只写单一语言）。
 */
async function archivedReadOnlyError(): Promise<{ ok: false; error: string }> {
  const en = await mainTextEn();
  return {
    ok: false,
    error: en
      ? 'Archived chats are read-only. Unarchive this chat first (Settings → Archived chats).'
      : '归档对话仅供查看，请先在 设置 → 归档对话 中点击「解档」',
  };
}

/** 对话是否还有执行中 / 排队中的轮次：有则不允许归档，否则等于把还在跑的对话封成只读。 */
const messageMutations = new Set<string>();

export function convIsExecuting(convId: string): boolean {
  return messageMutations.has(convId) || aborters.has(convId) || convDraining.has(convId) || (convQueue.get(convId)?.length ?? 0) > 0;
}

/**
 * 更新对话缓存（供外部调用，如入站消息保存后刷新缓存）。
 * 直接从磁盘重新加载并缓存。
 */
export async function refreshConvCache(id: string): Promise<void> {
  // Active execution owns the cached object; replacing it loses live writes.
  if (aborters.has(id) && convCache.has(id)) return;
  const meta = await findConvById(id);
  if (aborters.has(id) && convCache.has(id)) return;
  if (meta) {
    convCache.set(id, meta);
  } else {
    convCache.delete(id);
  }
}

/**
 * 更新对话元数据（供外部调用，如渠道批准机制更新 preApprovedTools）。
 * 直接修改缓存并持久化到磁盘。
 */
export async function updateConvMeta(id: string, patch: Partial<ConversationMeta>): Promise<boolean> {
  const meta = await getConvCached(id);
  if (!meta) return false;
  Object.assign(meta, patch, { updatedAt: new Date().toISOString() });
  await saveConv(meta);
  return true;
}

interface PendingApproval {
  request?: ApprovalRequest;
  resolve: (r: { decision: 'allow' | 'deny'; updatedInput?: any; message?: string }) => void;
  convId: string;
  senderId: number;
  toolName?: string;
  /** 原始请求（工具名+参数）：会话级批量授权写入 grant 时用于匹配同命令。 */
  req?: { toolName: string; input?: any };
}
export const pendingApprovals = new Map<string, PendingApproval>();

/**
 * 挂起中的澄清请求（AskUser 工具）。与 pendingApprovals 同构：
 * 模型调用 AskUser → conv-engine 挂起 Promise → 用户回答后
 * ConvClarifyResponse resolve → 答案回填为 tool_result。
 */
interface PendingClarify {
  request?: ClarifyRequest;
  resolve: (answer: string) => void;
  convId: string;
  senderId: number;
}
const pendingClarifies = new Map<string, PendingClarify>();

/** Preserve the concrete requests for another authenticated client to review. */
export function getMobileInteractionRequests(convId: string) {
  return {
    approvals: [...pendingApprovals.entries()].filter(([, p]) => p.convId === convId).map(([requestId, p]) =>
      p.request ?? { requestId, msgId: '', toolName: p.req?.toolName ?? p.toolName ?? '', input: p.req?.input }),
    questions: [...pendingClarifies.entries()].filter(([, p]) => p.convId === convId && p.request).map(([, p]) => p.request!),
  };
}

export function respondPermissionRequest(args: { requestId: string; decision: 'allow' | 'deny' | 'allow-conv' | 'allow-conv-command'; updatedInput?: any; message?: string }, convId?: string) {
  const p = pendingApprovals.get(args.requestId);
  if (!p || (convId !== undefined && p.convId !== convId)) return { ok: false };
  pendingApprovals.delete(args.requestId);
  if (args.decision === 'allow-conv' || args.decision === 'allow-conv-command') {
    grantConversation(p.convId, args.decision === 'allow-conv' ? 'all' : 'command', p.req?.toolName ?? '', p.req?.input);
    p.resolve({ decision: 'allow', updatedInput: args.updatedInput,
      message: args.decision === 'allow-conv' ? '用户批准本对话的全部工具调用' : '用户批准本对话的同命令工具调用' });
  } else p.resolve({ decision: args.decision, updatedInput: args.updatedInput, message: args.message });
  return { ok: true };
}

export function respondClarifyRequest(args: { requestId: string; answer: string }, convId?: string) {
  const p = pendingClarifies.get(args.requestId);
  if (!p || (convId !== undefined && p.convId !== convId)) return { ok: false };
  pendingClarifies.delete(args.requestId);
  p.resolve(String(args.answer ?? ''));
  return { ok: true };
}

/**
 * 专家团模式：挂起中的计划确认。
 * 项目经理生成计划后等待用户确认/重新规划/取消，
 * ExpertsConfirmPlan IPC 到达后 resolve。
 */
export type PlanDecision =
  | { action: 'confirm' }
  | { action: 'replan'; feedback: string }
  | { action: 'cancel' };
const pendingPlanConfirms = new Map<string, (d: PlanDecision) => void>();

// ── Per-conversation FIFO queue for "interject" messages ──────────────────
// 当 Claude 正在回复时用户又发了新消息，不拒绝而是入队。当前轮结束后
// 自动出队下一条，直到队列清空。
interface QueuedSend {
  queueId: string;
  clientMessageId?: string;
  text: string;
  images?: Array<{ name: string; mimeType: string; dataBase64: string }>;
  senderId: number;
  /** Mobile-originated queued turns keep all-window streaming just like immediate sends. */
  broadcast?: boolean;
  /** 执行模式：首句排队时也必须保留，否则专家团会退化为智能体 */
  mode?: ConversationMode;
  resolve: (r: { ok: boolean; error?: string; meta?: ConversationMeta }) => void;
}
const convQueue = new Map<string, QueuedSend[]>();
const failedQueueItems = new Map<string, { queueId: string; text: string; images?: QueuedSend['images']; error: string; mode?: ConversationMode; anchor?: FailedTurnAnchor; broadcast?: boolean; inboundChannel?: Parameters<typeof runOneTurn>[6] }>();

function queuedMessages(convId: string): ChatMessage[] {
  return (convQueue.get(convId) ?? []).map(item => ({
    id: `u-queued-${item.queueId}`, role: 'user', content: item.text,
    images: item.images, queued: true, queueId: item.queueId,
    clientMessageId: item.clientMessageId, ts: new Date().toISOString(),
  }));
}

function emitQueueUpdate(convId: string, senderId: number): void {
  emitChat(windowsRef, senderId, {
    convId, msgId: '', type: 'queue_update',
    payload: { messages: queuedMessages(convId), running: aborters.has(convId) || convDraining.has(convId) }, ts: Date.now(),
  });
}

// ── 队列 drain 锁：防止 aborters.delete 与 drainQueue 之间的竞态窗口 ──
// runOneTurn 的 finally 中先 delete aborter，之后 drainQueue 才开始执行。
// 在这个窗口期到达的 ConvSend 请求如果不检查 convDraining，会绕过队列直接
// 执行，导致两条消息并发跑。drainQueue 执行前设置锁，完成后清除。
const convDraining = new Set<string>();

// ── 插话队列（安全边界注入）──────────────────────────────────────────────
// 与排队不同：插话消息立即显示在对话里，在下一个安全执行边界
// （工具调用之间）注入到 agent 上下文，不停止当前执行。
// agentic 循环在每次工具结果处理完后调用 drainInterjections() 取出。
const convInterjections = new Map<string, Interjection[]>();

/** 向插话队列追加一条消息（文字与图片一并携带）。 */
function pushInterjection(convId: string, item: Interjection): void {
  const q = convInterjections.get(convId);
  if (q) {
    q.push(item);
  } else {
    convInterjections.set(convId, [item]);
  }
}

/** 诊断日志：追加写 userData/diag-experts.log，定位专家团模式退化（复现后直接读文件）。 */
function diagExperts(info: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...info }) + '\n';
    appendFile(path.join(app.getPath('userData'), 'diag-experts.log'), line).catch(() => {});
  } catch {
    /* 诊断不得影响主链路 */
  }
}

/** 取出并清空插话队列（agentic 循环在安全边界调用）。 */
function drainInterjections(convId: string, accepts: (item: Interjection) => boolean = () => true): Interjection[] {
  const q = convInterjections.get(convId);
  if (q && q.length > 0) {
    const taken = q.filter(accepts);
    convInterjections.set(convId, q.filter(item => !taken.includes(item)));
    return taken;
  }
  return [];
}

/** 清空插话队列（turn 结束时调用，防止残留）。 */
function clearInterjections(convId: string): void {
  convInterjections.delete(convId);
}

/**
 * Module-level window registry reference. Assigned when
 * registerSpecHandlers runs, so module-level helpers (runOneTurn /
 * drainQueue) can emit chat events without being inside the closure.
 */
let windowsRef: GetWindows = () => new Map();

/** Append results using the live cached object so concurrent turns cannot overwrite them. */
export async function appendScheduledResult(projectPath:string,convId:string,taskName:string,content:string,runId:string,deliveryId='main'):Promise<void>{
  emptyConversationLifecycle?.retain(convId);
  const meta=await getConvCached(convId);
  if(!meta||meta.projectPath!==projectPath||meta.archived)throw new Error('Output conversation is missing or archived');
  const id='scheduled-result-'+runId+'-'+deliveryId;
  if(meta.messages.some(m=>m.id===id))return;
  const message:ChatMessage={id,role:'assistant',content:`⏳ ${taskName}\n\n${content}`,ts:new Date().toISOString()};
  meta.messages.push(message);meta.updatedAt=new Date().toISOString();
  await queueSave(meta);await flushSaves(meta.id);
  for(const [senderId]of windowsRef()){
    emitChat(windowsRef,senderId,{convId,msgId:id,type:'message_start',payload:{message},ts:Date.now()});
    emitChat(windowsRef,senderId,{convId,msgId:id,type:'message_end',payload:{message},ts:Date.now()});
  }
}

type MobileSubmissionResult =
  | { ok: true; accepted: true; queued?: boolean; queueId?: string; interjected?: boolean; msgId?: string; conversationId: string }
  | { ok: false; error: string };
const mobileSubmissions = new Map<string, MobileSubmissionResult>();
const pendingMobileSubmissions = new Map<string, Promise<MobileSubmissionResult>>();

/** Reserve the client ID before async attachment work, including retries using another send action. */
async function submitMobileRequest(
  convId: string,
  clientMessageId: string | undefined,
  submit: (meta: ConversationMeta, senderId: number) => Promise<MobileSubmissionResult> | MobileSubmissionResult,
): Promise<MobileSubmissionResult> {
  emptyConversationLifecycle?.retain(convId);
  const key = clientMessageId ? convId + ':' + clientMessageId : '';
  if (key && pendingMobileSubmissions.has(key)) return pendingMobileSubmissions.get(key)!;
  const request = (async (): Promise<MobileSubmissionResult> => {
    const meta = await getConvCached(convId);
    if (!meta) return { ok: false, error: 'Chat not found' };
    if (meta.archived) return { ok: false, error: 'Archived chats are read-only' };
    if (mobileDeletes.has(convId)) return { ok: false, error: 'Conversation is being deleted' };
    if (isUpdateInstalling()) return { ok: false, error: 'Update installation is in progress' };
    if (key && mobileSubmissions.has(key)) return mobileSubmissions.get(key)!;
    const existing = clientMessageId && meta.messages.find(m => m.clientMessageId === clientMessageId);
    if (existing) return { ok: true, accepted: true, conversationId: convId, interjected: existing.interjection || undefined, msgId: existing.id };
    const queued = clientMessageId && convQueue.get(convId)?.find(q => q.clientMessageId === clientMessageId);
    if (queued) return { ok: true, accepted: true, conversationId: convId, queued: true, queueId: queued.queueId };
    const senderId = [...windowsRef()].find(([, w]) => !w.isDestroyed() && !w.webContents.isDestroyed())?.[0];
    if (senderId === undefined) return { ok: false, error: 'Open a Sage desktop window to handle approvals' };
    const result = await submit(meta, senderId);
    if (key && result.ok) {
      mobileSubmissions.set(key, result);
      if (mobileSubmissions.size > 256) mobileSubmissions.delete(mobileSubmissions.keys().next().value!);
    }
    return result;
  })();
  if (key) pendingMobileSubmissions.set(key, request);
  try { return await request; }
  finally { if (key) pendingMobileSubmissions.delete(key); }
}

/** Mobile uses the same queue as desktop. Repeating a client ID cannot start a second turn. */
export async function submitMobileMessage(convId: string, text: string, images?: ImageAttachment[], clientMessageId?: string, internalMutation = false) {
  return submitMobileRequest(convId, clientMessageId, (meta, senderId) => {
    const approval = acceptConversationalApproval(meta, text, images, clientMessageId, true);
    if (approval) return approval.ok
      ? { ok: true, accepted: true, conversationId: convId, msgId: approval.msgId }
      : { ok: false, error: approval.error! };
    if (messageMutations.has(convId) && !internalMutation) return { ok: false, error: '正在修改消息，请稍后重试' };
    const queued = internalMutation ? aborters.has(convId) || convDraining.has(convId) || (convQueue.get(convId)?.length ?? 0) > 0 : convIsExecuting(convId);
    // Desktop determines the first turn automatically; existing expert conversations keep their mode.
    const mode: ConversationMode | undefined = meta.messages.some(message => message.role === 'user') ? meta.mode : 'auto';
    const result = { ok: true as const, accepted: true as const, conversationId: convId, queued, queueId: queued ? randomBytes(6).toString('base64url') : undefined };
    if (queued) {
      const q = convQueue.get(convId) ?? [];
      q.push({ queueId: result.queueId!, clientMessageId, text, images, senderId, mode, broadcast: true, resolve: () => {} });
      convQueue.set(convId, q); emitQueueUpdate(convId, senderId);
    } else {
      failedQueueItems.delete(convId);
      void runOneTurn(convId, text, images, senderId, meta, undefined, undefined, mode, clientMessageId, true, undefined, internalMutation)
        .then(() => drainQueue(convId)).catch(error => console.error('[mobile] turn failed:', error));
    }
    return result;
  });
}

export async function submitMobileInterjection(convId: string, text: string, images?: ImageAttachment[], clientMessageId?: string) {
  return submitMobileRequest(convId, clientMessageId, async (_meta, senderId) => {
    const result = await interjectConversation({ id: convId, text, images, clientMessageId }, senderId, true);
    if (!result.ok) return { ok: false, error: result.error || 'Interjection failed' };
    return { ok: true, accepted: true, conversationId: convId, interjected: result.interjected, queued: result.queued, queueId: result.queueId, msgId: result.msgId };
  });
}

/** Only authenticated desktop/mobile submissions reach this path; channel/model text never does. */
export function acceptConversationalApproval(
  meta: ConversationMeta, text: string, images: ImageAttachment[] | undefined,
  clientMessageId?: string, mobile = false,
) {
  // A retry of an older queued send is not fresh consent for a newly waiting tool.
  if (clientMessageId && convQueue.get(meta.id)?.some(item => item.clientMessageId === clientMessageId)) return;
  return handleApprovalReply({
    meta, text, images, clientMessageId, mobile,
    requests: [...pendingApprovals].map(([requestId, pending]) => ({ requestId, convId: pending.convId, request: pending.request })),
    competingQuestionOrPlan: [...pendingClarifies.values()].some(pending => pending.convId === meta.id) || pendingPlanConfirms.has(meta.id),
    updateInstalling: isUpdateInstalling(),
    resolve: (requestId, decision, message) => respondPermissionRequest({ requestId, decision, message }, meta.id),
    newId: () => randomBytes(6).toString('base64url'),
    accepted: message => {
      void queueSave(meta);
      emitChatToAll(windowsRef, { convId: meta.id, msgId: message.id, type: 'message_start', payload: { message }, ts: Date.now() });
      notifyMobileConversation(meta);
    },
  });
}

/** Desktop and mobile share history anchors, attachment handling and safe-boundary injection. */
async function interjectConversation(
  args: { id: string; text: string; images?: ImageAttachment[]; queueId?: string; clientMessageId?: string },
  senderId: number,
  mobile = false,
): Promise<{ ok: boolean; error?: string; interjected?: boolean; queued?: boolean; queueId?: string; msgId?: string; meta?: ConversationMeta }> {
  const meta = await getConvCached(args.id);
  if (!meta) return { ok: false, error: 'chat not found' };
  if (meta.archived) return archivedReadOnlyError();
  if (messageMutations.has(args.id) || mobileDeletes.has(args.id)) return { ok: false, error: '正在修改消息，请稍后重试' };
  if (isUpdateInstalling()) return { ok: false, error: 'Update installation is in progress' };
  if (!args.queueId) {
    const approval = acceptConversationalApproval(meta, args.text, args.images, args.clientMessageId, mobile);
    if (approval) return approval;
  }
  // Resolve queued content in the main process; never remove a message before acceptance.
  const queued = args.queueId ? convQueue.get(args.id)?.find(item => item.queueId === args.queueId) : undefined;
  if (args.queueId && (!queued || !aborters.has(args.id))) return { ok: false, error: 'Queue message is no longer available for interjection' };
  let text = String(queued?.text ?? args.text ?? '').trim();
  let images = queued?.images ?? (args.images && args.images.length > 0 ? args.images : undefined);
  if (!text && !images?.length) return { ok: false, error: 'empty text' };
  if (!queued) {
    try { ({ text, images } = await materializeFileImages(meta.projectPath, text, images)); }
    catch (error) { return { ok: false, error: `无法保存文件附件：${String(error)}` }; }
  }
  // Attachment work can yield while another client starts a message mutation.
  if (messageMutations.has(args.id) || mobileDeletes.has(args.id)) return { ok: false, error: '正在修改消息，请稍后重试' };
  if (meta.archived) return archivedReadOnlyError();
  if (isUpdateInstalling()) return { ok: false, error: 'Update installation is in progress' };
  const clientMessageId = queued?.clientMessageId ?? args.clientMessageId;
  const mode: ConversationMode | undefined = mobile ? (meta.messages.some(message => message.role === 'user') ? meta.mode : 'auto') : undefined;
  if (aborters.has(args.id)) {
    const active = [...meta.messages].reverse().find(m => m.role === 'assistant' && m.pending);
    const userMsg: ChatMessage = {
      id: randomBytes(6).toString('base64url'), role: 'user', content: text,
      ts: new Date().toISOString(), interjection: true, images, clientMessageId,
      interjectionAnchor: active ? {
        messageId: active.id, contentOffset: active.content.length,
        toolCallCount: active.toolCalls?.length ?? 0,
      } : undefined,
    };
    if (queued) {
      const q = convQueue.get(args.id)!;
      q.splice(q.indexOf(queued), 1);
      if (!q.length) convQueue.delete(args.id);
      queued.resolve({ ok: true });
      emitQueueUpdate(args.id, senderId);
    }
    meta.messages.push(userMsg);
    meta.updatedAt = userMsg.ts;
    pushInterjection(args.id, { text, images });
    void queueSave(meta);
    const event: ChatEvent = { convId: meta.id, msgId: userMsg.id, type: 'message_start', payload: { message: userMsg }, ts: Date.now() };
    if (mobile) emitChatToAll(windowsRef, event); else emitChat(windowsRef, senderId, event);
    return { ok: true, interjected: true, msgId: userMsg.id, meta };
  }
  // In the drain gap, enqueue rather than starting a concurrent turn.
  if (convDraining.has(args.id) || (convQueue.get(args.id)?.length ?? 0) > 0) {
    const queueId = randomBytes(6).toString('base64url');
    const q = convQueue.get(args.id) ?? [];
    q.push({ queueId, text, images, senderId, mode, clientMessageId, broadcast: mobile, resolve: () => {} });
    convQueue.set(args.id, q);
    emitQueueUpdate(args.id, senderId);
    return { ok: true, queued: true, queueId };
  }
  // Idle interjections use the ordinary send lifecycle without a phantom bubble.
  failedQueueItems.delete(args.id);
  const turn = runOneTurn(args.id, text, images, senderId, meta, undefined, undefined, mode, clientMessageId, mobile);
  if (mobile) {
    void turn.then(() => drainQueue(args.id)).catch(error => console.error('[mobile] turn failed:', error));
    return { ok: true };
  }
  const result = await turn;
  await drainQueue(args.id);
  return result;
}

export function getMobileInteractionState(convId: string) {
  return {
    running: aborters.has(convId) || convDraining.has(convId),
    queue: (convQueue.get(convId) ?? []).map(q => ({ id: q.queueId, text: q.text, imageCount: q.images?.length ?? 0 })),
    failed: failedQueueItems.get(convId) ? { text: failedQueueItems.get(convId)!.text, error: failedQueueItems.get(convId)!.error } : null,
    approvalCount: [...pendingApprovals.values()].filter(p => p.convId === convId).length,
    clarifyCount: [...pendingClarifies.values()].filter(p => p.convId === convId).length,
    planPending: pendingPlanConfirms.has(convId),
  };
}
export async function stopMobileConversation(convId: string) {
  const meta = await getConvCached(convId);
  if (!meta || meta.archived) throw Error('对话不存在或已归档');
  // Stop also clears queued turns so they cannot unexpectedly execute after the stop.
  for (const queued of convQueue.get(convId) ?? []) queued.resolve({ ok: false, error: '你已停止本次对话' });
  convQueue.delete(convId);
  aborters.get(convId)?.controller.abort('你已停止本次对话');
  for (const [id] of windowsRef()) emitQueueUpdate(convId, id);
}
export async function removeMobileQueuedMessage(convId: string, queueId: string) {
  const meta = await getConvCached(convId);
  if (!meta || meta.archived) throw Error('对话不存在或已归档');
  const queue = convQueue.get(convId), index = queue?.findIndex(q => q.queueId === queueId) ?? -1;
  if (!queue || index < 0) throw Error('排队消息已开始或已移除');
  const [removed] = queue.splice(index, 1); removed.resolve({ ok: false, error: 'removed from queue' });
  if (!queue.length) convQueue.delete(convId);
  for (const [id] of windowsRef()) emitQueueUpdate(convId, id);
}
/** Mutating mobile actions retain the desktop archive, update and live-window guards. */
async function mobileConversationContext(convId: string) {
  const meta = await getConvCached(convId);
  if (!meta || meta.archived) throw Error('对话不存在或已归档');
  if (isUpdateInstalling()) throw Error('正在安装更新，请重启后重试');
  const senderId = [...windowsRef()].find(([, w]) => !w.isDestroyed() && !w.webContents.isDestroyed())?.[0];
  if (senderId === undefined) throw Error('请打开 Sage 桌面端窗口');
  return { meta, senderId };
}
export async function takeMobileQueuedMessage(convId: string, queueId: string) {
  await mobileConversationContext(convId);
  const queue = convQueue.get(convId), index = queue?.findIndex(q => q.queueId === queueId) ?? -1;
  if (!queue || index < 0) throw Error('排队消息已开始或已移除');
  const [removed] = queue.splice(index, 1);
  if (!queue.length) convQueue.delete(convId);
  removed.resolve({ ok: false, error: 'removed from queue for editing' });
  for (const [id] of windowsRef()) emitQueueUpdate(convId, id);
  return { content: removed.text, images: removed.images?.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 })) ?? [] };
}
export async function promoteMobileQueuedMessage(convId: string, queueId: string) {
  const { senderId } = await mobileConversationContext(convId);
  if (messageMutations.has(convId) || mobileDeletes.has(convId)) throw Error('正在修改消息，请稍后重试');
  const queue = convQueue.get(convId), index = queue?.findIndex(q => q.queueId === queueId) ?? -1;
  if (!queue || index < 0) throw Error('排队消息已开始或已移除');
  if (aborters.has(convId)) {
    const result = await interjectConversation({ id: convId, text: '', queueId }, senderId, true);
    if (!result.ok) throw Error(result.error || '插话失败');
    return { accepted: true, interjected: true };
  }
  if (convDraining.has(convId)) throw Error('消息即将执行，请稍后重试');
  const [item] = queue.splice(index, 1); item.broadcast = true; queue.unshift(item);
  failedQueueItems.delete(convId);
  emitQueueUpdate(convId, senderId);
  void drainQueue(convId).catch(error => console.error('[mobile] queue failed:', error));
  return { accepted: true };
}
export async function reorderMobileQueuedMessages(convId: string, queueIds: string[]) {
  const { senderId } = await mobileConversationContext(convId);
  const queue = convQueue.get(convId);
  if (!queue || queueIds.length !== queue.length || new Set(queueIds).size !== queue.length) throw Error('队列已变化，请刷新后重试');
  const byId = new Map(queue.map(q => [q.queueId, q]));
  const reordered = queueIds.map(id => byId.get(id));
  if (reordered.some(item => !item)) throw Error('队列已变化，请刷新后重试');
  convQueue.set(convId, reordered as QueuedSend[]); emitQueueUpdate(convId, senderId);
  return { reordered: true };
}
/** One guarded retry transaction is shared by desktop and mobile. */
async function startFailedConversationRetry(meta: ConversationMeta, senderId: number, mobile = false) {
  const convId = meta.id;
  if (messageMutations.has(convId) || mobileDeletes.has(convId) || aborters.has(convId) || convDraining.has(convId))
    throw Error('对话正在执行或修改，请稍后重试');
  if (meta.archived || isUpdateInstalling()) throw Error('对话已归档或正在安装更新，请稍后重试');
  const failed = failedQueueItems.get(convId);
  if (!failed) throw Error('没有可重试的消息');
  planFailedConversationRetry(meta, failed.anchor);
  messageMutations.add(convId);
  const oldMessages = meta.messages, oldUpdatedAt = meta.updatedAt;
  let saved = false;
  let removedAssistant: ChatMessage | undefined;
  let removedIndex = -1;
  let consumed = false;
  let retryUpdatedAt: string | undefined;
  const emitMeta = (visibleMeta = meta) => {
    const event: ChatEvent = { convId, msgId: '', type: 'meta_update', payload: { meta: visibleMeta }, ts: Date.now() };
    if (mobile || failed.broadcast || failed.inboundChannel) emitChatToAll(windowsRef, event); else emitChat(windowsRef, senderId, event);
    notifyMobileConversation(visibleMeta);
  };
  try {
    await flushSaves(convId);
    if (await getConvCached(convId) !== meta || failedQueueItems.get(convId) !== failed)
      throw Error('失败消息已变化，请刷新后重试');
    if (meta.archived || isUpdateInstalling() || mobileDeletes.has(convId) || aborters.has(convId) || convDraining.has(convId))
      throw Error('对话正在执行、归档或更新，请稍后重试');
    const plan = planFailedConversationRetry(meta, failed.anchor);
    if (plan.removeAssistantMessageId) {
      removedIndex = meta.messages.findIndex(message => message.id === plan.removeAssistantMessageId);
      removedAssistant = meta.messages[removedIndex];
      meta.messages = meta.messages.filter(message => message.id !== plan.removeAssistantMessageId);
      meta.updatedAt = retryUpdatedAt = new Date().toISOString();
      await saveConv(meta);
      saved = true;
    }
    // Recheck state after the final asynchronous cache read, immediately before handoff.
    if (await getConvCached(convId) !== meta || failedQueueItems.get(convId) !== failed) throw Error('失败消息已变化，请刷新后重试');
    if (meta.archived || isUpdateInstalling() || mobileDeletes.has(convId) || aborters.has(convId) || convDraining.has(convId))
      throw Error('对话正在执行、归档或更新，请稍后重试');
    // Scheduled reports may append to this live history during the save, without the mutation lease.
    // The original user must still be the tail before creating a replacement assistant.
    planFailedConversationRetry(meta, failed.anchor?.state === 'messages'
      ? { ...failed.anchor, assistantMessageId: undefined } : failed.anchor);
    consumed = true;
    failedQueueItems.delete(convId);
    const turn = runOneTurn(convId, failed.text, failed.images, senderId, meta, undefined, failed.inboundChannel, failed.mode,
      undefined, mobile || failed.broadcast === true, plan.retryUserMessageId, true);
    // runOneTurn acquires its execution lease synchronously, before any model work.
    if (!aborters.has(convId)) {
      const result = await turn;
      throw Error(result.error || '无法开始重试，请稍后重试');
    }
    try { emitMeta(); } catch (error) { console.error('[retry] metadata notification failed:', error); }
    return { turn };
  } catch (error) {
    // Another legitimate writer may refresh the cache object; merge only our own removal
    // into its live history rather than persisting an obsolete snapshot over that writer.
    const current = removedAssistant ? await getConvCached(convId) : meta;
    if (removedAssistant && current) {
      const ownHistory = oldMessages.filter(message => message !== removedAssistant);
      const unchanged = current === meta && current.messages.length === ownHistory.length && current.messages.every((message, index) => message === ownHistory[index]);
      if (unchanged) {
        current.messages = oldMessages;
        if (current.updatedAt === retryUpdatedAt) current.updatedAt = oldUpdatedAt;
      } else if (!current.messages.some(message => message.id === removedAssistant!.id)) {
        // Restore only our removed placeholder, retaining reports appended by other writers.
        const previousId = oldMessages[removedIndex - 1]?.id;
        const previousIndex = current.messages.findIndex(message => message.id === previousId);
        current.messages.splice(previousIndex >= 0 ? previousIndex + 1 : Math.min(removedIndex, current.messages.length), 0, removedAssistant);
      }
    }
    if (consumed && !failedQueueItems.has(convId)) failedQueueItems.set(convId, failed);
    if (saved && current) { await saveConv(current); emitMeta(current); }
    throw error;
  } finally { messageMutations.delete(convId); }
}
export async function retryMobileFailedMessage(convId: string) {
  const { meta, senderId } = await mobileConversationContext(convId);
  const { turn } = await startFailedConversationRetry(meta, senderId, true);
  void turn.then(() => drainQueue(convId)).catch(error => console.error('[mobile] retry failed:', error));
  return { accepted: true };
}
export async function skipMobileFailedMessage(convId: string) {
  const { senderId } = await mobileConversationContext(convId);
  if (messageMutations.has(convId) || mobileDeletes.has(convId) || aborters.has(convId) || convDraining.has(convId)) throw Error('对话正在执行，请稍后重试');
  if (!failedQueueItems.has(convId)) throw Error('失败消息已处理，请刷新');
  failedQueueItems.delete(convId); emitQueueUpdate(convId, senderId);
  void drainQueue(convId).catch(error => console.error('[mobile] queue failed:', error));
  return { accepted: true };
}
export async function resumeMobileExecutionPlan(convId: string) {
  const { senderId } = await mobileConversationContext(convId);
  const result = await resumeExpertsConversation(convId, senderId, true);
  if (!result.ok) throw Error(result.error);
  return { accepted: true };
}

/** One pending plan decision is consumed once, whether sent from desktop or mobile. */
export async function confirmExpertsPlan(convId: string, action: PlanDecision['action'], feedback?: string) {
  const meta = await getConvCached(convId);
  if (!meta) return { ok: false, error: 'chat not found' };
  if (meta.archived) return archivedReadOnlyError();
  if (isUpdateInstalling()) return { ok: false, error: '正在安装更新，请稍后重试' };
  const resolve = pendingPlanConfirms.get(convId);
  if (!resolve) return { ok: false, error: '没有等待确认的计划' };
  pendingPlanConfirms.delete(convId);
  resolve(action === 'replan' ? { action, feedback: String(feedback ?? '').trim() || '请重新评估任务分解' } : { action });
  return { ok: true };
}
export async function confirmMobileExecutionPlan(convId: string, action: PlanDecision['action'], feedback?: string, planId?: string) {
  const { meta } = await mobileConversationContext(convId);
  if (planId !== undefined && meta.expertsPlan?.id !== planId) throw Error('执行计划已变化，请刷新后重新确认');
  const result = await confirmExpertsPlan(convId, action, feedback);
  if (!result.ok) throw Error(result.error);
  return { accepted: true };
}

/** Resume the existing confirmed plan with the same permission and clarification callbacks on every client. */
export async function resumeExpertsConversation(convId: string, senderId: number, mobile = false): Promise<{ ok: boolean; error?: string; accepted?: boolean; retriedCount?: number; remainingFailed?: number; meta?: ConversationMeta }> {
  const meta = await getConvCached(convId);
  if (!meta) return { ok: false, error: 'chat not found' };
  const plan = meta.expertsPlan;
  if (!plan) return { ok: false, error: '当前对话没有专家团计划' };

  if(aborters.has(convId)||convDraining.has(convId))return {ok:false,error:'对话正在执行，请勿重复恢复'};
  if(meta.archived)return {ok:false,error:'归档对话不能恢复执行'};
  if(!canResumeExperts(plan))return {ok:false,error:'没有需要继续的已确认计划'};

  if (isUpdateInstalling()) throw new Error('Update installation is in progress. Please retry after restart.');
  const aborter = new AbortController();
  aborters.set(convId, { controller: aborter, senderId });

  const send = (msgId: string, type: ChatEventType, payload?: any) => {
    const event: ChatEvent = { convId: meta.id, msgId, type, payload, ts: Date.now() };
    if (mobile) emitChatToAll(windowsRef, event); else emitChat(windowsRef, senderId, event);
  };

  return withConversationExecution(meta, async () => {
  let resolved: Awaited<ReturnType<typeof resolveModel>>;
  try {
    resolved = await resolveModel({ convMeta: meta, projectPath: meta.projectPath });
    if (!resolved) { aborters.delete(convId); return { ok: false, error: '专家团模式需要 API 直连模型，请先配置模型档案' }; }
  } catch (error) { aborters.delete(convId); throw error; }
  send('', 'turn_state', {running:true});

  const emitMeta = () => {
    meta.updatedAt = new Date().toISOString();
    send('', 'meta_update', { meta });
  };

  const execute = async () => {
  try {
    const cb: ExpertsCallbacks = {
      send,
      awaitPermission: (req) =>
        new Promise((resolve) => {
          pendingApprovals.set(req.requestId, { resolve, request: req, convId: meta.id, senderId, req: { toolName: req.toolName, input: req.input } });
        }),
      onPermissionRequest: (req) => send(req.msgId, 'permission_request', { request: req }),
      onPermissionResolved: (requestId, decision) =>
        send('', 'permission_resolved', { requestId, decision }),
      awaitClarify: (req) =>
        new Promise<string>((resolve) => {
          pendingClarifies.set(req.requestId, { resolve, request: req, convId: meta.id, senderId });
        }),
      onClarifyRequest: (req) => send(req.msgId, 'clarify_request', { request: req }),
      onClarifyResolved: (requestId, answer) =>
        send('', 'clarify_resolved', { requestId, answer }),
      interject: target => drainInterjections(meta.id, item => !target || expertInterjectionMatches(item.text, meta.expertsPlan, target)),
    };

    const { retriedCount, remainingFailed } = await retryFailedExpertsTasks({
      meta,
      resolved: resolved!,
      signal: aborter.signal,
      cb,
      onProgress: () => {
        emitMeta();
        return queueSave(meta);
      },
    });

    emitMeta();
    await flushSaves(meta.id);
    await saveConv(meta);

    return { ok: true, retriedCount, remainingFailed, meta };
  } finally {
    aborters.delete(convId);
    send('', 'turn_state', {running:false});
    // 清理残留的权限/澄清请求
    for (const [k, v] of pendingApprovals) {
      if (v.convId === convId) {
        v.resolve({ decision: 'deny', message: 'retry session ended' });
        pendingApprovals.delete(k);
      }
    }
    for (const [k, v] of pendingClarifies) {
      if (v.convId === convId) {
        v.resolve('(未回答，重试已结束)');
        pendingClarifies.delete(k);
      }
    }
  }
  };
  if (mobile) {
    void execute().catch(error => console.error('[mobile] plan resume failed:', error));
    return { ok: true, accepted: true };
  }
  return execute();
  }, true);
}
export async function getConversationReadState(meta: ConversationMeta) {
  return conversationReadState(path.join(convRoot(meta.projectPath), meta.id));
}
async function notifyReadState(meta: ConversationMeta, state: import('../shared/types').ConversationReadState) {
  // Keep later metadata IPC replies consistent with the independent persisted receipt.
  Object.assign(meta, state);
  broadcastConvListChanged(-1, { projectPath: meta.projectPath, convId: meta.id, reason: 'read-state',
    readState: state, projectUnread: await projectHasUnread(meta.projectPath) });
}
export async function markConversationRead(id: string, revision: number, expectedProjectPath?: string) {
  const meta = await getConvCached(id);
  if (!meta) throw Error('对话不存在');
  if (expectedProjectPath !== undefined && meta.projectPath !== expectedProjectPath) throw Error('对话不属于指定项目');
  const result = await acknowledgeConversationRead(path.join(convRoot(meta.projectPath), meta.id), revision);
  // A committed receipt remains successful when another project or a closing window prevents its hint.
  if (result.changed) {
    Object.assign(meta, result.state);
    try { await notifyReadState(meta, result.state); }
    catch (error) { console.error('[read-receipt] Cannot notify committed read state', error); }
  }
  return result.state;
}
function observeReply(event: ChatEvent) {
  const reply = event.payload?.message as ChatMessage | undefined;
  if (event.type !== 'message_end' || !reply || reply.role !== 'assistant' || reply.pending || reply.contextCompaction
    || (!reply.content?.trim() && !reply.images?.length && !reply.error)) return;
  void (async () => {
    const meta = await getConvCached(event.convId);
    if (!meta || meta.scheduledExecution) return;
    const result = await recordConversationReply(path.join(convRoot(meta.projectPath), meta.id), reply.id);
    if (result.changed) await notifyReadState(meta, result.state);
  })().catch(error => console.error('[read-receipt] Cannot record reply', error));
}

async function deleteConversationMessages(meta: ConversationMeta, ids: Set<string>) {
  if (meta.archived) throw Error('归档对话仅供查看，请先解档');
  if (convIsExecuting(meta.id) || mobileDeletes.has(meta.id)) throw Error('对话正在执行或删除，不能修改消息');
  messageMutations.add(meta.id);
  try { return await removeConversationMessages(meta, ids); }
  finally { messageMutations.delete(meta.id); }
}
async function removeConversationMessages(meta: ConversationMeta, ids: Set<string>) {
  const removed = meta.messages.filter(message => ids.has(message.id));
  if (!removed.length) throw Error('消息不存在');
  await flushSaves(meta.id);
  const oldMessages = meta.messages, oldUsage = meta.totalUsage, oldUpdatedAt = meta.updatedAt;
  const usage = meta.totalUsage && { ...meta.totalUsage };
  for (const message of removed) if (message.role === 'assistant' && message.usage && usage) {
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd'] as const)
      usage[key] = Math.max(0, usage[key] - (message.usage[key] ?? 0));
  }
  meta.messages = meta.messages.filter(message => !ids.has(message.id));
  meta.totalUsage = usage;
  meta.updatedAt = new Date().toISOString();
  try { await saveConv(meta); }
  catch (error) { meta.messages = oldMessages; meta.totalUsage = oldUsage; meta.updatedAt = oldUpdatedAt; throw error; }
  if (removed.some(message => message.role === 'assistant' && message.error)) failedQueueItems.delete(meta.id);
  notifyMobileConversation(meta);
  return { ok: true as const, meta };
}
export async function deleteMobileMessage(conversationId: string, messageId: string) {
  const meta = await getConvCached(conversationId);
  if (!meta) throw Error('对话不存在');
  await deleteConversationMessages(meta, new Set([messageId]));
  return { deleted: true };
}
export async function retryMobileMessage(conversationId: string, messageId: string) {
  const meta = await getConvCached(conversationId);
  if (!meta || meta.archived) throw Error('对话不存在或已归档');
  if (convIsExecuting(meta.id) || mobileDeletes.has(meta.id) || isUpdateInstalling()) throw Error('请等待当前执行完成后重试');
  const index = meta.messages.findIndex(message => message.id === messageId && message.role === 'assistant' && !!message.error && !message.pending);
  let userIndex = index - 1;
  while (userIndex >= 0 && meta.messages[userIndex].role !== 'user') userIndex--;
  if (index < 0 || userIndex < 0) throw Error('找不到可重试的原始消息');
  const user = meta.messages[userIndex];
  if (!user.content?.trim() && !user.images?.length) throw Error('原始消息为空');
  if (![...windowsRef()].some(([, window]) => !window.isDestroyed() && !window.webContents.isDestroyed())) throw Error('请先打开 Sage 桌面窗口');
  messageMutations.add(meta.id);
  const original = [...meta.messages], originalUsage = meta.totalUsage, originalUpdatedAt = meta.updatedAt;
  const originalFailure = failedQueueItems.get(meta.id);
  try {
    await removeConversationMessages(meta, new Set(meta.messages.slice(userIndex, index + 1).map(message => message.id)));
    try {
      const result = await submitMobileMessage(meta.id, user.content, user.images, undefined, true);
      if (!result.ok) throw Error(result.error);
      return result;
    } catch (error) {
      // Rejected or thrown submission leaves the old turn available for another retry.
      meta.messages = original; meta.totalUsage = originalUsage; meta.updatedAt = originalUpdatedAt;
      if (originalFailure) failedQueueItems.set(meta.id, originalFailure);
      await saveConv(meta); notifyMobileConversation(meta);
      throw error;
    }
  } finally { messageMutations.delete(meta.id); }
}
export async function getMobileMessageTool(conversationId: string, messageId: string, toolId: string) {
  const meta = await getConvCached(conversationId);
  const tool = meta?.messages.find(message => message.id === messageId)?.toolCalls?.find(call => call.id === toolId);
  if (!tool) throw Error('工具记录不存在，请刷新后重试');
  return { id: tool.id, name: tool.name, input: tool.input, result: tool.result,
    done: tool.result !== undefined, isError: tool.isError, aborted: tool.aborted, approval: tool.approval };
}

export function mobileConversationMutationBlocked(id: string) { return mobileDeletes.has(id) || messageMutations.has(id); }
export async function persistMobileConversationOptions(meta: ConversationMeta, patch: Partial<ConversationMeta>) {
  emptyConversationLifecycle?.retain(meta.id);
  if (mobileDeletes.has(meta.id) || messageMutations.has(meta.id)) throw Error('对话正在修改，请稍后重试');
  // Serialize config persistence with delete/archive and the start of queued turns.
  messageMutations.add(meta.id);
  try {
    await flushSaves(meta.id);
    if (await getConvCached(meta.id) !== meta || meta.archived || mobileDeletes.has(meta.id)) throw Error('对话已变化，请刷新');
    const keys = Object.keys(patch) as (keyof ConversationMeta)[];
    const previous = Object.fromEntries(keys.map(key => [key, meta[key]]));
    Object.assign(meta, patch);
    try { await saveConv(meta); }
    catch (error) {
      // Streaming history and unrelated/concurrent metadata remain owned by their callers.
      for (const key of keys) if (meta[key] === patch[key]) (meta as any)[key] = previous[key];
      throw error;
    }
  } finally { messageMutations.delete(meta.id); void drainQueue(meta.id); }
}

export function notifyMobileConversation(meta: ConversationMeta, reason: ConvListChangedPayload['reason'] = 'updated') {
  broadcastConvListChanged(-1, { projectPath: meta.projectPath, convId: meta.id, reason, archived: meta.archived });
}

/**
 * Execute a single turn (user msg → model → assistant response) for the
 * given conversation. Extracted from the ConvSend handler so both the
 * synchronous path and the queue-drain path can share it.
 */
export async function runOneTurn(
  convId: string,
  text: string,
  images: Array<{ name: string; mimeType: string; dataBase64: string }> | undefined,
  senderId: number,
  meta: ConversationMeta,
  queueId?: string,
  inboundChannel?: {
    id: string;
    name: string;
    type: string;
    senderId?: string;
    senderName?: string;
  },
  /** 执行模式（仅第一句消息生效，之后锁定在 meta.mode）。 */
  mode?: ConversationMode,
  clientMessageId?: string,
  broadcast = false,
  retryUserMessageId?: string,
  /** Only an already validated retry transaction may hand its own mutation lease to execution. */
  mutationHandoff = false,
): Promise<{ ok: boolean; error?: string; meta?: ConversationMeta }> {
  emptyConversationLifecycle?.retain(convId);
  if (isUpdateInstalling()) return { ok:false, error:'Update installation is in progress. Please retry after restart.' };
  if (aborters.has(convId)) return { ok: false, error: 'conversation is already running' };
  if (mobileDeletes.has(convId) || messageMutations.has(convId) && !mutationHandoff) return { ok: false, error: '正在修改消息，请稍后重试' };
  convCache.set(convId, meta);
  let turnError: string | undefined;
  let failedText = text;
  let failedImages = images;
  const initialMessageIds = meta.messages.map(message => message.id);
  let failedUserMessageId = retryUserMessageId;
  let failedAssistantMessageId: string | undefined;
  let retryAnchorEligible = true;
  if (isUpdateInstalling()) throw new Error('Update installation is in progress. Please retry after restart.');
  const aborter = new AbortController();
  aborters.set(convId, { controller: aborter, senderId });
  const send = (msgId: string, type: ChatEventType, payload?: any) => {
    const event = { convId: meta.id, msgId, type, payload, ts: Date.now() };
    // 外部渠道入站可能发生在另一个窗口当前活跃时。若仍只向 active
    // sender 定向发送，正在显示此对话的窗口收不到流事件，只能切换对话后重载。
    if (inboundChannel || broadcast) emitChatToAll(windowsRef, event);
    else emitChat(windowsRef, senderId, event);
  };

  send('', 'turn_state', { running: true });

  // Activate the queued bubble by identity before real message_start events.
  if (queueId) {
    send('', 'queue_start', { queueId, clientMessageId });
  }

  return withConversationExecution(meta, async () => {
  try {
    // ── 专家团模式首轮：模式在提交第一句时确定并锁定 ──
    let nextText = text;
    let continuation = false;
    // 续轮（provider 未在工具边界消费完的插话）携带的图片：与文字同属一个整体
    let continuationImages: ImageAttachment[] | undefined;
    let r: { ok: boolean; error?: string };
    const isFirstTurn = !meta.messages.some((m) => m.role === 'user');
    // 诊断日志：专家团首轮分支判定依据（退化排查用）
    diagExperts({
      where: 'run-one-turn',
      convId: meta.id,
      mode: mode ?? null,
      isFirstTurn,
      hasPlan: !!meta.expertsPlan,
      inbound: !!inboundChannel,
      queued: !!queueId,
    });
    console.log('[experts] first-turn check:', JSON.stringify({
      convId: meta.id,
      mode: mode ?? null,
      isFirstTurn,
      hasPlan: !!meta.expertsPlan,
      inbound: !!inboundChannel,
    }));
    if (mode === 'auto') mode = resolveAutoMode(text, currentExpertNameSignals());
    // 首句实际执行模式（含 auto 解析结果）持久化进 meta：
    // 重进对话时选择器恢复为「当时实际用的模式」；否则草稿清空后回退 auto，
    // 用户会误以为自己选的模式丢了（agent 分支此前不回写 meta.mode）。
    if (isFirstTurn && meta.mode !== mode) {
      meta.mode = mode;
      void queueSave(meta);
    }
    if (mode === 'experts' && (!meta.expertsPlan || meta.expertsPlan.status === 'done' && !meta.expertsPlan.hasFailedTasks) && !inboundChannel) {
      retryAnchorEligible = false;
      const result = await runExpertsFirstTurn(meta, text, senderId, aborter, send, clientMessageId);
      if (!result.ok) { turnError = result.error ?? '执行失败'; return result; }
      const drained = drainInterjections(convId);
      nextText = drained.map((d) => d.text).join('\n\n');
      continuationImages = drained.flatMap((d) => d.images ?? []);
      if ((!nextText && !continuationImages.length) || aborter.signal.aborted) return result;
      continuation = true;
    }

    do {
      failedText = nextText;
      failedImages = continuation ? continuationImages : images;
      retryAnchorEligible = !continuation;
      failedAssistantMessageId = undefined;
      r = await sendMessage({
        meta,
        text: nextText,
        clientMessageId: continuation ? undefined : clientMessageId,
        skipUserMessage: continuation || !!retryUserMessageId,
        retryUserMessageId: continuation ? undefined : retryUserMessageId,
        images: continuation ? continuationImages : images,
        inbound: inboundChannel
          ? {
              channelId: inboundChannel.id,
              channelName: inboundChannel.name,
              channelType: inboundChannel.type,
              senderId: inboundChannel.senderId,
              senderName: inboundChannel.senderName,
            }
          : undefined,
        signal: aborter.signal,
        onMessageStart: (m) => {
          if (m.role === 'user') failedUserMessageId = m.id;
          if (m.role === 'assistant') failedAssistantMessageId = m.id;
          send(m.id, 'message_start', { message: m });
        },
        onContextAudit: (audits) => send('', 'context_audit', { audits }),
        onText: (msgId, chunk, updatedAt) => send(msgId, 'text', { chunk, updatedAt }),
        onToolUse: (msgId, call, updatedAt) => send(msgId, 'tool_use', { call, updatedAt }),
        onReviewStatus: (msgId, callId, status) => send(msgId, 'review_status', {callId,status}),
        onToolResult: (msgId, callId, result, updatedAt, call, images) =>
          send(msgId, 'tool_result', { callId, result, updatedAt, call, images }),
        onMessageEnd: (m) => send(m.id, 'message_end', { message: m }),
        onError: (msgId, error) => send(msgId, 'error', { error }),
        onRetry: (msgId, info) => send(msgId, 'retrying', info),
        onPermissionRequest: (req) => {
          send(req.msgId, 'permission_request', { request: req });
          // 如果消息来自渠道，向该渠道发送通知
          if (inboundChannel) {
            void notifyChannelForPermission(meta, inboundChannel, req);
          }
        },
        onPermissionResolved: (requestId, decision) =>
          send('', 'permission_resolved', { requestId, decision }),
        awaitPermission: (req) =>
          new Promise((resolve) => {
            pendingApprovals.set(req.requestId, { resolve, request: req, convId: meta.id, senderId, req: { toolName: req.toolName, input: req.input } });
          }),
        onClarifyRequest: (req) =>
          send(req.msgId, 'clarify_request', { request: req }),
        onClarifyResolved: (requestId, answer) =>
          send('', 'clarify_resolved', { requestId, answer }),
        awaitClarify: (req) =>
          new Promise<string>((resolve) => {
            pendingClarifies.set(req.requestId, { resolve, request: req, convId: meta.id, senderId });
          }),
        // 插话注入：agentic 循环在安全边界（工具调用之间）调用，
        // 取出累积的插话消息注入到 agent 上下文。
        interject: () => drainInterjections(convId),
      });

      // A provider may finish without another tool boundary (including SDK runs).
      // Continue only after it has fully settled; accepted interjections already
      // exist in history, so do not insert another user bubble.
      const remaining = r.ok && !aborter.signal.aborted ? drainInterjections(convId) : [];
      nextText = remaining.map((d) => d.text).join('\n\n');
      continuationImages = remaining.flatMap((d) => d.images ?? []);
      continuation = true;
    } while (nextText || continuationImages?.length);
    if (!r.ok) turnError = r.error ?? '执行失败';
    return { ok: r.ok, error: r.error, meta };
  } catch (error) {
    turnError = error instanceof Error ? error.message : String(error);
    for (const message of meta.messages) {
      if (message.role === 'assistant' && message.pending) {
        message.pending = false;
        message.error = turnError;
        send(message.id, 'message_end', { message });
      }
    }
    await queueSave(meta).catch(() => {});
    return { ok: false, error: turnError, meta };
  } finally {
    aborters.delete(convId);
    send('', 'meta_update', { meta, completedClientMessageId: clientMessageId });
    send('', 'turn_state', { running: false });
    // Cancellation with no waiting work belongs to the stopped message, not a queue error.
    const remainingQueued = convQueue.get(convId)?.length ?? 0;
    if (turnError && (!aborter.signal.aborted || remainingQueued > 0)) {
      failedQueueItems.set(convId, { queueId: queueId ?? clientMessageId ?? convId, text: failedText, images: failedImages, error: turnError, mode, broadcast, inboundChannel: inboundChannel && { ...inboundChannel },
        anchor: retryAnchorEligible ? captureFailedTurnAnchor(meta, initialMessageIds, failedUserMessageId, failedAssistantMessageId) : undefined });
      send('', 'queue_stopped', {
        error: turnError, failedQueueId: queueId ?? clientMessageId ?? convId,
        failedText, remaining: remainingQueued,
      });
    }
    // 插话队列收尾：turn 结束后清空残留，避免污染下一轮
    clearInterjections(convId);
    // Drop any lingering approvals for this conv
    for (const [k, v] of pendingApprovals) {
      if (v.convId === convId) {
        v.resolve({ decision: 'deny', message: 'session ended' });
        pendingApprovals.delete(k);
      }
    }
    // Drop any lingering clarifies for this conv（abort/异常收尾时避免永久挂起）
    for (const [k, v] of pendingClarifies) {
      if (v.convId === convId) {
        v.resolve('(未回答，对话已结束)');
        pendingClarifies.delete(k);
      }
    }
    // 专家团：会话结束时若仍在等待计划确认，按取消处理
    const pc = pendingPlanConfirms.get(convId);
    if (pc) {
      pc({ action: 'cancel' });
      pendingPlanConfirms.delete(convId);
    }
    if (!turnError) void drainQueue(convId);
  }
  }, true);
}

/**
 * 专家团模式首轮编排：
 *   1. 锁定 mode='experts'，写入用户消息
 *   2. 项目经理规划 → 计划卡片 → 等待用户确认（可重新规划 ≤ MAX_REPLANS 次）
 *   3. 依赖调度并行执行任务（流式写入对话）
 *   4. 项目经理汇总报告 + 渠道出站/广播
 */
async function runExpertsFirstTurn(
  meta: ConversationMeta,
  text: string,
  senderId: number,
  aborter: AbortController,
  send: (msgId: string, type: ChatEventType, payload?: any) => void,
  clientMessageId?: string,
): Promise<{ ok: boolean; error?: string; meta?: ConversationMeta }> {
  const signal = aborter.signal;
  diagExperts({ where: 'experts-first-turn-enter', convId: meta.id });
  const newId = () => randomBytes(6).toString('base64url');
  const now = () => new Date().toISOString();

  /** 计划/状态流转后通知渲染端刷新 meta（计划卡片、进度）。 */
  const emitMeta = () => {
    meta.updatedAt = now();
    send('', 'meta_update', { meta });
  };

  const pushStatus = (content: string): ChatMessage => {
    const m: ChatMessage = {
      id: newId(),
      role: 'assistant',
      content,
      ts: now(),
      pending: true,
      experts: { kind: 'status', role: 'lead' },
    };
    meta.messages.push(m);
    send(m.id, 'message_start', { message: m });
    return m;
  };

  const endStatus = (m: ChatMessage, error?: string) => {
    m.pending = false;
    if (error) m.error = error;
    m.updatedAt = now();
    if (error) send(m.id, 'error', { error });
    send(m.id, 'message_end', { message: m });
  };

  // ── 锁定模式 + 写入用户消息（与 sendMessage 首句行为对齐） ──
  meta.mode = 'experts';
  if (meta.messages.length === 0 && meta.title === '新对话') {
    meta.title = text.slice(0, 40).replace(/\s+/g, ' ');
  }
  const userMsg: ChatMessage = { id: newId(), role: 'user', content: text, ts: now(), clientMessageId };
  meta.messages.push(userMsg);
  void queueSave(meta);

  // 广播：用户在客户端输入的消息（与 sendMessage 一致）
  if (meta.broadcastUserChannelIds && meta.broadcastUserChannelIds.length > 0) {
    void broadcastToChannels(meta, 'user', text, meta.broadcastUserChannelIds).catch((e) => {
      console.error('[experts] broadcast user message failed:', e);
    });
  }

  // ── 模型解析：专家团模式必须 API 直连（规划/任务/汇总都走 API） ──
  const resolved = await resolveModel({ convMeta: meta, projectPath: meta.projectPath });
  if (!resolved) {
    const m = pushStatus('❌ 专家团模式需要 API 直连模型。请先在设置中配置模型档案（或 API Key）。');
    endStatus(m, '专家团模式需要 API 直连模型');
    await flushSaves(meta.id);
    await saveConv(meta);
    return { ok: false, error: '专家团模式需要 API 直连模型，请先配置模型档案', meta };
  }

  // ── 并行上限：读取用户设置（未设置 = 按端点自动估计） ──
  try {
    const settings = await readSettings();
    setExpertsMaxParallel(settings?.expertsMaxParallel);
  } catch {
    setExpertsMaxParallel(undefined);
  }

  // ── 事件回调接线（权限/澄清管道与 runOneTurn 同构） ──
  const cb: ExpertsCallbacks = {
    send,
    awaitPermission: (req) =>
      new Promise((resolve) => {
        pendingApprovals.set(req.requestId, { resolve, request: req, convId: meta.id, senderId, req: { toolName: req.toolName, input: req.input } });
      }),
    onPermissionRequest: (req) => send(req.msgId, 'permission_request', { request: req }),
    onPermissionResolved: (requestId, decision) =>
      send('', 'permission_resolved', { requestId, decision }),
    awaitClarify: (req) =>
      new Promise<string>((resolve) => {
        pendingClarifies.set(req.requestId, { resolve, request: req, convId: meta.id, senderId });
      }),
    onClarifyRequest: (req) => send(req.msgId, 'clarify_request', { request: req }),
    onClarifyResolved: (requestId, answer) => send('', 'clarify_resolved', { requestId, answer }),
    // 插话注入：专家团各调用点在安全边界取出累积的插话消息
    interject: target => drainInterjections(meta.id, item => !target || expertInterjectionMatches(item.text, meta.expertsPlan, target)),
  };

  // ── Phase 1: 项目经理规划 ──
  // 先加载自定义专家定义，状态消息才能用上改过的成员名（否则回退内置名）
  await refreshExpertSettings();
  const statusMsg = pushStatus(`${expertLabel('lead')} 正在分析需求、制定执行计划…`);
  emitMeta();

  let plan: ExpertsPlan;
  try {
    plan = await generateExpertsPlan({ meta, goal: text, resolved, signal, interject: () => drainInterjections(meta.id) });
  } catch (err: any) {
    statusMsg.content = `❌ 规划失败：${err?.message ?? err}`;
    endStatus(statusMsg, String(err?.message ?? err));
    await flushSaves(meta.id);
    await saveConv(meta);
    return { ok: false, error: String(err?.message ?? err), meta };
  }
  if (signal.aborted) {
    endStatus(statusMsg, 'aborted');
    return { ok: true, meta };
  }
  statusMsg.content = `计划已就绪：分解为 ${plan.tasks.length} 个任务，确认后开始执行。`;
  endStatus(statusMsg);

  // 计划卡片消息
  const planMsg: ChatMessage = {
    id: newId(),
    role: 'assistant',
    content: formatPlanText(plan),
    ts: now(),
    experts: { kind: 'plan', role: 'lead' },
  };
  meta.messages.push(planMsg);
  meta.expertsPlan = plan;
  send(planMsg.id, 'message_start', { message: planMsg });
  emitMeta();
  await flushSaves(meta.id);
  await saveConv(meta);

  // ── 等待确认（支持重新规划 / 取消） ──
  let replans = 0;
  for (;;) {
    if (signal.aborted) {
      plan.status = 'canceled';
      emitMeta();
      await saveConv(meta);
      return { ok: true, meta };
    }
    const decision = await new Promise<PlanDecision>((resolve) => {
      pendingPlanConfirms.set(meta.id, resolve);
    });
    pendingPlanConfirms.delete(meta.id);

    if (decision.action === 'confirm') break;

    if (decision.action === 'cancel') {
      plan.status = 'canceled';
      const cancelMsg = pushStatus('已取消执行计划。你可以继续发消息调整需求，或新建对话。');
      endStatus(cancelMsg);
      emitMeta();
      await flushSaves(meta.id);
      await saveConv(meta);
      return { ok: true, meta };
    }

    // replan：达到上限后不再重新规划，直接按当前计划执行
    if (replans >= MAX_REPLANS) {
      const noteMsg = pushStatus(`⚠️ 已达到重新规划上限（${MAX_REPLANS} 次），将按当前计划执行。`);
      endStatus(noteMsg);
      break;
    }
    replans++;

    const reStatus = pushStatus(`正在根据你的意见重新规划（${replans}/${MAX_REPLANS}）…`);
    try {
      const newPlan = await generateExpertsPlan({
        meta,
        goal: text,
        resolved,
        signal,
        feedback: decision.feedback,
        interject: () => drainInterjections(meta.id),
      });
      plan = newPlan;
      meta.expertsPlan = plan;
      planMsg.content = formatPlanText(plan);
      send(planMsg.id, 'message_end', { message: planMsg });
      reStatus.content = `新计划已就绪：${plan.tasks.length} 个任务，确认后开始执行。`;
      endStatus(reStatus);
      emitMeta();
      await saveConv(meta);
    } catch (err: any) {
      reStatus.content = `❌ 重新规划失败（${err?.message ?? err}），仍使用原计划，请再次确认。`;
      endStatus(reStatus, String(err?.message ?? err));
      emitMeta();
    }
  }

  // ── Phase 2: 执行 ──
  plan.status = 'running';
  emitMeta();
  await saveConv(meta);

  const parallelism = estimateParallel(resolved);
  const execStatus = pushStatus(`开始执行：最多 ${parallelism} 个任务并行，遇到限流自动降速。`);
  endStatus(execStatus);

  await executeExpertsPlan({
    meta,
    plan,
    resolved,
    signal,
    cb,
    onProgress: () => {
      emitMeta();
      return queueSave(meta);
    },
  });

  if (signal.aborted) {
    plan.status = 'done';
    emitMeta();
    await flushSaves(meta.id);
    await saveConv(meta);
    return { ok: true, meta };
  }

  // 标记是否存在失败任务（供前端展示"重试失败任务"按钮）
  const countFailed = (tasks: typeof plan.tasks): number =>
    tasks.reduce((sum, t) => sum + (t.status === 'error' ? 1 : 0) + (t.subPlan ? countFailed(t.subPlan.tasks) : 0), 0);
  plan.hasFailedTasks = countFailed(plan.tasks) > 0;
  emitMeta();

  // ── Phase 3: 项目经理汇总 ──
  const sumStatus = pushStatus(`${expertLabel('lead')} 正在汇总各专家的执行结果…`);
  endStatus(sumStatus);
  const summaryMsg = await summarizeExpertsPlan({
    meta,
    plan,
    resolved,
    signal,
    cb: { ...cb, interject: () => drainInterjections(meta.id) },
  });

  plan.status = 'done';
  emitMeta();
  await flushSaves(meta.id);
  await saveConv(meta);

  // ── 渠道：出站转发 + AI 回复广播（与 sendMessage 一致） ──
  const outboundIds = meta.outboundChannelIds ?? meta.channelIds;
  if (outboundIds && outboundIds.length > 0 && summaryMsg.content.trim()) {
    void forwardToChannels(meta, summaryMsg.content, outboundIds).catch((e) => {
      console.error('[experts] forwardToChannels failed:', e);
    });
  }
  if (
    meta.broadcastAssistantChannelIds &&
    meta.broadcastAssistantChannelIds.length > 0 &&
    summaryMsg.content.trim()
  ) {
    void broadcastToChannels(meta, 'assistant', summaryMsg.content, meta.broadcastAssistantChannelIds).catch((e) => {
      console.error('[experts] broadcast assistant failed:', e);
    });
  }

  return { ok: true, meta };
}

/** 计划的纯文本版（消息 content 兜底 / 渠道转发用；UI 用 meta.expertsPlan 渲染卡片）。 */
function formatPlanText(plan: ExpertsPlan): string {
  const lines = plan.tasks.map((t, i) => {
    const dep = t.dependsOn && t.dependsOn.length > 0 ? `（依赖 ${t.dependsOn.join(', ')}）` : '';
    return `${i + 1}. 【${expertLabel(t.expert, t)}】${t.title}${dep}\n   ${t.description}`;
  });
  return `执行计划 · ${plan.goal}\n\n${lines.join('\n')}`;
}

/**
 * 当渠道消息触发权限请求时，向该渠道发送通知。
 * 告知用户需要批准某个操作，并展示工具名、参数详情。
 * 同时提示可用的批量批准命令。
 */
async function notifyChannelForPermission(
  meta: ConversationMeta,
  channel: { id: string; name: string; type: string },
  req: { requestId: string; msgId?: string; toolName: string; input: any; title?: string; displayName?: string; description?: string },
): Promise<void> {
  const { sendViaChannel } = await import('./channels/registry');
  const { listChannels } = await import('./store');
  const channels = await listChannels(meta.projectPath);
  const targetChannel = channels.find((c) => c.id === channel.id);
  if (!targetChannel) return;

  // 工具名显示优先级：title > displayName > description > toolName
  const toolName = req.title || req.displayName || req.description || req.toolName;

  // 构造 input 详情（关键：展示参数让用户能判断是否该批准）
  const detail = formatInputDetail(req.toolName, req.input);

  // 专家团模式：标注是哪个专家成员/任务在请求（同角色并行时不混淆归属）
  const expertLabelStr = req.msgId ? findExpertLabelByMsgId(meta, req.msgId) : undefined;
  const who = expertLabelStr ? `**${expertLabelStr}** 请求执行操作` : 'Claude 请求执行操作';

  const message = `⚠️ ${who}：${toolName}${detail}\n\n**批准命令：**
- \`批准\` - 单次批准
- \`批准 ${req.toolName}\` - 批准并记住此工具
- \`批准全部\` - 开启自动批准模式`;

  await sendViaChannel(targetChannel.type, targetChannel.config, {
    title: `操作授权：${toolName}`,
    content: message,
    projectName: meta.projectPath.split('/').pop() || '',
    timestamp: Date.now(),
  }, meta.projectPath);
}

/**
 * 格式化 input 对象为可读的详情文本。
 * 使用飞书/钉钉/企微等渠道都支持的通用 markdown 语法：
 * - **粗体** 标签
 * - `行内代码`（单行）
 * - 换行分隔
 * 注意：飞书卡片不支持 GFM 代码块（```），所以改用粗体 + 行内代码。
 */
function formatInputDetail(toolName: string, input: any): string {
  if (input == null) return '';
  const truncate = (s: string, max: number) =>
    s.length > max ? s.slice(0, max) + '…' : s;

  // 按工具类型做特殊格式化
  const tn = toolName.toLowerCase();
  if (tn === 'bash' && typeof input.command === 'string') {
    // 单行命令用行内代码
    return `\n**Command:** \`${truncate(input.command, 800)}\``;
  }
  if ((tn === 'write' || tn === 'edit' || tn === 'multiedit') && typeof input.file_path === 'string') {
    let detail = `\n**File:** \`${input.file_path}\``;
    if (typeof input.content === 'string') {
      detail += `\n**Content:**\n${truncate(input.content, 300)}`;
    } else if (typeof input.old_string === 'string') {
      detail += `\n**Old:**\n${truncate(input.old_string, 150)}`;
      if (typeof input.new_string === 'string') {
        detail += `\n**New:**\n${truncate(input.new_string, 150)}`;
      }
    }
    return detail;
  }
  if (tn === 'read' || tn === 'grep' || tn === 'glob') {
    const parts: string[] = [];
    if (typeof input.file_path === 'string') parts.push(`**File:** \`${input.file_path}\``);
    if (typeof input.pattern === 'string') parts.push(`**Pattern:** \`${input.pattern}\``);
    if (typeof input.query === 'string') parts.push(`**Query:** \`${input.query}\``);
    if (parts.length > 0) return '\n' + parts.join('\n');
  }

  // 默认：序列化为 JSON（去掉多余换行，用紧凑格式）
  if (typeof input === 'string') return `\n${truncate(input, 800)}`;
  try {
    const json = JSON.stringify(input);
    return `\n${truncate(json, 800)}`;
  } catch {
    return '';
  }
}


/**
 * 尝试批准挂起的权限请求。
 * 由渠道代理批准机制调用。
 */
export async function resolvePendingPermission(
  convId: string,
  decision: 'allow' | 'deny',
): Promise<boolean> {
  for (const [requestId, p] of pendingApprovals) {
    if (p.convId === convId) {
      p.resolve({ decision });
      pendingApprovals.delete(requestId);
      return true;
    }
  }
  return false;
}

/**
 * Drain the FIFO queue for the given conversation. Called after each
 * turn finishes. Processes one message at a time until the
 * queue is empty.
 *
 * Error semantics: when runOneTurn returns `{ ok: false }`, the queue
 * is **paused** instead of continuing. The frontend is notified via
 * `queue_stopped` so the user can retry it from the UI. This matches the
 * common expectation that a failing message should stop the chain —
 * otherwise every subsequent queued message would also fail (same root
 * cause, e.g. network outage / auth error / rate limit).
 *
 * Retry uses the failed request, never the last user bubble (which may be
 * an interjection received while that request was running).
 */
async function drainQueue(convId: string) {
  if (messageMutations.has(convId) || aborters.has(convId) || convDraining.has(convId) || failedQueueItems.has(convId)) return;
  const q = convQueue.get(convId);
  if (!q || q.length === 0) {
    convQueue.delete(convId);
    return;
  }
  // 设置 drain 锁：防止窗口期内新消息绕过队列直接执行
  convDraining.add(convId);
  let processing: QueuedSend | undefined;
  try {
    while (true) {
      if (messageMutations.has(convId)) return;
      const q = convQueue.get(convId);
      if (!q?.length) { convQueue.delete(convId); break; }
      const next = q.shift()!;
      processing = next;
      if (q.length === 0) convQueue.delete(convId);

      // Re-read meta (may have been updated by the previous turn)
      const meta = await getConvCached(convId);
      if (!meta) {
        next.resolve({ ok: false, error: 'chat not found' });
        // Conversation gone — stop draining, emit stopped so UI updates
        const entry = aborters.get(convId);
        const senderId = entry?.senderId ?? next.senderId;
        emitChat(windowsRef, senderId, {
          convId,
          msgId: '',
          type: 'queue_stopped',
          payload: { reason: 'chat not found', failedQueueId: next.queueId },
          ts: Date.now(),
        });
        return;
      }

      if (messageMutations.has(convId)) {
        convQueue.set(convId, [next, ...(convQueue.get(convId) ?? [])]);
        processing = undefined;
        return;
      }

      const result = await runOneTurn(convId, next.text, next.images, next.senderId, meta, next.queueId, undefined, next.mode, next.clientMessageId, next.broadcast === true);
      next.resolve(result);

      if (!result.ok) return;

      // 成功：继续处理下一条
    }
  } catch (error) {
    const queued = processing;
    console.error(`[queue] ${convId}:`, error);
    if (queued) {
      const failure = { queueId: queued.queueId, text: queued.text, images: queued.images, error: String(error), mode: queued.mode, broadcast: queued.broadcast };
      failedQueueItems.set(convId, failure);
      emitChat(windowsRef, queued.senderId, { convId, msgId: '', type: 'queue_stopped', ts: Date.now(),
        payload: { error: failure.error, failedQueueId: failure.queueId, failedText: failure.text, remaining: convQueue.get(convId)?.length ?? 0 } });
    }
  } finally {
    convDraining.delete(convId);
  }
}

/**
 * Abort all in-flight operations belonging to the given window.
 * Called on window close to clean up only that window's work.
 */
export function abortAllForWindow(senderId: number) {
  killVoiceForSender(senderId);
  emptyConversationLifecycle?.forgetWindow(senderId);
  for (const [k, entry] of aborters) {
    if (entry.senderId === senderId) {
      entry.controller.abort('窗口已关闭，对话已停止');
      // The owning operation releases its lock after cleanup, even on close.
    }
  }
  for (const [k, p] of pendingApprovals) {
    if (p.senderId === senderId) {
      p.resolve({ decision: 'deny', message: 'window closed' });
      pendingApprovals.delete(k);
    }
  }
  for (const [k, p] of pendingClarifies) {
    if (p.senderId === senderId) {
      p.resolve('(未回答，窗口已关闭)');
      pendingClarifies.delete(k);
    }
  }
}

/**
 * Send a stream event to a specific window by senderId (webContents.id).
 */
function emit(getWindows: GetWindows, senderId: number, evt: StreamEvent) {
  const w = getWindows().get(senderId);
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
  try {
    w.webContents.send(IpcChannels.StreamEvent, evt);
  } catch {
    /* window torn down between the guard and send — safe to drop */
  }
}

const chatEventSequences = new Map<string, number>();

function emitChat(getWindows: GetWindows, senderId: number, evt: ChatEvent) {
  observeReply(evt);
  evt.sequence = (chatEventSequences.get(evt.convId) ?? 0) + 1;
  chatEventSequences.set(evt.convId, evt.sequence);
  const w = getWindows().get(senderId);
  if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return;
  try {
    w.webContents.send(IpcChannels.ChatEvent, evt);
  } catch {
    /* drop */
  }
}

/** 渠道入站的对话事件广播给所有窗口；每个窗口仅应用自己正在查看的对话。 */
function emitChatToAll(getWindows: GetWindows, evt: ChatEvent) {
  observeReply(evt);
  evt.sequence = (chatEventSequences.get(evt.convId) ?? 0) + 1;
  chatEventSequences.set(evt.convId, evt.sequence);
  for (const w of getWindows().values()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try {
      w.webContents.send(IpcChannels.ChatEvent, evt);
    } catch {
      /* one window may close while broadcasting */
    }
  }
}

/**
 * 对话清单发生结构性变化（新增/删除/归档）→ 推给除发起方以外的所有窗口。
 * 为什么需要单独一条通道：ChatEvent 按 senderId 定向，只发给驱动那个动作的窗口。
 * 宠物窗新建的对话，主窗口左栏原本只能等到切一次项目才看得见（0.6.513 用户反馈）。
 */
function broadcastConvListChanged(exceptSenderId: number, payload: ConvListChangedPayload): void {
  try { emitMobileReminderChange(); } catch { /* Reminder delivery cannot undo a committed update. */ }
  for (const [id, w] of windowsRef()) {
    if (id === exceptSenderId || w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try {
      w.webContents.send(IpcChannels.ConvListChanged, payload);
    } catch {
      /* window torn down between the guard and send — safe to drop */
    }
  }
}

function makeStream(getWindows: GetWindows, senderId: number, specId: string, channel: StreamEvent['channel']) {
  return (type: StreamEventType, payload?: any) =>
    emit(getWindows, senderId, { specId, channel, type, payload, ts: Date.now() });
}

export function registerSpecHandlers(getWindows: GetWindows) {
  ipcMain.handle(LinkDownloadChannel, createLinkDownloadHandler({
    getWindows,
    language: async () => resolveLanguage((await readSettings()).language, app.getLocale()),
    chooseFile: async (window, options) => (await import('electron')).dialog.showSaveDialog(window, options),
  }));
  registerScreenshotEditor();
  // Start the scheduler with the same window registry
  windowsRef = getWindows;
  startScheduler(getWindows);

  // ── 剪贴板兜底通道：打包环境渲染层 navigator.clipboard 受限时保证复制可用 ──
  ipcMain.handle('clip:write-text', (_e, text: string) => {
    try { clipboard.writeText(text ?? ''); return true; } catch { return false; }
  });
  ipcMain.handle('browser-evidence:read', (_e, source: string) => readBrowserEvidence(path.join(app.getPath('userData'), 'browser-evidence'), source));
  ipcMain.handle('preview:read-image', (_e, source: string) => readPreviewImage(source));
  ipcMain.handle('clip:write-image', (_e, bytes: Uint8Array) => writeClipboardPng(bytes));
  ipcMain.handle('clip:write-rich', (_e, args: { html: string; plain: string }) => {
    try { clipboard.write({ html: args?.html ?? '', text: args?.plain ?? '' }); return true; } catch { return false; }
  });

  // ── Memory（长期记忆系统）───────────────────────────────────────────────────
  ipcMain.handle(
    IpcChannels.MemoryList,
    async (_e, projectPath: string, convId?: string) => listMemories(projectPath, undefined, convId),
  );
  ipcMain.handle(
    IpcChannels.MemoryConvCounts,
    async (_e, projectPath: string) => listConvMemoryCounts(projectPath),
  );
  ipcMain.handle(
    IpcChannels.MemoryAdd,
    async (_e, args: { projectPath: string; content: string; tags: string[]; scope?: MemoryScope; convId?: string }) =>
      addMemory(args.projectPath, args.content, args.tags, 'user', args.scope, args.convId),
  );
  ipcMain.handle(
    IpcChannels.MemoryDedupe,
    async (_e, args: { projectPath: string; convId?: string; selection?: {scope:MemoryScope;ids:string[];content:string;tags:string[]} }) => dedupeMemories(args.projectPath, args.convId, args.selection),
  );
  ipcMain.handle(
    IpcChannels.MemoryUpdate,
    async (_e, args: { projectPath: string; id: string; content?: string; tags?: string[]; convId?: string }) =>
      updateMemory(args.projectPath, args.id, { content: args.content, tags: args.tags }, args.convId),
  );
  ipcMain.handle(
    IpcChannels.MemoryDelete,
    async (_e, args: { projectPath: string; id: string; convId?: string }) =>
      deleteMemory(args.projectPath, args.id, args.convId),
  );

  ipcMain.handle(
    IpcChannels.SpecCreate,
    async (_e, args: { projectPath: string; title: string; description: string }) => {
      const id = randomBytes(6).toString('base64url'); // 8-char URL-safe id

      const meta = newSpecMeta({ ...args, id });
      await saveSpecMeta(meta);
      // Track total specs created (persistent across deletions)
      await incrProjectStatsCounter(args.projectPath, 'specs');
      return meta;
    },
  );

  ipcMain.handle(IpcChannels.SpecList, async (_e, projectPath: string) => listSpecsForProject(projectPath));

  ipcMain.handle(IpcChannels.SpecGet, async (_e, specId: string): Promise<{ meta: SpecMeta | null; docs: any }> => {
    const meta = await findSpecById(specId);
    if (!meta) return { meta: null, docs: {} };
    const [requirements, design, tasks] = await Promise.all([
      readDoc(meta.projectPath, meta.id, 'requirements'),
      readDoc(meta.projectPath, meta.id, 'design'),
      readDoc(meta.projectPath, meta.id, 'tasks'),
    ]);
    return { meta, docs: { requirements, design, tasks } };
  });

  ipcMain.handle(
    IpcChannels.SpecGenerate,
    async (
      event,
      args: { specId: string; phase: 'requirements' | 'design' | 'tasks'; feedback?: string; lang?: string },
    ) => {
      const meta = await findSpecById(args.specId);
      if (!meta) return { ok: false, error: 'spec not found' };

      const senderId = event.sender.id;
      if (isUpdateInstalling()) throw new Error('Update installation is in progress. Please retry after restart.');
      const aborter = new AbortController();
      aborters.set(args.specId, { controller: aborter, senderId });
      const stream = makeStream(getWindows, senderId, args.specId, args.phase);

      try {
        const result = await generatePhase(args.phase, {
          meta,
          feedback: args.feedback,
          lang: args.lang,
          signal: aborter.signal,
          onText: (chunk) => stream('text', { chunk }),
          onLog: (line) => stream('log', { msg: line }),
        });
        if (result.ok) {
          stream('phase_done', { phase: args.phase, content: result.content });
        } else {
          stream('error', { error: result.error });
        }
        return result;
      } finally {
        aborters.delete(args.specId);
      }
    },
  );

  ipcMain.handle(
    IpcChannels.SpecChatList,
    async (_e, args: { specId: string; phase: 'requirements' | 'design' | 'tasks' }) => {
      const meta = await findSpecById(args.specId);
      if (!meta) return [];
      return readPhaseChat(meta.projectPath, meta.id, args.phase);
    },
  );

  ipcMain.handle(
    IpcChannels.SpecChatRefine,
    async (
      event,
      args: { specId: string; phase: 'requirements' | 'design' | 'tasks'; message: string; lang?: string },
    ) => {
      const meta = await findSpecById(args.specId);
      if (!meta) return { ok: false, error: 'spec not found' };

      const senderId = event.sender.id;
      if (isUpdateInstalling()) throw new Error('Update installation is in progress. Please retry after restart.');
      const aborter = new AbortController();
      const key = `chat:${args.specId}`;
      aborters.set(key, { controller: aborter, senderId });
      const stream = makeStream(getWindows, senderId, args.specId, args.phase);

      try {
        const result = await refinePhaseChat({
          meta,
          phase: args.phase,
          message: args.message,
          lang: args.lang,
          signal: aborter.signal,
          onText: (chunk) => stream('text', { chunk }),
          onLog: (line) => stream('log', { msg: line }),
        });
        if (result.ok) {
          stream('phase_done', { phase: args.phase, content: result.content });
        } else {
          stream('error', { error: result.error });
        }
        return result;
      } finally {
        aborters.delete(key);
      }
    },
  );

  ipcMain.handle(
    IpcChannels.SpecApprove,
    async (_e, args: { specId: string; phase: 'requirements' | 'design' | 'tasks' }) => {
      const meta = await findSpecById(args.specId);
      if (!meta) return { ok: false };
      meta.phases[args.phase].status = 'approved';
      meta.phases[args.phase].approvedAt = new Date().toISOString();
      // advance phase pointer
      const order: ('requirements' | 'design' | 'tasks')[] = ['requirements', 'design', 'tasks'];
      const idx = order.indexOf(args.phase);
      if (idx >= 0 && idx < order.length - 1) {
        meta.currentPhase = order[idx + 1];
      } else if (args.phase === 'tasks') {
        meta.currentPhase = 'execute';
        // re-parse tasks in case the user edited the doc by hand
        await refreshTasksFromDoc(meta);
      }
      meta.updatedAt = new Date().toISOString();
      await saveSpecMeta(meta);
      return { ok: true, meta };
    },
  );

  ipcMain.handle(IpcChannels.SpecExecute, async (event, args: { specId: string; lang?: string }) => {
    const specId = typeof args === 'string' ? args : args.specId;
    const lang = typeof args === 'string' ? undefined : args.lang;
    const meta = await findSpecById(specId);
    if (!meta) return { ok: false, error: 'spec not found' };

    const senderId = event.sender.id;
    if (isUpdateInstalling()) throw new Error('Update installation is in progress. Please retry after restart.');
    const aborter = new AbortController();
    aborters.set(specId, { controller: aborter, senderId });
    const stream = makeStream(getWindows, senderId, specId, 'execute');

    try {
      const r = await executeSpec({
        meta,
        lang,
        signal: aborter.signal,
        onTaskStart: (t) => stream('task_start', { taskId: t.id, title: t.title }),
        onTaskText: (t, chunk) => stream('text', { taskId: t.id, chunk }),
        onTaskDone: (t) => stream('task_done', { taskId: t.id }),
        onTaskFailed: (t, err) => stream('task_failed', { taskId: t.id, error: err }),
        onLog: (line) => stream('log', { msg: line }),
      });
      if (r.ok) stream('phase_done', { phase: 'execute' });
      return r;
    } finally {
      aborters.delete(specId);
    }
  });

  ipcMain.handle(
    IpcChannels.SpecRetryTask,
    async (event, args: { specId: string; taskId: string; lang?: string }) => {
      const meta = await findSpecById(args.specId);
      if (!meta) return { ok: false, error: 'spec not found' };

      const senderId = event.sender.id;
      const aborterKey = `${args.specId}:retry:${args.taskId}`;
      if (isUpdateInstalling()) throw new Error('Update installation is in progress. Please retry after restart.');
      const aborter = new AbortController();
      aborters.set(aborterKey, { controller: aborter, senderId });
      const stream = makeStream(getWindows, senderId, args.specId, 'execute');

      try {
        const r = await retryTask({
          meta,
          taskId: args.taskId,
          lang: args.lang,
          signal: aborter.signal,
          onTaskStart: (t) => stream('task_start', { taskId: t.id, title: t.title }),
          onTaskText: (t, chunk) => stream('text', { taskId: t.id, chunk }),
          onTaskDone: (t) => stream('task_done', { taskId: t.id }),
          onTaskFailed: (t, err) => stream('task_failed', { taskId: t.id, error: err }),
          onLog: (line) => stream('log', { msg: line }),
        });
        return r;
      } finally {
        aborters.delete(aborterKey);
      }
    },
  );

  ipcMain.handle(IpcChannels.SpecAbort, async (_e, arg: string | { key: string }) => {
    const key = typeof arg === 'string' ? arg : arg.key;
    const entry = aborters.get(key);
    if (entry) {
      entry.controller.abort();
      aborters.delete(key);
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle(
    IpcChannels.SpecUpdateDoc,
    async (
      _e,
      args: { specId: string; phase: 'requirements' | 'design' | 'tasks'; content: string },
    ) => {
      const meta = await findSpecById(args.specId);
      if (!meta) return { ok: false };
      await writeDoc(meta.projectPath, meta.id, args.phase, args.content);
      if (args.phase === 'tasks') await refreshTasksFromDoc(meta);
      // 手动编辑本阶段文档后：清除自身 stale，并把下游已生成阶段标记为过时。
      meta.phases[args.phase].stale = false;
      markDownstreamStale(meta, args.phase);
      meta.updatedAt = new Date().toISOString();
      await saveSpecMeta(meta);
      return { ok: true };
    },
  );

  ipcMain.handle(IpcChannels.SpecDelete, async (_e, specId: string) => {
    const meta = await findSpecById(specId);
    if (!meta) return { ok: false };
    await deleteSpec(meta);
    return { ok: true };
  });

  // ---------- Retro Analysis (逆向分析) ----------

  ipcMain.handle(
    IpcChannels.SpecRetroAnalyze,
    async (
      event,
      args: { projectPath: string; scopePath?: string; title?: string; lang?: string },
    ) => {
      const senderId = event.sender.id;
      const abortKey = `retro:${args.projectPath}`;

      // Guard: prevent concurrent retro analysis on same project
      if (aborters.has(abortKey)) {
        return { ok: false, error: 'already running' };
      }

      if (isUpdateInstalling()) throw new Error('Update installation is in progress. Please retry after restart.');
      const aborter = new AbortController();
      aborters.set(abortKey, { controller: aborter, senderId });

      // Use abortKey as temporary specId for streaming (before real specId is known)
      const streamSpecId = abortKey;

      // Helper to build a stream for a given specId and channel
      const streamFor = (specId: string, channel: StreamEvent['channel']) =>
        makeStream(getWindows, senderId, specId, channel);

      // Default stream uses abortKey as specId (before real specId is known)
      const stream = (phase: string) =>
        streamFor(streamSpecId, phase as StreamEvent['channel']);

      try {
        const result = await generateRetroSpec({
          projectPath: args.projectPath,
          scopePath: args.scopePath,
          title: args.title,
          lang: args.lang,
          signal: aborter.signal,
          onText: (phase, chunk, specId) => {
            const sid = specId ?? streamSpecId;
            streamFor(sid, `retro-${phase}` as StreamEvent['channel'])('text', { chunk });
          },
          onLog: (line) => stream('retro-requirements')('log', { msg: line }),
          onPhaseStart: (phase, specId, title) => {
            const sid = specId ?? streamSpecId;
            streamFor(sid, `retro-${phase}` as StreamEvent['channel'])('phase_done', { phase, start: true, title });
          },
          onPhaseDone: (phase, specId) => {
            const sid = specId ?? streamSpecId;
            streamFor(sid, `retro-${phase}` as StreamEvent['channel'])('phase_done', { phase });
          },
          onSpecCreated: (specId) => {
            // Tell renderer this spec is now visible — it can refresh its specs list
            streamFor(specId, 'retro-requirements' as StreamEvent['channel'])('phase_done', {
              phase: 'spec_created',
              specId,
            });
          },
          onComplete: (specIds) => {
            // Final event: all modules done
            stream('retro-requirements')('phase_done', { phase: 'complete', specIds });
          },
        });

        // Only surface non-abort errors to the frontend
        if (!result.ok && result.error !== 'aborted') {
          stream('retro-requirements')('error', { error: result.error });
        }
        return result;
      } finally {
        aborters.delete(abortKey);
      }
    },
  );

  // ---------- Optimization Report (优化审查) ----------

  ipcMain.handle(
    IpcChannels.SpecOptimizeAnalyze,
    async (
      event,
      args: { projectPath: string; title?: string; lang?: string },
    ) => {
      const senderId = event.sender.id;
      const abortKey = `optimize:${args.projectPath}`;

      if (aborters.has(abortKey)) {
        return { ok: false, error: 'already running' };
      }

      if (isUpdateInstalling()) throw new Error('Update installation is in progress. Please retry after restart.');
      const aborter = new AbortController();
      aborters.set(abortKey, { controller: aborter, senderId });

      const streamSpecId = abortKey;
      const stream = makeStream(getWindows, senderId, streamSpecId, 'optimize');

      try {
        const existingSpecs = await listSpecsForProject(args.projectPath);
        const result = await generateOptimizationReport({
          projectPath: args.projectPath,
          existingSpecs,
          title: args.title,
          lang: args.lang,
          signal: aborter.signal,
          onText: (chunk) => stream('text', { chunk }),
          onLog: (line) => stream('log', { msg: line }),
        });

        if (result.ok) {
          stream('phase_done', { specId: result.specId });
        } else {
          stream('error', { error: result.error });
        }
        return result;
      } finally {
        aborters.delete(abortKey);
      }
    },
  );

  // ---------- Project Wiki (AI-generated documentation) ----------

  ipcMain.handle(
    IpcChannels.WikiGenerate,
    async (
      event,
      args: { projectPath: string; lang?: string; depth?: import('../shared/types').WikiDepth },
    ) => {
      const senderId = event.sender.id;
      const abortKey = `wiki:${args.projectPath}`;

      if (aborters.has(abortKey)) {
        return { ok: false, error: 'already running' };
      }

      if (isUpdateInstalling()) throw new Error('Update installation is in progress. Please retry after restart.');
      const aborter = new AbortController();
      aborters.set(abortKey, { controller: aborter, senderId });

      const streamSpecId = abortKey;
      const stream = makeStream(getWindows, senderId, streamSpecId, 'wiki');

      try {
        const result = await generateProjectWiki({
          projectPath: args.projectPath,
          lang: args.lang,
          depth: args.depth,
          signal: aborter.signal,
          onText: (chunk) => stream('text', { chunk }),
          onLog: (line) => stream('log', { msg: line }),
        });

        if (!result.ok) {
          stream('error', { error: result.error });
        }
        return result;
      } catch (err: any) {
        // Catch unexpected exceptions so wikiGenerating doesn't get stuck
        const msg = err?.message ?? String(err);
        console.error('[WikiGenerate] unexpected error:', msg);
        stream('error', { error: msg });
        return { ok: false, error: msg };
      } finally {
        aborters.delete(abortKey);
      }
    },
  );

  ipcMain.handle(IpcChannels.WikiLoad, async (_e, projectPath: string) => {
    const content = await readWiki(projectPath);
    return { ok: true, content };
  });

  ipcMain.handle(IpcChannels.WikiDelete, async (_e, projectPath: string) => {
    await deleteWiki(projectPath);
    return { ok: true };
  });

  // ---------- Loop Engineering (自主迭代循环) ----------

  /** Checkpoint waiters: specId → { resolve, reject } */
  const checkpointWaiters = new Map<string, { resolve: (feedback?: string) => void; reject: (err: Error) => void }>();

  ipcMain.handle(
    IpcChannels.LoopStart,
    async (
      event,
      args: { specId: string; config: import('../shared/types').LoopConfig; lang?: string },
    ) => {
      const senderId = event.sender.id;
      const abortKey = `loop:${args.specId}`;

      if (aborters.has(abortKey)) {
        return { ok: false, error: 'loop already running' };
      }

      const meta = await findSpecById(args.specId);
      if (!meta) return { ok: false, error: 'spec not found' };

      if (isUpdateInstalling()) throw new Error('Update installation is in progress. Please retry after restart.');
      const aborter = new AbortController();
      aborters.set(abortKey, { controller: aborter, senderId });

      const streamSpecId = args.specId;
      const stream = makeStream(getWindows, senderId, streamSpecId, 'loop');

      // Import dynamically to avoid circular dependency
      const { runLoop } = await import('./loop-engine');

      // Initialize loop state
      meta.loop = {
        config: args.config,
        state: {
          running: true,
          status: 'generating',
          iterations: [],
          currentIteration: 0,
          metricHistory: [],
          startedAt: Date.now(),
        },
      };
      meta.updatedAt = new Date().toISOString();
      await saveSpecMeta(meta);

      try {
        const result = await runLoop({
          meta,
          config: args.config,
          signal: aborter.signal,
          lang: args.lang,
          onIterationStart: (n) => {
            stream('loop_iteration_start', { iteration: n });
          },
          onIterationText: (n, chunk) => {
            stream('text', { iteration: n, chunk });
          },
          onIterationEval: (n, evalResult) => {
            stream('loop_iteration_eval', {
              iteration: n,
              passed: evalResult.passed,
              metric: evalResult.metricValue,
              summary: evalResult.summary,
            });
          },
          onIterationDone: (n, status) => {
            stream('loop_iteration_done', { iteration: n, status });
          },
          onPlan: (n, plan) => {
            stream('loop_plan', { iteration: n, plan });
          },
          onCheckpoint: (n, metricHistory) => {
            stream('loop_checkpoint', { iteration: n, metricHistory });
          },
          onConverged: (output, total, metric) => {
            stream('loop_converged', { output, totalIterations: total, finalMetric: metric });
          },
          onLog: (line) => stream('log', { msg: line }),
          onError: (error) => stream('error', { error }),
          waitForCheckpoint: args.config.humanCheckpoint
            ? () =>
                new Promise<string | undefined>((resolve, reject) => {
                  checkpointWaiters.set(args.specId, { resolve, reject });
                })
            : undefined,
        });

        // Update meta with final state
        meta.loop!.state.running = false;
        meta.loop!.state.status = result.ok ? 'converged' : 'failed';
        if (result.ok) {
          meta.loop!.state.convergedOutput = result.convergedOutput;
          meta.loop!.state.latestMetric = result.finalMetric;
        }
        meta.loop!.state.currentIteration = result.iterations;
        meta.updatedAt = new Date().toISOString();
        await saveSpecMeta(meta);

        return result;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.error('[LoopStart] unexpected error:', msg);
        stream('error', { error: msg });
        meta.loop!.state.running = false;
        meta.loop!.state.status = 'failed';
        meta.loop!.state.error = msg;
        meta.updatedAt = new Date().toISOString();
        await saveSpecMeta(meta);
        return { ok: false, error: msg, iterations: 0 };
      } finally {
        aborters.delete(abortKey);
        checkpointWaiters.delete(args.specId);
      }
    },
  );

  ipcMain.handle(
    IpcChannels.LoopStop,
    async (_e, args: { specId: string }) => {
      const entry = aborters.get(`loop:${args.specId}`);
      if (entry) {
        entry.controller.abort();
        aborters.delete(`loop:${args.specId}`);
        // If there's a checkpoint waiter, reject it
        const waiter = checkpointWaiters.get(args.specId);
        if (waiter) {
          waiter.resolve('__abort__');
          checkpointWaiters.delete(args.specId);
        }
        const meta = await findSpecById(args.specId);
        if (meta?.loop) {
          meta.loop.state.running = false;
          meta.loop.state.status = 'aborted';
          await saveSpecMeta(meta);
        }
        return { ok: true };
      }
      return { ok: false };
    },
  );

  ipcMain.handle(
    IpcChannels.LoopResume,
    async (_e, args: { specId: string; feedback?: string }) => {
      const waiter = checkpointWaiters.get(args.specId);
      if (waiter) {
        waiter.resolve(args.feedback);
        checkpointWaiters.delete(args.specId);
        return { ok: true };
      }
      return { ok: false, error: 'no checkpoint waiting' };
    },
  );

  ipcMain.handle(IpcChannels.LoopGetState, async (_e, specId: string) => {
    const meta = await findSpecById(specId);
    return { ok: true, loop: meta?.loop };
  });

  ipcMain.handle(IpcChannels.LoopExportSkill, async (_e, specId: string) => {
    const meta = await findSpecById(specId);
    if (!meta) return { ok: false, error: 'spec not found' };
    const { exportLoopAsSkill } = await import('./loop-engine');
    return exportLoopAsSkill(meta);
  });

  // ---------- Global Skills（客户端级共享 skill） ----------

  ipcMain.handle(IpcChannels.GlobalSkillList, async () => {
    const { listGlobalSkills } = await import('./skills');
    return listGlobalSkills();
  });

  ipcMain.handle(IpcChannels.GlobalSkillDir, async () => {
    const { globalSkillsDir } = await import('./skills');
    return globalSkillsDir();
  });

  ipcMain.handle(IpcChannels.GlobalSkillOpenDir, async () => {
    const { openGlobalSkillsDir } = await import('./skills');
    return openGlobalSkillsDir();
  });

  ipcMain.handle(IpcChannels.ProjectSkillOpenDir, async (_e, projectPath: string) => {
    const { openProjectSkillsDir } = await import('./skills');
    return openProjectSkillsDir(projectPath);
  });

  // ---------- Steering documents (SDD project-level context) ----------

  ipcMain.handle(IpcChannels.SteeringGet, async (_e, projectPath: string) => {
    return readSteering(projectPath);
  });

  ipcMain.handle(
    IpcChannels.SteeringSet,
    async (
      _e,
      args: { projectPath: string; kind: SteeringKind; content: string },
    ) => {
      await writeSteering(args.projectPath, args.kind, args.content);
      return { ok: true };
    },
  );

  // ---------- Conversations ----------
  ipcMain.on(IpcChannels.ConvTabsSync, (event, ids: unknown) => {
    if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !/^[\w-]{1,200}$/.test(id))) return;
    void emptyConversations().then(lifecycle => lifecycle.syncTabs(event.sender.id, ids)).catch(error => console.warn('[empty-chat] Cannot sync tab leases', error));
  });
  ipcMain.handle(IpcChannels.ConvCloseTab, async (event, args: unknown) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, deleted: false };
    const input = args as Record<string, unknown>;
    if (Object.keys(input).some(key => !['id', 'projectPath', 'keep'].includes(key)) || typeof input.id !== 'string'
      || !/^[\w-]{1,200}$/.test(input.id) || typeof input.projectPath !== 'string' || typeof input.keep !== 'boolean') return { ok: false, deleted: false };
    return (await emptyConversations()).close(event.sender.id, input as { id: string; projectPath: string; keep: boolean });
  });


  ipcMain.handle(
    IpcChannels.ConvCreate,
    async (_e, args: { projectPath: string; title?: string; permissionMode?: any }) => {
      const meta = newConversation(args);
      await initializeConversationPolicy(meta);
      await saveConv(meta);
      convCache.set(meta.id, meta);
      if (args.title === undefined) (await emptyConversations()).remember(meta, _e.sender.id);
      // Track total conversations created (persistent across deletions)
      await incrProjectStatsCounter(args.projectPath, 'conversations');
      broadcastConvListChanged(_e.sender.id, { projectPath: args.projectPath, convId: meta.id, reason: 'created' });
      return meta;
    },
  );

  ipcMain.handle(IpcChannels.ConvList, async (_e, projectPath: string) => listConvsForProject(projectPath));

  // 上下文整理记录查看器：跨项目/跨对话汇总全部审计（附对话标题供筛选与展示）
  ipcMain.handle(
    IpcChannels.ContextAuditList,
    async (): Promise<Array<{ convId: string; convTitle: string; projectPath: string; audits: ContextCompactionAudit[] }>> => {
      const projects = await listProjects();
      const out: Array<{ convId: string; convTitle: string; projectPath: string; audits: ContextCompactionAudit[] }> = [];
      for (const p of projects) {
        let convs: ConversationMeta[] = [];
        try { convs = await listConvsForProject(p.path); } catch { continue; }
        for (const c of convs) {
          if (c.contextCompactionAudits?.length) {
            out.push({ convId: c.id, convTitle: c.title, projectPath: p.path, audits: c.contextCompactionAudits });
          }
        }
      }
      return out;
    },
  );

  ipcMain.handle(
    IpcChannels.ConvSetArchived,
    async (_e, args: { projectPath: string; id: string; archived: boolean }) => {
      emptyConversationLifecycle?.retain(args.id);
      try {
        // 归档 = 封存。还在跑（或有排队）的对话先挡住，否则归档后会出现
        // “只读提示条 + 仍在流式输出”的脏状态，重试/插话入口也无从统一隐藏。
        if (args.archived && convIsExecuting(args.id)) {
          const en = await mainTextEn();
          return {
            ok: false,
            error: en
              ? 'This chat is still running (or has queued messages). Stop it before archiving.'
              : '该对话还在执行（或有消息排队），请先停止后再归档',
          };
        }
        // Fail closed: if pausing cannot persist, do not archive with live schedules.
        if(args.archived)await pauseScheduledForConversation(args.projectPath,args.id);
        const found = await setConvArchived(args.projectPath, args.id, args.archived);
        // 归档/解档改变左栏可见性：不推的话，另一个窗口要么看得见已封存的对话，
        // 要么相反——在那里点了却像“没生效”。
        if (found) {
          broadcastConvListChanged(_e.sender.id, {
            projectPath: args.projectPath, convId: args.id, reason: 'archived', archived: args.archived,
          });
        }
        return { ok: true, found };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.ConvSearch,
    async (_e, args: { projectPath: string; query: string }) => {
      try {
        return { ok: true, hits: await searchConvs(args.projectPath, args.query) };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  // --- Request Monitor ---
  ipcMain.handle(IpcChannels.MonitorList, () => listRecords());
  ipcMain.handle(IpcChannels.MonitorClear, (_e, projectPath?: string) => {
    clearRecords(projectPath);
    return { ok: true };
  });
  ipcMain.handle(IpcChannels.MonitorLoadProject, (_e, projectPath: string) =>
    loadProjectRecords(projectPath),
  );
  // 全项目检索（无当前项目时的默认视图）：内存缓冲 + 各已登记项目落盘记录按 id 去重合并，最新在前。
  ipcMain.handle(IpcChannels.MonitorLoadAll, async () => {
    const merged = createMonitorBuffer();
    for (const r of listRecords()) merged.set(r.id, r);
    for (const p of await listProjects()) {
      try {
        for (const r of await loadProjectRecords(p.path)) if (!merged.has(r.id)) merged.set(r.id, r);
      } catch { /* 单个项目记录不可读跳过 */ }
    }
    return [...merged.values()].sort((a, b) => b.ts - a.ts).slice(0, 1000);
  });

  ipcMain.handle(IpcChannels.ConvGet, async (_e, input: string | { id: string; openingTab: true }) => {
    const id = typeof input === 'string' ? input : input?.id;
    if (typeof id !== 'string' || !/^[\w-]{1,200}$/.test(id) || typeof input !== 'string'
      && (!input || input.openingTab !== true || Object.keys(input).some(key => !['id', 'openingTab'].includes(key)))) return null;
    if (mobileDeletes.has(id)) return null;
    // Metadata fetches used by cross-window lists do not open a tab. Reserve only explicit selection, including its async load.
    if (typeof input !== 'string') (await emptyConversations()).view(id, _e.sender.id);
    const meta = await getConvCached(id);
    if (!meta) return null;
    return {
      ...meta,
      ...await getConversationReadState(meta),
      messages: [...meta.messages, ...queuedMessages(id)],
      runtime: {
        eventSequence: chatEventSequences.get(id) ?? 0,
        running: aborters.has(id) || convDraining.has(id),
        queueStopped: failedQueueItems.get(id),
      },
    };
  });

  // 麦克风 TCC 授权：Electron 渲染层 getUserMedia 不触发系统弹框（只拿到静音流），
  // 必须由主进程 askForMediaAccess 发起，Sage 才会进隐私列表并拿到真实音频。
  ipcMain.handle('voice:ensure-mic', async () => {
    try {
      let st = systemPreferences.getMediaAccessStatus('microphone');
      diagVoice(`ensure-mic: TCC status=${st}`);
      if (st === 'not-determined') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        st = systemPreferences.getMediaAccessStatus('microphone');
        diagVoice(`ensure-mic: askForMediaAccess -> ${granted}, status=${st}`);
        return { ok: granted, status: st };
      }
      return { ok: st === 'granted', status: st };
    } catch (err) {
      diagVoice(`ensure-mic threw: ${(err as Error)?.stack ?? err}`);
      return { ok: false, status: String((err as Error)?.message ?? err) };
    }
  });

  // TCC 秒拒自救：voice.log 实证 not-determined → askForMediaAccess 281ms 内 denied（系统框未出现），
  // 多为失效/受限的 TCC 记录所致；用 tccutil 清除本 bundle 的麦克风/语音识别记录后，
  // 再由 ensure-mic 重新发起 askForMediaAccess 触发系统弹框。全过程落盘 voice.log。
  ipcMain.handle('voice:reset-mic-tcc', () => {
    // 清的是「当前运行实例」的记录：打包态就是 sage.app，开发态是 Electron 宿主
    const bundleId = getRunningBundleId();
    if (!bundleId) return { ok: false, status: 'unknown', detail: '无法确认当前应用身份，未重置权限。' };
    const lines: string[] = [];
    let ok = true;
    for (const svc of ['Microphone', 'SpeechRecognition']) {
      try {
        const out = execFileSync('/usr/bin/tccutil', ['reset', svc, bundleId], { encoding: 'utf8', timeout: 5000 });
        lines.push(`${svc}: ${String(out).trim()}`);
      } catch (err) {
        ok = false;
        lines.push(`${svc}: error ${String((err as Error)?.message ?? err).split('\n')[0]}`);
      }
    }
    diagVoice(`reset-mic-tcc(${bundleId}): ${lines.join(' | ')}`);
    const st = systemPreferences.getMediaAccessStatus('microphone');
    diagVoice(`reset-mic-tcc: post status=${st}`);
    return { ok, status: st, detail: lines.join(' | ') };
  });

  // 语音输入（macOS 系统 Speech 听写助手进程）：start 返回 {ok,error?}，事件经 VoiceEvent 推送
  ipcMain.handle('chat:capabilities', async (_event, project: string, refresh: boolean) => {
    const { chatCapabilities } = await import('./chat-capabilities');
    return chatCapabilities(project, refresh === true);
  });
  ipcMain.handle(IpcChannels.ScreenshotCapture, async () => {
    const settings = await readSettings();
    return openScreenshotEditor(resolveLanguage(settings.language));
  });
  ipcMain.handle(IpcChannels.VoiceStart, (e, locale: string) => {
    // 同步抛错也要变成结构化返回：渲染层 await 拒绝会被静默吞掉，界面将毫无反应
    try {
      const r = startVoice(locale, e.sender);
      console.log('[voice] VoiceStart', JSON.stringify({ locale, ...r }));
      diagVoice(`VoiceStart result: ${JSON.stringify({ locale, ...r })}`);
      return r;
    } catch (err) {
      console.error('[voice] VoiceStart threw:', err);
      diagVoice(`VoiceStart threw: ${(err as Error)?.stack ?? err}`);
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  });
  // 渲染层语音诊断汇入（getUserMedia 成败等），统一落盘 voice.log
  ipcMain.on(IpcChannels.VoiceDiag, (_e, msg: string) => diagVoice(`renderer: ${msg}`));
  ipcMain.handle(IpcChannels.VoiceStop, e => stopVoice(e.sender.id));
  // 渲染进程采音的高频 PCM 流（fire-and-forget），转发给助手 stdin
  ipcMain.on(IpcChannels.VoiceAudio, (e, b64: string) => feedVoiceAudio(b64, e.sender.id));
  // 一键跳转系统设置对应隐私面板；辅助功能复用快捷键模块的受信任授权入口。
  ipcMain.handle(IpcChannels.OpenSystemPrivacy, async (_e, pane: 'camera' | 'microphone' | 'speech' | 'notifications' | 'screen') => {
    const { shell } = await import('electron');
    const anchors = { camera: 'Privacy_Camera', microphone: 'Privacy_Microphone', speech: 'Privacy_SpeechRecognition', notifications: 'Privacy_Notifications', screen: 'Privacy_ScreenCapture' };
    if (!Object.prototype.hasOwnProperty.call(anchors, pane)) return { ok: false };
    const anchor = anchors[pane];
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
    return { ok: true };
  });
  // 系统权限（TCC）总览：辅助功能、屏幕录制、摄像头、麦克风、语音识别和通知。
  // 麦克风：systemPreferences.getMediaAccessStatus（主进程就是 app 本体，身份天然正确）。
  // 语音识别/通知：Electron 31 都没有查询接口（Notification.isGranted 是 v32+ 才有），
  // 靠 Contents/MacOS/ 下的助手副本在带 bundle 身份的进程内直读（见 tools/sage-voice/main.swift）；
  // 拿不到身份（开发态）时返回 unknown，界面如实显示"无法检测"，不伪装成"未请求"。
  // 同时返回 identity：ad-hoc 构建下 DR 绑 cdhash 会让授权每次更新后失效，得让面板能说出来。
  ipcMain.handle(IpcChannels.PrivacyStatus, async () => {
    const { systemPreferences, Notification } = await import('electron');
    const mapStatus = (raw?: string) => raw === 'authorized' ? 'granted'
      : raw === 'denied' ? 'denied' : raw === 'restricted' ? 'restricted'
      : raw === 'not-determined' ? 'not-determined' : raw === 'provisional' ? 'provisional' : 'unknown';
    const probe = (args: string[]) => {
      try { return execFileSync(helperPath(), args, { encoding: 'utf8', timeout: 4000 }).trim(); } catch { return ''; }
    };
    const speechStatus = (out: string) => mapStatus((/"status":"([a-z-]+)"/.exec(out) ?? [])[1]);
    let speech = speechStatus(probe(['status']));
    let notifications = speechStatus(probe(['notify-status']));
    if (notifications === 'unknown') {
      // 助手不可用时退回 Electron 接口（v32+ 的 Notification.isGranted），再不行才是无法检测
      try {
        const isGranted = (Notification as any).isGranted;
        notifications = typeof isGranted === 'function' ? (isGranted.call(Notification) ? 'granted' : 'denied') : 'unknown';
      } catch { notifications = 'unknown'; }
    }
    if (speech === 'unknown') {
      try {
        const db = path.join(app.getPath('home'), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');
        const client = getRunningBundleId().replace(/'/g, "''");
        if (!client) throw Error('Unknown running app identity');
        const out = execFileSync('/usr/bin/sqlite3', [db, `SELECT auth_value FROM access WHERE service='kTCCServiceSpeechRecognition' AND client='${client}';`], { encoding: 'utf8', timeout: 3000 }).trim();
        speech = out === '2' ? 'granted' : out === '0' ? 'denied' : out === '3' ? 'restricted' : out === '' ? 'not-determined' : 'unknown';
      } catch { /* 无完全磁盘访问时查不到，保持 unknown，仅影响胶囊文案不影响去授权按钮 */ }
    }
    return {
      accessibility: process.platform === 'darwin' ? (systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied') : 'unknown',
      screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'unknown',
      camera: systemPreferences.getMediaAccessStatus('camera'),
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
      speech,
      notifications,
      identity: getSignatureIdentity(),
    };
  });
  ipcMain.handle(IpcChannels.PrivacyCameraGrant, async () => {
    try {
      const { systemPreferences } = await import('electron');
      if (process.platform !== 'darwin') return { ok: false, status: 'unknown' };
      const granted = await systemPreferences.askForMediaAccess('camera');
      return { ok: granted, status: systemPreferences.getMediaAccessStatus('camera') };
    } catch (error) {
      return { ok: false, status: 'unknown', error: String(error) };
    }
  });
  // 发送一条真实系统通知验证授权链路（未授权时 macOS 首次会弹授权框）
  ipcMain.handle(IpcChannels.NotifyTest, async () => {
    const { Notification } = await import('electron');
    if (!Notification.isSupported()) return { ok: false, error: '当前系统不支持通知' };
    new Notification({ title: 'Sage 系统通知', body: '授权链路正常，后台任务完成将在这里提醒你。' }).show();
    // 发完重新探测（首次投递会让 macOS 弹授权框/注册到通知中心），状态直接回给界面
    try {
      const out = execFileSync(helperPath(), ['notify-status'], { encoding: 'utf8', timeout: 4000 }).trim();
      const st = (/"status":"([a-z-]+)"/.exec(out) ?? [])[1];
      return { ok: true, granted: st === 'authorized' ? true : st === 'denied' ? false : 'unknown' };
    } catch {
      const isGranted = (Notification as any).isGranted;
      return { ok: true, granted: typeof isGranted === 'function' ? !!isGranted.call(Notification) : 'unknown' };
    }
  });

  // 语音识别"去授权"：新版 macOS 隐私面板没有手动添加入口，未请求过的应用根本不出现在列表里，
  // 只能由应用自己弹系统授权框。走语音助手 `auth` 子命令（与首次语音输入的弹框同一条路径），
  // 等用户选完返回最新状态；助手不可用/异常退出时 ok=false，由界面回退跳系统设置。
  ipcMain.handle(IpcChannels.PrivacySpeechGrant, async () => {
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(helperPath(), ['auth'], { encoding: 'utf8', timeout: 50000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
      const m = /"status":"([a-z-]+)"/.exec(out);
      return { ok: true, status: m?.[1] ?? 'unknown' };
    } catch (err) {
      return { ok: false, status: 'unknown', error: String((err as Error)?.message ?? err).split('\n')[0] };
    }
  });

  // ── MCP 管理（设置→MCP 服务器）──
  /** 测试连接：按条目建立会话并拉工具列表。令牌只从宿主环境读（bearerTokenEnv/
   *  headersFromEnv 存的是变量名），失败如实返回错误供面板展示。 */
  ipcMain.handle(IpcChannels.McpTest, async (_e, server: any) => {
    try {
      if (!server || typeof server !== 'object') throw new Error('缺少 MCP 服务器配置');
      const { mcpTestConnection } = await import('./mcp-client');
      let result: any;
      if (server.transport === 'http') {
        if (typeof server.url !== 'string' || !/^https?:\/\/.+/.test(server.url)) throw new Error('URL 必须是 http(s) 地址');
        const headers: Record<string, string> = { ...(server.headers && typeof server.headers === 'object' ? server.headers : {}) };
        for (const [name, envKey] of Object.entries((server.headersFromEnv ?? {}) as Record<string, string>)) {
          if (typeof envKey !== 'string' || !envKey.trim()) throw new Error(`标头“${name}”的环境变量名无效。`);
          if (!getMcpEnvironmentVariable(envKey)) throw new Error(`标头“${name}”对应的 MCP 环境变量未设置；请在 MCP 设置中保存变量值。`);
          headers[name] = getMcpEnvironmentVariable(envKey)!;
        }
        if (typeof server.bearerTokenEnv === 'string' && server.bearerTokenEnv.trim()) {
          const value = getMcpEnvironmentVariable(server.bearerTokenEnv);
          if (!value) {
            throw new Error('Bearer 令牌环境变量未设置；请在 MCP 设置的“加密环境变量”中保存该变量的值。');
          }
          headers.authorization = `Bearer ${value}`;
        }
        result = await mcpTestConnection({ url: server.url, headers });
      } else {
        if (typeof server.command !== 'string' || !server.command.trim()) throw new Error('启动命令不能为空');
        result = await mcpTestConnection({
          command: server.command,
          args: Array.isArray(server.args) ? server.args.map(String) : [],
          env: server.env && typeof server.env === 'object' ? server.env : undefined,
          envPassThrough: Array.isArray(server.envPassThrough) ? server.envPassThrough.map(String) : [],
          cwd: typeof server.cwd === 'string' && server.cwd ? server.cwd : undefined,
        });
      }
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      return { ok: true, tools: tools.map((tool: any) => ({ name: String(tool?.name ?? ''), description: String(tool?.description ?? '').slice(0, 200) })) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });


  // 一次性文本补全（优化输入等）：不创建对话，按对话>项目>全局解析模型后直连调用
  ipcMain.handle(
    IpcChannels.LlmComplete,
    async (_e, req: { prompt: string; selectedModel?: import("../shared/types").SelectedModel; followGlobal?: boolean; convId?: string; projectPath?: string; requestId?: string }) => {
      const convMeta = req.convId ? await getConvCached(req.convId) : undefined;
      // requestId 让渲染层可以取消（长按「优化输入」→ 取消），避免模型无响应时请求一直悬挂
      const controller = req.requestId ? new AbortController() : undefined;
      if (req.requestId && controller) inflightCompletions.set(req.requestId, controller);
      try {
        return await completeTextOnce(
          { prompt: req.prompt, convMeta: convMeta ?? null, projectPath: req.projectPath, selectedModel:req.selectedModel, followGlobal:req.followGlobal },
          { signal: controller?.signal },
        );
      } finally {
        if (req.requestId) inflightCompletions.delete(req.requestId);
      }
    },
  );

  // 取消一次性补全：中止底层请求；渲染层同时丢弃该 requestId 的结果并恢复输入框可编辑
  ipcMain.handle(IpcChannels.LlmCompleteAbort, (_e, requestId: string) => {
    const controller = inflightCompletions.get(requestId);
    if (!controller) return false;
    controller.abort();
    inflightCompletions.delete(requestId);
    return true;
  });

  ipcMain.handle(
    IpcChannels.ConvUpdateMeta,
    async (_e, args: { id: string; patch: Partial<ConversationMeta> }) => {
      if (mobileDeletes.has(args.id)) return { ok: false };
      emptyConversationLifecycle?.retain(args.id);
      const meta = await getConvCached(args.id);
      if (!meta || mobileDeletes.has(args.id)) return { ok: false };
      const patch = { ...args.patch };
      if ('thinkingEffort' in patch && patch.thinkingEffort !== undefined && patch.thinkingEffort !== null
        && !['off', 'low', 'medium', 'xhigh'].includes(patch.thinkingEffort)) {
        throw Error('思考强度无效，请重新选择');
      }
      if ('securityProfile' in patch) {
        const profile = enabledSecurityProfiles(await readSettings()).find(p => p.enabled!==false && p.id === patch.securityProfile?.id);
        if (!profile) throw Error('安全方案不存在，请重新选择');
        patch.securityProfile = securitySnapshot(profile);
      }
      Object.assign(meta, patch, Object.keys(patch).every(key => key === 'pinned') ? {} : { updatedAt: new Date().toISOString() });
      await saveConv(meta);
      broadcastConvListChanged(_e.sender.id, { projectPath: meta.projectPath, convId: meta.id, reason: 'updated' });
      return { ok: true, meta };
    },
  );

  ipcMain.handle(IpcChannels.ConvDelete, async (_e, args: { id: string; projectPath?: string }) => {
    console.log('[ConvDelete] args:', JSON.stringify(args));
    let meta = await getConvCached(args.id);
    console.log('[ConvDelete] from cache:', meta?.id, 'projectPath:', meta?.projectPath);
    // 如果缓存里没有，但有 projectPath，直接从磁盘加载
    if (!meta && args.projectPath) {
      console.log('[ConvDelete] loading from disk:', args.projectPath, args.id);
      meta = await loadConv(args.projectPath, args.id);
      console.log('[ConvDelete] loaded:', meta?.id, 'projectPath:', meta?.projectPath);
      if (meta) convCache.set(args.id, meta);
    }
    if (!meta) {
      console.log('[ConvDelete] FAILED: meta is null');
      return { ok: false };
    }
    // 兜底：如果 meta.projectPath 是 undefined（历史数据或代码 bug），用传入的 projectPath
    if (!meta.projectPath && args.projectPath) {
      console.log('[ConvDelete] fixing undefined projectPath with:', args.projectPath);
      meta.projectPath = args.projectPath;
    }
    if (!meta.projectPath) {
      console.log('[ConvDelete] FAILED: meta.projectPath is still undefined');
      return { ok: false, error: 'conversation has no projectPath' };
    }
    if (convIsExecuting(args.id) || mobileDeletes.has(args.id)) return { ok: false, error: '请先停止当前执行再删除对话' };
    mobileDeletes.add(args.id);
    try {
    console.log('[ConvDelete] deleting convDir:', meta.projectPath, meta.id);
    // Before deleting, accumulate this conversation's usage into the
    // project's historical stats so that token/cost totals survive deletion.
    if (meta.totalUsage) {
      await addUsageToProjectStats(meta.projectPath, meta.totalUsage);
      // Also add to global stats
      await addUsageToGlobalStats(meta.totalUsage);
    }
    await deleteConv(meta);
    convCache.delete(args.id);
    broadcastConvListChanged(_e.sender.id, { projectPath: meta.projectPath, convId: args.id, reason: 'deleted' });
    console.log('[ConvDelete] success');
    return { ok: true };
    } finally { mobileDeletes.delete(args.id); }
  });

  ipcMain.handle(IpcChannels.ConvDeleteMessage, async (_event, args: { convId: string; msgId: string | string[] }) => {
    try {
      const meta = await getConvCached(args.convId);
      if (!meta) return { ok: false, error: 'chat not found' };
      return await deleteConversationMessages(meta, new Set(Array.isArray(args.msgId) ? args.msgId : [args.msgId]));
    } catch (error) { return { ok: false, error: (error as Error).message }; }
  });
  ipcMain.handle(IpcChannels.ConvMarkRead, (_event, args: { id: string; revision: number }) => markConversationRead(args.id, args.revision));

  // 整理对话上下文：压缩历史消息，只保留最近 N 轮对话
  ipcMain.handle(
    IpcChannels.ConvCompact,
    async (_e, args: { convId: string; keepRecentTurns?: number }) => {
      if (mobileDeletes.has(args.convId)) return { ok: false, error: '正在修改对话，请稍后重试' };
      emptyConversationLifecycle?.retain(args.convId);
      const meta = await getConvCached(args.convId);
      if (!meta) return { ok: false, error: 'chat not found' };
      if (meta.archived) return await archivedReadOnlyError();

      const { compactConversation } = await import('./conv-engine');
      const result = await compactConversation(meta, args.keepRecentTurns ?? 3);

      if (!result.ok) {
        // 把真实失败原因带数字告知，不再统一报"轮次不足或为空"误导用户；
        // 拒绝文案的口径在 shared/compact-boundary（体量而不是只看条数），主进程文案必须双语。
        const en = await mainTextEn();
        const { describeCompactionRejection } = await import('../shared/compact-boundary');
        const detail = result.reason === 'empty'
          ? (en ? 'conversation is empty' : '对话为空')
          : result.reason === 'summary'
            ? (en ? 'no summarizable content before the boundary' : '边界之前没有可提取的摘要内容')
            : result.rejection
              ? describeCompactionRejection(result.rejection, en ? 'en' : 'zh')
              : (en ? 'not enough context to compact' : '上下文还不够大，不需要整理');
        return { ok: false, error: en ? `cannot compact: ${detail}` : `无法整理：${detail}` };
      }

      return { ok: true, meta: result.meta, stats: result.stats };
    },
  );

  ipcMain.handle(
    IpcChannels.ConvSend,
    async (
      event,
      args: {
        id: string;
        text: string;
        images?: Array<{ name: string; mimeType: string; dataBase64: string }>;
        /** 执行模式：仅对话第一句生效（之后锁定在 meta.mode）。 */
        mode?: ConversationMode;
        clientMessageId?: string;
      },
    ) => {
      emptyConversationLifecycle?.retain(args.id);
      const meta = await getConvCached(args.id);
      if (!meta) return { ok: false, error: 'chat not found' };
      if (messageMutations.has(args.id)) return { ok: false, error: '正在修改消息，请稍后重试' };
      // 归档对话不能发起新一轮执行（包含入队）：渠道入站 / 旧标签页都必须先解档
      if (meta.archived) return await archivedReadOnlyError();

      const approval = acceptConversationalApproval(meta, args.text, args.images, args.clientMessageId);
      if (approval) return approval;
      try { Object.assign(args, await materializeFileImages(meta.projectPath, args.text, args.images)); }
      catch (error) { return { ok: false, error: `无法保存文件附件：${String(error)}` }; }

      // Attachment materialization can yield while another client changes the conversation.
      if (messageMutations.has(args.id) || mobileDeletes.has(args.id)) return { ok: false, error: '正在修改对话，请稍后重试' };
      if (meta.archived) return await archivedReadOnlyError();
      const senderId = event.sender.id;
      // 诊断：渲染端实际送达的 mode（区分渲染层丢失 vs 主进程丢失）
      diagExperts({
        where: 'conv-send',
        convId: args.id,
        mode: args.mode ?? null,
        hasClientMessageId: !!args.clientMessageId,
      });

      // ── 排队逻辑：如果当前对话正在执行或正在 drain 队列，入队而非拒绝 ──
      // 增加 convDraining 检查：runOneTurn 的 finally 中 aborters.delete 之后、
      // drainQueue 开始之前的窗口期，新消息也必须入队，否则会和 drain 中的消息并发执行。
      if (aborters.has(args.id) || convDraining.has(args.id) || (convQueue.get(args.id)?.length ?? 0) > 0) {
        const queueId = randomBytes(6).toString('base64url');
        const q = convQueue.get(args.id) ?? [];
        const entry: QueuedSend = {
          queueId,
          clientMessageId: args.clientMessageId,
          text: args.text,
          images: args.images,
          senderId,
          mode: args.mode,
          resolve: () => {},
        };
        q.push(entry);
        convQueue.set(args.id, q);
        emitQueueUpdate(args.id, senderId);
        // Return immediately with queueId so frontend can show "queued" badge
        return { ok: true, queued: true, queueId, meta };
      }

      // ── 空闲：直接执行，完成后自动 drain 队列 ──
      failedQueueItems.delete(args.id);
      const result = await runOneTurn(args.id, args.text, args.images, senderId, meta, undefined, undefined, args.mode, args.clientMessageId);
      // After the turn completes, drain any queued messages
      await drainQueue(args.id);
      return result;
    },
  );

  // ── 插话：执行过程中注入消息，下一个安全边界生效 ──
  // 与排队的区别：
  // - 排队：等当前 turn 完全结束后才开始新一轮
  // - 插话：消息立即写入对话历史 + 推送到 UI，并在当前 turn 的
  //   下一个工具调用间隙注入到 agent 上下文，agent 可即时参考
  ipcMain.handle(
    IpcChannels.ConvInterject,
    async (event, args: { id: string; text: string; images?: ImageAttachment[]; queueId?: string }) =>
      interjectConversation(args, event.sender.id),
  );

  // ── 专家团模式：计划确认 / 重新规划 / 取消 ──
  ipcMain.handle(
    IpcChannels.ExpertsConfirmPlan,
    async (_e, args: { convId: string; action: PlanDecision['action']; feedback?: string }) => confirmExpertsPlan(args.convId, args.action, args.feedback),
  );

  // ── 专家团模式：重试失败的专家团任务（网络中断等可恢复错误后全量重跑 error 任务）──
  ipcMain.handle(
    IpcChannels.ExpertsRetryFailedTasks,
    async (event, args: { convId: string }) => resumeExpertsConversation(args.convId, event.sender.id),
  );

  ipcMain.handle(
    IpcChannels.ConvPermissionResponse,
    async (
      _e,
      args: { requestId: string; decision: 'allow' | 'deny' | 'allow-conv' | 'allow-conv-command'; updatedInput?: any; message?: string },
    ) => {
      return respondPermissionRequest(args);
    },
  );

  // 澄清回答回填：用户在问题卡片上选择/输入后触发
  ipcMain.handle(
    IpcChannels.ConvClarifyResponse,
    async (_e, args: { requestId: string; answer: string }) => {
      return respondClarifyRequest(args);
    },
  );

  ipcMain.handle(IpcChannels.ConvAbort, async (_e, id: string, reason?: string) => {
    const entry = aborters.get(id);
    if (entry) {
      entry.controller.abort(reason === 'project-switch' ? '切换项目，对话已停止' : '你已停止本次对话');
      // Keep ownership until the actual execution and persistence settle.
      return { ok: true };
    }
    // 没有正在执行的 turn，无需中止
    return { ok: false };
  });

  /**
   * 查询对话当前是否真的在执行。
   *
   * 这是"卡死检测"的权威判据：前端只看消息时间戳会把长任务（单个工具跑几分钟、
   * 深度思考无输出等）误判为卡死，进而 abort 掉正在运行的 turn。后端持有
   * aborters / convDraining 的真实状态，以此为准。
   */
  ipcMain.handle(IpcChannels.ConvIsRunning, async (_e, id: string) => {
    return {
      running: aborters.has(id) || convDraining.has(id),
      queued: convQueue.get(id)?.length ?? 0,
    };
  });

  // ── Queue management ────────────────────────────────────────────────────

  /** Remove a queued (not yet executing) message. Zero cost — it was never sent. */
  ipcMain.handle(
    IpcChannels.ConvQueueRemove,
    async (_e, args: { convId: string; queueId: string }) => {
      const q = convQueue.get(args.convId);
      if (!q) return { ok: false };
      const idx = q.findIndex((item) => item.queueId === args.queueId);
      if (idx < 0) return { ok: false };
      const [removed] = q.splice(idx, 1);
      if (q.length === 0) convQueue.delete(args.convId);
      // Resolve the pending Promise so the backend doesn't hold a dangling ref
      removed.resolve({ ok: false, error: 'removed from queue' });
      emitQueueUpdate(args.convId, _e.sender.id);
      return { ok: true };
    },
  );

  /** List currently queued messages for a conversation. */
  ipcMain.handle(
    IpcChannels.ConvQueueList,
    async (_e, convId: string) => {
      const q = convQueue.get(convId);
      if (!q) return [];
      return q.map((item) => ({
        queueId: item.queueId,
        clientMessageId: item.clientMessageId,
        text: item.text,
        images: item.images,
      }));
    },
  );

  /** Reorder the queue: pass the new queueId order (must be a permutation of current ids). */
  ipcMain.handle(
    IpcChannels.ConvQueueReorder,
    async (_e, args: { convId: string; queueIds: string[] }) => {
      const q = convQueue.get(args.convId);
      if (!q) return { ok: false };
      // Validate: must be a permutation of current ids
      if (args.queueIds.length !== q.length || new Set(args.queueIds).size !== q.length) return { ok: false };
      const byId = new Map(q.map((item) => [item.queueId, item]));
      const reordered: QueuedSend[] = [];
      for (const id of args.queueIds) {
        const item = byId.get(id);
        if (!item) return { ok: false };
        reordered.push(item);
      }
      convQueue.set(args.convId, reordered);
      emitQueueUpdate(args.convId, _e.sender.id);
      return { ok: true };
    },
  );

  /** A failed turn pauses the queue until an explicit resume or retry. */
  ipcMain.handle(IpcChannels.ConvQueueResume, async (_e, args: { convId: string }) => {
    if (messageMutations.has(args.convId) || mobileDeletes.has(args.convId) || aborters.has(args.convId) || convDraining.has(args.convId)) return { ok: false };
    const meta = await getConvCached(args.convId);
    if (meta?.archived) return await archivedReadOnlyError();
    failedQueueItems.delete(args.convId);
    await drainQueue(args.convId);
    return { ok: true };
  });

  ipcMain.handle(IpcChannels.ConvQueueRetry, async (event, args: { convId: string }) => {
    const meta = await getConvCached(args.convId);
    if (!meta) return { ok: false, error: 'chat not found' };
    if (aborters.has(args.convId) || convDraining.has(args.convId)) return { ok: false, error: 'conversation is running' };
    if (meta.archived) return await archivedReadOnlyError();
    const failed = failedQueueItems.get(args.convId);
    if (!failed) return { ok: false, error: '没有可重试的消息' };
    try {
      const { turn } = await startFailedConversationRetry(meta, event.sender.id);
      return await turn;
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });

  ipcMain.handle(IpcChannels.ConvQueueGetFailed, async (_e, args: { convId: string }) => ({
    ok: true, failed: failedQueueItems.get(args.convId) ?? null,
  }));

  ipcMain.handle('git:branch-action', async (_e, { projectPath, request }) => {
    if (['create', 'track'].includes(request.action)) {
      const { applyBranchPrefix } = await import('./git-utils');
      request = { ...request, name: applyBranchPrefix(String(request.name ?? ''), String(builtinSettingValue(await readSettings(), projectPath, 'git', 'branchPrefix') ?? '')) };
    }
    try { await gitBranchAction(projectPath, request); }
    finally { invalidateRefsCache(projectPath); invalidateDiscoverCache(); }
  });
  // ---------- Git / DeepWiki ----------

  ipcMain.handle(IpcChannels.GitRepoInfo, async (_e, projectPath: string) =>
    detectGitRepo(projectPath),
  );

  ipcMain.handle(IpcChannels.GitBranchList, async (_e, projectPath: string) =>
    gitBranchList(projectPath),
  );

  ipcMain.handle(IpcChannels.GitCurrentBranch, async (_e, projectPath: string) =>
    gitCurrentBranch(projectPath),
  );

  ipcMain.handle(
    IpcChannels.GitCheckout,
    async (_e, args: { projectPath: string; branch: string }) =>
      gitCheckout(args.projectPath, args.branch),
  );

  ipcMain.handle(
    IpcChannels.GitBranchCreate,
    async (_e, args: { projectPath: string; name: string; opts?: { base?: string; checkout?: boolean } }) => {
      const { applyBranchPrefix } = await import('./git-utils');
      const name = applyBranchPrefix(args.name, String(builtinSettingValue(await readSettings(), args.projectPath, 'git', 'branchPrefix') ?? ''));
      return gitBranchCreate(args.projectPath, name, args.opts);
    },
  );

  ipcMain.handle(
    IpcChannels.GitBranchDelete,
    async (_e, args: { projectPath: string; name: string; opts?: { force?: boolean } }) =>
      gitBranchDelete(args.projectPath, args.name, args.opts),
  );

  ipcMain.handle(IpcChannels.GitPull, async (_e, projectPath: string) => {
    const result = await gitPull(projectPath);
    invalidateRefsCache(projectPath);
    return result;
  });

  ipcMain.handle(
    IpcChannels.GitPush,
    async (_e, args: { projectPath: string; opts?: { setUpstream?: boolean; forceWithLease?: boolean; remote?: string } }) => {
      // Git 插件「始终强制推送」配置：调用方未显式指定时自动应用 --force-with-lease
      let opts = args.opts ?? {};
      if (opts.forceWithLease === undefined) {
        try {
          const settings = await readSettings();
          opts = { ...opts, forceWithLease: builtinSettingValue(settings, args.projectPath, 'git', 'forceWithLease') === true };
        } catch { /* 读配置失败按默认普通推送 */ }
      }
      const result = await gitPush(args.projectPath, opts);
      invalidateRefsCache(args.projectPath);
      return result;
    },
  );

  ipcMain.handle(IpcChannels.GitStatus, async (_e, projectPath: string) =>
    gitStatus(projectPath),
  );

  ipcMain.handle(
    IpcChannels.GitStage,
    async (_e, args: { projectPath: string; paths: string[] }) =>
      gitStage(args.projectPath, args.paths),
  );

  ipcMain.handle(
    IpcChannels.GitUnstage,
    async (_e, args: { projectPath: string; paths: string[] }) =>
      gitUnstage(args.projectPath, args.paths),
  );

  ipcMain.handle(
    IpcChannels.GitCommit,
    async (_e, args: { projectPath: string; message: string }) =>
      gitCommit(args.projectPath, args.message),
  );

  ipcMain.handle(
    IpcChannels.GitDiff,
    async (_e, args: { projectPath: string; ref1?: string; ref2?: string }) =>
      gitDiff(args.projectPath, args.ref1, args.ref2),
  );

  ipcMain.handle(
    IpcChannels.GitFileDiff,
    async (_e, args: { projectPath: string; filePath: string; ref1?: string; ref2?: string }) =>
      gitFileDiff(args.projectPath, args.filePath, args.ref1, args.ref2),
  );

  ipcMain.handle(
    IpcChannels.GitLog,
    async (_e, args: { projectPath: string; opts?: { limit?: number; ref?: string; path?: string; skip?: number } }) =>
      gitLog(args.projectPath, args.opts),
  );

  ipcMain.handle(
    IpcChannels.GitLogGraph,
    async (_e, args: { projectPath: string; opts?: { limit?: number; ref?: string; refs?: string[]; only?: boolean; path?: string; skip?: number } }) => {
      try {
        const commits = await gitLogGraph(args.projectPath, args.opts);
        return { ok: true, commits };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.GitShow,
    async (_e, args: { projectPath: string; ref: string }) =>
      gitShow(args.projectPath, args.ref),
  );

  ipcMain.handle(IpcChannels.GitBrowserRefs, (_e,root:string,force?:boolean)=>gitBrowserRefs(root, !!force));
  ipcMain.handle(IpcChannels.GitBrowserCommit, (_e,args:{root:string;ref:string})=>gitBrowserCommit(args.root,args.ref));
  ipcMain.handle(IpcChannels.GitBrowserFile, (_e,args:{root:string;ref:string;file:string;patch?:boolean;base64?:boolean})=>gitBrowserFile(args.root,args.ref,args.file,args.patch,args.base64));
  ipcMain.handle(IpcChannels.GitBrowserFetch, (_e,root:string)=>gitBrowserFetch(root));
  ipcMain.handle(IpcChannels.GitDiscoverRepos, async (_e, projectPath: string, force?: boolean) => {
    try {
      // 缓存 TTL 取 Git 插件配置项（分钟）；命中缓存秒回，过期后台静默重扫
      const settings = await readSettings();
      const mins = Number(builtinSettingValue(settings, projectPath, 'git', 'scanRefreshMinutes'));
      const ttl = (Number.isFinite(mins) && mins > 0 ? mins : 10) * 60_000;
      return { ok: true, ...(await discoverGitReposCached(projectPath, ttl, !!force)) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(
    IpcChannels.GitInit,
    async (_e, args: { projectPath: string; relDir?: string }) => {
      try {
        const output = await gitInit(args.projectPath, args.relDir);
        invalidateRefsCache();
        invalidateDiscoverCache(args.projectPath);
        return { ok: true, output };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.GitDiffFiles,
    async (_e, args: { projectPath: string; ref1: string; ref2?: string }) =>
      gitDiffFiles(args.projectPath, args.ref1, args.ref2),
  );

  ipcMain.handle(IpcChannels.OpenPdf, async (_e, args: {projectPath:string;relPath:string;external?:boolean}) => {
    try {
      const url = await projectPdfUrl(args.projectPath, args.relPath);
      if (args.external) await openPdfInExternalBrowser(url);
      return {ok:true,url};
    } catch(error:any) { return {ok:false,error:error?.message ?? String(error)}; }
  });

  ipcMain.handle(IpcChannels.OpenExternal, async (_e, url: string) => {
    // 渲染层会把模型输出/网页里的链接直接传进来：只允许浏览器协议，
    // 封死 file:// / x-apple.systempreferences: 等自定义 scheme 注入（与 main.ts 窗口导航同口径）。
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    const { shell } = await import('electron');
    return shell.openExternal(url);
  });

  // 反馈提交：主进程拼装上下文 + 客户端标识头后 POST 到反馈服务器
  ipcMain.handle(IpcChannels.FeedbackCapture, event => captureFeedbackScreenshot(event.sender));
  ipcMain.handle(IpcChannels.FeedbackSubmit, async (_e, sub: FeedbackSubmission) => submitFeedback(sub));

  // 反馈服务自检：主进程 GET 一次（不受 CORS 限制）；入参为设置页可选的自定义地址覆盖
  ipcMain.handle(IpcChannels.FeedbackProbe, async (_e, urlOverride?: string) => probeFeedbackService(urlOverride));

  // 中继站点 Token 申请页自检：设置页据此决定要不要显示「申请」入口（只有 200 才显示）
  ipcMain.handle(IpcChannels.RelayApplyProbe, async (_e, urlOverride?: string) => probeRelayApply(urlOverride));

  // 设备模拟：对 webview guest 应用 UA + client hints（CDP Emulation.setUserAgentOverride）。
  // 传 null 清除覆盖。debugger 通道仅用于 Emulation 域，失败静默返回 ok:false。
  ipcMain.handle(
    IpcChannels.WebviewEmulate,
    async (
      _e,
      id: number,
      payload: {
        userAgent?: string;
        metadata?: {
          mobile?: boolean;
          platform?: string;
          platformVersion?: string;
          architecture?: string;
          model?: string;
          brands?: Array<{ brand: string; version: string }>;
          fullVersionList?: Array<{ brand: string; version: string }>;
        };
      } | null,
    ) => {
      const wc = webContents.fromId(id ?? 0);
      if (!wc || wc.isDestroyed()) return { ok: false, error: 'webContents not found' };
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        if (!payload || (!payload.userAgent && !payload.metadata)) {
          await wc.debugger.sendCommand('Emulation.setUserAgentOverride', { userAgent: '' });
        } else {
          const params: Record<string, unknown> = {};
          if (payload.userAgent) params.userAgent = payload.userAgent;
          if (payload.metadata) params.userAgentMetadata = payload.metadata;
          await wc.debugger.sendCommand('Emulation.setUserAgentOverride', params);
        }
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  // ---------- Files ----------

  ipcMain.handle(
    IpcChannels.FilesList,
    async (_e, args: { projectPath: string; relPath?: string }) => {
      try {
        return { ok: true, entries: await listDir(args.projectPath, args.relPath ?? '', (await readSettings()).fileBrowserHiddenDirectories??['.sage']) };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.FilesRead,
    async (_e, args: { projectPath: string; relPath: string }) => {
      try {
        return { ok: true, ...(await readProjFile(args.projectPath, args.relPath)) };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.FilesReadAsBase64,
    async (_e, args: { projectPath: string; relPath: string }) => {
      try {
        return await readFileAsBase64(args.projectPath, args.relPath);
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.FilesWrite,
    async (_e, args: { projectPath: string; relPath: string; content: string }) => {
      try {
        await writeProjFile(args.projectPath, args.relPath, args.content);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(IpcChannels.FilesStat, async (_e, args: { projectPath: string; relPath: string }) => {
    try {
      return { ok: true, ...(await statFile(args.projectPath, args.relPath)) };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  ipcMain.handle(
    IpcChannels.FilesSearch,
    async (_e, args: { projectPath: string; query: string; limit?: number; scope?: string }) => {
      try {
        return { ok: true, entries: await searchFiles(args.projectPath, args.query, args.limit ?? 200, args.scope, (await readSettings()).fileBrowserHiddenDirectories??['.sage']) };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.FilesSearchContent,
    async (_e, args: { projectPath: string; query: string; scope?: string }) => {
      try {
        return { ok: true, result: await searchFileContents(args.projectPath, args.query, undefined, undefined, args.scope, (await readSettings()).fileBrowserHiddenDirectories??['.sage']) };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.FilesMkdir,
    async (_e, args: { projectPath: string; relPath: string }) => {
      try {
        await mkdirProj(args.projectPath, args.relPath);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  ipcMain.handle(
    IpcChannels.FilesCreate,
    async (_e, args: { projectPath: string; relPath: string; content?: string }) => {
      try {
        await createProjFile(args.projectPath, args.relPath, args.content ?? '');
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  );

  // ---------- Terminal (node-pty) ----------

  ipcMain.handle(
    IpcChannels.TerminalCreate,
    async (event, args: { cwd: string }) => {
      try {
        const senderId = event.sender.id;
        const id = createTerminal(args.cwd, senderId, getWindows);
        return { id };
      } catch (err: any) {
        console.error('TerminalCreate error:', err);
        throw err;
      }
    },
  );

  // High-frequency keyboard input: use ipcMain.on (fire-and-forget) instead
  // of ipcMain.handle to avoid invoke's round-trip overhead.
  ipcMain.on(
    IpcChannels.TerminalData,
    (_event, args: { id: string; data: string }) => {
      writeTerminal(args.id, args.data);
    },
  );

  ipcMain.on(IpcChannels.TerminalAcknowledge, (event, args: {id:string; count:number; ready?:boolean}) => {
    if (event.senderFrame !== event.sender.mainFrame || !args || typeof args.id !== 'string') return;
    acknowledgeTerminal(args.id, args.count, event.sender.id, args.ready === true);
  });

  ipcMain.handle(
    IpcChannels.TerminalResize,
    async (_e, args: { id: string; cols: number; rows: number }) => {
      resizeTerminal(args.id, args.cols, args.rows);
      return { ok: true };
    },
  );

  ipcMain.handle(IpcChannels.TerminalDispose, async (_e, args: { id: string }) => {
    disposeTerminal(args.id);
    return { ok: true };
  });

  // ---------- Scheduled Tasks (定时任务) ----------

  ipcMain.handle(IpcChannels.ScheduledList, async (_e, projectPath: string) => {
    return loadTasksForProject(projectPath);
  });

  ipcMain.handle(
    IpcChannels.ScheduledCreate,
    async (
      _e,
      args: { projectPath: string; name: string; prompt: string; schedule: any; options?: import('../shared/types').ScheduledTaskInput },
    ) => {
      const task=await createScheduledTask(args.projectPath, args.name, args.prompt, args.schedule, args.options);
      if(task.sourceConvId&&!task.sourceMessageId){
        try {
          const en=await mainTextEn(),runId='created-'+task.id;
          await appendScheduledResult(task.projectPath,task.sourceConvId,task.name,`${en?'Scheduled task created. Task ID: ':'定时任务已创建。任务 ID：'}${task.id}\n\n${task.prompt}`,runId);
          return await updateScheduledTask(task.id,{sourceMessageId:'scheduled-result-'+runId})??task;
        }catch(error){console.warn('[scheduled] Task saved; origin message unavailable',error);}
      }
      return task;
    },
  );

  ipcMain.handle(
    IpcChannels.ScheduledUpdate,
    async (_e, args: { taskId: string; patch: any; expectedUpdatedAt?:string }) => {
      return updateScheduledTask(args.taskId, args.patch, args.expectedUpdatedAt);
    },
  );

  ipcMain.handle(IpcChannels.ScheduledDelete, async (_e, taskId: string) => {
    return { ok: await deleteScheduledTask(taskId) };
  });

  ipcMain.handle(IpcChannels.ScheduledToggle, async (_e, args: { taskId: string; enabled: boolean }) => {
    return updateScheduledTask(args.taskId, { enabled: args.enabled });
  });

  ipcMain.handle(IpcChannels.ScheduledApproval, async (_e,args:{projectPath:string;runId:string;requestId:string;decision:'allow'|'deny'}) => respondScheduledApproval(args.projectPath,args.runId,args.requestId,args.decision));

  ipcMain.handle(IpcChannels.ScheduledRunNow, async (_e, taskId: string) => {
    return runScheduledTaskNow(taskId);
  });

  ipcMain.handle(IpcChannels.ScheduledListRuns, async (_e, args: { projectPath: string; taskId?: string }) => {
    return getRunsForProject(args.projectPath, args.taskId);
  });

  // ---------- Channels (通知渠道) ----------

  /** 列出所有可用渠道类型及其表单字段（供前端渲染配置表单）。 */
  ipcMain.handle(IpcChannels.ChannelListTypes, async () => {
    return listChannelPlugins().map((p) => ({
      type: p.type,
      label: p.label,
      fields: p.fields,
    }));
  });

  /** 列出当前项目的所有渠道配置。 */
  ipcMain.handle(IpcChannels.ChannelList, async (_e, projectPath: string) => {
    return listChannelsStore(projectPath);
  });

  /** 新增或更新渠道配置（upsert）。 */
  ipcMain.handle(
    IpcChannels.ChannelSave,
    async (_e, args: { projectPath: string; channel: ChannelConfig }) => {
      const channels = await listChannelsStore(args.projectPath);
      const idx = channels.findIndex((c) => c.id === args.channel.id);
      if (idx >= 0) {
        channels[idx] = args.channel;
      } else {
        channels.push(args.channel);
      }
      await saveChannelsStore(args.projectPath, channels);
      return args.channel;
    },
  );

  /** 删除渠道配置。 */
  ipcMain.handle(IpcChannels.ChannelDelete, async (_e, args: { projectPath: string; channelId: string }) => {
    const channels = await listChannelsStore(args.projectPath);
    const filtered = channels.filter((c) => c.id !== args.channelId);
    await saveChannelsStore(args.projectPath, filtered);
    return { ok: true };
  });

  /** 测试渠道连通性。 */
  ipcMain.handle(
    IpcChannels.ChannelTest,
    async (_e, args: { type: string; config: Record<string, string>; projectPath?: string }) => {
      return testChannel(args.type, args.config, args.projectPath);
    },
  );

  // ── 渠道诊断（「测试成功但没收到」的自动定位）──────────────────────────

  /** 诊断事件缓冲（detail 已在主进程脱敏，这里不回任何密钥）。 */
  ipcMain.handle(
    IpcChannels.ChannelDiagList,
    (_e, args?: { channelKey?: string; projectPath?: string; since?: number }) => listChannelDiag(args),
  );

  ipcMain.handle(IpcChannels.ChannelDiagClear, () => {
    // 只清内存缓冲：落盘日志是事后复盘的依据，不留「一键抹掉证据」的入口
    clearChannelDiag();
    return { ok: true };
  });

  ipcMain.handle(
    IpcChannels.ChannelDiagPath,
    (_e, scope?: { projectPath?: string; channelKey?: string }) => channelDiagLogPath(scope),
  );

  /** 长连接实时状态。 */
  ipcMain.handle(IpcChannels.ChannelWsStatus, () => feishuConnectionStatus());

  /**
   * 诊断事件推给所有窗口：入站消息由飞书长连接推进来，渲染层根本没有对应动作，
   * 不推就只能靠手动刷新去看日志是否长出了新行。
   */
  subscribeChannelDiag((event) => {
    for (const w of getWindows().values()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
      try {
        w.webContents.send(IpcChannels.ChannelDiagEvent, event);
      } catch {
        /* window torn down between the guard and send — safe to drop */
      }
    }
  });

  /** Telegram 专属：设置入站 Webhook（调用 Telegram Bot API setWebhook）。 */
  ipcMain.handle(
    IpcChannels.ChannelTelegramSetWebhook,
    async (_e, args: { config: Record<string, string>; webhookUrl: string }) => {
      return setTelegramWebhook(args.config, args.webhookUrl);
    },
  );

  /** Telegram 专属：删除 Webhook。 */
  ipcMain.handle(
    IpcChannels.ChannelTelegramDeleteWebhook,
    async (_e, args: { config: Record<string, string> }) => {
      return deleteTelegramWebhook(args.config);
    },
  );

  // ── 对话-渠道双向打通 ──────────────────────────────────────────────────

  /** 获取对话绑定的渠道 id 列表（返回入站和出站）。 */
  ipcMain.handle(
    IpcChannels.ConvChannelsGet,
    async (_e, args: { projectPath: string; convId: string }) => {
      const conv = await getConvCached(args.convId);
      return {
        inbound: conv?.inboundChannelIds ?? [],
        outbound: conv?.outboundChannelIds ?? conv?.channelIds ?? [],
      };
    },
  );

  /** 设置对话绑定的渠道（分别设置入站、出站和三个广播通道）。 */
  ipcMain.handle(
    IpcChannels.ConvChannelsSet,
    async (_e, args: {
      projectPath: string;
      convId: string;
      inbound?: string[];
      outbound?: string[];
      broadcastUser?: string[];
      broadcastInbound?: string[];
      broadcastAssistant?: string[];
    }) => {
      if (mobileDeletes.has(args.convId)) return { ok: false, error: '正在修改对话，请稍后重试' };
      emptyConversationLifecycle?.retain(args.convId);
      const conv = await getConvCached(args.convId);
      if (mobileDeletes.has(args.convId)) return { ok: false, error: '正在修改对话，请稍后重试' };
      if (!conv || conv.projectPath !== args.projectPath) return { ok: false, error: 'chat not found' };
      
      // 更新入站渠道（发送方）
      if (args.inbound !== undefined) {
        conv.inboundChannelIds = args.inbound.length > 0 ? args.inbound : undefined;
      }
      // 更新出站渠道（回答方）
      if (args.outbound !== undefined) {
        conv.outboundChannelIds = args.outbound.length > 0 ? args.outbound : undefined;
      }
      // Preserve both legacy broadcast targets before changing just one direction.
      if (conv.broadcastChannelIds) {
        conv.broadcastUserChannelIds ??= [...conv.broadcastChannelIds];
        conv.broadcastInboundChannelIds ??= [...conv.broadcastChannelIds];
      }
      // 更新三个广播通道
      if (args.broadcastUser !== undefined) {
        conv.broadcastUserChannelIds = args.broadcastUser.length > 0 ? args.broadcastUser : undefined;
      }
      if (args.broadcastInbound !== undefined) {
        conv.broadcastInboundChannelIds = args.broadcastInbound.length > 0 ? args.broadcastInbound : undefined;
      }
      if (args.broadcastAssistant !== undefined) {
        conv.broadcastAssistantChannelIds = args.broadcastAssistant.length > 0 ? args.broadcastAssistant : undefined;
      }
      
      // 兼容旧数据：如果入站+出站都设置了，清除旧的 channelIds
      if (args.outbound !== undefined) {
        conv.channelIds = undefined;
      }
      // 旧 broadcastChannelIds 迁移：拆分到 broadcastUser + broadcastInbound（旧语义是广播用户+入站）
      // 注意：只在用户设置了任意广播字段时才清理旧的 broadcastChannelIds
      if (
        args.broadcastUser !== undefined ||
        args.broadcastInbound !== undefined ||
        args.broadcastAssistant !== undefined
      ) {
        conv.broadcastChannelIds = undefined;
      }
      
      conv.updatedAt = new Date().toISOString();
      await saveConv(conv);

      // 合并广播字段：新字段优先，旧的 broadcastChannelIds 作为 fallback
      const user = conv.broadcastUserChannelIds ?? conv.broadcastChannelIds ?? [];
      const inbound = conv.broadcastInboundChannelIds ?? conv.broadcastChannelIds ?? [];
      const assistant = conv.broadcastAssistantChannelIds ?? [];

      return {
        ok: true,
        inbound: conv.inboundChannelIds ?? [],
        outbound: conv.outboundChannelIds ?? conv.channelIds ?? [],
        broadcastUser: user,
        broadcastInbound: inbound,
        broadcastAssistant: assistant,
      };
    },
  );

  /** 获取渠道的入站 webhook URL。 */
  ipcMain.handle(
    IpcChannels.ChannelInboundUrl,
    async (_e, args: { channel: ChannelConfig; port?: number }) => {
      const port = args.port ?? 19527;
      if (!args.channel.inboundWebhookPath) {
        // 自动生成
        const path = generateWebhookPath(args.channel.type);
        return {
          webhookPath: path,
          url: await getInboundUrl(path, port),
        };
      }
      return {
        webhookPath: args.channel.inboundWebhookPath,
        url: await getInboundUrl(args.channel.inboundWebhookPath, port),
      };
    },
  );

  /** 启动入站 webhook 服务器。 */
  ipcMain.handle(
    IpcChannels.ChannelInboundStart,
    async (_e, args: { port?: number }) => {
      return startInboundWebhook(args.port ?? 19527);
    },
  );

  /** 停止入站 webhook 服务器。 */
  ipcMain.handle(IpcChannels.ChannelInboundStop, async () => {
    await stopInboundWebhook();
    return { ok: true };
  });

  // ── Relay 长连接（本地无公网 IP 场景） ────────────────────────────────

  ipcMain.handle(IpcChannels.RelayCertificateProbe, async (event, url: unknown) => {
    if (!getWindows().has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) throw Error('Untrusted certificate inspection caller');
    if (typeof url !== 'string') throw Error('Invalid relay certificate address');
    return probeRelayCertificate(url);
  });

  /** 启动 relay 长连接（配置来自 settings.relayUrl / relayToken）。 */
  ipcMain.handle(IpcChannels.RelayStart, async () => {
    return startRelay(getWindows);
  });

  /** 停止 relay 长连接。 */
  ipcMain.handle(IpcChannels.RelayStop, async () => {
    stopRelay();
    return { ok: true };
  });

  ipcMain.handle(IpcChannels.RelayClientNameSet,async(_event,name:unknown)=>setRelayClientName(name));

  /** 获取 relay 连接状态。 */
  ipcMain.handle(IpcChannels.RelayStatusGet, async () => {
    return getRelayStatusSnapshot();
  });

  /**
   * 重置 Webhook Token（客户端自助）：
   * 用 Client Token 调 relay admin API 重置自己的 Webhook Token，
   * 更新 settings.relayWebhookToken，重置后旧回调地址立即失效。
   */
  ipcMain.handle(IpcChannels.RelayRotateWebhook, async () => {
    try {
      const settings = await readSettings();
      if (!settings.relayUrl || !settings.relayToken) {
        return { ok: false, error: '未配置 relay 连接地址与 Client Token' };
      }
      let base = settings.relayUrl.trim().replace(/\/+$/, '');
      base = base.replace(/^ws(s?):\/\//, 'http$1://');
      if (!/^https?:\/\//.test(base)) base = 'https://' + base;
      const auth = { Authorization: `Bearer ${settings.relayToken}` };
      const request = relayFetch({origin:new URL(base).origin, certificate:settings.relayCertificate});

      // Client Token 只能看自己 → GET /tokens 返回自己的条目
      const listRes = await request(`${base}/admin/api/tokens`, { headers: auth });
      if (!listRes.ok) {
        return { ok: false, error: `认证失败（HTTP ${listRes.status}），请检查 Client Token 是否正确且未停用` };
      }
      const listJson = await listRes.json() as any;
      const self = Array.isArray(listJson?.tokens) ? listJson.tokens[0] : null;
      if (!self?.id) return { ok: false, error: '未找到对应的客户端记录' };

      const rotRes = await request(`${base}/admin/api/tokens/${self.id}/rotate-webhook`, {
        method: 'POST',
        headers: auth,
      });
      if (!rotRes.ok) {
        return { ok: false, error: `重置失败（HTTP ${rotRes.status}）` };
      }
      const rotJson = await rotRes.json() as any;
      const newToken = rotJson?.token?.webhookToken;
      if (!newToken) return { ok: false, error: '重置返回异常：未拿到新的 Webhook Token' };

      // 更新本地持久化 + 内存缓存，供渠道页拼接入站 URL（立即生效）
      await patchSettings({ relayWebhookToken: newToken });
      syncRelayWebhookToken(newToken);
      return { ok: true, webhookToken: newToken };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });
}

export function activeUpdateTaskCount(): number { return new Set([...aborters.keys(), ...convDraining, ...[...convQueue].filter(([,items]) => items.length > 0).map(([id]) => id)]).size; }
