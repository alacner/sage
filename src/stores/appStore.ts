import { hasConversationDraft, mountedConversationDraft } from '../lib/conversation-draft-lifecycle';
import { mergeConversationReadState } from '../../shared/conversation-read-state';
import {appendStreamText,appendStreamLog,trimStreamEntries} from '../../shared/stream-memory';
import {readSidebarLayout,writeSidebarLayout} from '../lib/sidebar-layout';
import { enabledBuiltins } from '../../shared/builtin-plugins';
import { resolveLanguage } from '../../shared/language';
import {nextForkTitle} from '../../shared/fork-title';
const retryingConversations = new Set<string>();
import { activateQueuedMessage, retainQueuedMessages, forkTimelineHistory } from '../../shared/chat-timeline';
import { translate } from '../i18n';
import { dropConversation, markConversationArchived, mergeConversation } from '../../shared/conv-list-sync';
import { confirmDialog } from '../lib/confirm-dialog';
import { create } from 'zustand';
import type {
  ProjectEntry,
  SpecMeta,
  ClaudeBridgeStatus,
  AppSettings,
  ConversationMeta,
  ConversationMode,
  ChatMessage,
  ChatEvent,
  ToolCall,
  FileEntry,
  ContentSearchResult,
  PendingApproval,
  ClarifyRequest,
  ImageAttachment,
  SteeringDocs,
  ScheduledTask,
  ScheduledRun,
  ScheduledEventPayload,
  InboundEventPayload,
  ConvListChangedPayload,
  ProjectStats,
  ChannelConfig,
} from '../../shared/types';
import { isImageFile, isPreviewableFile } from '../lib/lang';
let settingsRequestEpoch = 0;

/** A delayed list snapshot must not roll back a receipt received while it was loading. */
function retainConversationReadState(incoming: ConversationMeta, previous?: ConversationMeta): ConversationMeta {
  if (!previous || previous.projectPath !== incoming.projectPath
    || (previous.activityRevision === undefined && incoming.activityRevision === undefined)) return incoming;
  return { ...incoming, ...mergeConversationReadState(previous, {
    activityRevision: incoming.activityRevision ?? 0, readRevision: incoming.readRevision ?? 0,
    unread: !!incoming.unread, lastReplyId: incoming.lastReplyId,
  }) };
}


/**
 * 单个对话的输入框草稿（未发送内容）。
 * 存在 store 里而非 ChatView 局部 state，这样切 tab / 切对话回来不会丢。
 */
export interface ConversationDraft {
  /** 输入框文字。 */
  text: string;
  /** 已粘贴 / 拖入但尚未发送的图片。 */
  images: ImageAttachment[];
  /** 超长粘贴文本：在输入框中以可移除卡片暂存。 */
  pastedTexts?: Array<{ id: string; text: string }>;
  /** 执行模式（智能体 / 专家团），仅对首条消息生效。 */
  mode?: ConversationMode;
}

interface OpenFile {
  source?: 'project' | 'virtual';
  readOnly?: boolean;
  relPath: string;
  content: string;
  originalContent: string;
  binary: boolean;
  size: number;
  truncated?: boolean;
  saving?: boolean;
  error?: string;
  /**
   * Markdown 文件的视图：'source' 显示带 Prism 高亮的源码编辑器，
   * 'preview' 渲染成 markdown 只读视图。非 markdown 文件忽略此字段。
   * 初值来自 settings.markdownDefaultView，用户可在 FileEditor 顶部切换。
   * 跟着 tab 走，关掉再开按设置重置。
   */
  view?: 'preview' | 'source';
  /** 图片文件的 base64 data URL（如 data:image/png;base64,...），仅图片文件有此字段。 */
  imageData?: string;
  /**
   * 打开后滚动到的行号（1 起）。内容搜索点击结果时设置，
   * FileEditor 消费后清除（一次性）。undefined = 不跳转。
   */
  scrollToLine?: number;
  /**
   * 配合 scrollToLine 使用：要在目标行内高亮的搜索词。
   * FileEditor 会在该行内定位搜索词并只选中匹配片段（而非整行）。
   */
  scrollToQuery?: string;
  /** 文件最后修改时间（ISO 字符串），来自后端 readFile；保存成功后刷新。 */
  mtime?: string;
}

interface OpenTerminal {
  id: string;        // PTY id from backend
  title: string;     // "Terminal 1", "Terminal 2", etc.
  cwd: string;
  exited?: boolean;
  exitCode?: number;
}

/**
 * 统一 Tab 模型 — 把所有"主内容"都视为 tab（file / terminal / conversation / spec）。
 * 
 * 设计目标：
 * - 一个 tab = 一个"主内容区"
 * - sidebar 点击 = 打开/激活对应类型的 tab
 * - FileTabs 渲染所有类型的 tab
 * - 关闭 tab = 切换回上一个视图
 * 
 * 去重规则：
 * - file: 同一个 relPath 只开一个 tab（已有）
 * - terminal: 每个终端独立（已有）
 * - conversation: 同一个 convId 只开一个 tab（新）
 * - spec: 同一个 specId 只开一个 tab（新）
 * 
 * 数据承载：
 * - file / terminal: 数据直接嵌入 tab.data
 * - conversation / spec: tab 只存 ID，数据从 conversations[] / specs[] 读
 *   （避免数据冗余，conversation/spec 更新时只需更新对应数组）
 */
/** 请求监控展示方式：right=右栏右边（dock，现状）；bottom=右栏下面（底栏）；float=完全浮动窗口 */
export type MonitorLayout = 'right' | 'bottom' | 'float';

/** Append new tabs without moving existing tabs; reuse retains the original order. */
export function appendTab(tabs: OpenTab[], tab: OpenTab, _sourceTabId?: string): OpenTab[] {
  return tabs.some(existing => existing.id === tab.id) ? tabs : [...tabs, tab];
}

type OpenTab =
  | { kind: 'plugin'; id: string; data: {plugin:string;contribution:string;title:string;dirty?:boolean}; pinned?: boolean }
  | { kind: 'file'; id: string; data: OpenFile; pinned?: boolean }
  | { kind: 'terminal'; id: string; data: OpenTerminal; pinned?: boolean }
  | { kind: 'conversation'; id: string; convId: string; pinned?: boolean }
  | { kind: 'spec'; id: string; specId: string; pinned?: boolean }
  | { kind: 'scheduled'; id: string; pinned?: boolean }
  | { kind: 'channels'; id: string; pinned?: boolean }
  | { kind: 'browser'; id: string; data: { url?: string; title?: string; favicon?: string; incognito?: boolean }; pinned?: boolean }
  | { kind: 'settings'; id: string; data?: { initialTab?: string; auditProfileId?: string; auditConvId?: string; memoryConvId?: string; navigationId?: number }; pinned?: boolean }
  | { kind: 'steering'; id: string; pinned?: boolean }
  | { kind: 'help'; id: string; pinned?: boolean }
  | { kind: 'analytics'; id: string; pinned?: boolean }
  | { kind: 'ctx-audit'; id: string; pinned?: boolean }
  | { kind: 'git-history'; id: string; data: { path?: string; title?: string; ref?: string; refs?: string[]; only?: boolean; selectedSha?: string }; pinned?: boolean }
  | { kind: 'git-commit'; id: string; data: { sha: string; title?: string; path?: string; section?: 'commit'|'changes'|'tree'; file?: string }; pinned?: boolean };

interface SpecBundle {
  meta: SpecMeta;
  docs: { requirements?: string; design?: string; tasks?: string };
}

interface PhaseStream {
  text: string;
  logs: string[];
}

/** Per-module retro analysis tracking. */
interface RetroModule {
  specId: string;
  title: string;
  currentPhase: 'requirements' | 'design' | 'tasks' | 'done';
  streams: Record<'requirements' | 'design' | 'tasks', PhaseStream>;
}

interface ExecutionStream {
  byTask: Record<string, string>;
  log: string[];
}

interface AppState {
  claudeStatus?: ClaudeBridgeStatus;
  settings?: AppSettings;
  /** 设置加载失败原因（非空时设置页显示错误并禁止保存，防默认值覆盖好配置） */
  settingsLoadError: string | null;
  projects: ProjectEntry[];
  currentProject?: ProjectEntry;
  specs: SpecMeta[];
  currentSpec?: SpecBundle;
  phaseStreams: Record<'requirements' | 'design' | 'tasks', PhaseStream>;
  execStream: ExecutionStream;
  busyPhase?: 'requirements' | 'design' | 'tasks' | 'execute';
  errorBanner?: string;
  /** 对话级错误，按 convId 隔离。切换对话时自动切换，互不影响。 */
  convErrors: Record<string, string>;

  /** Analysis mode: 'retro' or 'optimize' when analysis is running. */
  analysisMode?: 'retro' | 'optimize';
  /** Per-module retro streams, keyed by specId. */
  retroModules: Record<string, RetroModule>;
  /** Order in which modules were discovered. */
  retroModuleOrder: string[];
  /** Global log shared across modules (module identification, etc). */
  retroGlobalLog: string[];
  /** When retro analysis started (epoch ms, for timer). */
  retroStartedAt: number | null;
  /** Last time a retro stream event was received (epoch ms, for stall detection). */
  retroLastEventAt: number | null;
  /** Whether Claude is currently being called (LLM thinking, not network stall). */
  retroClaudeCalling: boolean;
  /** Streaming text for optimization report. */
  optimizeStream: PhaseStream;

  /** Project wiki content (markdown). null = not loaded yet, '' = no wiki. */
  wikiContent?: string | null;
  /** Whether wiki generation is in progress. */
  wikiGenerating: boolean;
  /** Streaming text for wiki generation. */
  wikiStream: PhaseStream;
  /** When the current wiki generation started (epoch ms). */
  wikiStartedAt: number | null;
  /** Selected wiki generation depth. */
  wikiDepth: import('../../shared/types').WikiDepth;
  /** Signal for App.tsx to close the wiki detail panel (e.g. after Q&A). */
  pendingCloseWikiDetail: boolean;
  /** Plugin-controlled: whether the wiki detail main view is open. */
  wikiDetailOpen: boolean;
  /** Plugin-controlled: which wiki heading to display in the detail view. */
  wikiDetailHeadingId?: string;
  /** Plugin-controlled: monotonic key to force ProjectWiki re-mount on each click. */
  wikiDetailNavKey: number;

  // ─── Loop Engineering ────────────────────────────────────────────────
  /** Per-iteration streaming text + global log. */
  loopStream: {
    byIteration: Record<number, string>;
    log: string[];
    latestEval?: { iteration: number; passed: boolean; metric?: number; summary: string };
  };
  /** Whether a loop is currently running (for any spec). */
  loopRunning: boolean;
  /** When the current loop started (epoch ms, for timer). */
  loopStartedAt: number | null;
  /** Latest metric value from the running loop. */
  loopLatestMetric?: number;
  /** Total iterations completed so far. */
  loopIterationsCompleted: number;
  /** Metric history for trend visualization. */
  loopMetricHistory: number[];
  /** Plans generated per iteration. */
  loopPlans: Record<number, string>;
  /** Checkpoint state: null when not at checkpoint, otherwise the checkpoint info. */
  loopCheckpoint: null | { iteration: number; metricHistory: number[] };

  conversations: ConversationMeta[];
  currentConversation?: ConversationMeta;
  /**
   * Per-conversation busy state. Key = convId, value = true.
   * 用 Record 而非 Set——Zustand shallow compare 友好，mutation 用 spread 产生新引用触发 re-render。
   * 替代旧的全局 chatBusy: boolean，解除"一个对话流式传输锁死全 UI"的问题。
   */
  busyConvIds: Record<string, true>;
  /**
   * Per-conversation pending approvals. Key = convId.
   * 切换对话时可立即看到该对话的审批请求；后台对话的审批不会丢失。
   */
  pendingApprovalsByConv: Record<string, PendingApproval[]>;
  /**
   * Per-conversation pending clarifies（AskUser 澄清问题）。Key = convId。
   * 与 pendingApprovalsByConv 同构：后台对话的澄清不会丢失。
   */
  pendingClarifiesByConv: Record<string, ClarifyRequest[]>;

  /** 当前显示的入站 toast（自动消失）。 */
  latestInboundToast: InboundEventPayload | null;

  fileTreeChildren: Record<string, FileEntry[]>;
  expandedDirs: Record<string, boolean>;
  /** 文件树排序方式：name=名称, ctime=创建时间, mtime=修改时间, type=文件类型 */
  fileTreeSortBy: 'name' | 'ctime' | 'mtime' | 'type';
  /** 文件树排序顺序：asc=升序, desc=降序 */
  fileTreeSortOrder: 'asc' | 'desc';
  /** 需要在文件树中定位的文件路径（用于 tab 右键「定位文件」） */
  fileToReveal: string | null;

  /** Per-project steering docs (product / tech / structure markdown). */
  steering: SteeringDocs;

  /** Git remote info for DeepWiki integration. null = detected but no remote. */
  gitRepoInfo?: { owner: string; repo: string; deepwikiUrl: string } | null;
  /** Whether the DeepWiki webview panel is visible in main pane. */
  deepwikiOpen: boolean;

  /** Terminal 编号计数器（用于 Terminal 1, Terminal 2... 命名）。 */
  terminalCounter: number;

  /**
   * 统一 tab 模型 — 把所有"主内容"都视为 tab。
   * 过渡阶段：与 openFiles / openTerminals / currentConversation / currentSpec 共存，
   * 新代码优先使用 openTabs / activeTabId，旧代码逐步迁移。
   */
  openTabs: OpenTab[];
  activeTabId?: string;
  /** 每次 selectConversation / selectSpec 递增，强制 tab 栏重新滚动定位（含重复点击同一项）。 */
  tabScrollTick: number;

  /**
   * 主区域当前显式视图（与对话/spec 统一管控，避免层覆盖）。
   * null 表示没有显式视图，按 currentConversation / currentSpec 回落。
   */
  mainView: 'conv' | 'spec' | 'scheduled' | 'channels' | null;

  // ── Channels (通知渠道) ──
  /** 当前项目的渠道列表。null = 未加载。 */
  projectChannels: ChannelConfig[];
  /** 对话绑定的渠道 id 列表（从后端按需加载）。 */
  convChannelIds: string[];

  // ── 自动更新 ──
  /** 更新状态快照（主进程推送）。 */
  updateStatus: import('../../shared/types').UpdateStatusPayload | null;
  /** 更新弹窗是否打开。 */
  updateDialogOpen: boolean;
  /** 手动检查更新。 */
  checkUpdate: () => Promise<void>;
  /** 下载并安装更新（完成后自动重启）。 */
  installUpdate: (restart?: boolean) => Promise<void>;
  /** 下载中发现更新版本：中止旧下载（删除部分文件）并改下新版本。 */
  switchUpdate: () => Promise<void>;
  cancelUpdate: () => Promise<void>;
  /** 忽略「发现更新版本」提示，继续当前下载。 */
  dismissSuperseded: () => Promise<void>;
  setUpdateDialogOpen: (open: boolean) => void;

  // ── 对话输入框草稿（按对话隔离，切 tab / 切对话不丢失） ──────────────
  /**
   * 每个对话的未发送草稿。
   *
   * 为什么放 store 而不是 ChatView 的 useState：切到文件 / Spec / 其它对话 tab 时
   * ChatView 会被卸载，局部 state 随之销毁；切回来重新挂载就成了空输入框，
   * 用户已经打好的内容（含粘贴的图片）全部丢失。
   *
   * 仅存内存（不落盘）：草稿是临时态，重启应用丢失可接受，也避免把用户
   * 未发送的内容写进对话文件造成意外泄露。
   */
  convDrafts: Record<string, ConversationDraft>;
  /** 写入草稿（浅合并；字段传 undefined 表示不动）。 */
  setConvDraft: (convId: string, patch: Partial<ConversationDraft>) => void;
  /** 清空某个对话的草稿（发送成功后 / 删除对话时调用）。 */
  clearConvDraft: (convId: string) => void;

  // ── Project Stats (持久化累计统计，删除对话/Spec 后不丢失) ──
  /** 当前项目的持久化累计统计。null = 未加载。 */
  projectStats: ProjectStats | null;

  refreshClaude: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>, revision?: string) => Promise<AppSettings>;

  refreshProjectStats: () => Promise<void>;

  refreshSteering: () => Promise<void>;
  saveSteering: (kind: 'product' | 'tech' | 'structure', content: string) => Promise<void>;

  refreshGitInfo: () => Promise<void>;
  toggleDeepwiki: () => void;
  openDeepwikiExternal: () => Promise<void>;
  /** Open the wiki detail main view at a specific heading. */
  openWikiDetail: (headingId: string) => void;
  /** Close the wiki detail main view. */
  closeWikiDetail: () => void;

  createTerminal: () => Promise<void>;
  activateTerminal: (idx: number) => void;
  closeTerminal: (idx?: number) => Promise<void>;
  closeAllTerminals: () => Promise<void>;

  refreshProjects: () => Promise<void>;
  pickProject: () => Promise<void>;
  selectProject: (p: ProjectEntry) => Promise<void>;
  removeProject: (path: string, purgeData?: boolean) => Promise<void>;
  clearAllProjects: (purgeData?: boolean) => Promise<void>;
  /** 设置项目级主模型档案 id（undefined = 跟随全局默认）。 */
  setProjectIcon: (path: string, icon?: string) => Promise<void>;
  setProjectModel: (path: string, modelProfileId?: string) => Promise<void>;
  /** 设置项目级选中的模型（null = 跟随全局默认）。 */
  setProjectSelectedModel: (path: string, selected: import('../../shared/types').SelectedModel | null) => Promise<void>;
  /** 设置项目级选中的视觉模型（null = 跟随全局默认视觉模型）。 */
  setProjectSelectedVisionModel: (path: string, selected: import('../../shared/types').SelectedModel | null) => Promise<void>;
  setProjectSandboxOverrides: (path: string, overrides: import('../../shared/types').SandboxOverrides) => Promise<void>;
  /** 设置项目级启用的插件列表。 */
  setProjectEnabledPlugins: (path: string, enabledPlugins: string[]) => Promise<void>;
  /** Open the given (or current) project in a new window. */
  openProjectInNewWindow: (projectPath?: string) => Promise<void>;

  createSpec: (title: string, description: string) => Promise<SpecMeta | null>;
  selectSpec: (id: string) => Promise<void>;
  deleteSpec: (id: string) => Promise<void>;
  /**
   * Re-read the specs list (and silently refresh the currently-selected
   * spec's meta+docs) from disk. Safe to call mid-stream: phaseStreams /
   * execStream are NOT reset (unlike selectSpec, which is the user-action
   * "I switched to this spec" semantic).
   */
  refreshSpecs: () => Promise<void>;

  generatePhase: (phase: 'requirements' | 'design' | 'tasks', feedback?: string) => Promise<void>;
  approvePhase: (phase: 'requirements' | 'design' | 'tasks') => Promise<void>;
  saveDoc: (phase: 'requirements' | 'design' | 'tasks', content: string) => Promise<void>;
  executeSpec: () => Promise<void>;
  retryTask: (taskId: string) => Promise<void>;
  abortSpec: () => Promise<void>;
  retroAnalyze: (opts?: { scopePath?: string; title?: string }) => Promise<void>;
  optimizeAnalyze: (opts?: { title?: string }) => Promise<void>;
  abortAnalysis: () => Promise<void>;

  loadWiki: () => Promise<void>;
  generateWiki: () => Promise<void>;
  abortWiki: () => Promise<void>;
  deleteWiki: () => Promise<void>;
  setWikiDepth: (depth: import('../../shared/types').WikiDepth) => void;
  /** Create a new conversation seeded with wiki content for Q&A. */
  wikiQnA: () => Promise<void>;

  startLoop: (config: import('../../shared/types').LoopConfig) => Promise<void>;
  stopLoop: () => Promise<void>;
  resumeLoop: (feedback?: string) => Promise<void>;
  exportLoopSkill: () => Promise<void>;

  applyStreamEvent: (e: any) => void;
  setBanner: (msg?: string) => void;
  /** 切换到顶层视图（scheduled / channels / null），同时取消激活的 tab。 */
  setMainView: (view: AppState['mainView']) => void;
  /** 打开定时任务 tab（复用已有则激活，否则新建）。 */
  scheduledCreateRequested: boolean;
  openScheduledTab: (options?: {create?:boolean}) => void;
  /** 打开渠道 tab（复用已有则激活，否则新建）。 */
  openChannelsTab: () => void;
  /** 打开设置 tab（单例）；opts 用于直达指定分类/对话记忆配置 */
  openSettingsTab: (opts?: { initialTab?: string; auditProfileId?: string; auditConvId?: string; memoryConvId?: string }) => void;
  /** 打开单例内容 tab（指导/帮助/详细统计/上下文整理记录）：已存在则激活 */
  openSingletonTab: (kind: 'steering' | 'help' | 'analytics' | 'ctx-audit') => void;
  /** 左下栏按钮式开关：当前激活则关闭（设置未保存走 closeTab 二次确认），否则打开/激活 */
  toggleSingletonTab: (kind: 'settings' | 'scheduled' | 'channels' | 'steering' | 'help' | 'analytics') => void;
  /** 设置 tab 是否存在未保存修改（关闭时二次确认用） */
  settingsDirty: boolean;
  setSettingsDirty: (dirty: boolean) => void;
  /** 请求监控 dock 开合态（左下栏按钮选中态与主区渲染共享） */
  monitorOpen: boolean;
  /** 请求监控展示方式：右栏右边（dock）/ 右栏下面（底栏）/ 完全浮动窗口 */
  monitorLayout: MonitorLayout;
  setMonitorLayout: (layout: MonitorLayout) => void;
  /** 监控全屏放大（脱离所在容器占满窗口）：标题栏双击与 header 按钮共用 */
  monitorFullscreen: boolean;
  setMonitorFullscreen: (open: boolean) => void;
  monitorTarget?: { projectPath: string; convId: string; messageId: string; requestedAt: number };
  openMessageMonitor: (messageId: string) => void;
  setMonitorOpen: (open: boolean) => void;
  /** 侧栏隐藏态（标题栏开关切换，localStorage 持久化） */
  sidebarHidden: boolean;
  setSidebarHidden: (hidden: boolean) => void;
  /** 活动流（倒序）：版本升级提醒、渠道消息事件等，标题栏铃铛 popover 展示 */
  activityItems: ActivityItem[];
  /** 上次打开活动面板的时间戳（未读徽标计算用） */
  activityReadTs: number;
  pushActivity: (item: { kind: ActivityItem['kind']; title: string; detail?: string }) => void;
  markActivityRead: () => void;
  clearActivity: () => void;
  /** 打开浏览器 tab：同 url 去重（激活已有），forceNew 强制新建（duplicate）。 */
  openBrowserTab: (url?: string, opts?: { forceNew?: boolean; incognito?: boolean }) => void;
  /** 更新浏览器 tab 的站点元信息（标题/favicon），由 webview 页面事件回调。 */
  updateBrowserTabMeta: (tabId: string, patch: { title?: string; favicon?: string }) => void;
  /** 设置【项目级】错误横幅（spec/wiki/loop/retro/文件/终端等全局错误）。 */
  setProjectError: (msg?: string) => void;
  /** 设置【对话级】错误横幅（发送失败、渠道绑定失败等，绑定到当前对话）。 */
  setConvError: (msg?: string) => void;

  refreshConversations: () => Promise<void>;
  /** 别的窗口（宠物/另一扇主窗/渠道）新建、删除、归档了对话 → 增量同步本窗口左栏。 */
  syncConvListChanged: (payload: ConvListChangedPayload) => Promise<void>;
  createConversation: () => Promise<ConversationMeta | null>;
  selectConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  forkConversationFromMessage: (messageId: string) => Promise<void>;
  deleteChatMessage: (msgId: string) => Promise<void>;
  /**
   * 重新发送：针对一条失败（带 error）的 assistant 消息，删除它与其对应的
   * 前一条 user 消息，然后用原始内容重新发起一次请求。等价于“删掉最后一轮
   * 再重发”，但一键完成、无需删除整个对话。
   */
  resendChatMessage: (assistantMsgId: string) => Promise<void>;
  /** 从指定消息起截断（删除该消息及其后全部回复），供编辑用户消息回收输入框时使用。 */
  truncateFromMessage: (msgId: string) => Promise<void>;
  /** 从指定用户消息 reload：删除该消息及其后全部回复，再以原内容重发（相当于重新发起提问）。 */
  reloadFromUserMessage: (msgId: string) => Promise<void>;
  sendChat: (text: string, images?: ImageAttachment[], mode?: ConversationMode) => Promise<void>;
  /** Remove a queued (not yet executing) message. Zero cost — never sent to model. */
  removeQueuedMessage: (queueId: string) => Promise<void>;
  /** Reorder queued messages: pass the new queueId order (full list). */
  reorderQueuedMessages: (queueIds: string[]) => Promise<void>;
  /** Resume a paused queue (after error): discard the failed item and continue. */
  resumeQueue: () => Promise<void>;
  /** Retry the last failed queue item and continue the queue. */
  retryQueue: () => Promise<void>;
  /** Clear the queue-stopped banner (when user acknowledges it). */
  clearQueueStopped: () => void;
  /**
   * Abort a conversation. If convId is omitted, aborts the current conversation.
   * Supports aborting background (non-active) conversations.
   */
  abortChat: (convId?: string) => Promise<void>;
  /** 专家团模式：计划确认 / 重新规划（带意见）/ 取消。 */
  expertsConfirmPlan: (action: 'confirm' | 'replan' | 'cancel', feedback?: string) => Promise<void>;
  /** 专家团模式：全量重试失败的专家任务（网络中断等可恢复错误后）。 */
  expertsRetryFailedTasks: () => Promise<void>;
  /** 设置对话级模型档案 id（undefined = 跟随项目/全局）。 */
  setConvModel: (modelProfileId?: string) => Promise<void>;
  /** 设置对话级选中的模型（新架构，null = 跟随项目/全局）。 */
  setConvSelectedModel: (selected: import('../../shared/types').SelectedModel | null) => Promise<void>;
  /** 设置对话级思考强度；low 是默认值。 */
  setConvThinkingEffort: (effort: import('../../shared/types').ThinkingEffort | undefined) => Promise<void>;
  /** 设置对话级上下文压缩策略（null = 沿用全局配置）。 */
  setConvContextStrategy: (
    strategy: import('../../shared/types').ContextStrategyConfig | null,
  ) => Promise<void>;
  /** 设置对话绑定的通知渠道（双向打通：出站+入站）。 */
  setConvChannels: (channelIds: string[]) => Promise<void>;
  setConvInboundChannels: (channelIds: string[]) => Promise<void>;
  setConvOutboundChannels: (channelIds: string[]) => Promise<void>;
  setConvBroadcastUserChannels: (channelIds: string[]) => Promise<void>;
  setConvBroadcastInboundChannels: (channelIds: string[]) => Promise<void>;
  setConvBroadcastAssistantChannels: (channelIds: string[]) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  respondApproval: (requestId: string, decision: 'allow' | 'deny' | 'allow-conv' | 'allow-conv-command') => Promise<void>;
  /** 回答 AskUser 澄清问题（答案回填为 tool_result，对话继续）。 */
  respondClarify: (requestId: string, answer: string) => Promise<void>;
  applyChatEvent: (e: any) => void;

  loadDir: (relPath: string) => Promise<void>;
  toggleDir: (relPath: string) => Promise<void>;
  /**
   * Re-fetch the root + every currently-expanded subdirectory. Used both
   * by the manual refresh button and the post-execute auto-refresh hook
   * (Claude likely created/deleted files during a task).
   */
  refreshFileTree: () => Promise<void>;
  /** 设置文件树排序方式 */
  setFileTreeSort: (sortBy: 'name' | 'ctime' | 'mtime' | 'type', order: 'asc' | 'desc') => void;
  /** 展开所有目录 */
  expandAllDirs: () => Promise<void>;
  /** 折叠所有目录 */
  collapseAllDirs: () => void;
  /** 创建文件夹 */
  createFolder: (relPath: string) => Promise<{ ok: boolean; error?: string }>;
  /** 创建文件 */
  createFile: (relPath: string, content?: string) => Promise<{ ok: boolean; error?: string }>;
  /** 在文件树中定位到指定文件（展开所有父目录 + 滚动到文件） */
  revealFileInTree: (relPath: string) => Promise<void>;
  /** 清除文件定位状态 */
  clearFileToReveal: () => void;
  /** 打开或激活一个文件 tab。已存在则只切到对应 idx，不会重读盘。 */
  openFile: (relPath: string, scrollToLine?: number, scrollToQuery?: string) => Promise<void>;
  /** 切到第 idx 个 tab。越界静默忽略。 */
  activateFile: (idx: number) => void;
  /** 切换当前 active markdown 文件的视图（源码/预览）。非 markdown 文件调用无效。 */
  setFileView: (view: 'preview' | 'source') => void;
  /** 改当前 active 文件内容（编辑器双向绑定）。 */
  setFileContent: (content: string) => void;
  /** 保存当前 active 文件。 */
  saveFile: () => Promise<void>;
  /**
   * 关闭一个 tab。idx 缺省关 active；dirty 时弹 confirm；
   * 关到只剩 0 个 → activeFileIdx 自动 undefined → 自然回落到 spec/conv 视图。
   */
  closeFile: (idx?: number) => void;
  /** 一次性关掉所有 tab；有 dirty 时弹一次 confirm 兜底。 */
  closeAllFiles: () => void;

  // ─── 统一 Tab API (过渡阶段：与旧 API 共存) ──────────────────────────────
  /**
   * 激活一个已存在的 tab。如果 tab 不存在则静默忽略。
   * 过渡阶段会同步更新 activeFileIdx / activeTerminalIdx / currentConversation / currentSpec。
   */
  activateTab: (tabId: string) => void;
  /**
   * 关闭一个 tab。如果是 active tab，自动选择相邻 tab 或回落到 EmptyProject。
   * file tab 有 dirty 内容时弹 confirm。
   * terminal tab 会调用 terminalDispose 销毁 PTY。
   */
  closeTab: (tabId: string) => Promise<void>;
  /** 关闭所有 tab（文件 + 终端）。有 dirty 文件时弹一次 confirm。 */
  closeAllTabs: () => Promise<void>;
  /**
   * 拖拽重排：把 dragTabId 移动到 targetTabId 的位置（浏览器式）。
   * 固定的（pinned）tab 不能拖到非固定区，非固定也不能拖到固定区——
   * 两组各自内部重排。
   */
  moveTab: (dragTabId: string, targetTabId: string) => void;
  /**
   * 固定 / 取消固定 tab。
   * - 固定：pinned = true 并移到最左边（固定区内追加到末尾）
   * - 取消固定：pinned = false 并移到非固定区开头（紧挨固定区之后）
   */
  togglePinTab: (tabId: string) => void;
  searchProjectFiles: (query: string, scope?: string) => Promise<FileEntry[]>;
  /** 项目全局内容搜索（grep），返回按文件分组的匹配行。scope = 限定子目录。 */
  searchFileContents: (query: string, scope?: string) => Promise<ContentSearchResult | null>;
  /** 消费掉当前 active 文件的跳转行号（FileEditor 完成滚动后调用）。 */
  clearFileScrollToLine: () => void;

  // ─── 跨组件搜索联动 ──────────────────────────────────────────────
  /**
   * 待注入 FileTree 搜索框的查询（由 FileEditor 右键菜单触发）。
   * FileTree 监听此值，非 null 时自动填入搜索框并切换到对应模式，
   * 然后清空此值（一次性消费）。
   */
  pendingFileTreeSearch: { query: string; mode: 'name' | 'content' } | null;
  setPendingFileTreeSearch: (search: { query: string; mode: 'name' | 'content' } | null) => void;
  /**
   * 搜索范围限定（文件树目录右键「作为搜索范围」设置）。
   * 非空时文件名搜索与内容搜索都只在该子目录内进行，缩小范围、加快响应。
   * 用户可点搜索框旁的范围标签清除，恢复全项目搜索。
   */
  fileTreeSearchScope: string | null;
  setFileTreeSearchScope: (scope: string | null) => void;

  /**
   * 排队消息执行失败时暂停的状态。非 null 时 MessageQueue 上方会显示
   * 错误横幅，用户可以点「重试」或「跳过（继续队列）」。
   * Key = convId，切换对话时按需恢复（重新拉取 failed 状态）。
   */
  queueStoppedByConv: Record<string, {
    error: string;
    failedQueueId?: string;
    failedText?: string;
    remaining: number;
  }>;

  // ─── Scheduled Tasks (定时任务) ─────────────────────────────────────
  scheduledTasks: ScheduledTask[];
  scheduledRuns: ScheduledRun[];
  scheduledMessageTarget?: {convId:string;messageId:string;nonce:number};
  refreshScheduledTasks: () => Promise<void>;
  refreshScheduledRuns: (taskId?: string) => Promise<void>;
  createScheduledTask: (name: string, prompt: string, schedule: ScheduledTask['schedule']) => Promise<void>;
  updateScheduledTask: (taskId: string, patch: Partial<Pick<ScheduledTask, 'name' | 'prompt' | 'schedule' | 'enabled'>>) => Promise<void>;
  deleteScheduledTask: (taskId: string) => Promise<void>;
  toggleScheduledTask: (taskId: string, enabled: boolean) => Promise<void>;
  runScheduledTaskNow: (taskId: string) => Promise<void>;
  applyScheduledEvent: (e: ScheduledEventPayload) => void;
  applyInboundEvent: (e: InboundEventPayload) => void;
  dismissInboundToast: () => void;
}

let conversationSelection = 0;
let projectSelection = 0;
let directoryReadSequence = 0;
let directoryExpansion = 0;
const directoryReads = new Map<string, number>();
const fileSaves = new Map<string, symbol>();
const loadingConversationEvents = new Map<string, ChatEvent[]>();
const cancelledConversationLoads = new WeakSet<ChatEvent[]>();
const appliedChatSequences = new Map<string, number>();

/** 标题栏活动流条目：版本升级提醒 / 渠道消息事件等汇总通知。 */
export interface ActivityItem {
  id: string;
  ts: number;
  kind: 'update' | 'channel' | 'system';
  title: string;
  detail?: string;
}

const emptyPhaseStream = (): PhaseStream => ({ text: '', logs: [] });
const emptyExec = (): ExecutionStream => ({ byTask: {}, log: [] });

/**
 * Tool names that can mutate the project's working tree. Used by the
 * chat-side auto-refresh in applyChatEvent to know when the file tree
 * sidebar might be stale.
 *
 * Read-only tools (Read / Grep / Glob / WebFetch / TodoWrite / NotebookRead)
 * are intentionally excluded so the sidebar doesn't refetch on every
 * tool result. Bash is included because it's the common escape hatch
 * for git commits, mkdir, mv, rm, etc.
 */
const WRITE_TOOLS = new Set<string>([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
]);

/**
 * 是否支持「源码 / 预览」切换的文件类型（markdown 或 HTML）。
 * 用于 openFile 时决定要不要初始化 view 字段。
 *
 * 不引 lang.ts 是为了让 store 保持只依赖类型，渲染层的 grammar / 色 / label
 * 集中在 src/lib/lang.ts。但预览性判断是纯扩展名匹配，简单重写一份。
 */
function isPreviewablePath(relPath: string): boolean {
  return isPreviewableFile(relPath);
}

/**
 * 持久化 tab 描述（跨重启恢复所有打开的 tab）。
 */
function tabSpecFromTab(tab: OpenTab): { kind: string; key: string } | null {
  switch (tab.kind) {
    case 'conversation': return { kind: 'conversation', key: tab.convId };
    case 'spec': return { kind: 'spec', key: tab.specId };
    case 'file': return { kind: 'file', key: tab.data.relPath };
    case 'terminal': return { kind: 'terminal', key: tab.data.cwd };
    case 'plugin': return {kind:'plugin',key:JSON.stringify({plugin:tab.data.plugin,contribution:tab.data.contribution,title:tab.data.title})};
    case 'browser': return tab.data.incognito ? null : { kind: 'browser', key: tab.data.url || '' };
    case 'git-history': return { kind: 'git-history', key: JSON.stringify(tab.data) };
    case 'git-commit': return { kind: 'git-commit', key: JSON.stringify(tab.data) };
    default: return null;
  }
}

function tabSpecsFromTabs(tabs: OpenTab[], activeTabId?: string): Array<{ kind: string; key: string; active?: boolean }> {
  const specs: Array<{ kind: string; key: string; active?: boolean }> = [];
  for (const t of tabs) {
    const spec = tabSpecFromTab(t);
    if (spec) specs.push({ ...spec, active: t.id === activeTabId });
  }
  return specs;
}

async function restorePersistedTabs(
  specs: Array<{ kind: string; key: string; active?: boolean }>,
  conversations: ConversationMeta[],
  specs_: SpecMeta[],
  projectPath?: string,
): Promise<{ tabs: OpenTab[]; activeTabId?: string }> {
  const restored: OpenTab[] = [];
  let restoredActiveId: string | undefined;
  for (const spec of specs) {
    let tab: OpenTab | null = null;
    if (spec.kind === 'conversation') {
      const conv = conversations.find((c) => c.id === spec.key);
      if (conv) tab = { kind: 'conversation', id: `conv:${conv.id}`, convId: conv.id };
    } else if (spec.kind === 'spec') {
      const s = specs_.find((x) => x.id === spec.key);
      if (s) tab = { kind: 'spec', id: `spec:${s.id}`, specId: s.id };
    } else if (spec.kind === 'file' && projectPath) {
      try {
        const r = (await window.api.readFile(projectPath, spec.key)) as any;
        if (r && r.ok) {
          const mtime = typeof r.mtime === 'string' ? r.mtime : (await window.api.fileStat?.(projectPath, spec.key) as any)?.mtime;
          // 恢复时按设置初始化 view（与 openFile 同口径）——缺失会导致
          // setFileView 的守卫把恢复 tab 当非预览文件，点「预览」无反应。
          const view: 'preview' | 'source' | undefined =
            isPreviewablePath(spec.key) && !r.binary
              ? useAppStore.getState().settings?.markdownDefaultView ?? 'preview'
              : undefined;
          tab = { kind: 'file', id: `file:${spec.key}`, data: { relPath: spec.key, content: r.content, originalContent: r.content, binary: !!r.binary, size: r.size, truncated: !!r.truncated, saving: false, error: undefined, mtime, view } };
        }
      } catch { /* ignore */ }
    } else if (spec.kind === 'terminal' && projectPath) {
      try {
        const r = (await window.api.terminalCreate(spec.key)) as { id: string };
        tab = { kind: 'terminal', id: `terminal:${r.id}`, data: { id: r.id, title: spec.key.split('/').pop() || spec.key, cwd: spec.key } };
      } catch { /* ignore */ }
    } else if (spec.kind === 'plugin') {
      try { const data=JSON.parse(spec.key);if(typeof data.plugin==='string'&&typeof data.contribution==='string'&&typeof data.title==='string')tab={kind:'plugin',id:`plugin:${data.plugin}:${data.contribution}`,data}; } catch {}
    } else if (spec.kind === 'browser') {
      tab = { kind: 'browser', id: `browser:${Date.now()}-${Math.random()}`, data: { url: spec.key, title: spec.key || 'Browser' } };
    } else if (spec.kind === 'git-history') {
      let data: Extract<OpenTab,{kind:'git-history'}>['data'];
      try {data=JSON.parse(spec.key);if(!data||typeof data!=='object')throw Error();}catch{data={path:spec.key,title:spec.key?`历史 · ${spec.key}`:'提交历史'};}
      tab = { kind: 'git-history', id: data.only ? `git-history:${data.path}:${data.refs?.join(' ') ?? data.ref ?? 'all'}:only` : `git-history:${data.path}:all`, data };
    } else if (spec.kind === 'git-commit') {
      let data: Extract<OpenTab,{kind:'git-commit'}>['data'];
      try {data=JSON.parse(spec.key);if(!data||typeof data.sha!=='string')throw Error();}catch{data={sha:spec.key,title:spec.key.slice(0,7)};}
      tab = { kind: 'git-commit', id: `git-commit:${data.path??''}:${data.sha}`, data };
    }
    if (tab) {
      if (spec.active) restoredActiveId = tab.id;
      restored.push(tab);
    }
  }
  return { tabs: restored, activeTabId: restoredActiveId };
}

export function saveTabsToStorage(projectPath: string, tabs: OpenTab[], activeTabId?: string): void {
  try {
    const specs = tabSpecsFromTabs(tabs, activeTabId);
    localStorage.setItem(`sage:tabs:${projectPath}`, JSON.stringify(specs));
  } catch { /* ignore */ }
}

export function loadTabsFromStorage(projectPath: string): Array<{ kind: string; key: string; active?: boolean }> {
  try {
    const raw = localStorage.getItem(`sage:tabs:${projectPath}`);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch { return []; }
}

/**
 * 归档对话 = 完全只读：任何会写历史或触发执行的动作都必须先过这一关。
 * UI 侧已把入口全部隐藏（ChatView 的 archived / readOnly 分支），这里是兜底：
 * 旧标签页、快捷键、归档前残留的队列状态都能绕过按钮直接调到 store。
 */
function rejectArchivedConv(get: () => AppState, cur?: ConversationMeta): boolean {
  if (!cur?.archived) return false;
  get().setConvError(translate('chat.archivedBlocked'));
  return true;
}

async function cleanupClosedConversationTab(tab: OpenTab, projectPath: string | undefined, keep: boolean) {
  if (tab.kind !== 'conversation' || !projectPath || !window.api.closeConversationTab) return;
  try {
    const result = await window.api.closeConversationTab(tab.convId, projectPath, keep);
    if (!result?.ok || !result.deleted) return;
    useAppStore.setState(state => state.currentProject?.path === projectPath ? {
      conversations: state.conversations.filter(conv => conv.id !== tab.convId),
      ...(state.currentConversation?.id === tab.convId ? { currentConversation: undefined } : {}),
    } : {});
    useAppStore.getState().clearConvDraft(tab.convId);
  } catch (error) { console.warn('[tabs] Empty conversation retained after cleanup failure', error); }
}
function retainClosedConversation(tab: OpenTab, state: AppState): boolean {
  if (tab.kind !== 'conversation') return true;
  const live = state.currentConversation?.id === tab.convId ? state.currentConversation : state.conversations.find(conv => conv.id === tab.convId);
  return !!tab.pinned || !!state.busyConvIds[tab.convId] || !!state.queueStoppedByConv[tab.convId]
    || !!live?.messages?.length || hasConversationDraft(mountedConversationDraft(tab.convId)) || hasConversationDraft(state.convDrafts[tab.convId]);
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  specs: [],
  conversations: [],
  settingsLoadError: null,
  settingsDirty: false,
  monitorOpen: false,
  monitorLayout: (['right', 'bottom', 'float'].includes(localStorage.getItem('monitorLayout') || '')
    ? localStorage.getItem('monitorLayout') : 'right') as MonitorLayout,
  monitorFullscreen: false,
  sidebarHidden: false,
  activityItems: [],
  activityReadTs: 0,
  busyConvIds: {},
  pendingApprovalsByConv: {},
  pendingClarifiesByConv: {},
  latestInboundToast: null,
  fileTreeChildren: {},
  expandedDirs: {},
  fileTreeSortBy: 'name',
  fileTreeSortOrder: 'asc',
  fileToReveal: null,
  steering: {},
  gitRepoInfo: undefined,
  deepwikiOpen: false,
  terminalCounter: 0,
  // 统一 tab 模型
  openTabs: [],
  activeTabId: undefined,
  tabScrollTick: 0,
  scheduledCreateRequested: false,
  mainView: null,
  pendingFileTreeSearch: null,
  fileTreeSearchScope: null,
  queueStoppedByConv: {},
  projectChannels: [],
  convChannelIds: [],
  projectStats: null,
  updateStatus: null,
  updateDialogOpen: false,
  convDrafts: {},
  phaseStreams: {
    requirements: emptyPhaseStream(),
    design: emptyPhaseStream(),
    tasks: emptyPhaseStream(),
  },
  execStream: emptyExec(),
  retroModules: {},
  retroModuleOrder: [],
  retroGlobalLog: [],
  retroStartedAt: null,
  retroLastEventAt: null,
  retroClaudeCalling: false,
  optimizeStream: emptyPhaseStream(),
  wikiContent: null,
  wikiGenerating: false,
  wikiStream: emptyPhaseStream(),
  wikiStartedAt: null,
  wikiDepth: 'fine' as const,
  pendingCloseWikiDetail: false,
  wikiDetailOpen: false,
  wikiDetailHeadingId: undefined,
  wikiDetailNavKey: 0,

  loopStream: { byIteration: {}, log: [] },
  loopRunning: false,
  loopStartedAt: null,
  loopIterationsCompleted: 0,
  loopMetricHistory: [],
  loopPlans: {},
  loopCheckpoint: null,

  scheduledTasks: [],
  scheduledRuns: [],
  convErrors: {},

  refreshClaude: async () => {
    const status = await window.api.claudeStatus();
    set({ claudeStatus: status });
  },

  refreshSettings: async () => {
    const epoch = ++settingsRequestEpoch;
    try {
      const settings = await window.api.getSettings();
      if (epoch === settingsRequestEpoch) set({ settings, settingsLoadError: null });
    } catch (e: any) {
      // 保留旧 settings（若有）；记录错误供设置页门控展示与重试
      if (epoch === settingsRequestEpoch) set({ settingsLoadError: String(e?.message || e) });
    }
  },

  saveSettings: async (patch, revision) => {
    // 前置闸：设置从未成功加载时拒绝保存，避免把默认值当真实配置写回
    if (get().settings === undefined) {
      throw new Error('设置尚未加载成功，已拒绝保存以防覆盖现有配置');
    }
    const { _modelMigrationVersion, _schemaVersion, _revision, _secretPolicy, _integrity, _recovery, ...fields } = patch;
    ++settingsRequestEpoch;
    const s = await window.api.setSettings(fields, revision ?? get().settings?._revision ?? 'legacy');
    ++settingsRequestEpoch;
    set({ settings: s, settingsLoadError: null });
    void window.api.plugins?.('settings-changed',{project:get().currentProject?.path??'',keys:Object.keys(fields)}).catch(()=>{});
    // Credential detection is ancillary; its failure must not report a committed save as failed.
    void get().refreshClaude().catch(() => {});
    return s;
  },

  refreshSteering: async () => {
    const p = get().currentProject;
    if (!p) {
      set({ steering: {} });
      return;
    }
    const docs = (await window.api.getSteering(p.path)) as SteeringDocs;
    set({ steering: docs });
  },

  saveSteering: async (kind, content) => {
    const p = get().currentProject;
    if (!p) return;
    await window.api.setSteering(p.path, kind, content);
    // Re-read to keep the in-memory copy authoritative (handles the
    // "empty content = delete file" semantics in writeSteering).
    await get().refreshSteering();
  },

  refreshProjectStats: async () => {
    const p = get().currentProject;
    if (!p) {
      set({ projectStats: null });
      return;
    }
    const stats = (await window.api.getProjectStats(p.path)) as ProjectStats;
    set({ projectStats: stats });
  },

  refreshGitInfo: async () => {
    const p = get().currentProject;
    if (!p) {
      set({ gitRepoInfo: undefined });
      return;
    }
    const info = await window.api.getGitRepoInfo(p.path);
    set({ gitRepoInfo: info });
  },

  toggleDeepwiki: () => {
    set({ deepwikiOpen: !get().deepwikiOpen });
  },

  openDeepwikiExternal: async () => {
    const info = get().gitRepoInfo;
    if (!info) return;
    const {getTabRenderer}=await import('../plugins');
    if(getTabRenderer('browser',enabledBuiltins(get().settings,get().currentProject)))get().openBrowserTab(info.deepwikiUrl);
    else await window.api.openExternal(info.deepwikiUrl);
  },

  openWikiDetail: (headingId) => {
    set({
      wikiDetailOpen: true,
      wikiDetailHeadingId: headingId,
      wikiDetailNavKey: get().wikiDetailNavKey + 1,
    });
  },

  closeWikiDetail: () => {
    set({ wikiDetailOpen: false, wikiDetailHeadingId: undefined });
  },

  createTerminal: async () => {
    const sourceTabId = get().activeTabId;
    const proj = get().currentProject;
    if (!proj) return;
    try {
      const r = (await window.api.terminalCreate(proj.path)) as { id: string };
      const counter = get().terminalCounter + 1;
      const newTerm: OpenTerminal = { id: r.id, title: `Terminal ${counter}`, cwd: proj.path };
      const tabId = `terminal:${r.id}`;
      const newTab: OpenTab = { kind: 'terminal', id: tabId, data: newTerm };
      set({
        openTabs: appendTab(get().openTabs, newTab, sourceTabId),
        activeTabId: tabId,
        terminalCounter: counter,
      });
    } catch (err: any) {
      console.error('createTerminal failed:', err);
      set({ errorBanner: `终端创建失败: ${err?.message ?? String(err)}` });
    }
  },

  activateTerminal: (idx) => {
    // PR 5: openTerminals 已废弃，idx 参数失效。改为通过 idx 在 openTabs 的 terminal tab 列表中定位。
    const termTabs = get().openTabs.filter((t) => t.kind === 'terminal');
    if (idx < 0 || idx >= termTabs.length) return;
    set({ activeTabId: termTabs[idx].id });
  },

  closeTerminal: async (idxToClose) => {
    const state = get();
    const termTabs = state.openTabs.filter((t) => t.kind === 'terminal');
    let target: Extract<OpenTab, { kind: 'terminal' }>;
    if (idxToClose !== undefined) {
      if (idxToClose < 0 || idxToClose >= termTabs.length) return;
      target = termTabs[idxToClose];
    } else {
      const active = state.openTabs.find((t) => t.id === state.activeTabId);
      if (!active || active.kind !== 'terminal') {
        if (termTabs.length === 0) return;
        target = termTabs[termTabs.length - 1];
      } else {
        target = active;
      }
    }
    // Dispose the PTY
    await window.api.terminalDispose(target.data.id);
    void state.closeTab(target.id);
  },

  closeAllTerminals: async () => {
    const state = get();
    const termTabs = state.openTabs.filter((t) => t.kind === 'terminal');
    await Promise.all(termTabs.map((t) => window.api.terminalDispose(t.data.id)));
    // 移除所有 terminal tab
    const nextTabs = state.openTabs.filter((t) => t.kind !== 'terminal');
    set({
      openTabs: nextTabs,
      activeTabId: state.activeTabId?.startsWith('terminal:') ? undefined : state.activeTabId,
    });
    const _pp4 = get().currentProject?.path;
    if (_pp4) saveTabsToStorage(_pp4, nextTabs, get().activeTabId);
  },

  refreshProjects: async () => {
    const projects = (await window.api.listProjects()) as ProjectEntry[];
    const cur = get().currentProject;
    const refreshed = cur && projects.find((p: ProjectEntry) => p.path === cur.path);
    if (cur && !refreshed) {
      set({ projects, currentProject: undefined, specs: [], currentSpec: undefined, steering: {} });
    } else {
      // Resolve the current selection after the request; include remotely changed project models.
      set({ projects, ...(cur ? { currentProject: refreshed } : {}) });
    }
  },

  pickProject: async () => {
    const entry = await window.api.pickProject();
    if (!entry) return;
    await get().refreshProjects();
    await get().selectProject(entry);
  },

  setProjectIcon: async (path, icon) => {
    const project = await window.api.setProjectIcon(path, icon);
    set(state => ({ projects: state.projects.map(entry => entry.path === path ? { ...entry, ...project } : entry),
      ...(state.currentProject?.path === path ? { currentProject: { ...state.currentProject, ...project } } : {}) }));
  },

  setProjectModel: async (path, modelProfileId) => {
    await window.api.setProjectModel(path, modelProfileId);
    // 本地同步更新 projects 与 currentProject，避免整表刷新。
    const projects = get().projects.map((p) =>
      p.path === path ? { ...p, modelProfileId } : p,
    );
    const cur = get().currentProject;
    set({
      projects,
      currentProject:
        cur && cur.path === path ? { ...cur, modelProfileId } : cur,
    });
  },

  setProjectSelectedModel: async (path, selected) => {
    await window.api.setProjectSelectedModel(path, selected);
    const newSelected = selected ?? undefined;
    const projects = get().projects.map((p) =>
      p.path === path ? { ...p, selectedModel: newSelected } : p,
    );
    const cur = get().currentProject;
    set({
      projects,
      currentProject:
        cur && cur.path === path ? { ...cur, selectedModel: newSelected } : cur,
    });
  },

  setProjectSelectedVisionModel: async (path, selected) => {
    await window.api.setProjectSelectedVisionModel(path, selected);
    const newSelected = selected ?? undefined;
    const projects = get().projects.map((p) =>
      p.path === path ? { ...p, selectedVisionModel: newSelected } : p,
    );
    const cur = get().currentProject;
    set({
      projects,
      currentProject:
        cur && cur.path === path ? { ...cur, selectedVisionModel: newSelected } : cur,
    });
  },

  setProjectSandboxOverrides: async (path, overrides) => {
    await window.api.setProjectSandboxOverrides(path, overrides);
    // 本地同步更新 projects 与 currentProject
    const newOverrides = Object.keys(overrides).length === 0 ? undefined : overrides;
    const projects = get().projects.map((p) =>
      p.path === path ? { ...p, sandboxOverrides: newOverrides } : p,
    );
    const cur = get().currentProject;
    set({
      projects,
      currentProject:
        cur && cur.path === path ? { ...cur, sandboxOverrides: newOverrides } : cur,
    });
  },

  setProjectEnabledPlugins: async (path, enabledPlugins) => {
    // 调用后端持久化到 projects.json
    await window.api.setProjectEnabledPlugins?.(path, enabledPlugins);
    // 本地同步更新 projects 与 currentProject
    const projects = get().projects.map((p) =>
      p.path === path ? { ...p, enabledPlugins } : p,
    );
    const cur = get().currentProject;
    set({
      projects,
      currentProject:
        cur && cur.path === path ? { ...cur, enabledPlugins } : cur,
    });
  },

  selectProject: async (p) => {
    const selection = ++projectSelection;
    directoryReads.clear();
    // Abort wiki generation for the old project so the aborter is cleaned up.
    // Without this, switching back to the same project would hit "already running".
    if (get().wikiGenerating) {
      const oldProj = get().currentProject;
      if (oldProj) {
        void window.api.abortAnalysis(`wiki:${oldProj.path}`);
      }
    }
    // Abort all busy conversations belonging to the old project before switching.
    // 这避免后台对话继续消耗资源，且 finally 块不会意外覆盖新项目的 UI 状态。
    const oldTermTabs = get().openTabs.filter((t): t is Extract<OpenTab, { kind: 'terminal' }> => t.kind === 'terminal');
    const oldBusy = get().busyConvIds;
    const oldConvs = get().conversations;
    const busyIds = Object.keys(oldBusy);
    if (busyIds.length > 0) {
      // Only abort conversations belonging to the current (old) project.
      // All conversations in the list are from the current project.
      const toAbort = busyIds.filter((id) => oldConvs.some((c) => c.id === id));
      await Promise.all(toAbort.map((id) => window.api.abortConv(id, 'project-switch')));
    }
    if (selection !== projectSelection) return;
    set({
      currentProject: p,
      sidebarHidden: readSidebarLayout(p.path).hidden,
      currentSpec: undefined,
      currentConversation: undefined,
      busyConvIds: {},
      pendingApprovalsByConv: {},
      pendingClarifiesByConv: {},
      // 切项目时清掉所有打开的 tab——它们是项目相对路径，新项目里也许根本不存在。
      openTabs: [],
      activeTabId: undefined,
      fileTreeChildren: {},
      expandedDirs: { '': true },
      // Clear steering up-front so a stale doc from the previous project
      // doesn't flash in the editor while we're loading the new one.
      steering: {},
      gitRepoInfo: undefined,
      deepwikiOpen: false,
      wikiContent: null,
      wikiGenerating: false,
      wikiStream: emptyPhaseStream(),
      wikiStartedAt: null,
      pendingCloseWikiDetail: false,
      wikiDetailOpen: false,
      wikiDetailHeadingId: undefined,
      wikiDetailNavKey: 0,
      terminalCounter: 0,
      // 清空定时任务缓存，避免新项目显示旧项目的任务/运行历史。
      scheduledTasks: [],
      scheduledRuns: [],
      scheduledCreateRequested: false,
      mainView: null,
      // Clear stats — will be reloaded below.
      projectStats: null,
    });
    // Dispose old terminal PTYs when switching project.
    for (const t of oldTermTabs) {
      void window.api.terminalDispose(t.data.id);
    }
    let workspace;
    try { workspace = await Promise.all([
      window.api.listSpecs(p.path) as Promise<SpecMeta[]>,
      window.api.listConvs(p.path) as Promise<ConversationMeta[]>,
      window.api.listFiles(p.path, '') as Promise<{ ok: boolean; entries?: FileEntry[]; error?: string }>,
      window.api.getSteering(p.path) as Promise<SteeringDocs>,
    ]); } catch (error) {
      if (selection === projectSelection) set({errorBanner: (error as Error).message || translate('ft.readFailed')});
      return;
    }
    if (selection !== projectSelection || get().currentProject?.path !== p.path) return;
    const [specs, conversations, rootList, steering] = workspace;
    set({
      specs,
      // store 保留全部对话（含归档）：归档对话也可从设置页打开为 tab，
      // 其标题解析 / 恢复需要在此列表中；左栏清单由渲染侧过滤归档项
      conversations,
      fileTreeChildren: rootList?.ok && rootList.entries ? { '': rootList.entries } : {},
      steering,
    });
    // 加载定时任务列表（fire-and-forget，不阻塞 UI 就绪）
    void get().refreshScheduledTasks();
    void get().refreshScheduledRuns().catch(() => {});
    // Fire-and-forget: git remote detection runs in parallel with the UI
    // being ready; result populates the Wiki tab in the sidebar.
    void get().refreshGitInfo();
    // Restore persisted wiki if it exists on disk.
    void get().loadWiki();
    // Load persistent accumulated stats (survives conversation/spec deletions).
    void get().refreshProjectStats();
    // Track most-recently-used project so Dock-activate restores it.
    void window.api.touchProject(p.path);
    // 恢复上一个项目的 tabs（异步，不阻塞 UI）
    void (async () => {
      const savedSpecs = loadTabsFromStorage(p.path);
      if (savedSpecs.length > 0) {
        const state = get();
        const { tabs: restoredTabs, activeTabId: restoredActiveId } = await restorePersistedTabs(savedSpecs, state.conversations, state.specs, p.path);
        // Restoration can finish after the user switches projects or opens a tab.
        // Do not replace that newer selection with an old workspace snapshot.
        if (selection !== projectSelection || get().currentProject?.path !== p.path || get().openTabs.length > 0) return;
        if (restoredTabs.length > 0) {
          const activeId = restoredActiveId ?? restoredTabs[0].id;
          set({ openTabs: restoredTabs });
          // Use the normal activation path to hydrate conversation/spec state too.
          get().activateTab(activeId);
        }
      }
    })();
  },

  removeProject: async (path, purgeData) => {
    await window.api.removeProject(path, purgeData);
    if (get().currentProject?.path === path) {
      projectSelection++; directoryReads.clear();
      // Dispose terminals belonging to this project
      const termTabs = get().openTabs.filter((t): t is Extract<OpenTab, { kind: 'terminal' }> => t.kind === 'terminal');
      for (const t of termTabs) void window.api.terminalDispose(t.data.id);
      set({
        currentProject: undefined,
        specs: [],
        conversations: [],
        currentSpec: undefined,
        currentConversation: undefined,
        openTabs: [],
        activeTabId: undefined,
        fileTreeChildren: {},
        expandedDirs: {},
        steering: {},
        gitRepoInfo: undefined,
        deepwikiOpen: false,
        terminalCounter: 0,
      });
    }
    await get().refreshProjects();
  },

  clearAllProjects: async (purgeData) => {
    projectSelection++; directoryReads.clear();
    // Dispose all terminals
    const termTabs = get().openTabs.filter((t): t is Extract<OpenTab, { kind: 'terminal' }> => t.kind === 'terminal');
    for (const t of termTabs) void window.api.terminalDispose(t.data.id);
    const all = get().projects;
    for (const p of all) {
      await window.api.removeProject(p.path, purgeData);
    }
    set({
      currentProject: undefined,
      specs: [],
      conversations: [],
      currentSpec: undefined,
      currentConversation: undefined,
      openTabs: [],
      activeTabId: undefined,
      fileTreeChildren: {},
      expandedDirs: {},
      steering: {},
      gitRepoInfo: undefined,
      deepwikiOpen: false,
      terminalCounter: 0,
    });
    await get().refreshProjects();
  },

  openProjectInNewWindow: async (projectPath?) => {
    const p = projectPath ?? get().currentProject?.path;
    if (!p) return;
    await window.api.openNewWindow(p);
  },

  createSpec: async (title, description) => {
    const proj = get().currentProject;
    if (!proj || !enabledBuiltins(get().settings,proj).includes('specs')) return null;
    const meta = await window.api.createSpec(proj.path, title, description);
    set({ specs: [meta, ...get().specs] });
    // Backend incremented totalSpecsCreated; refresh the persisted stats.
    void get().refreshProjectStats();
    await get().selectSpec(meta.id);
    return meta;
  },

  selectSpec: async (id) => {
    const sourceTabId = get().activeTabId;
    const r = await window.api.getSpec(id);
    if (!r.meta) return;
    // 同步到 openTabs：与主状态合并为一次 set，
    // 保证 FileTabs 的滚动定位 effect 能拿到已渲染的 tab。
    const tabId = `spec:${id}`;
    const existingTab = get().openTabs.find((t) => t.id === tabId);
    set({
      currentSpec: { meta: r.meta, docs: r.docs },
      currentConversation: undefined,
      mainView: 'spec',
      phaseStreams: {
        requirements: emptyPhaseStream(),
        design: emptyPhaseStream(),
        tasks: emptyPhaseStream(),
      },
      execStream: emptyExec(),
      loopStream: { byIteration: {}, log: [] },
      loopLatestMetric: undefined,
      loopIterationsCompleted: 0,
      loopMetricHistory: [],
      loopPlans: {},
      loopCheckpoint: null,
      openTabs: existingTab
        ? get().openTabs
        : appendTab(get().openTabs, { kind: 'spec', id: tabId, specId: id } as OpenTab, sourceTabId),
      activeTabId: tabId,
      tabScrollTick: get().tabScrollTick + 1,
    });
  },

  deleteSpec: async (id) => {
    await window.api.deleteSpec(id);
    const proj = get().currentProject;
    if (proj) {
      const specs = await window.api.listSpecs(proj.path);
      set({ specs });
    }
    if (get().currentSpec?.meta.id === id) {
      set({ currentSpec: undefined });
    }
    // Stats file on disk is unchanged for spec deletion (no usage tracked),
    // but refresh for consistency (totalSpecsCreated counter was updated).
    void get().refreshProjectStats();
  },

  refreshSpecs: async () => {
    const proj = get().currentProject;
    if (!proj) return;
    const [specs, curId] = [
      (await window.api.listSpecs(proj.path)) as SpecMeta[],
      get().currentSpec?.meta.id,
    ];
    set({ specs });
    // Silently refresh the currently-opened spec's meta + docs so the
    // SpecOverview / PhasePanel reflect any out-of-band edits (manual
    // tasks.md tweak, file replaced from disk, etc.) — but preserve
    // phaseStreams / execStream so mid-stream refreshes don't wipe the
    // live output panel.
    if (curId && specs.find((s) => s.id === curId)) {
      const r = await window.api.getSpec(curId);
      if (r.meta) {
        set({ currentSpec: { meta: r.meta, docs: r.docs } });
      }
    }
  },

  generatePhase: async (phase, feedback) => {
    const cur = get().currentSpec;
    if (!cur) return;
    set({
      busyPhase: phase,
      phaseStreams: {
        ...get().phaseStreams,
        [phase]: emptyPhaseStream(),
      },
    });
    const lang = resolveLanguage(get().settings?.language,get().settings?._systemLocale);
    const r = await window.api.generatePhase(cur.meta.id, phase, feedback, lang);
    set({ busyPhase: undefined });
    if (!r.ok) set({ errorBanner: r.error ?? 'generation failed' });
    // refresh from disk
    await get().selectSpec(cur.meta.id);
  },

  approvePhase: async (phase) => {
    const cur = get().currentSpec;
    if (!cur) return;
    await window.api.approvePhase(cur.meta.id, phase);
    await get().selectSpec(cur.meta.id);
  },

  saveDoc: async (phase, content) => {
    const cur = get().currentSpec;
    if (!cur) return;
    await window.api.updateDoc(cur.meta.id, phase, content);
    await get().selectSpec(cur.meta.id);
  },

  executeSpec: async () => {
    const cur = get().currentSpec;
    if (!cur) return;
    set({ busyPhase: 'execute', execStream: emptyExec() });
    const lang = resolveLanguage(get().settings?.language,get().settings?._systemLocale);
    const r = await window.api.executeSpec(cur.meta.id, lang);
    set({ busyPhase: undefined });
    if (!r.ok && (r as any).error) set({ errorBanner: (r as any).error });
    await get().selectSpec(cur.meta.id);
  },

  retryTask: async (taskId) => {
    const cur = get().currentSpec;
    if (!cur) return;
    set({ busyPhase: 'execute' });
    // Clear only this task's stream output
    const exec = get().execStream;
    set({
      execStream: {
        ...exec,
        byTask: { ...exec.byTask, [taskId]: '' },
        log: [...exec.log, `▶ retrying ${taskId}`],
      },
    });
    const lang = resolveLanguage(get().settings?.language,get().settings?._systemLocale);
    const r = await window.api.retryTask(cur.meta.id, taskId, lang);
    set({ busyPhase: undefined });
    if (!r.ok && (r as any).error) set({ errorBanner: (r as any).error });
    await get().selectSpec(cur.meta.id);
  },

  abortSpec: async () => {
    const cur = get().currentSpec;
    if (!cur) return;
    await window.api.abortSpec(cur.meta.id);
    set({ busyPhase: undefined });
    // Refresh spec meta so task statuses don't stay stuck at 'running'
    await get().refreshSpecs();
  },

  retroAnalyze: async (opts) => {
    const proj = get().currentProject;
    if (!proj) return;
    set({
      analysisMode: 'retro',
      retroModules: {},
      retroModuleOrder: [],
      retroGlobalLog: [],
      retroStartedAt: Date.now(),
      retroLastEventAt: Date.now(),
      retroClaudeCalling: false,
    });
    const lang = (get().settings?.language as string) ?? 'zh';
    const r = await window.api.retroAnalyze(proj.path, opts?.scopePath, opts?.title, lang);
    set({ analysisMode: undefined, retroStartedAt: null, retroLastEventAt: null, retroClaudeCalling: false });
    if (!r.ok && r.error) set({ errorBanner: r.error });
    if (r.ok && r.specIds && r.specIds.length > 0) {
      await get().refreshSpecs();
      // Select the first created spec
      await get().selectSpec(r.specIds[0]);
    } else if (r.ok && r.specId) {
      await get().refreshSpecs();
      await get().selectSpec(r.specId);
    }
  },

  optimizeAnalyze: async (opts) => {
    const proj = get().currentProject;
    if (!proj) return;
    set({
      analysisMode: 'optimize',
      optimizeStream: emptyPhaseStream(),
    });
    const lang = (get().settings?.language as string) ?? 'zh';
    const r = await window.api.optimizeAnalyze(proj.path, opts?.title, lang);
    set({ analysisMode: undefined, retroStartedAt: null, retroLastEventAt: null });
    if (!r.ok && r.error) set({ errorBanner: r.error });
    if (r.ok && r.specId) {
      await get().refreshSpecs();
      await get().selectSpec(r.specId);
    }
  },

  abortAnalysis: async () => {
    const proj = get().currentProject;
    const mode = get().analysisMode;
    if (!proj || !mode) return;
    const key = `${mode}:${proj.path}`;
    await window.api.abortAnalysis(key);
    set({ analysisMode: undefined, retroStartedAt: null, retroLastEventAt: null, retroClaudeCalling: false });
  },

  loadWiki: async () => {
    const proj = get().currentProject;
    if (!proj) return;
    const r = await window.api.wikiLoad(proj.path);
    set({ wikiContent: r.ok ? (r.content ?? '') : null });
  },

  generateWiki: async () => {
    if (get().wikiGenerating) return;           // ← prevent double-click
    const proj = get().currentProject;
    if (!proj) return;
    const lang = (get().settings?.language as string) ?? 'zh';
    const depth = get().wikiDepth;
    set({
      wikiGenerating: true,
      wikiStream: emptyPhaseStream(),
      wikiStartedAt: Date.now(),
    });
    try {
      const r = await window.api.wikiGenerate(proj.path, lang, depth);
      if (!r.ok && r.error) {
        set({ errorBanner: r.error, wikiGenerating: false, wikiStartedAt: null });
        return;
      }
      if (r.ok) {
        await get().loadWiki();                // load content FIRST
        set({ wikiGenerating: false, wikiStartedAt: null }); // THEN flip flag — no flash
      }
    } catch (err: any) {
      // IPC call itself failed (process crash, etc.) — recover gracefully
      console.error('[generateWiki] IPC error:', err);
      set({ errorBanner: `Wiki generation failed: ${err?.message ?? err}`, wikiGenerating: false, wikiStartedAt: null });
    }
  },

  abortWiki: async () => {
    const proj = get().currentProject;
    if (!proj) return;
    await window.api.abortAnalysis(`wiki:${proj.path}`);
    set({ wikiGenerating: false, wikiStartedAt: null });
  },

  deleteWiki: async () => {
    const proj = get().currentProject;
    if (!proj) return;
    await window.api.wikiDelete(proj.path);
    set({ wikiContent: '' });
  },

  setWikiDepth: (depth) => {
    set({ wikiDepth: depth });
  },

  wikiQnA: async () => {
    const wiki = get().wikiContent;
    if (!wiki) return;
    // Create a new conversation seeded with wiki content
    const meta = await get().createConversation();
    if (!meta) return;
    const seed = `以下是项目 Wiki 文档，请将其作为上下文来回答我的问题：\n\n---\n${wiki}\n---\n\n接下来我会针对这个项目提问。`;
    await get().sendChat(seed);
    // Signal App.tsx to close the wiki detail panel so the chat is visible
    set({ pendingCloseWikiDetail: true });
  },

  startLoop: async (config) => {
    const cur = get().currentSpec;
    if (!cur) return;
    const lang = resolveLanguage(get().settings?.language,get().settings?._systemLocale);
    set({
      loopRunning: true,
      loopStartedAt: Date.now(),
      loopStream: { byIteration: {}, log: [] },
      loopIterationsCompleted: 0,
      loopLatestMetric: undefined,
      loopMetricHistory: [],
      loopPlans: {},
      loopCheckpoint: null,
    });
    const r = await window.api.loopStart(cur.meta.id, config, lang);
    set({ loopRunning: false, loopStartedAt: null });
    if (!r.ok) set({ errorBanner: r.error ?? 'Loop failed' });
    await get().refreshSpecs();
  },

  stopLoop: async () => {
    const cur = get().currentSpec;
    if (!cur) return;
    await window.api.loopStop(cur.meta.id);
    set({ loopRunning: false, loopStartedAt: null, loopCheckpoint: null });
    await get().refreshSpecs();
  },

  resumeLoop: async (feedback) => {
    const cur = get().currentSpec;
    if (!cur) return;
    set({ loopCheckpoint: null });
    await window.api.loopResume(cur.meta.id, feedback);
  },

  exportLoopSkill: async () => {
    const cur = get().currentSpec;
    if (!cur) return;
    const r = await window.api.loopExportSkill(cur.meta.id);
    if (r.ok) {
      set({ errorBanner: undefined });
    } else {
      set({ errorBanner: r.error ?? 'Export failed' });
    }
  },

  applyStreamEvent: (e) => {
    // ── Retro analysis streaming (multi-module) ──
    if (typeof e.channel === 'string' && e.channel.startsWith('retro-')) {
      // Track last event time for stall detection
      const now = Date.now();
      const phase = e.channel.replace('retro-', '') as 'requirements' | 'design' | 'tasks' | 'complete';

      // Global log messages (module identification etc.) — use specId from event
      if (e.type === 'log') {
        const msg = e.payload.msg;
        // Detect "calling Claude" / "Claude responded" messages to track LLM state
        let claudeCalling = get().retroClaudeCalling;
        if (msg.includes('调用 Claude 中') || msg.includes('Calling Claude')) {
          claudeCalling = true;
        } else if (msg.includes('Claude 已响应') || msg.includes('Claude responded')) {
          claudeCalling = false;
        }
        set({
          retroGlobalLog: appendStreamLog(get().retroGlobalLog, msg),
          retroLastEventAt: now,
          retroClaudeCalling: claudeCalling,
        });
        return;
      }

      // Error
      if (e.type === 'error') {
        set({ errorBanner: e.payload.error, analysisMode: undefined, retroStartedAt: null, retroLastEventAt: null, retroClaudeCalling: false });
        return;
      }

      // phase_done with special phases
      if (e.type === 'phase_done') {
        if (e.payload?.phase === 'complete') {
          // All modules done
          set({ analysisMode: undefined, retroStartedAt: null, retroLastEventAt: null, retroClaudeCalling: false });
          return;
        }
        if (e.payload?.phase === 'spec_created') {
          // A new spec became visible — refresh specs list immediately
          const specId = e.payload.specId ?? e.specId;
          set({ retroLastEventAt: now });
          void get().refreshSpecs().then(() => {
            // Update module title from refreshed specs list
            const state = get();
            const mod = state.retroModules[specId];
            const spec = state.specs.find((s) => s.id === specId);
            if (mod && spec && mod.title === mod.specId) {
              const updated = { ...state.retroModules, [specId]: { ...mod, title: spec.title } };
              set({ retroModules: updated });
            }
          });
          return;
        }
      }

      // Per-module streaming — need a valid specId
      const specId = e.specId;
      if (!specId || specId.startsWith('retro:')) {
        // Pre-module events (before first spec is created) — ignore text/phase_done
        return;
      }

      if (phase !== 'requirements' && phase !== 'design' && phase !== 'tasks') return;

      const modules = { ...get().retroModules };
      const order = [...get().retroModuleOrder];

      // Create module entry if it doesn't exist
      if (!modules[specId]) {
        // Prefer title from payload (sent by spec-engine), fall back to specs list
        const spec = get().specs.find((s) => s.id === specId);
        modules[specId] = {
          specId,
          title: e.payload?.title ?? spec?.title ?? specId,
          currentPhase: phase,
          streams: {
            requirements: emptyPhaseStream(),
            design: emptyPhaseStream(),
            tasks: emptyPhaseStream(),
          },
        };
        if (!order.includes(specId)) order.push(specId);
      }

      const mod = { ...modules[specId] };
      const modStreams = { ...mod.streams };
      const phaseStream = { ...modStreams[phase] };

      if (e.type === 'text') {
        phaseStream.text = appendStreamText(phaseStream.text, e.payload.chunk);
        // Text received → Claude is responding, clear the "calling" state
        set({ retroClaudeCalling: false });
      } else if (e.type === 'phase_done') {
        if (e.payload?.start) {
          mod.currentPhase = phase;
        } else {
          // Phase done — advance to next
          const nextPhase: Record<string, 'design' | 'tasks' | 'done'> = {
            requirements: 'design',
            design: 'tasks',
            tasks: 'done',
          };
          mod.currentPhase = nextPhase[phase] ?? 'done';
        }
      }

      modStreams[phase] = phaseStream;
      mod.streams = modStreams;
      modules[specId] = mod;

      for (const old of order.splice(0, Math.max(0, order.length - 32))) delete modules[old];
      set({ retroModules: modules, retroModuleOrder: order, retroLastEventAt: now });
      return;
    }

    // ── Optimize analysis streaming ──
    if (e.channel === 'optimize') {
      const next = { ...get().optimizeStream };
      if (e.type === 'text') next.text = appendStreamText(next.text, e.payload.chunk);
      else if (e.type === 'log') next.logs = appendStreamLog(next.logs, e.payload.msg);
      else if (e.type === 'phase_done') {
        if (e.payload?.specId) {
          void get().refreshSpecs().then(() => get().selectSpec(e.payload.specId));
        }
        set({ analysisMode: undefined, retroStartedAt: null, optimizeStream: next });
        return;
      } else if (e.type === 'error') {
        set({ errorBanner: e.payload.error, analysisMode: undefined, retroStartedAt: null, retroLastEventAt: null });
        return;
      }
      set({ optimizeStream: next });
      return;
    }

    // ── Wiki generation streaming ──
    if (e.channel === 'wiki') {
      const next = { ...get().wikiStream };
      if (e.type === 'text') next.text = appendStreamText(next.text, e.payload.chunk);
      else if (e.type === 'log') next.logs = appendStreamLog(next.logs, e.payload.msg);
      else if (e.type === 'error') {
        set({ errorBanner: e.payload.error, wikiGenerating: false, wikiStartedAt: null });
        return;
      }
      set({ wikiStream: next });
      return;
    }

    // ── Loop engineering streaming ──
    if (e.channel === 'loop') {
      const cur = get().currentSpec;
      if (!cur || cur.meta.id !== e.specId) return;
      const next = { ...get().loopStream };

      if (e.type === 'text') {
        const iter = e.payload.iteration;
        next.byIteration = { ...next.byIteration, [iter]: appendStreamText(next.byIteration[iter] ?? '', e.payload.chunk) };
      } else if (e.type === 'loop_iteration_start') {
        next.log = appendStreamLog(next.log, `▶ Iteration ${e.payload.iteration}`);
        set({ loopIterationsCompleted: e.payload.iteration - 1 });
      } else if (e.type === 'loop_iteration_eval') {
        next.latestEval = {
          iteration: e.payload.iteration,
          passed: e.payload.passed,
          metric: e.payload.metric,
          summary: e.payload.summary,
        };
        if (e.payload.metric !== undefined) {
          set({
            loopLatestMetric: e.payload.metric,
            loopMetricHistory: [...get().loopMetricHistory, e.payload.metric],
          });
        }
        next.log = appendStreamLog(next.log, `${e.payload.passed ? '✓' : '✗'} Iteration ${e.payload.iteration}: ${e.payload.summary}`);
      } else if (e.type === 'loop_iteration_done') {
        next.log = appendStreamLog(next.log, `  ↪ ${e.payload.status}`);
        set({ loopIterationsCompleted: e.payload.iteration });
      } else if (e.type === 'loop_plan') {
        set({ loopPlans: { ...get().loopPlans, [e.payload.iteration]: e.payload.plan } });
        next.log = appendStreamLog(next.log, `  📋 Plan generated (${e.payload.plan.length} chars)`);
      } else if (e.type === 'loop_checkpoint') {
        set({ loopCheckpoint: { iteration: e.payload.iteration, metricHistory: e.payload.metricHistory } });
        next.log = appendStreamLog(next.log, `  ⏸ Human checkpoint at iteration ${e.payload.iteration}`);
      } else if (e.type === 'loop_converged') {
        next.log = appendStreamLog(next.log, `★ Converged after ${e.payload.totalIterations} iterations`);
        set({ loopRunning: false, loopStartedAt: null });
      } else if (e.type === 'log') {
        next.log = appendStreamLog(next.log, e.payload.msg);
      } else if (e.type === 'error') {
        set({ errorBanner: e.payload.error, loopRunning: false, loopStartedAt: null, loopCheckpoint: null });
      }
      trimStreamEntries(next.byIteration);
      set({ loopStream: next });
      return;
    }

    // ── Existing spec streaming ──
    const cur = get().currentSpec;
    if (!cur || cur.meta.id !== e.specId) return;
    if (e.channel === 'execute') {
      const next = { ...get().execStream, byTask: { ...get().execStream.byTask } };
      if (e.type === 'task_start') {
        next.log = appendStreamLog(next.log, `▶ ${e.payload.title}`);
        next.byTask[e.payload.taskId] = '';
      } else if (e.type === 'text') {
        const id = e.payload.taskId;
        next.byTask[id] = appendStreamText(next.byTask[id] ?? '', e.payload.chunk);
      } else if (e.type === 'task_done') {
        next.log = appendStreamLog(next.log, `✓ ${e.payload.taskId}`);
        // Auto-refresh after each task: the file tree likely has new /
        // changed files, and the spec list's per-spec updatedAt should
        // bubble up to the sidebar. Fire-and-forget; both refreshes are
        // safe to interleave with continued streaming of the next task.
        void get().refreshSpecs();
        void get().refreshFileTree();
      } else if (e.type === 'task_failed') {
        next.log = appendStreamLog(next.log, `✗ ${e.payload.taskId}: ${e.payload.error}`);
        // Same as task_done: partial file changes may have landed before
        // the failure, and the task status itself just transitioned.
        void get().refreshSpecs();
        void get().refreshFileTree();
      } else if (e.type === 'phase_done') {
        // Whole execute phase finished — final sync.
        void get().refreshSpecs();
        void get().refreshFileTree();
      } else if (e.type === 'log') {
        next.log = appendStreamLog(next.log, e.payload.msg);
      }
      trimStreamEntries(next.byTask);
      set({ execStream: next });
    } else {
      const ph = e.channel as 'requirements' | 'design' | 'tasks';
      const stream = { ...get().phaseStreams[ph] };
      if (e.type === 'text') stream.text = appendStreamText(stream.text, e.payload.chunk);
      else if (e.type === 'log') stream.logs = appendStreamLog(stream.logs, e.payload.msg);
      else if (e.type === 'phase_done') {
        // Spec generation phase wrote requirements/design/tasks.md to
        // disk — refresh the list so the sidebar timestamp updates, and
        // pull the spec's docs back into memory so PhasePanel renders
        // them once streaming text fades out.
        void get().refreshSpecs();
      }
      set({
        phaseStreams: { ...get().phaseStreams, [ph]: stream },
      });
    }
  },

  setBanner: (msg) => set({ errorBanner: msg }),
  setProjectError: (msg) => set({ errorBanner: msg }),
  setConvError: (msg) => {
    const cur = get().currentConversation;
    if (!cur) {
      // 无当前对话时退化为项目级
      set({ errorBanner: msg });
      return;
    }
    const next = { ...get().convErrors };
    if (msg) {
      next[cur.id] = msg;
    } else {
      delete next[cur.id];
    }
    set({ convErrors: next });
  },

  setMainView: (view) => set({ mainView: view }),

  openScheduledTab: (options) => {
    const tabId = 'scheduled';
    const existingTab = get().openTabs.find((t) => t.id === tabId);
    set({
      mainView: 'scheduled',
      scheduledCreateRequested: !!options?.create,
      openTabs: existingTab
        ? get().openTabs
        : appendTab(get().openTabs, { kind: 'scheduled', id: tabId } as OpenTab, get().activeTabId),
      activeTabId: tabId,
      tabScrollTick: get().tabScrollTick + 1,
    });
  },

  openChannelsTab: () => {
    if(get().currentProject)get().openSettingsTab({initialTab:'project-channels'});
  },

  openSettingsTab: (opts) => {
    const tabId = 'settings';
    const existingTab = get().openTabs.find((t) => t.id === tabId);
    set({
      openTabs: existingTab
        ? get().openTabs.map((t) =>
            t.id === tabId && t.kind === 'settings' && opts ? { ...t, data: { ...t.data, ...opts, navigationId: (t.data?.navigationId ?? 0) + 1 } } : t,
          )
        : appendTab(get().openTabs, { kind: 'settings', id: tabId, data: opts ? { ...opts, navigationId: 1 } : undefined } as OpenTab, get().activeTabId),
      activeTabId: tabId,
      tabScrollTick: get().tabScrollTick + 1,
    });
  },

  openSingletonTab: (kind) => {
    const tabId = kind;
    const existingTab = get().openTabs.find((t) => t.id === tabId);
    set({
      openTabs: existingTab
        ? get().openTabs
        : appendTab(get().openTabs, { kind, id: tabId } as OpenTab, get().activeTabId),
      activeTabId: tabId,
      tabScrollTick: get().tabScrollTick + 1,
    });
  },

  toggleSingletonTab: (kind) => {
    const state = get();
    // 再次点击当前激活的按钮 = 关闭（设置未保存时由 closeTab 二次确认）
    if (state.activeTabId === kind && state.openTabs.some((t) => t.id === kind)) {
      void state.closeTab(kind);
      return;
    }
    if (kind === 'settings') {
      state.openSettingsTab();
      return;
    }
    if (kind === 'scheduled') {
      state.openScheduledTab();
      return;
    }
    if (kind === 'channels') {
      state.openChannelsTab();
      return;
    }
    state.openSingletonTab(kind);
  },

  setSettingsDirty: (dirty) => {
    if (get().settingsDirty === dirty) return;
    set({ settingsDirty: dirty });
  },

  openMessageMonitor: (messageId) => {
    const conv = get().currentConversation;
    if (conv) set({monitorOpen:true,monitorTarget:{projectPath:conv.projectPath,convId:conv.id,messageId,requestedAt:Date.now()}});
  },
  setMonitorOpen: (open) => {
    if (get().monitorOpen === open) return;
    set({ monitorOpen: open, monitorTarget: undefined, monitorFullscreen: false });
  },
  setMonitorLayout: (layout) => {
    localStorage.setItem('monitorLayout', layout);
    // 切换展示方式时退出全屏，避免 fixed 全屏层盖住新容器的控制栏
    set({ monitorLayout: layout, monitorFullscreen: false });
  },
  setMonitorFullscreen: (open) => set({ monitorFullscreen: open }),

  setSidebarHidden: (hidden) => {
    if (get().sidebarHidden === hidden) return;
    try {
      writeSidebarLayout(get().currentProject?.path,{hidden});
    } catch {
      /* 隐私模式等场景忽略持久化失败 */
    }
    set({ sidebarHidden: hidden });
  },

  pushActivity: (item) => {
    const now = Date.now();
    // Repeated status delivery is duplicate; distinct messages from one channel are not.
    if (get().activityItems.some(a=>a.kind===item.kind && a.title===item.title && a.detail===item.detail && now-a.ts<30_000)) return;
    const entry: ActivityItem = {
      id: `act-${now}-${Math.random().toString(36).slice(2, 6)}`,
      ts: now,
      ...item,
    };
    set({ activityItems: [entry, ...get().activityItems].slice(0, 100) });
    window.api.petActivity?.(item);
  },

  markActivityRead: () => set({ activityReadTs: Date.now() }),
  clearActivity: () => set({ activityItems: [], activityReadTs: Date.now() }),

  openBrowserTab: (url, opts) => {
    const raw = url?.trim() || '';
    // 同 url 去重：已有同地址 browser tab 直接激活（与 file/conversation 去重口径一致）；
    // 无痕 tab 不参与去重（独立内存 session，与普通 tab 隔离）；
    // 空白页（about:blank）不去重：允许连续新建多个空白标签页
    if (raw && raw !== 'about:blank' && !opts?.forceNew && !opts?.incognito) {
      const existing = get().openTabs.find((t) => t.kind === 'browser' && (t.data.url || '') === raw);
      if (existing) {
        set({ activeTabId: existing.id, tabScrollTick: get().tabScrollTick + 1 });
        return;
      }
    }
    // 标题取主机名便于 tab 栏阅读；解析失败回退原始输入
    let title = '新标签页';
    if (raw) {
      try {
        title = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname || raw;
      } catch {
        title = raw;
      }
    }
    const tabId = `browser:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    set({
      openTabs: appendTab(get().openTabs, { kind: 'browser', id: tabId, data: { url: raw || undefined, title, incognito: opts?.incognito || undefined } } as OpenTab, get().activeTabId),
      activeTabId: tabId,
      tabScrollTick: get().tabScrollTick + 1,
    });
  },

  updateBrowserTabMeta: (tabId, patch) => {
    const tabs = get().openTabs;
    const target = tabs.find((t) => t.id === tabId);
    if (!target || target.kind !== 'browser') return;
    // 无实际变化时跳过 set，避免页面事件高频触发引起无谓重渲染
    if (
      (patch.title === undefined || patch.title === target.data.title) &&
      (patch.favicon === undefined || patch.favicon === target.data.favicon)
    ) {
      return;
    }
    set({
      openTabs: tabs.map((t) =>
        t.id === tabId && t.kind === 'browser' ? { ...t, data: { ...t.data, ...patch } } : t,
      ),
    });
  },

  // ---------- conversations ----------

  refreshConversations: async () => {
    const proj = get().currentProject;
    if (!proj) return;
    // 保留归档对话（见 selectProject 处注释）；左栏清单由 Sidebar 渲染侧过滤
    const previousArchived = new Map(get().conversations.map(conv => [conv.id, !!conv.archived]));
    const conversations = (await window.api.listConvs(proj.path)) as ConversationMeta[];
    if (get().currentProject?.path !== proj.path) return;
    set((state) => {
      const current = state.currentConversation;
      const refreshed = conversations.find((conv) => conv.id === current?.id);
      const merged = conversations.map(incoming => retainConversationReadState(incoming, state.conversations.find(previous => previous.id === incoming.id)));
      const unread = merged.some(conversation => conversation.projectPath === proj.path && !conversation.archived && !conversation.scheduledExecution && conversation.unread);
      return {
        conversations: merged,
        projects: state.projects.map(project => project.path === proj.path ? { ...project, unread } : project),
        ...(state.currentProject?.path === proj.path ? { currentProject: { ...state.currentProject, unread } } : {}),
        // 只同步归档标记，保留当前消息与运行状态，避免磁盘快照覆盖实时内容。
        ...(current && refreshed && !!current.archived !== !!refreshed.archived
          ? { currentConversation: { ...current, archived: !!refreshed.archived } }
          : {}),
      };
    });
    // Close only new archive transitions; manually opened archive records stay viewable.
    for (const conv of conversations) {
      if (!conv.archived || previousArchived.get(conv.id) !== false) continue;
      for (const tab of get().openTabs.filter(tab => tab.kind === 'conversation' && tab.convId === conv.id)) {
        await get().closeTab(tab.id);
      }
    }

  },

  // 只做增量、不整表重拉：重拉读到的是磁盘快照，本窗口正有对话在流式输出时
  // 会把那条对话的消息短暂回退（聊天页“文字突然少一截”）。见 shared/conv-list-sync.ts。
  syncConvListChanged: async (p) => {
    if (p.reason === 'read-state' && p.convId && p.readState) {
      const receipt = p.readState;
      set(state => {
        const current = state.currentConversation;
        const conversations = state.conversations.map(conversation => conversation.id === p.convId && conversation.projectPath === p.projectPath
          ? { ...conversation, ...mergeConversationReadState(conversation, receipt) } : conversation);
        const knownProject = state.currentProject?.path === p.projectPath
          && conversations.some(conversation => conversation.id === p.convId && conversation.projectPath === p.projectPath);
        // Derive the current project's dot from merged counters, even when aggregate events arrive late.
        const projectUnread = knownProject ? conversations.some(conversation => conversation.projectPath === p.projectPath
          && !conversation.archived && !conversation.scheduledExecution && conversation.unread) : p.projectUnread;
        return {
          projects: state.projects.map(project => project.path === p.projectPath ? { ...project, unread: projectUnread ?? project.unread } : project),
          ...(state.currentProject?.path === p.projectPath ? { currentProject: { ...state.currentProject, unread: projectUnread ?? state.currentProject.unread } } : {}),
          conversations,
          ...(current && current.id === p.convId && current.projectPath === p.projectPath ? { currentConversation: { ...current,
            ...mergeConversationReadState(current, receipt) } } : {}),
        };
      });
      return;
    }
    const proj = get().currentProject;
    // 宠物可以往任意项目发对话：不是当前项目就什么都不用做
    if (!proj || proj.path !== p.projectPath) return;
    if (p.reason === 'updated') {
      const refreshed = await window.api.listConvs(proj.path) as ConversationMeta[];
      if (get().currentProject?.path !== proj.path) return;
      const current = get().currentConversation;
      const next = current && refreshed.find(c => c.id === current.id);
      set(state => {
        const conversations = refreshed.map(incoming => retainConversationReadState(incoming, state.conversations.find(previous => previous.id === incoming.id)));
        const unread = conversations.some(conversation => conversation.projectPath === proj.path && !conversation.archived && !conversation.scheduledExecution && conversation.unread);
        return { conversations,
          projects: state.projects.map(project => project.path === proj.path ? { ...project, unread } : project),
          ...(state.currentProject?.path === proj.path ? { currentProject: { ...state.currentProject, unread } } : {}),
          ...(next && current ? { currentConversation: { ...current, pinned: next.pinned, title: next.title, selectedModel: next.selectedModel, modelProfileId: next.modelProfileId, securityProfile: next.securityProfile, thinkingEffort: next.thinkingEffort, mode: next.mode } } : {}),
        };
      });
      return;
    }
    if (p.reason === 'deleted' && p.convId) {
      set(state => {
        const conversations = dropConversation(state.conversations, p.convId!);
        const unread = conversations.some(conversation => conversation.projectPath === proj.path && !conversation.archived && !conversation.scheduledExecution && conversation.unread);
        return { conversations,
          projects: state.projects.map(project => project.path === proj.path ? { ...project, unread } : project),
          ...(state.currentProject?.path === proj.path ? { currentProject: { ...state.currentProject, unread } } : {}),
        };
      });
      return;
    }
    if (p.reason === 'archived' && p.convId) {
      set(state => {
        const current = state.currentConversation;
        const conversations = markConversationArchived(state.conversations, p.convId!, !!p.archived);
        const unread = conversations.some(conversation => conversation.projectPath === proj.path && !conversation.archived && !conversation.scheduledExecution && conversation.unread);
        return { conversations,
          projects: state.projects.map(project => project.path === proj.path ? { ...project, unread } : project),
          ...(state.currentProject?.path === proj.path ? { currentProject: { ...state.currentProject, unread } } : {}),
          ...(current && current.id === p.convId ? { currentConversation: { ...current, archived: !!p.archived } } : {}),
        };
      });
      if (p.archived) {
        for (const tab of get().openTabs.filter(tab => tab.kind === 'conversation' && tab.convId === p.convId)) {
          await get().closeTab(tab.id);
        }
      }
      return;
    }
    if (p.reason !== 'created' || !p.convId) return;
    // 本窗口自己建的对话早就在表里（同一窗口不会收到自己触发的广播，这层是防重复推送）
    if (get().conversations.some((c) => c.id === p.convId)) return;
    const meta = (await (window.api.getConv(p.convId) as Promise<ConversationMeta | null>).catch(() => null));
    // 拉取期间用户已切项目：不要把另一个项目的对话插进新项目清单
    if (!meta || get().currentProject?.path !== proj.path) return;
    if (get().conversations.some((c) => c.id === meta.id)) return;
    set({ conversations: mergeConversation(get().conversations, meta) });
  },

  forkConversationFromMessage: async (messageId) => {
    const sourceTabId = get().activeTabId;
    const cur = get().currentConversation;
    const proj = get().currentProject;
    if (!cur || !proj) return;
    if (rejectArchivedConv(get, cur)) return;
    
    // 找到目标消息索引
    const targetIdx = cur.messages.findIndex((m) => m.id === messageId);
    if (targetIdx < 0) return;
    
    const forkedMessages = forkTimelineHistory(cur.messages, messageId,
      id => `fork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${id}`);

    const newTitle = nextForkTitle(cur.title, [...get().conversations.map(c => c.title), cur.title]);

    // createConv 后端返回 ConversationMeta 对象本身（不是 { ok, meta }）
    const createdMeta = (await window.api.createConv(proj.path, newTitle, cur.permissionMode)) as ConversationMeta;
    if (!createdMeta || !createdMeta.id) {
      console.warn('[forkConversation] createConv failed');
      return;
    }
    
    // 用后端返回的真实 meta，填充我们 fork 的消息
    const newConv: ConversationMeta = {
      ...createdMeta,
      messages: forkedMessages,
      permissionMode: cur.permissionMode,
      modelProfileId: cur.modelProfileId,
      selectedModel: cur.selectedModel,
      mode: cur.mode,
      preApprovedTools: cur.preApprovedTools,
    };
    
    // 持久化消息到后端（updateConvMeta 会合并 patch 并 saveConv + 更新缓存）
    try {
      await window.api.updateConvMeta(newConv.id, { messages: forkedMessages, title: newTitle });
    } catch (err) {
      console.warn('[forkConversation] persist messages failed', err);
    }
    
    // 从后端重新读取完整对话（确保缓存已同步）
    const reloaded = (await window.api.getConv(newConv.id)) as ConversationMeta;
    const finalConv = (reloaded && reloaded.messages && reloaded.messages.length > 0) ? reloaded : newConv;
    
    // 添加到列表并选中
    set({
      conversations: [finalConv, ...get().conversations.filter((c) => c.id !== finalConv.id)],
      currentConversation: finalConv,
    });
    
    // 创建新 tab 并激活
    const tabId = `conv:${newConv.id}`;
    set({
      openTabs: appendTab(get().openTabs, { kind: 'conversation', id: tabId, convId: newConv.id }, sourceTabId),
      activeTabId: tabId,
      tabScrollTick: get().tabScrollTick + 1,
    });
  },

  createConversation: async () => {
    const sourceTabId = get().activeTabId;
    const proj = get().currentProject;
    if (!proj) return null;
    const meta = (await window.api.createConv(
      proj.path,
      undefined,
      get().settings?.permissionMode ?? 'plan',
    )) as ConversationMeta;
    set({
      conversations: [meta, ...get().conversations],
      currentConversation: meta,
      currentSpec: undefined,
      mainView: 'conv',
    });
    // 同步到 openTabs
    const tabId = `conv:${meta.id}`;
    const existingTab = get().openTabs.find((t) => t.id === tabId);
    if (!existingTab) {
      const newTab: OpenTab = { kind: 'conversation', id: tabId, convId: meta.id };
      set({
        openTabs: appendTab(get().openTabs, newTab, sourceTabId),
        activeTabId: tabId,
      });
    } else {
      set({ activeTabId: tabId });
    }
    return meta;
  },

  selectConversation: async (id) => {
    const sourceTabId = get().activeTabId;
    const selection = ++conversationSelection;
    const buffered: ChatEvent[] = [];
    loadingConversationEvents.set(id, buffered);
    let meta: ConversationMeta | null;
    try {
      meta = await window.api.getConv(id, true);
    } catch (error) {
      if (loadingConversationEvents.get(id) === buffered) loadingConversationEvents.delete(id);
      throw error;
    }
    if (loadingConversationEvents.get(id) === buffered) loadingConversationEvents.delete(id);
    if (!meta || selection !== conversationSelection || cancelledConversationLoads.has(buffered)) return;
    const runtime = meta.runtime;
    delete meta.runtime;
    if (runtime) {
      appliedChatSequences.set(id, runtime.eventSequence);
      const busy = { ...get().busyConvIds };
      if (runtime.running) busy[id] = true; else delete busy[id];
      const stopped = { ...get().queueStoppedByConv };
      if (runtime.queueStopped) stopped[id] = {
        failedQueueId: runtime.queueStopped.queueId, failedText: runtime.queueStopped.text,
        error: runtime.queueStopped.error, remaining: meta.messages.filter(m => m.queued).length,
      }; else delete stopped[id];
      set({ busyConvIds: busy, queueStoppedByConv: stopped });
    }
    // 同 selectSpec：露出 conv 视图但保留 openFiles/openTerminals tab bar。
    // 合并为一次 set，确保 currentConversation / openTabs / activeTabId 同帧生效，
    // FileTabs 的滚动定位 effect 能拿到已渲染的 tab。
    const tabId = `conv:${id}`;
    const existingTab = get().openTabs.find((t) => t.id === tabId);
    set({
      currentConversation: meta,
      currentSpec: undefined,
      mainView: 'conv',
      openTabs: existingTab
        ? get().openTabs
        : appendTab(get().openTabs, { kind: 'conversation', id: tabId, convId: id } as OpenTab, sourceTabId),
      activeTabId: tabId,
      tabScrollTick: get().tabScrollTick + 1,
    });
    for (const event of buffered) {
      if (event.sequence === undefined || event.sequence > (runtime?.eventSequence ?? 0)) get().applyChatEvent(event);
    }

  },

  deleteConversation: async (id) => {
    const proj = get().currentProject;
    console.log('[deleteConversation] id:', id, 'projectPath:', proj?.path);
    const result = await window.api.deleteConv(id, proj?.path);
    console.log('[deleteConversation] result:', result);
    if (!result?.ok) { get().setConvError(result?.error || '无法删除对话，请稍后重试'); return; }
    if (get().currentConversation?.id === id) set({ currentConversation: undefined });
    // 对话已删除，其输入框草稿一并清掉（避免内存泄漏与 id 复用时的脏数据）
    get().clearConvDraft(id);
    await get().refreshConversations();
    // Stats file was updated on the backend (usage accumulated); refresh it.
    void get().refreshProjectStats();
  },

  deleteChatMessage: async (msgId: string) => {
    const cur = get().currentConversation;
    if (!cur) return;
    if (rejectArchivedConv(get, cur)) return;
    // Keep the message visible until persistence succeeds; a busy/failed deletion must not hide history.
    const r = (await window.api.deleteConvMessage(cur.id, msgId)) as {
      ok: boolean;
      error?: string;
      meta?: ConversationMeta;
    };
    if (!r.ok) { get().setConvError(r.error || '无法删除消息，请稍后重试'); return; }
    if (r.meta && get().currentConversation?.id === cur.id) {
      set({ currentConversation: retainConversationReadState(r.meta, get().currentConversation) });
    }
  },

  resendChatMessage: async (assistantMsgId: string) => {
    const cur = get().currentConversation;
    if (!cur) return;
    if (rejectArchivedConv(get, cur)) return;
    // 忙碌中不允许重发
    if (get().busyConvIds[cur.id]) return;

    const idx = cur.messages.findIndex((m) => m.id === assistantMsgId);
    if (idx < 0) return;
    // 向前找到对应的 user 消息
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (cur.messages[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const userMsg = cur.messages[userIdx];
    const text = userMsg.content ?? '';
    const images = userMsg.images;
    if (!text.trim() && !(images && images.length > 0)) return;

    if(retryingConversations.has(cur.id))return;
    retryingConversations.add(cur.id);
    try {
      // Remove all messages belonging to this failed response, including placeholders.
      const remove=cur.messages.slice(userIdx,idx+1);
      const result=await window.api.deleteConvMessage(cur.id,remove.map(message=>message.id));
      if(!result?.ok)throw Error(result?.error??'无法清理失败消息');
      if(get().currentConversation?.id!==cur.id)return;
      const ids=new Set(remove.map(m=>m.id));
      set(s=>({currentConversation:s.currentConversation?{...s.currentConversation,messages:s.currentConversation.messages.filter(m=>!ids.has(m.id))}:undefined}));
      const {[cur.id]:_failed,...remaining}=get().queueStoppedByConv;set({queueStoppedByConv:remaining});
      await get().sendChat(text,images);
    } catch(error){get().setConvError(String((error as Error).message));}
    finally {retryingConversations.delete(cur.id);}

  },

  truncateFromMessage: async (msgId: string) => {
    const cur = get().currentConversation;
    if (!cur) return;
    if (rejectArchivedConv(get, cur)) return;
    const idx = cur.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return;
    const removed = cur.messages.slice(idx);
    for (const m of removed) {
      await window.api.deleteConvMessage(cur.id, m.id);
    }
    const conv = get().currentConversation;
    if (conv && conv.id === cur.id) {
      const ids = new Set(removed.map((m) => m.id));
      set({
        currentConversation: {
          ...conv,
          messages: conv.messages.filter((m) => !ids.has(m.id)),
        },
      });
    }
  },

  reloadFromUserMessage: async (msgId: string) => {
    const cur = get().currentConversation;
    if (!cur || get().busyConvIds[cur.id]) return;
    if (rejectArchivedConv(get, cur)) return;
    const idx = cur.messages.findIndex((m) => m.id === msgId);
    if (idx < 0 || cur.messages[idx].role !== 'user') return;
    const userMsg = cur.messages[idx];
    const text = userMsg.content ?? '';
    const images = userMsg.images;
    if (!text.trim() && !(images && images.length > 0)) return;
    // 截断（含本条）后以原内容重发 = 从该点重新发起提问
    await get().truncateFromMessage(msgId);
    await get().sendChat(text, images);
  },

  setConvModel: async (modelProfileId) => {
    const cur = get().currentConversation;
    if (!cur) return;
    const r = (await window.api.updateConvMeta(cur.id, { modelProfileId: modelProfileId ?? null })) as {
      ok: boolean;
      meta: ConversationMeta;
    };
    if (r.ok) set({ currentConversation: r.meta });
  },

  /** 设置对话级选中的模型（新架构 Provider+Model）。立即更新当前对话与列表。 */
  setConvSelectedModel: async (selected) => {
    const cur = get().currentConversation;
    if (!cur) return;
    const r = (await window.api.updateConvMeta(cur.id, { selectedModel: selected ?? null, thinkingEffort: undefined })) as {
      ok: boolean;
      meta: ConversationMeta;
    };
    if (r.ok) {
      set({
        currentConversation: r.meta,
        conversations: get().conversations.map((c) => (c.id === r.meta.id ? r.meta : c)),
      });
    }
  },

  setConvThinkingEffort: async (effort) => {
    const cur = get().currentConversation;
    if (!cur) return;
    const r = (await window.api.updateConvMeta(cur.id, { thinkingEffort: effort })) as {
      ok: boolean;
      meta: ConversationMeta;
    };
    if (r.ok) {
      set({
        currentConversation: r.meta,
        conversations: get().conversations.map((c) => (c.id === r.meta.id ? r.meta : c)),
      });
    }
  },

  /** 设置对话级上下文压缩策略（null = 沿用全局配置）。 */
  setConvContextStrategy: async (strategy) => {
    const cur = get().currentConversation;
    if (!cur) return;
    const r = (await window.api.updateConvMeta(cur.id, { contextStrategy: strategy ?? null })) as {
      ok: boolean;
      meta: ConversationMeta;
    };
    if (r.ok) {
      set({
        currentConversation: r.meta,
        conversations: get().conversations.map((c) => (c.id === r.meta.id ? r.meta : c)),
      });
    }
  },

  setConvChannels: async channelIds => persistChannelBindings({inbound:channelIds,outbound:channelIds}),
  setConvInboundChannels: async inbound => persistChannelBindings({inbound}),
  setConvOutboundChannels: async outbound => persistChannelBindings({outbound}),
  setConvBroadcastUserChannels: async broadcastUser => persistChannelBindings({broadcastUser}),
  setConvBroadcastInboundChannels: async broadcastInbound => persistChannelBindings({broadcastInbound}),
  setConvBroadcastAssistantChannels: async broadcastAssistant => persistChannelBindings({broadcastAssistant}),

  renameConversation: async (id, title) => {
    const next = title.trim() || '新对话';
    const r = (await window.api.updateConvMeta(id, { title: next })) as {
      ok: boolean;
      meta: ConversationMeta;
    };
    if (!r.ok) return;
    if (get().currentConversation?.id === id) {
      set({ currentConversation: r.meta });
    }
    set({
      conversations: get().conversations.map((c) => (c.id === id ? r.meta : c)),
    });
  },

  respondApproval: async (requestId, decision) => {
    const cur = get().currentConversation;
    if (!cur) return;
    await window.api.respondPermission(requestId, decision);
    const existing = get().pendingApprovalsByConv[cur.id] ?? [];
    set({
      pendingApprovalsByConv: {
        ...get().pendingApprovalsByConv,
        [cur.id]: existing.filter((a) => a.requestId !== requestId),
      },
    });
  },

  respondClarify: async (requestId, answer) => {
    // 乐观移除卡片；后端 resolve 后还会发 clarify_resolved 兑底。
    // 注意：按 requestId 全局移除，不依赖 currentConversation（用户可能已切走）。
    const result = await window.api.respondClarify(requestId, answer);
    if (!result.ok) {
      console.error('[respondClarify] IPC failed - requestId not found in backend pendingClarifies:', { requestId });
      // 设置错误横幅
      const error = '问题澄清提交失败，请重试。';
      set({ errorBanner: error });
      throw new Error(error);
    }
    const all = get().pendingClarifiesByConv;
    const next: Record<string, ClarifyRequest[]> = {};
    for (const [convId, list] of Object.entries(all)) {
      next[convId] = list.filter((c) => c.requestId !== requestId);
    }
    set({ pendingClarifiesByConv: next });
  },

  expertsConfirmPlan: async (action, feedback) => {
    const cur = get().currentConversation;
    if (!cur) return;
    if (rejectArchivedConv(get, cur)) return;
    await window.api.expertsConfirmPlan(cur.id, action, feedback);
    // 确认后立即在本地把计划状态推进为 running（乐观更新，
    // 后端随后也会通过 meta_update 同步），让按钮立刻消失。
    if (action === 'confirm' && cur.expertsPlan && cur.expertsPlan.status === 'draft') {
      set({
        currentConversation: {
          ...cur,
          expertsPlan: { ...cur.expertsPlan, status: 'running' },
        },
      });
    }
    if (action === 'cancel' && cur.expertsPlan) {
      set({
        currentConversation: {
          ...cur,
          expertsPlan: { ...cur.expertsPlan, status: 'canceled' },
        },
      });
    }
  },

  expertsRetryFailedTasks: async () => {
    const cur = get().currentConversation;
    if (!cur) return;
    if (rejectArchivedConv(get, cur)) return;
    // 重试期间锁定：避免重复触发
    if (get().busyConvIds[cur.id]) return;
    set({ busyConvIds: { ...get().busyConvIds, [cur.id]: true } });
    try {
      const r = await window.api.expertsRetryFailed(cur.id);
      if (r?.ok && r.meta && get().currentConversation?.id===cur.id) {
        set({ currentConversation: r.meta });
      } else if(!r?.ok) throw new Error(r?.error??'恢复执行失败');
    } finally {
      const { [cur.id]: _, ...restBusy } = get().busyConvIds;
      set({ busyConvIds: restBusy });
    }
  },

  sendChat: async (text, images, mode) => {
    const cur = get().currentConversation;
    if (!cur) return;
    if (rejectArchivedConv(get, cur)) return;
    const hasImages = !!images && images.length > 0;
    if (!text.trim() && !hasImages) return;

    // 每次新请求均由主进程按复杂度路由，旧会话模式不再锁定输入。
    const effMode: ConversationMode = 'auto';

    // The backend decides whether this send starts or queues. A separate busy
    // probe is already stale by the time its reply arrives.
    const isBusy = !!get().busyConvIds[cur.id] || !!get().pendingApprovalsByConv[cur.id]?.length;

    // Optimistic insert: render user bubble + assistant pending placeholder
    // immediately, before any IPC. The assistant placeholder gets a temp id
    // prefixed `a-temp-`; applyChatEvent('message_start') reconciles by
    // replacing it with the backend's real id. User messages reconcile by
    // clientMessageId; IPC replies never overwrite newer streamed state.
    const now = new Date().toISOString();
    const rand = () => Math.random().toString(36).slice(2, 8);
    const userTempId = `u-temp-${Date.now()}-${rand()}`;
    const asstTempId = `a-temp-${Date.now()}-${rand()}`;

    if (isBusy) {
      // ── 排队模式：只插入 user bubble（标记 queued），不插 assistant 占位 ──
      const userMsg: ChatMessage = {
        id: userTempId,
        clientMessageId: userTempId,
        role: 'user',
        content: text,
        images,
        ts: now,
        queued: true,
      };
      set({
        currentConversation: get().currentConversation?.id === cur.id
          ? { ...get().currentConversation!, messages: [...get().currentConversation!.messages, userMsg] }
          : get().currentConversation,
      });
      // Don't set busyConvIds — it's already set from the current turn.

      const r = (await window.api.sendConv(cur.id, text, images, effMode, userTempId)
        .catch((error: unknown) => ({ ok: false, error: String(error) }))) as {
        ok: boolean;
        queued?: boolean;
        queueId?: string;
        error?: string;
        meta?: ConversationMeta;
      };

      if (r.ok && r.queued && r.queueId) {
        // Backend assigned a queueId — stamp it on the user msg so cancel works
        const conv = get().currentConversation;
        if (conv && conv.id === cur.id) {
          const msgs = conv.messages.map((m) =>
            m.id === userTempId ? { ...m, queueId: r.queueId } : m,
          );
          set({ currentConversation: { ...conv, messages: msgs } });
        }
      } else if (r.ok && !r.queued) {
        // Stream events already committed this turn. The IPC reply can arrive
        // after the next queued turn starts and must not overwrite it.
        void get().refreshConversations();
      } else if (!r.ok && get().currentConversation?.id === cur.id) {
        // Failed to enqueue — remove the optimistic user bubble
        const conv = get().currentConversation;
        if (conv) {
          const cleaned = conv.messages.filter((m) => m.id !== userTempId);
          set({ currentConversation: { ...conv, messages: cleaned } });
        }
        if (r.error) get().setConvError(r.error);
      }
      // Don't touch busyConvIds in finally — the original turn is still running.
      return;
    }

    // ── 正常模式（非 busy）：插入 user + assistant 占位 ──
    // 失败/异常路径必须自行清理 busyConvIds：后端 turn_state 事件只在 turn
    // 真正启动后才发，早失败（IPC 拒绝/后端早退）不会有任何事件，busy 会
    // 永久残留 → 后续发送全部误入排队分支（历史版本该分支丢 mode，导致
    // 专家团静默退化为智能体）。
    const clearBusy = () => {
      const { [cur.id]: _drop, ...rest } = get().busyConvIds;
      set({ busyConvIds: rest });
    };
    const userMsg: ChatMessage = {
      id: userTempId,
      clientMessageId: userTempId,
      role: 'user',
      content: text,
      images,
      ts: now,
    };
    const asstMsg: ChatMessage = {
      id: asstTempId,
      clientMessageId: userTempId,
      role: 'assistant',
      content: '',
      ts: now,
      pending: true,
    };
    set({
      currentConversation: get().currentConversation?.id === cur.id
        ? { ...get().currentConversation!, messages: [...get().currentConversation!.messages, userMsg, asstMsg] }
        : get().currentConversation,
      busyConvIds: { ...get().busyConvIds, [cur.id]: true },
      pendingApprovalsByConv: { ...get().pendingApprovalsByConv, [cur.id]: [] },
      pendingClarifiesByConv: { ...get().pendingClarifiesByConv, [cur.id]: [] },
    });

    try {
      const r = (await window.api.sendConv(cur.id, text, images, effMode, userTempId)) as {
        ok: boolean;
        authorization?: boolean;
        queued?: boolean;
        queueId?: string;
        error?: string;
        meta?: ConversationMeta;
      };
      if (r.authorization && get().currentConversation?.id === cur.id) {
        const live = get().currentConversation!;
        set({ currentConversation: { ...live, messages: live.messages.filter(m => m.id !== asstTempId) } });
      }
      if (r.queued && get().currentConversation?.id === cur.id) {
        const live = get().currentConversation!;
        set({ currentConversation: { ...live, messages: live.messages
          .filter(m => m.id !== asstTempId)
          .map(m => m.id === userTempId ? { ...m, queued: true, queueId: r.queueId } : m) } });
      }
      // 仅当用户仍在看这个对话时才更新 currentConversation——
      // 用户可能已经切走，此时不应覆盖新对话的状态。
      if (!r.ok && !r.meta && get().currentConversation?.id === cur.id) {
        // sendMessage returned early (e.g. path validation failed) without
        // creating real messages — remove the optimistic placeholders.
        const conv = get().currentConversation;
        if (conv) {
          const cleaned = conv.messages.filter(
            (m) => m.id !== userTempId && m.id !== asstTempId,
          );
          set({ currentConversation: { ...conv, messages: cleaned } });
        }
      }
      // Fire-and-forget: sidebar "last active" sort isn't worth blocking
      // the chat hot path on a project-wide IPC roundtrip.
      void get().refreshConversations();
      // Successful turns publish authoritative runtime events. A late reply may belong
      // to the preceding turn, so only an early failure without a turn clears busy.
      if (!r.ok && !r.meta && !r.queued) clearBusy();
      if (!r.ok && r.error && !r.meta?.messages.some(m => m.role === 'assistant' && m.error === r.error)) get().setConvError(r.error);
    } catch (error) {
      get().setConvError(String(error));
      clearBusy();
      if (get().currentConversation?.id === cur.id) {
        await get().selectConversation(cur.id).catch(() => {});
      }
    }
  },

  removeQueuedMessage: async (queueId) => {
    const cur = get().currentConversation;
    if (!cur) return;
    if (rejectArchivedConv(get, cur)) return;
    const removed = await window.api.removeQueuedMessage(cur.id, queueId);
    if (!removed?.ok) return;
    // Remove the queued user msg from the UI
    const conv = get().currentConversation;
    if (conv && conv.id === cur.id) {
      const cleaned = conv.messages.filter((m) => !(m.queued && m.queueId === queueId));
      set({ currentConversation: { ...conv, messages: cleaned } });
    }
  },

  reorderQueuedMessages: async (queueIds) => {
    const cur = get().currentConversation;
    if (!cur) return;
    if (rejectArchivedConv(get, cur)) return;
    // queue_update owns the result; a late IPC reply must not drop newly
    // enqueued items or restore an item that has already started.
    await window.api.reorderQueuedMessages(cur.id, queueIds);
  },

  resumeQueue: async () => {
    const cur = get().currentConversation;
    if (!cur) return;
    if (rejectArchivedConv(get, cur)) return;
    const { [cur.id]: _, ...rest } = get().queueStoppedByConv;
    set({ queueStoppedByConv: rest });
    await window.api.resumeQueue(cur.id);
  },

  retryQueue: async () => {
    const cur = get().currentConversation;
    if (!cur || get().busyConvIds[cur.id] || retryingConversations.has(cur.id)) return;
    if (rejectArchivedConv(get, cur)) return;
    const { [cur.id]: _, ...rest } = get().queueStoppedByConv;
    set({ queueStoppedByConv: rest });
    retryingConversations.add(cur.id);
    try {
      const r = await window.api.retryQueue(cur.id) as {ok:boolean;error?:string};
      if(!r.ok && r.error!=='conversation is running')get().setConvError(r.error??'重试失败');
    } finally {retryingConversations.delete(cur.id);}

  },

  clearQueueStopped: () => {
    const cur = get().currentConversation;
    if (!cur) return;
    const { [cur.id]: _, ...rest } = get().queueStoppedByConv;
    set({ queueStoppedByConv: rest });
  },

  abortChat: async (convId?) => {
    const id = convId ?? get().currentConversation?.id;
    if (!id) return;
    await window.api.abortConv(id);
  },

  // ---------- files ----------

  loadDir: async (relPath) => {
    const proj = get().currentProject;
    if (!proj) return;
    const selection=projectSelection,filter=get().settings?.fileBrowserHiddenDirectories,key=proj.path+'\0'+relPath,request=++directoryReadSequence;
    directoryReads.set(key,request);
    const active=()=>selection===projectSelection&&get().currentProject?.path===proj.path&&get().settings?.fileBrowserHiddenDirectories===filter&&directoryReads.get(key)===request;
    let r;
    try { r = (await window.api.listFiles(proj.path, relPath)) as {
      ok: boolean;
      entries?: FileEntry[];
      error?: string;
    } | null; } catch(error) {
      if(active())set({errorBanner:(error as Error)?.message||translate('ft.readFailed')});
      if(directoryReads.get(key)===request)directoryReads.delete(key);
      return;
    }
    if(!active()){if(directoryReads.get(key)===request)directoryReads.delete(key);return;}
    directoryReads.delete(key);
    if (r?.ok && Array.isArray(r.entries)) {
      // 应用排序
      const sortBy = get().fileTreeSortBy;
      const sortOrder = get().fileTreeSortOrder;
      const sorted = [...r.entries].sort((a, b) => {
        // 目录始终排在文件前面
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        
        let cmp = 0;
        switch (sortBy) {
          case 'name':
            cmp = a.name.localeCompare(b.name);
            break;
          case 'ctime':
            cmp = (a.ctime || '').localeCompare(b.ctime || '');
            break;
          case 'mtime':
            cmp = (a.mtime || '').localeCompare(b.mtime || '');
            break;
          case 'type':
            const extA = a.name.includes('.') ? a.name.split('.').pop() || '' : '';
            const extB = b.name.includes('.') ? b.name.split('.').pop() || '' : '';
            cmp = extA.localeCompare(extB) || a.name.localeCompare(b.name);
            break;
        }
        return sortOrder === 'desc' ? -cmp : cmp;
      });
      
      set({
        fileTreeChildren: { ...get().fileTreeChildren, [relPath]: sorted },
      });
    } else {
      set({ errorBanner: r?.error || translate('ft.readFailed') });
    }
  },

  toggleDir: async (relPath) => {
    directoryExpansion++;
    const expanded = { ...get().expandedDirs };
    if (expanded[relPath]) {
      delete expanded[relPath];
      set({ expandedDirs: expanded });
      return;
    }
    expanded[relPath] = true;
    set({ expandedDirs: expanded });
    if (!get().fileTreeChildren[relPath]) {
      await get().loadDir(relPath);
    }
  },

  refreshFileTree: async () => {
    const proj = get().currentProject;
    if (!proj) return;
    const selection=projectSelection,filter=get().settings?.fileBrowserHiddenDirectories;
    const active=()=>selection===projectSelection&&get().currentProject?.path===proj.path&&get().settings?.fileBrowserHiddenDirectories===filter;
    // The root is always loaded; every other key in fileTreeChildren is a
    // directory the user previously expanded. Re-fetch each one in
    // parallel and commit them in a single set() so the tree doesn't
    // flicker through partial states.
    const paths = Object.keys(get().fileTreeChildren);
    if (!paths.includes('')) paths.push('');
    const results = await Promise.all(paths.map(async rel => {
      const key=proj.path+'\0'+rel,request=++directoryReadSequence;directoryReads.set(key,request);
      try { return {rel,key,request,r:await window.api.listFiles(proj.path,rel)}; }
      catch(error) { return {rel,key,request,r:{ok:false,error:(error as Error).message||translate('ft.readFailed')}}; }
    }));
    if(!active()){
      for(const {key,request} of results)if(directoryReads.get(key)===request)directoryReads.delete(key);
      return;
    }
    const next = { ...get().fileTreeChildren };
    let firstError: string | undefined;
    const expanded={...get().expandedDirs};
    const sortBy = get().fileTreeSortBy;
    const sortOrder = get().fileTreeSortOrder;
    
    for (const { rel, key, request, r } of results) {
      if(directoryReads.get(key)!==request)continue;directoryReads.delete(key);
      if (r?.ok && Array.isArray(r.entries)) {
        // 应用排序
        const sorted = [...r.entries].sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          
          let cmp = 0;
          switch (sortBy) {
            case 'name':
              cmp = a.name.localeCompare(b.name);
              break;
            case 'ctime':
              cmp = (a.ctime || '').localeCompare(b.ctime || '');
              break;
            case 'mtime':
              cmp = (a.mtime || '').localeCompare(b.mtime || '');
              break;
            case 'type':
              const extA = a.name.includes('.') ? a.name.split('.').pop() || '' : '';
              const extB = b.name.includes('.') ? b.name.split('.').pop() || '' : '';
              cmp = extA.localeCompare(extB) || a.name.localeCompare(b.name);
              break;
          }
          return sortOrder === 'desc' ? -cmp : cmp;
        });
        next[rel] = sorted;
      } else {
        // Only a confirmed missing directory invalidates cached children.
        // Transport/permission failures keep the last readable snapshot.
        if(r?.ok===false&&/\b(?:ENOENT|ENOTDIR)\b/.test(r.error??'')){delete next[rel];delete expanded[rel];}
        firstError ||= r?.error || translate('ft.readFailed');
      }
    }
    set({ fileTreeChildren: next, expandedDirs:expanded, ...(firstError?{errorBanner:firstError}:{}) });
  },

  setFileTreeSort: (sortBy, order) => {
    set({ fileTreeSortBy: sortBy, fileTreeSortOrder: order });
    
    // 重新排序所有已加载的目录
    const fileTreeChildren = get().fileTreeChildren;
    const next: Record<string, FileEntry[]> = {};
    
    for (const [relPath, entries] of Object.entries(fileTreeChildren)) {
      next[relPath] = [...entries].sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        
        let cmp = 0;
        switch (sortBy) {
          case 'name':
            cmp = a.name.localeCompare(b.name);
            break;
          case 'ctime':
            cmp = (a.ctime || '').localeCompare(b.ctime || '');
            break;
          case 'mtime':
            cmp = (a.mtime || '').localeCompare(b.mtime || '');
            break;
          case 'type':
            const extA = a.name.includes('.') ? a.name.split('.').pop() || '' : '';
            const extB = b.name.includes('.') ? b.name.split('.').pop() || '' : '';
            cmp = extA.localeCompare(extB) || a.name.localeCompare(b.name);
            break;
        }
        return order === 'desc' ? -cmp : cmp;
      });
    }
    
    set({ fileTreeChildren: next });
  },

  expandAllDirs: async () => {
    const proj = get().currentProject;
    if (!proj) return;
    const selection = projectSelection, expansion = ++directoryExpansion;
    const filter = get().settings?.fileBrowserHiddenDirectories;
    const active = () => selection === projectSelection && expansion === directoryExpansion &&
      get().currentProject?.path === proj.path && get().settings?.fileBrowserHiddenDirectories === filter;
    const allDirs: string[] = [], visited = new Set<string>();
    async function collectDirs(relPath: string) {
      if (!active() || visited.has(relPath)) return;
      visited.add(relPath);
      if (!get().fileTreeChildren[relPath]) await get().loadDir(relPath);
      if (!active()) return;
      for (const entry of get().fileTreeChildren[relPath] || []) {
        if (!active()) return;
        if (entry.isDir) {
          allDirs.push(entry.relPath);
          await collectDirs(entry.relPath);
        }
      }
    }
    await collectDirs('');
    if (!active()) return;
    const expanded: Record<string, boolean> = { '': true };
    for (const dir of allDirs) expanded[dir] = true;
    set({ expandedDirs: expanded });
  },

  collapseAllDirs: () => {
    directoryExpansion++;
    set({ expandedDirs: { '': true } });
  },

  createFolder: async (relPath) => {
    const proj = get().currentProject;
    if (!proj) return { ok: false, error: '没有选择项目' };
    
    try {
      await window.api.mkdir(proj.path, relPath);
      // 刷新父目录
      const parentPath = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '';
      await get().loadDir(parentPath);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  },

  createFile: async (relPath, content) => {
    const proj = get().currentProject;
    if (!proj) return { ok: false, error: '没有选择项目' };
    
    try {
      await window.api.createFile(proj.path, relPath, content ?? '');
      // 刷新父目录
      const parentPath = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '';
      await get().loadDir(parentPath);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  },

  revealFileInTree: async (relPath) => {
    const proj = get().currentProject;
    if (!proj) return;
    const selection = projectSelection, expansion = ++directoryExpansion;
    const filter = get().settings?.fileBrowserHiddenDirectories;
    const active = () => selection === projectSelection && expansion === directoryExpansion &&
      get().currentProject?.path === proj.path && get().settings?.fileBrowserHiddenDirectories === filter;
    const parts = relPath.split('/');
    parts.pop();
    const dirsToExpand: string[] = [''];
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      dirsToExpand.push(currentPath);
    }
    for (const dir of dirsToExpand) {
      if (!active()) return;
      if (!get().fileTreeChildren[dir]) await get().loadDir(dir);
    }
    if (!active()) return;
    const expanded = { ...get().expandedDirs };
    for (const dir of dirsToExpand) expanded[dir] = true;
    set({ expandedDirs: expanded, fileToReveal: relPath });
  },

  clearFileToReveal: () => {
    set({ fileToReveal: null });
  },

  openFile: async (relPath, scrollToLine, scrollToQuery) => {
    const sourceTabId = get().activeTabId;
    const proj = get().currentProject;
    if (!proj) return;
    const selection = projectSelection;
    const active = () => selection === projectSelection && get().currentProject?.path === proj.path;

    if (/\.pdf$/i.test(relPath)) {
      try {
        const {getTabRenderer} = await import('../plugins');
        if (!active()) return;
        const internal = !!getTabRenderer('browser',enabledBuiltins(get().settings,proj));
        const result = await window.api.openPdf(proj.path,relPath,!internal);
        if (!active()) return;
        if (!result.ok) { set({errorBanner:result.error ?? 'Unable to open PDF'}); return; }
        if (internal && result.url) get().openBrowserTab(result.url);
      } catch(error:any) { if (active()) set({errorBanner:error?.message ?? String(error)}); }
      return;
    }

    const tabId = `file:${relPath}`;

    // 如果已经打开过这个文件，只激活对应 tab，不重读盘——保留 dirty 状态。
    // 带行号跳转时把目标行写进该 tab（内容搜索点击不同行可反复跳转）。
    const existingTabIdx = get().openTabs.findIndex(
      (t) => t.kind === 'file' && t.data.relPath === relPath,
    );
    if (existingTabIdx >= 0) {
      if (scrollToLine !== undefined) {
        const existingTab = get().openTabs[existingTabIdx];
        if (existingTab.kind === 'file') {
          set({
            openTabs: get().openTabs.map((t): OpenTab => {
              if (t.id === tabId && t.kind === 'file') {
                return { ...t, data: { ...t.data, scrollToLine, scrollToQuery } };
              }
              return t;
            }),
          });
        }
      }
      set({ activeTabId: tabId });
      const _ppAct = get().currentProject?.path;
      if (_ppAct) saveTabsToStorage(_ppAct, get().openTabs, tabId);
      return;
    }

    try {
    // 图片文件：调用 readFileAsBase64 获取 base64 data URL
    if (isImageFile(relPath)) {
      const r = (await window.api.readFileAsBase64(proj.path, relPath)) as any;
      if (!active()) return;
      if (!r?.ok) {
        set({ errorBanner: r?.error ?? 'read image failed' });
        return;
      }
      // 图片分支没有 content，但头部同样要显示「最后更新时间」，单独 stat 一次。
      let mtime: string | undefined;
      try {
        const st = (await window.api.fileStat?.(proj.path, relPath)) as { mtime?: string } | null;
        mtime = st?.mtime;
      } catch { /* ignore */ }
      if (!active()) return;
      if (get().openTabs.some(tab => tab.id === tabId)) return;
      const newFile: OpenFile = {
        relPath,
        content: '',
        originalContent: '',
        binary: true,
        size: r.size,
        imageData: r.data,
        mtime,
      };
      const newTab: OpenTab = { kind: 'file', id: tabId, data: newFile };
      set({
        openTabs: appendTab(get().openTabs, newTab, sourceTabId),
        activeTabId: tabId,
      });
      return;
    }

    const r = (await window.api.readFile(proj.path, relPath)) as any;
    if (!active()) return;
    if (!r?.ok) {
      set({ errorBanner: r?.error ?? 'read failed' });
      return;
    }

    if (get().openTabs.some(tab => tab.id === tabId)) return;
    // markdown / html 文件按 settings 决定初始 view；其他文件留 undefined。
    const initialView: 'preview' | 'source' | undefined =
      isPreviewablePath(relPath) && !r.binary
        ? get().settings?.markdownDefaultView ?? 'preview'
        : undefined;
    const newFile: OpenFile = {
      relPath,
      content: r.content,
      originalContent: r.content,
      binary: r.binary,
      size: r.size,
      truncated: r.truncated,
      view: initialView,
      scrollToLine,
      scrollToQuery,
      mtime: r.mtime,
    };
    const newTab: OpenTab = { kind: 'file', id: tabId, data: newFile };
    set({
      openTabs: appendTab(get().openTabs, newTab, sourceTabId),
      activeTabId: tabId,
    });
    // 即时落盘：退出时 beforeunload 之外多一层保险，开过的文件重启必恢复
    const _ppOpen = get().currentProject?.path;
    if (_ppOpen) saveTabsToStorage(_ppOpen, get().openTabs, tabId);
    } catch (error: any) { if (active()) set({errorBanner:error?.message ?? String(error)}); }
  },

  activateFile: (idx) => {
    // PR 5: openFiles 已废弃，idx 参数失效。但为保持调用点兼容，
    // 改为通过 idx 在 openTabs 的 file tab 列表中定位。
    const fileTabs = get().openTabs.filter((t) => t.kind === 'file');
    if (idx < 0 || idx >= fileTabs.length) return;
    set({ activeTabId: fileTabs[idx].id });
  },

  setFileView: (view) => {
    const { openTabs, activeTabId } = get();
    if (!activeTabId) return;
    const tabIndex = openTabs.findIndex((t) => t.id === activeTabId);
    if (tabIndex < 0) return;
    const tab = openTabs[tabIndex];
    if (tab.kind !== 'file') return;
    // 按文件类型判断（而非 view 字段是否已初始化）：恢复 tab / 历史数据
    // 可能缺 view 初值，守卫过严会让「预览」按钮静默失效。
    if (tab.data.binary || !isPreviewablePath(tab.data.relPath)) return;
    if (tab.data.view === view) return;
    set({
      openTabs: openTabs.map((t): OpenTab => {
        if (t.id === activeTabId && t.kind === 'file') {
          return { ...t, data: { ...t.data, view } };
        }
        return t;
      }),
    });
  },

  setFileContent: (content) => {
    const { openTabs, activeTabId } = get();
    if (!activeTabId) return;
    const tabIndex = openTabs.findIndex((t) => t.id === activeTabId);
    if (tabIndex < 0) return;
    const tab = openTabs[tabIndex];
    if (tab.kind !== 'file' || tab.data.readOnly) return;
    set({
      openTabs: openTabs.map((t): OpenTab => {
        if (t.id === activeTabId && t.kind === 'file') {
          return { ...t, data: { ...t.data, content, error: undefined } };
        }
        return t;
      }),
    });
  },

  saveFile: async () => {
    const proj = get().currentProject, activeTabId = get().activeTabId;
    if (!proj || !activeTabId) return;
    const tab = get().openTabs.find(tab => tab.id === activeTabId);
    if (!tab || tab.kind !== 'file' || tab.data.readOnly || tab.data.saving) return;
    const cur = tab.data, selection = projectSelection;
    const key = proj.path + '\0' + activeTabId, request = Symbol();
    fileSaves.set(key, request);
    const current = () => {
      if (selection !== projectSelection || get().currentProject?.path !== proj.path || fileSaves.get(key) !== request) return;
      const latest = get().openTabs.find(tab => tab.id === activeTabId);
      return latest?.kind === 'file' && latest.data.relPath === cur.relPath && latest.data.saving ? latest : undefined;
    };
    set({openTabs:get().openTabs.map(tab => tab.id === activeTabId && tab.kind === 'file' ? {...tab,data:{...tab.data,saving:true,error:undefined}} : tab)});
    try {
      const r = await window.api.writeFile(proj.path, cur.relPath, cur.content) as {ok:boolean;mtime?:string;error?:string}|null;
      if (!current()) return;
      let mtime = r?.mtime;
      if (r?.ok && !mtime) {
        try { mtime = (await window.api.fileStat?.(proj.path, cur.relPath) as {mtime?:string}|null)?.mtime; } catch { /* optional metadata */ }
      }
      if (!current()) return;
      // Only the exact bytes sent to disk become clean. Later typing stays dirty.
      set({openTabs:get().openTabs.map(tab => tab.id === activeTabId && tab.kind === 'file' ? {...tab,data:r?.ok ?
        {...tab.data,saving:false,originalContent:cur.content,error:undefined,mtime:mtime ?? new Date().toISOString()} :
        {...tab.data,saving:false,error:r?.error ?? 'write failed'}} : tab)});
    } catch (error: any) {
      if (current()) set({openTabs:get().openTabs.map(tab => tab.id === activeTabId && tab.kind === 'file' ?
        {...tab,data:{...tab.data,saving:false,error:error?.message ?? String(error)}} : tab)});
    } finally {
      if (fileSaves.get(key) === request) fileSaves.delete(key);
    }
  },

  closeFile: async (idxToClose) => {
    // PR 5: openFiles 已废弃。idx 参数按 file tab 在 openTabs 中的相对位置处理。
    // 如果 idx 未提供，则关闭当前 active file tab。
    const state = get();
    const fileTabs = state.openTabs.filter((t) => t.kind === 'file');
    if (fileTabs.length === 0) return;

    let tabToClose: Extract<OpenTab, { kind: 'file' }>;
    if (idxToClose !== undefined) {
      if (idxToClose < 0 || idxToClose >= fileTabs.length) return;
      tabToClose = fileTabs[idxToClose];
    } else {
      const active = state.openTabs.find((t) => t.id === state.activeTabId);
      if (!active || active.kind !== 'file') {
        // 没有 active file tab，关最后一个
        tabToClose = fileTabs[fileTabs.length - 1];
      } else {
        tabToClose = active;
      }
    }

    if (tabToClose.data.content !== tabToClose.data.originalContent) {
      if (!(await confirmDialog({ message: translate('tabs.closeDirtyConfirm', { path: tabToClose.data.relPath }) }))) return;
    }

    void state.closeTab(tabToClose.id);
  },

  closeAllFiles: async () => {
    const dirty = get().openTabs.filter(
      (t): t is Extract<OpenTab, { kind: 'file' }> =>
        t.kind === 'file' && t.data.content !== t.data.originalContent,
    );
    if (dirty.length > 0) {
      const names = dirty.map((f) => f.data.relPath).join('\n  ');
      if (!(await confirmDialog({ message: translate('tabs.closeAllDirtyConfirm', { count: dirty.length, names }) }))) return;
    }
    // 关闭所有 file tab
    const tabsToClose = get().openTabs.filter((t) => t.kind === 'file');
    tabsToClose.forEach((t) => {
      void get().closeTab(t.id);
    });
  },

  // ─── 统一 Tab API 实现 ────────────────────────────────────────────────
  activateTab: (tabId) => {
    const state = get();
    const tab = state.openTabs.find((t) => t.id === tabId);
    if (!tab) return;

    // conversation / spec tab 激活时触发数据加载
    if (tab.kind === 'conversation') {
      state.selectConversation(tab.convId);
    } else if (tab.kind === 'spec') {
      state.selectSpec(tab.specId);
    } else if (tab.kind === 'scheduled') {
      set({ mainView: 'scheduled' });
    } else if (tab.kind === 'channels') {
      set({ mainView: 'channels' });
    }

    set({ activeTabId: tabId });
    const _ppTab = get().currentProject?.path;
    if (_ppTab) saveTabsToStorage(_ppTab, get().openTabs, tabId);
  },

  closeTab: async (tabId) => {
    const state = get();
    const tabIndex = state.openTabs.findIndex((t) => t.id === tabId);
    if (tabIndex < 0) return;

    const tab = state.openTabs[tabIndex];

    // 关闭时清理：file tab 检查 dirty，terminal tab dispose PTY
    if (tab.kind === 'plugin' && tab.data.dirty) {
      if (!(await confirmDialog({message:'此插件视图有未保存的内容，确认关闭？ / Discard unsaved plugin changes?'}))) return;
    } else if (tab.kind === 'file') {
      if (tab.data.content !== tab.data.originalContent) {
        if (!(await confirmDialog({ message: translate('tabs.closeDirtyConfirm', { path: tab.data.relPath }) }))) return;
      }
    } else if (tab.kind === 'terminal') {
      await window.api.terminalDispose(tab.data.id);
    } else if (tab.kind === 'settings') {
      // 设置未保存：二次确认
      if (get().settingsDirty) {
        if (!(await confirmDialog({ message: translate('tabs.closeSettingsDirtyConfirm') }))) return;
        set({ settingsDirty: false });
      }
    }
    const latest = get();
    const latestIndex = latest.openTabs.findIndex(t => t.id === tabId);
    if (latestIndex < 0) return;
    const closingTab = latest.openTabs[latestIndex];
    if (closingTab.kind === 'conversation') {
      const loading = loadingConversationEvents.get(closingTab.convId);
      if (loading) cancelledConversationLoads.add(loading);
    }
    const keepConversation = retainClosedConversation(closingTab, latest);
    const closingProject = latest.currentProject?.path;
    const nextTabs = latest.openTabs.filter(t => t.id !== tabId);
    let nextActiveTabId = latest.activeTabId;

    // 如果关闭的是 active tab，选择相邻 tab
    if (latest.activeTabId === tabId) {
      if (nextTabs.length === 0) {
        nextActiveTabId = undefined;
      } else if (latestIndex < nextTabs.length) {
        nextActiveTabId = nextTabs[latestIndex].id;
      } else {
        nextActiveTabId = nextTabs[nextTabs.length - 1].id;
      }
    }

    set({ openTabs: nextTabs, activeTabId: nextActiveTabId });

    // 关闭 scheduled/channels tab 时清理 mainView
    if (tab.kind === 'scheduled' || tab.kind === 'channels') {
      // 如果切到的 tab 也不是 scheduled/channels，则清空 mainView
      const nextTab = nextTabs.find((t) => t.id === nextActiveTabId);
      if (!nextTab || (nextTab.kind !== 'scheduled' && nextTab.kind !== 'channels')) {
        set({ mainView: null });
      } else if (nextTab.kind === 'scheduled') {
        set({ mainView: 'scheduled' });
      } else if (nextTab.kind === 'channels') {
        set({ mainView: 'channels' });
      }
    }
    // Removing the active tab also has to run the destination tab's activation
    // side effects (load its conversation/spec and switch the main view). Merely
    // changing activeTabId updates the underline, but leaves the old content mounted.
    if (latest.activeTabId === tabId && nextActiveTabId) get().activateTab(nextActiveTabId);
    else if (latest.activeTabId === tabId && closingTab.kind === 'conversation') set({ currentConversation: undefined, mainView: null });
    // 同步到 localStorage
    const _ppClose = get().currentProject?.path;
    if (_ppClose) saveTabsToStorage(_ppClose, nextTabs, nextActiveTabId);
    await cleanupClosedConversationTab(closingTab, closingProject, keepConversation);
  },

  closeAllTabs: async () => {
    const state = get();

    // 固定的（pinned）tab 在批量关闭时保留（与编辑器惯例一致）
    const closable = state.openTabs.filter((t) => !t.pinned);

    // 检查 dirty 文件
    const dirtyFiles = closable.filter((t) => {
      if (t.kind !== 'file') return false;
      return t.data.content !== t.data.originalContent;
    });

    if (dirtyFiles.length > 0) {
      const names = dirtyFiles
        .map((t) => (t as Extract<OpenTab, { kind: 'file' }>).data.relPath)
        .join('\n  ');
      if (!(await confirmDialog({ message: translate('tabs.closeAllDirtyConfirm', { count: dirtyFiles.length, names }) }))) {
        return;
      }
    }

    // 设置未保存：批量关闭同样二次确认
    if (state.settingsDirty && closable.some((t) => t.kind === 'settings')) {
      if (!(await confirmDialog({ message: translate('tabs.closeAllSettingsDirtyConfirm') }))) return;
      set({ settingsDirty: false });
    }

    // 关闭可关闭的 terminal PTY
    const termTabs = closable.filter((t) => t.kind === 'terminal');
    await Promise.all(termTabs.map((t) => window.api.terminalDispose((t as Extract<OpenTab, { kind: 'terminal' }>).data.id)));

    // Only close the tabs confirmed above; async disposal must not discard newly opened tabs.
    const latest = get(), closingIds = new Set(closable.map(tab => tab.id));
    const actualClosed = latest.openTabs.filter(tab => closingIds.has(tab.id) && !tab.pinned);
    const remaining = latest.openTabs.filter(tab => !actualClosed.includes(tab));
    for (const tab of actualClosed) if (tab.kind === 'conversation') {
      const loading = loadingConversationEvents.get(tab.convId);
      if (loading) cancelledConversationLoads.add(loading);
    }
    const cleanup = actualClosed.map(tab => ({ tab, keep: retainClosedConversation(tab, latest) }));
    const projectPath = latest.currentProject?.path;
    const nextActive = remaining.find(tab => tab.id === latest.activeTabId)?.id ?? remaining[0]?.id;
    set({ openTabs: remaining, activeTabId: nextActive });
    if (nextActive && nextActive !== latest.activeTabId) get().activateTab(nextActive);
    else if (!nextActive) set({ currentConversation: undefined, mainView: null });
    const _pp2 = get().currentProject?.path;
    // 关闭全部非固定tab后，保存剩余的tabs（只有固定的）
    if (_pp2) saveTabsToStorage(_pp2, remaining, nextActive);
    await Promise.all(cleanup.map(({ tab, keep }) => cleanupClosedConversationTab(tab, projectPath, keep)));
  },

  moveTab: (dragTabId, targetTabId) => {
    if (dragTabId === targetTabId) return;
    const tabs = get().openTabs;
    const dragIdx = tabs.findIndex((t) => t.id === dragTabId);
    const targetIdx = tabs.findIndex((t) => t.id === targetTabId);
    if (dragIdx < 0 || targetIdx < 0) return;
    // 固定区 / 非固定区各自内部重排，不允许跨区拖动
    const dragPinned = !!tabs[dragIdx].pinned;
    if (!!tabs[targetIdx].pinned !== dragPinned) return;
    const next = [...tabs];
    const [moved] = next.splice(dragIdx, 1);
    // 移除后目标索引可能偏移
    const insertIdx = dragIdx < targetIdx ? targetIdx - 1 : targetIdx;
    next.splice(insertIdx, 0, moved);
    set({ openTabs: next });
    const _pp3 = get().currentProject?.path;
    if (_pp3) saveTabsToStorage(_pp3, next, get().activeTabId);
  },

  togglePinTab: (tabId) => {
    const tabs = get().openTabs;
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const nowPinned = !tab.pinned;
    const updated = tabs.map((t) => (t.id === tabId ? { ...t, pinned: nowPinned } : t));
    // 稳定排序：固定区在前（按现有相对顺序），非固定区在后
    const sorted = [
      ...updated.filter((t) => t.pinned),
      ...updated.filter((t) => !t.pinned),
    ];
    set({ openTabs: sorted });
    const _pp = get().currentProject?.path;
    if (_pp) saveTabsToStorage(_pp, sorted, get().activeTabId);
  },

  searchProjectFiles: async (query, scope) => {
    const proj = get().currentProject;
    if (!proj) return [];
    const r = (await window.api.searchFiles(proj.path, query, undefined, scope ?? undefined)) as {
      ok: boolean;
      entries?: FileEntry[];
      error?: string;
    };
    return r.ok && r.entries ? r.entries : [];
  },

  searchFileContents: async (query, scope) => {
    const proj = get().currentProject;
    if (!proj) return null;
    const r = (await window.api.searchFileContents(proj.path, query, scope ?? undefined)) as {
      ok: boolean;
      result?: ContentSearchResult;
      error?: string;
    };
    return r.ok && r.result ? r.result : null;
  },

  clearFileScrollToLine: () => {
    const { openTabs, activeTabId } = get();
    if (!activeTabId) return;
    const tab = openTabs.find((t) => t.id === activeTabId);
    if (!tab || tab.kind !== 'file' || (tab.data.scrollToLine === undefined && tab.data.scrollToQuery === undefined)) return;
    set({
      openTabs: openTabs.map((t): OpenTab => {
        if (t.id === activeTabId && t.kind === 'file') {
          return { ...t, data: { ...t.data, scrollToLine: undefined, scrollToQuery: undefined } };
        }
        return t;
      }),
    });
  },

  setPendingFileTreeSearch: (search) => set({ pendingFileTreeSearch: search }),

  setFileTreeSearchScope: (scope) => set({ fileTreeSearchScope: scope }),

  // ─── 自动更新 ──────────────────────────────────────────────────────
  checkUpdate: async () => {
    try {
      const s = (await window.api.updateCheck()) as import('../../shared/types').UpdateStatusPayload;
      set({ updateStatus: s });
      // 发现新版本 → 自动弹更新窗口；下载中发现更新版本（supersededBy）也弹窗提示切换
      if (s.phase === 'available' || s.supersededBy) set({ updateDialogOpen: true });
    } catch (e: any) {
      set({ updateStatus: { phase: 'error', currentVersion: '', configured: false, error: e?.message ?? '检查失败' } });
    }
  },
  installUpdate: async (restart = false) => {
    try {
      const s = (await window.api.updateInstall(restart)) as import('../../shared/types').UpdateStatusPayload;
      set({ updateStatus: s });
    } catch (e: any) {
      set({ updateStatus: { currentVersion: '', configured: false, ...get().updateStatus, phase: 'error', errorPhase: 'download', error: e?.message ?? '安装失败' } });
    }
  },
  cancelUpdate: async () => {
    try {
      const status = await window.api.updateCancel();
      set({ updateStatus: status });
    } catch (e: any) {
      set({ updateStatus: { currentVersion: '', configured: false, ...get().updateStatus, phase: 'error', errorPhase: 'download', error: e?.message ?? '取消下载失败' } });
    }
  },
  switchUpdate: async () => {
    try {
      const s = (await window.api.updateSwitch()) as import('../../shared/types').UpdateStatusPayload;
      set({ updateStatus: s });
    } catch (e: any) {
      set({ updateStatus: { phase: 'error', currentVersion: '', configured: false, error: e?.message ?? '切换版本失败' } });
    }
  },
  dismissSuperseded: async () => {
    try {
      const s = (await window.api.updateDismissSuperseded()) as import('../../shared/types').UpdateStatusPayload;
      set({ updateStatus: s });
    } catch (e: any) {
      set({ updateStatus: { phase: 'error', currentVersion: '', configured: false, error: e?.message ?? '操作失败' } });
    }
  },
  setUpdateDialogOpen: (open) => set({ updateDialogOpen: open }),

  setConvDraft: (convId, patch) => {
    const cur = get().convDrafts[convId] ?? { text: '', images: [], pastedTexts: [], mode: 'agent' };
    const next = { ...cur, ...patch };
    // 空草稿不占内存：内容和图片都清空时直接删掉这一项
    const empty = !next.text && (next.images?.length ?? 0) === 0 && (next.pastedTexts?.length ?? 0) === 0 && (next.mode ?? 'agent') === 'agent';
    const drafts = { ...get().convDrafts };
    if (empty) delete drafts[convId];
    else drafts[convId] = next;
    set({ convDrafts: drafts });
  },

  clearConvDraft: (convId) => {
    const drafts = get().convDrafts;
    if (!(convId in drafts)) return;
    const next = { ...drafts };
    delete next[convId];
    set({ convDrafts: next });
  },

  // ─── Scheduled Tasks (定时任务) ─────────────────────────────────────
  refreshScheduledTasks: async () => {
    const proj = get().currentProject;
    if (!proj) { set({ scheduledTasks: [] }); return; }
    const tasks = (await window.api.listScheduled(proj.path)) as ScheduledTask[];
    if(get().currentProject?.path===proj.path)set({ scheduledTasks: tasks });
  },

  refreshScheduledRuns: async (taskId) => {
    const proj = get().currentProject;
    if (!proj) { set({ scheduledRuns: [] }); return; }
    const runs = (await window.api.listScheduledRuns(proj.path, taskId)) as ScheduledRun[];
    if(get().currentProject?.path===proj.path)set({ scheduledRuns: runs });
  },

  createScheduledTask: async (name, prompt, schedule) => {
    const proj = get().currentProject;
    if (!proj) return;
    await window.api.createScheduled(proj.path, name, prompt, schedule);
    await get().refreshScheduledTasks();
  },

  updateScheduledTask: async (taskId, patch) => {
    await window.api.updateScheduled(taskId, patch);
    await get().refreshScheduledTasks();
  },

  deleteScheduledTask: async (taskId) => {
    await window.api.deleteScheduled(taskId);
    await get().refreshScheduledTasks();
  },

  toggleScheduledTask: async (taskId, enabled) => {
    await window.api.toggleScheduled(taskId, enabled);
    await get().refreshScheduledTasks();
  },

  runScheduledTaskNow: async (taskId) => {
    const r = await window.api.runScheduledNow(taskId);
    if (!r.ok && (r as any).error) set({ errorBanner: (r as any).error });
    await get().refreshScheduledTasks();
    await get().refreshScheduledRuns();
  },

  applyScheduledEvent: (e) => {
    const proj = get().currentProject;
    if (!proj || (e.projectPath && e.projectPath !== proj.path)) return;
    if (e.kind === 'task_deleted' && e.task) {
      set({scheduledTasks:get().scheduledTasks.filter(t=>t.id!==e.task!.id)});
    } else if (e.kind === 'task_updated' && e.task) {
      const tasks = get().scheduledTasks.some(t=>t.id===e.task!.id)?get().scheduledTasks.map((t) => (t.id === e.task!.id ? e.task! : t)):[...get().scheduledTasks,e.task];
      if(get().currentProject?.path===proj.path)set({ scheduledTasks: tasks });
    } else if (e.kind === 'run_started' && e.run) {
      set({ scheduledRuns: [e.run!, ...get().scheduledRuns] });
    } else if ((e.kind === 'run_finished'||e.kind==='run_updated') && e.run) {
      void get().refreshConversations();
      const runs = get().scheduledRuns.some(r=>r.id===e.run!.id)?get().scheduledRuns.map((r) => (r.id === e.run!.id ? e.run! : r)):[e.run,...get().scheduledRuns];
      if(get().currentProject?.path===proj.path)set({ scheduledRuns: runs });
    } else if (e.kind === 'run_missed' && e.run) {
      set({ scheduledRuns: [e.run!, ...get().scheduledRuns] });
    }
  },

  applyInboundEvent: (e) => {
    // 仅处理当前项目的入站消息
    const proj = get().currentProject;
    if (!proj || (e.projectPath && e.projectPath !== proj.path)) return;

    // 活动流：渠道消息事件（含投递状态与正文摘要）
    get().pushActivity({
      kind: 'channel',
      title: `${e.channelName ?? e.channelType ?? '渠道'} incoming message`,
      detail:
        e.status === 'error'
          ? `Delivery failed: ${e.error ?? 'unknown error'}`
          : e.status === 'no_binding'
            ? `No bound chat: ${(e.message?.text ?? '').slice(0, 60)}`
            : `${e.message?.senderName ? `${e.message.senderName}: ` : ''}${(e.message?.text ?? '').slice(0, 60)}`,
    });

    // 如果是当前正在查看的对话，且投递成功，就不弹 toast（消息已在对话流里）
    const cur = get().currentConversation;
    if (e.status === 'delivered' && cur && cur.id === e.convId) {
      // 刷新当前对话以拉取新消息
      void get().selectConversation(cur.id);
      return;
    }
    // 否则弹 toast（no_binding / error / 投递到其他对话）
    set({ latestInboundToast: e });
  },

  dismissInboundToast: () => set({ latestInboundToast: null }),

  applyChatEvent: (e) => {
    loadingConversationEvents.get(e.convId)?.push(e);
    if (e.sequence !== undefined) {
      if (e.sequence <= (appliedChatSequences.get(e.convId) ?? 0)) return;
      appliedChatSequences.set(e.convId, e.sequence);
    }
    if (e.type === 'queue_update') {
      const busy = { ...get().busyConvIds };
      if (e.payload.running) busy[e.convId] = true; else delete busy[e.convId];
      const stopped = { ...get().queueStoppedByConv };
      if (stopped[e.convId]) stopped[e.convId] = { ...stopped[e.convId], remaining: e.payload.messages.length };
      set({ busyConvIds: busy, queueStoppedByConv: stopped });
    }
    // 上下文整理审计同步：后端新增/合并审计后下发最新列表，
    // 修正「横幅已显示整理但面板计数仍为 0」的 store 滞后问题
    if (e.type === 'context_audit') {
      const cur = get().currentConversation;
      if (cur && cur.id === e.convId) {
        set({ currentConversation: { ...cur, contextCompactionAudits: e.payload.audits } });
      }
      return;
    }
    if (e.type === 'turn_state') {
      const busy = { ...get().busyConvIds };
      if (e.payload.running) busy[e.convId] = true;
      else delete busy[e.convId];
      set({ busyConvIds: busy });
      if (!e.payload.running) {
        const approvals = { ...get().pendingApprovalsByConv };
        const clarifies = { ...get().pendingClarifiesByConv };
        delete approvals[e.convId]; delete clarifies[e.convId];
        set({ pendingApprovalsByConv: approvals, pendingClarifiesByConv: clarifies });
      }
      return;
    }
    // ── queue_stopped: a queued message failed, queue is paused ──
    if (e.type === 'queue_stopped') {
      const { error, failedQueueId, failedText, remaining } = e.payload;
      const stoppedMap = { ...get().queueStoppedByConv };
      stoppedMap[e.convId] = {
        error: error ?? '执行失败',
        failedQueueId,
        failedText,
        remaining: remaining ?? 0,
      };
      set({ queueStoppedByConv: stoppedMap });
      // 清理 busy 状态（因为 drainQueue 不再继续，当前 turn 实际结束了）
      const { [e.convId]: _, ...restBusy } = get().busyConvIds;
      const { [e.convId]: __, ...restApprovals } = get().pendingApprovalsByConv;
      const { [e.convId]: ___, ...restClarifies } = get().pendingClarifiesByConv;
      set({
        busyConvIds: restBusy,
        pendingApprovalsByConv: restApprovals,
        pendingClarifiesByConv: restClarifies,
      });
      return;
    }

    // permission 事件需要在 convId 守卫之前处理——后台对话的审批不应丢失。
    // 用户切回该对话时可立即看到审批卡。
    if (e.type === 'permission_request') {
      const req = e.payload.request as PendingApproval;
      const existing = get().pendingApprovalsByConv[e.convId] ?? [];
      set({
        pendingApprovalsByConv: {
          ...get().pendingApprovalsByConv,
          [e.convId]: [...existing, req],
        },
      });
      return;
    }
    if (e.type === 'permission_resolved') {
      const existing = get().pendingApprovalsByConv[e.convId] ?? [];
      set({
        pendingApprovalsByConv: {
          ...get().pendingApprovalsByConv,
          [e.convId]: existing.filter((a) => a.requestId !== e.payload.requestId),
        },
      });
      // 如果当前对话不是这个 conv，跳过后续 meta 更新
      const cur = get().currentConversation;
      if (!cur || cur.id !== e.convId) return;
      // permission_resolved 不改 meta messages，直接 return
      return;
    }

    // ── clarify 事件：与 permission 同样在 convId 守卫之前处理 ──
    if (e.type === 'clarify_request') {
      const req = e.payload.request as ClarifyRequest;
      const existing = get().pendingClarifiesByConv[e.convId] ?? [];
      set({
        pendingClarifiesByConv: {
          ...get().pendingClarifiesByConv,
          [e.convId]: [...existing, req],
        },
      });
      return;
    }
    if (e.type === 'clarify_resolved') {
      const existing = get().pendingClarifiesByConv[e.convId] ?? [];
      set({
        pendingClarifiesByConv: {
          ...get().pendingClarifiesByConv,
          [e.convId]: existing.filter((c) => c.requestId !== e.payload.requestId),
        },
      });
      return;
    }

    // ── meta_update：专家团模式计划/状态流转，整体替换 meta ──
    if (e.type === 'meta_update') {
      const incoming = e.payload?.meta as ConversationMeta | undefined;
      if (!incoming) return;
      const cur = get().currentConversation;
      if (cur && cur.id === incoming.id) {
        // 保留本地正在流式追加的消息内容（meta_update 携带的 meta
        // 可能落后于已收到的 text 事件），以流式内容为准合并。
        const merged = incoming.messages.map((im) => {
          const local = cur.messages.find((lm) => lm.id === im.id);
          if (local && (local.content?.length ?? 0) > (im.content?.length ?? 0)) {
            return { ...im, content: local.content, toolCalls: local.toolCalls ?? im.toolCalls };
          }
          return im;
        });
        set({ currentConversation: { ...incoming, messages: retainQueuedMessages(merged, cur.messages, e.payload.completedClientMessageId) } });
      }
      return;
    }

    const cur = get().currentConversation;
    if (!cur || cur.id !== e.convId) return;
    const meta = { ...cur, messages: cur.messages.map((m) => ({ ...m })) };

    if (e.type === 'queue_update') {
      const queued = e.payload.messages as ChatMessage[];
      const clients = new Set(queued.map(m => m.clientMessageId).filter(Boolean));
      meta.messages = [...meta.messages.filter(m => !m.queued && !clients.has(m.id)
        && !(m.clientMessageId && clients.has(m.clientMessageId))), ...queued];
      set({ currentConversation: meta });
      return;
    }

    // ── queue_start: backend starts processing a queued message ──
    // Move the exact queued user bubble to the active timeline; message_start follows.
    if (e.type === 'queue_start') {
      const { queueId, clientMessageId } = e.payload;
      meta.messages = activateQueuedMessage(meta.messages, queueId, clientMessageId);
      // Ensure busy state is set for this conv (may have been briefly cleared)
      if (!get().busyConvIds[e.convId]) {
        set({
          currentConversation: meta,
          busyConvIds: { ...get().busyConvIds, [e.convId]: true },
        });
      } else {
        set({ currentConversation: meta });
      }
      return;
    }

    // ── queue_resuming: 用户点击了「重试」，队列继续处理 ──
    if (e.type === 'queue_resuming') {
      const { queueId } = e.payload;
      // 与 queue_start 类似，把对应的 queued 消息切到 active
      const qIdx = meta.messages.findIndex((m) => m.queued && m.queueId === queueId);
      if (qIdx >= 0) {
        meta.messages[qIdx] = {
          ...meta.messages[qIdx],
          queued: false,
          queueId: undefined,
        };
      }
      const asstTempId = `a-temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      meta.messages.push({
        id: asstTempId,
        role: 'assistant',
        content: '',
        ts: new Date().toISOString(),
        pending: true,
      });
      set({
        currentConversation: meta,
        busyConvIds: { ...get().busyConvIds, [e.convId]: true },
      });
      return;
    }

    if (e.type === 'message_start') {
      const incoming = e.payload.message as ChatMessage;
      if (incoming.role === 'user') {
        const index = meta.messages.findIndex(m => m.id === incoming.id
          || (!!incoming.clientMessageId && (m.id === incoming.clientMessageId || m.clientMessageId === incoming.clientMessageId)));
        if (index >= 0) meta.messages[index] = incoming;
        else meta.messages.push(incoming);
      } else {
        if (incoming.contextCompaction) {
          // Compaction happens before the pending assistant response is sent;
          // keep its notice directly before that response in the timeline.
          const pendingIdx = meta.messages.findIndex((m) => m.role === 'assistant' && m.pending);
          if (pendingIdx >= 0) meta.messages.splice(pendingIdx, 0, incoming);
          else if (!meta.messages.some((m) => m.id === incoming.id)) meta.messages.push(incoming);
          set({ currentConversation: meta });
          return;
        }
        // Reconcile with optimistic placeholder: if the last message is our
        // `a-temp-` assistant placeholder, replace in-place with the real one
        // (preserving any content that already streamed in — should be empty,
        // but defensive against text events that beat message_start).
        const lastIdx = meta.messages.findIndex(m => m.id.startsWith('a-temp-') && m.pending);
        if (lastIdx >= 0) {
          const tempContent = meta.messages[lastIdx].content;
          meta.messages[lastIdx] = {
            ...incoming,
            content: incoming.content || tempContent,
          };
        } else if (!meta.messages.some((m) => m.id === incoming.id)) {
          meta.messages.push(incoming);
        }
      }
    } else if (e.type === 'text') {
      let m = meta.messages.find((x) => x.id === e.msgId);
      // Fallback: if message_start hasn't landed yet (event reorder), append
      // the chunk to the still-pending a-temp- placeholder so we don't drop chars.
      if (!m) {
        const last = meta.messages[meta.messages.length - 1];
        if (last && last.id.startsWith('a-temp-')) m = last;
      }
      if (m) {
        m.content = (m.content ?? '') + e.payload.chunk;
        // 同步后端的 updatedAt，让消息气泡右下角的"最后更新"时间随流式输出实时刷新
        if (e.payload.updatedAt) m.updatedAt = e.payload.updatedAt;
        // First post-retry chunk → clear the retry hint.
        if (m.retryInfo) m.retryInfo = undefined;
      }
    } else if (e.type === 'tool_use') {
      const m = meta.messages.find((x) => x.id === e.msgId);
      if (m) {
        m.toolCalls = [...(m.toolCalls ?? []), e.payload.call as ToolCall];
        if (e.payload.updatedAt) m.updatedAt = e.payload.updatedAt;
        if (m.retryInfo) m.retryInfo = undefined;
      }
    } else if (e.type === 'review_status') {
      const m=get().currentConversation?.messages.find(x=>x.id===e.msgId);const call=m?.toolCalls?.find(c=>c.id===e.payload.callId);if(call)call.reviewStatus=e.payload.status;
      if(m){m.updatedAt=new Date().toISOString();set({currentConversation:{...get().currentConversation!}});}
    } else if (e.type === 'tool_result') {
      const m = meta.messages.find((x) => x.id === e.msgId);
      if (m && Array.isArray(e.payload.images)) m.images = e.payload.images;
      const call = m?.toolCalls?.find((c) => c.id === e.payload.callId);
      if (call) {
        if (e.payload.call) Object.assign(call, e.payload.call);
        call.result = e.payload.result;
        if (e.payload.updatedAt) m!.updatedAt = e.payload.updatedAt;
        // Auto-refresh the file tree once a write/edit tool returns, so
        // the sidebar reflects new files immediately. We only trigger on
        // known write tools to avoid spamming list IPCs from every Grep
        // / Read result. Bash is conservatively included — it commonly
        // touches the filesystem and the cost of an extra refresh is low.
        if (WRITE_TOOLS.has(call.name)) {
          void get().refreshFileTree();
        }
      }
    } else if (e.type === 'retrying') {
      // Transient hint while backoff is pending; cleared on next text/tool/end/error.
      const m = meta.messages.find((x) => x.id === e.msgId);
      if (m) {
        m.retryInfo = {
          attempt: e.payload.attempt,
          max: e.payload.max,
          waitMs: e.payload.waitMs,
          reason: e.payload.reason,
        };
      }
    } else if (e.type === 'message_end') {
      const idx = meta.messages.findIndex((x) => x.id === e.msgId);
      if (idx >= 0) {
        const incoming = e.payload.message as ChatMessage;
        // Don't persist retryInfo to the final message — it's a transient hint.
        meta.messages[idx] = { ...incoming, retryInfo: undefined };
      }
    } else if (e.type === 'interjection_reorder') {
      // 后端在 turn 结束后将 assistant 消息按插话位置拆分，
      // 用后端计算好的新消息序列替换前端的消息列表。
      const reordered = e.payload.meta as ConversationMeta;
      if (reordered && Array.isArray(reordered.messages)) {
        meta.messages = retainQueuedMessages(reordered.messages, meta.messages);
      }
    } else if (e.type === 'error') {
      const m = meta.messages.find((x) => x.id === e.msgId);
      if (m) {
        m.pending = false;
        m.error = e.payload.error;
        m.retryInfo = undefined;
      }
    }
    set({ currentConversation: meta });
  },
}));

/**
 * 共享 selector：当前显示在 FileEditor 里的文件。
 * 从 openTabs + activeTabId 派生：active tab 且 kind='file' 时返回文件数据。
 */
export function useActiveFile() {
  return useAppStore((s) => {
    if (!s.activeTabId) return undefined;
    const activeTab = s.openTabs.find((t) => t.id === s.activeTabId);
    if (!activeTab || activeTab.kind !== 'file') return undefined;
    return activeTab.data;
  });
}

export function useActiveTerminal() {
  return useAppStore((s) => {
    if (!s.activeTabId) return undefined;
    const activeTab = s.openTabs.find((t) => t.id === s.activeTabId);
    if (!activeTab || activeTab.kind !== 'terminal') return undefined;
    return activeTab.data;
  });
}

/** 所有已打开的终端 tab（供 TerminalView 遍历渲染）。 */
export function useOpenTerminals() {
  return useAppStore((s) =>
    s.openTabs
      .filter((t): t is Extract<OpenTab, { kind: 'terminal' }> => t.kind === 'terminal')
      .map((t) => t.data),
  );
}

/** 所有已打开的文件 tab（供 ExecutionView/SpecOverview 判断文件是否在 tab 中）。 */
export function useOpenFiles() {
  return useAppStore((s) =>
    s.openTabs
      .filter((t): t is Extract<OpenTab, { kind: 'file' }> => t.kind === 'file')
      .map((t) => t.data),
  );
}


const channelFields = {
  inbound:'inboundChannelIds', outbound:'outboundChannelIds',
  broadcastUser:'broadcastUserChannelIds', broadcastInbound:'broadcastInboundChannelIds',
  broadcastAssistant:'broadcastAssistantChannelIds',
} as const;
type ChannelBindingPatch = Partial<Record<keyof typeof channelFields,string[]>>;
const channelSaves = new Map<string,Promise<void>>();
async function persistChannelBindings(patch: ChannelBindingPatch): Promise<void> {
  const current = useAppStore.getState().currentConversation;
  if (!current) return;
  const {id,projectPath} = current;
  const pending = (channelSaves.get(id) ?? Promise.resolve()).then(async()=>{
    try {
      const result = await window.api.setConvChannels(projectPath,id,patch);
      if (!result.ok) throw new Error(result.error ?? '保存渠道失败');
      const fields: Partial<ConversationMeta> = {};
      for (const key of Object.keys(patch) as (keyof typeof channelFields)[]) fields[channelFields[key]] = result[key] ?? patch[key];
      useAppStore.setState(state=>({
        currentConversation:state.currentConversation?.id===id ? {...state.currentConversation,...fields} : state.currentConversation,
        conversations:state.conversations.map(conv=>conv.id===id?{...conv,...fields}:conv),
      }));
    } catch (error) {
      if (useAppStore.getState().currentConversation?.id===id) useAppStore.getState().setConvError(String((error as Error).message ?? error));
    }
  });
  channelSaves.set(id,pending);
  await pending;
  if (channelSaves.get(id)===pending) channelSaves.delete(id);
}

// Include background tabs in host leases. The IPC sends no message/draft contents.
useAppStore.subscribe((state, previous) => {
  if (state.openTabs === previous.openTabs || typeof window === 'undefined') return;
  try { window.api?.syncConversationTabs?.(state.openTabs.filter(tab => tab.kind === 'conversation').map(tab => (tab as Extract<OpenTab, { kind: 'conversation' }>).convId)); }
  catch (error) { console.warn('[tabs] Cannot synchronize conversation tabs', error); }
});
