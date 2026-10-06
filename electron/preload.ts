import { LinkDownloadChannel, type LinkDownloadResult } from '../shared/link-download';
import type { BackupGroup, SettingsImportPreview } from '../shared/settings-backup';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { SettingsVersionPreview, PrivacyStatusPayload, RelayStatusPayload } from '../shared/types';
import { IpcChannels } from '../shared/types';
import {MobileManagementChangedChannel,type MobileManagementChangedPayload} from '../shared/ipc';
import { ComposerShortcutChannels, type ComposerShortcutScope, type ComposerShortcutEvent, type ComposerShortcut, type ShortcutAvailability } from '../shared/composer-shortcuts';

// Buffer an explicit notification click while a newly opened main renderer mounts.
let pendingPetReveal: import('../shared/pet-notifications').PetNoticeTarget | undefined;
const petRevealListeners = new Set<(target: import('../shared/pet-notifications').PetNoticeTarget)=>void>();
ipcRenderer.on(IpcChannels.PetReveal, (_event, target) => {
  if (!petRevealListeners.size) pendingPetReveal = target;
  else for (const listener of petRevealListeners) listener(target);
});

const api = {
  /** DOM File must stay in the renderer; it cannot be sent through invoke(). */
  getPathForFile: (file: File): string => {
    if (!file || typeof file !== 'object') return '';
    try {
      // webUtils validates the native File brand, including Files from another realm.
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  setComposerShortcutScope: (scope?: ComposerShortcutScope) => ipcRenderer.send(ComposerShortcutChannels.scope, scope),
  onComposerShortcut: (cb: (event: ComposerShortcutEvent) => void) => {
    const listener = (_event: unknown, payload: ComposerShortcutEvent) => cb(payload);
    ipcRenderer.on(ComposerShortcutChannels.event, listener);
    return () => { ipcRenderer.removeListener(ComposerShortcutChannels.event, listener); };
  },
  probeComposerShortcuts: (): Promise<Record<ComposerShortcut, ShortcutAvailability>> => ipcRenderer.invoke(ComposerShortcutChannels.probe),
  requestComposerShortcutPriority: (): Promise<void> => ipcRenderer.invoke(ComposerShortcutChannels.priorityPermission),
  setFnShortcutRecording: (enabled: boolean, allowFn = true) => ipcRenderer.send(ComposerShortcutChannels.recordFn, enabled, allowFn),
  onFnShortcutRecorded: (cb: (accelerator: string) => void) => {
    const listener = (_event: unknown, accelerator: string) => cb(accelerator);
    ipcRenderer.on(ComposerShortcutChannels.recordedFn, listener);
    return () => { ipcRenderer.removeListener(ComposerShortcutChannels.recordedFn, listener); };
  },
  onBrowserPreviewCommand: (cb: (command: import('../shared/browser-agent').BrowserPreviewCommand) => void) => { const handler = (_event: unknown, command: import('../shared/browser-agent').BrowserPreviewCommand) => cb(command); ipcRenderer.on('browser-preview:command', handler); return () => { ipcRenderer.removeListener('browser-preview:command', handler); }; },
  replyBrowserPreview: (reply: import('../shared/browser-agent').BrowserPreviewReply) => ipcRenderer.send('browser-preview:reply', reply),
  readBrowserEvidence: (source: string): Promise<string | null> => ipcRenderer.invoke('browser-evidence:read', source),
  browserPreviewControl: (tabId: string, action: 'pause' | 'resume' | 'retain') => ipcRenderer.invoke('browser-preview:control', {tabId, action}),
  browserPreviewDisposeIdle: (args: { project: string; tabId: string; leaseId: string }): Promise<boolean> => ipcRenderer.invoke('browser-preview:dispose-idle', args),
  browserPreviewWorkspace: (args: { project?: string; openTabIds: string[]; visibleTabIds: string[] }) => ipcRenderer.invoke('browser-preview:workspace', args),
  listSystemFonts: (): Promise<Array<{family:string;monospace:boolean}>> => ipcRenderer.invoke('fonts:list'),
  claimOnboarding: (): Promise<{show: boolean; version: number}> => ipcRenderer.invoke('app:onboarding:claim'),
  chatCapabilities: (project: string, refresh = false): Promise<import('../shared/chat-capabilities').ChatCapabilities> => ipcRenderer.invoke('chat:capabilities', project, refresh),
  plugins: (operation: string, args: any = {}): Promise<any> => ipcRenderer.invoke('plugins:manage', operation, args),
  onMobileManagementChanged: (cb: (event: MobileManagementChangedPayload) => void) => { const listener = (_event: unknown, payload: MobileManagementChangedPayload) => cb(payload); ipcRenderer.on(MobileManagementChangedChannel, listener); return () => { ipcRenderer.removeListener(MobileManagementChangedChannel, listener); }; },
  onPluginsChanged: (cb: () => void) => { const f = () => cb(); ipcRenderer.on('plugins:changed', f); return () => { ipcRenderer.removeListener('plugins:changed', f); }; },
  onPluginNotification: (cb: (value: any) => void) => { const f = (_e: any, value: any) => cb(value); ipcRenderer.on('plugins:notification', f); return () => { ipcRenderer.removeListener('plugins:notification', f); }; },
  relayModelsSchedule: (): Promise<{ nextAt: number; refreshing: boolean }> => ipcRenderer.invoke(IpcChannels.RelayModelsSchedule),
  relayModels: () => ipcRenderer.invoke(IpcChannels.RelayModelsList),
  modelPricesCache: (models: string[] = [], options?: { force?: boolean }) => ipcRenderer.invoke('model-prices-cache', models, options),
  providerModelsSchedule: (): Promise<{ nextAt: number; refreshing: boolean }> => ipcRenderer.invoke(IpcChannels.ProviderModelsSchedule),
  providerModelsRefresh: (providerId: string): Promise<{ ok: boolean; listSupported?: boolean; error?: string; models: string[]; named: NonNullable<import('../shared/types').ModelProvider['relayModels']> }> => ipcRenderer.invoke(IpcChannels.ProviderModelsRefresh, providerId),
  getSettings: () => ipcRenderer.invoke(IpcChannels.AppSettingsGet),
  setSettings: (patch: any, revision: string) => ipcRenderer.invoke(IpcChannels.AppSettingsSet, patch, revision),
  setMcpEnvironmentVariables: (values: Record<string,string>, baselineNames: string[]) => ipcRenderer.invoke(IpcChannels.McpEnvironmentSet, values, baselineNames),
  exportSettings: (args: { password: string; policy: { apiKey: boolean; apiHost: boolean }; groups?: BackupGroup[] }) => ipcRenderer.invoke(IpcChannels.SettingsExport, args),
  importSettings: (args: { password: string; mode: 'merge' | 'replace' }) => ipcRenderer.invoke(IpcChannels.SettingsImport, args),
  previewSettingsVersion: (name: string): Promise<SettingsVersionPreview> => ipcRenderer.invoke(IpcChannels.SettingsVersionPreview, name),
  previewSettingsImport: (password: string): Promise<{canceled: boolean; preview?: SettingsImportPreview}> => ipcRenderer.invoke(IpcChannels.SettingsImportPreview, password),
  applySettingsImport: (ticket: string, groups: BackupGroup[]) => ipcRenderer.invoke(IpcChannels.SettingsImportApply, ticket, groups),
  settingsVersions: (): Promise<string[]> => ipcRenderer.invoke(IpcChannels.SettingsVersions),
  restoreSettings: (name: string, revision: string) => ipcRenderer.invoke(IpcChannels.SettingsRestore, name, revision),
  captureFeedbackScreenshot: (): Promise<string> => ipcRenderer.invoke(IpcChannels.FeedbackCapture),
  /** 提交反馈（主进程拼装上下文并 POST 到反馈服务器）。 */
  submitFeedback: (sub: any) => ipcRenderer.invoke(IpcChannels.FeedbackSubmit, sub),
  /** 反馈服务自检（入参可选自定义地址覆盖；返回 ProbeResult）。 */
  probeFeedbackService: (urlOverride?: string) => ipcRenderer.invoke(IpcChannels.FeedbackProbe, urlOverride),
  /** 更新源自检（入参可选自定义地址覆盖；返回 ProbeResult）。 */
  probeUpdateService: (urlOverride?: string) => ipcRenderer.invoke(IpcChannels.UpdateProbe, urlOverride),
  /** 中继站点 Token 申请页（<地址>/apply）自检；ProbeResult.url 即可打开的申请页地址。 */
  probeRelayCertificate: (url: string): Promise<import('../shared/relay-certificate').RelayCertificateProbe> => ipcRenderer.invoke(IpcChannels.RelayCertificateProbe, url),
  probeRelayApply: (urlOverride?: string) => ipcRenderer.invoke(IpcChannels.RelayApplyProbe, urlOverride),
  applyWebviewEmulation: (webContentsId: number, emu: any) =>
    ipcRenderer.invoke(IpcChannels.WebviewEmulate, webContentsId, emu),
  codexStatus: () => ipcRenderer.invoke(IpcChannels.CodexStatus),
  claudeStatus: () => ipcRenderer.invoke(IpcChannels.ClaudeStatus),
  /** 获取应用版本号（package.json version）。 */
  appVersion: () => ipcRenderer.invoke(IpcChannels.AppVersion),
  apiUserAgentVersions: (): Promise<import('../shared/api-user-agent').ApiUserAgentVersions> => ipcRenderer.invoke(IpcChannels.ApiUserAgentVersions),
  /** 手动检查更新，返回最新状态。 */
  updateCheck: () => ipcRenderer.invoke(IpcChannels.UpdateCheck),
  /** 下载并安装更新（完成后自动重启）。 */
  updateInstall: (restart = false) => ipcRenderer.invoke(IpcChannels.UpdateInstall, restart),
  /** 下载中发现更新版本：中止旧下载（删除部分文件）并改下新版本。 */
  updateCancel: () => ipcRenderer.invoke(IpcChannels.UpdateCancel),
  updateSwitch: () => ipcRenderer.invoke(IpcChannels.UpdateSwitch),
  /** 忽略「发现更新版本」提示，继续当前下载。 */
  updateDismissSuperseded: () => ipcRenderer.invoke(IpcChannels.UpdateDismissSuperseded),
  /** 跨对话汇总所有上下文整理审计记录（设置页记录查看器）。 */
  contextAuditList: () => ipcRenderer.invoke(IpcChannels.ContextAuditList),
  /** 拉取当前更新状态快照。 */
  updateStatusGet: () => ipcRenderer.invoke(IpcChannels.UpdateStatus),
  /** 订阅更新状态推送，返回取消订阅函数。 */
  onUpdateStatus: (cb: (s: import('../shared/types').UpdateStatusPayload) => void) => {
    const listener = (_evt: any, payload: any) => cb(payload);
    ipcRenderer.on(IpcChannels.UpdateStatus, listener);
    return () => ipcRenderer.removeListener(IpcChannels.UpdateStatus, listener);
  },
  /** 测试提供商连接。models = 提供商已配置的模型（主进程取第一个做真实调用），空 = 只测接口连通性。 */
  testApiConnection: (apiKey: string, baseUrl?: string, protocol?: 'anthropic' | 'openai', providerId?: string, models?: string[]) =>
    ipcRenderer.invoke(IpcChannels.ApiTestConnection, { apiKey, baseUrl, protocol, providerId, models }),

  pickProject: () => ipcRenderer.invoke(IpcChannels.ProjectPick),
  listProjects: () => ipcRenderer.invoke(IpcChannels.ProjectList),
  setProjectIcon: (projectPath: string, icon?: string) => ipcRenderer.invoke(IpcChannels.ProjectSetIcon, { projectPath, icon }),
  markConversationRead: (id: string, revision: number) => ipcRenderer.invoke(IpcChannels.ConvMarkRead, { id, revision }),
  /** 把指定目录直接注册为项目（文件树右键「作为 Sage 项目打开」）。 */
  addProject: (p: string) => ipcRenderer.invoke(IpcChannels.ProjectAdd, p),
  removeProject: (p: string, purgeData?: boolean) =>
    ipcRenderer.invoke(IpcChannels.ProjectRemove, p, purgeData),
  touchProject: (p: string) =>
    ipcRenderer.invoke(IpcChannels.ProjectTouch, p),
  setProjectModel: (p: string, modelProfileId?: string) =>
    ipcRenderer.invoke(IpcChannels.ProjectSetModel, p, modelProfileId),
  setProjectSelectedModel: (p: string, selected: import("../shared/types").SelectedModel | null) =>
    ipcRenderer.invoke(IpcChannels.ProjectSetSelectedModel, p, selected),
  setProjectSelectedVisionModel: (p: string, selected: import("../shared/types").SelectedModel | null) =>
    ipcRenderer.invoke(IpcChannels.ProjectSetSelectedVisionModel, p, selected),
  setProjectEnabledPlugins: (p: string, enabledPlugins: string[]) =>
    ipcRenderer.invoke(IpcChannels.ProjectSetEnabledPlugins, { projectPath: p, enabledPlugins }),
  setProjectSandboxOverrides: (p: string, overrides: any) =>
    ipcRenderer.invoke(IpcChannels.ProjectSetSandboxOverrides, p, overrides),
  getSandboxDefaults: () => ipcRenderer.invoke(IpcChannels.SandboxDefaultsGet),
  /** 读取沙箱审计日志（最近 limit 条，倒序）。 */
  getAuditLog: (query?: number | import('../shared/types').AuditQuery) => ipcRenderer.invoke(IpcChannels.AuditLogGet, typeof query === 'number' ? {limit:query} : query),
  /** 在 Finder 中显示审计日志文件。 */
  openAuditLogInFinder: () => ipcRenderer.invoke(IpcChannels.AuditLogOpenInFinder),
  /** 设置当前审计上下文的项目路径。 */
  setAuditProject: (projectPath: string | null) => ipcRenderer.invoke(IpcChannels.AuditLogSetProject, projectPath),
  getProjectStats: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.ProjectStatsGet, projectPath),
  getGlobalStats: () =>
    ipcRenderer.invoke(IpcChannels.GlobalStatsGet),

  createSpec: (projectPath: string, title: string, description: string) =>
    ipcRenderer.invoke(IpcChannels.SpecCreate, { projectPath, title, description }),
  listSpecs: (projectPath: string) => ipcRenderer.invoke(IpcChannels.SpecList, projectPath),
  getSpec: (specId: string) => ipcRenderer.invoke(IpcChannels.SpecGet, specId),
  generatePhase: (specId: string, phase: 'requirements' | 'design' | 'tasks', feedback?: string, lang?: string) =>
    ipcRenderer.invoke(IpcChannels.SpecGenerate, { specId, phase, feedback, lang }),
  approvePhase: (specId: string, phase: 'requirements' | 'design' | 'tasks') =>
    ipcRenderer.invoke(IpcChannels.SpecApprove, { specId, phase }),
  executeSpec: (specId: string, lang?: string) =>
    ipcRenderer.invoke(IpcChannels.SpecExecute, { specId, lang }),
  retryTask: (specId: string, taskId: string, lang?: string) =>
    ipcRenderer.invoke(IpcChannels.SpecRetryTask, { specId, taskId, lang }),
  abortSpec: (specId: string) => ipcRenderer.invoke(IpcChannels.SpecAbort, specId),
  updateDoc: (specId: string, phase: 'requirements' | 'design' | 'tasks', content: string) =>
    ipcRenderer.invoke(IpcChannels.SpecUpdateDoc, { specId, phase, content }),
  listSpecChat: (specId: string, phase: 'requirements' | 'design' | 'tasks') =>
    ipcRenderer.invoke(IpcChannels.SpecChatList, { specId, phase }),
  refineSpecChat: (specId: string, phase: 'requirements' | 'design' | 'tasks', message: string, lang?: string) =>
    ipcRenderer.invoke(IpcChannels.SpecChatRefine, { specId, phase, message, lang }),
  deleteSpec: (specId: string) => ipcRenderer.invoke(IpcChannels.SpecDelete, specId),
  openInFinder: (p: string) => ipcRenderer.invoke(IpcChannels.SpecOpenInFinder, p),
  retroAnalyze: (projectPath: string, scopePath?: string, title?: string, lang?: string) =>
    ipcRenderer.invoke(IpcChannels.SpecRetroAnalyze, { projectPath, scopePath, title, lang }),
  optimizeAnalyze: (projectPath: string, title?: string, lang?: string) =>
    ipcRenderer.invoke(IpcChannels.SpecOptimizeAnalyze, { projectPath, title, lang }),
  abortAnalysis: (key: string) =>
    ipcRenderer.invoke(IpcChannels.SpecAbort, { key }),

  wikiGenerate: (projectPath: string, lang?: string, depth?: import('../shared/types').WikiDepth) =>
    ipcRenderer.invoke(IpcChannels.WikiGenerate, { projectPath, lang, depth }),
  wikiLoad: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.WikiLoad, projectPath),
  wikiDelete: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.WikiDelete, projectPath),

  // Loop Engineering
  loopStart: (specId: string, config: any, lang?: string) =>
    ipcRenderer.invoke(IpcChannels.LoopStart, { specId, config, lang }),
  loopStop: (specId: string) =>
    ipcRenderer.invoke(IpcChannels.LoopStop, { specId }),
  loopResume: (specId: string, feedback?: string) =>
    ipcRenderer.invoke(IpcChannels.LoopResume, { specId, feedback }),
  loopGetState: (specId: string) =>
    ipcRenderer.invoke(IpcChannels.LoopGetState, specId),
  loopExportSkill: (specId: string) =>
    ipcRenderer.invoke(IpcChannels.LoopExportSkill, specId),

  // Global Skills（客户端级共享 skill，所有项目通用）
  listGlobalSkills: () =>
    ipcRenderer.invoke(IpcChannels.GlobalSkillList),
  getGlobalSkillsDir: () =>
    ipcRenderer.invoke(IpcChannels.GlobalSkillDir),
  openGlobalSkillsDir: () =>
    ipcRenderer.invoke(IpcChannels.GlobalSkillOpenDir),
  openProjectSkillsDir: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.ProjectSkillOpenDir, projectPath),

  getSteering: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.SteeringGet, projectPath),
  setSteering: (
    projectPath: string,
    kind: 'product' | 'tech' | 'structure',
    content: string,
  ) => ipcRenderer.invoke(IpcChannels.SteeringSet, { projectPath, kind, content }),

  // Conversations
  createConv: (projectPath: string, title?: string, permissionMode?: any) =>
    ipcRenderer.invoke(IpcChannels.ConvCreate, { projectPath, title, permissionMode }),
  listConvs: (projectPath: string) => ipcRenderer.invoke(IpcChannels.ConvList, projectPath),
  closeConversationTab: (id: string, projectPath: string, keep: boolean) =>
    ipcRenderer.invoke(IpcChannels.ConvCloseTab, { id, projectPath, keep }) as Promise<{ ok: boolean; deleted: boolean }>,
  syncConversationTabs: (ids: string[]) => ipcRenderer.send(IpcChannels.ConvTabsSync, ids),
  convSetArchived: (projectPath: string, id: string, archived: boolean) =>
    ipcRenderer.invoke(IpcChannels.ConvSetArchived, { projectPath, id, archived }) as Promise<any>,
  convSearch: (projectPath: string, query: string) =>
    ipcRenderer.invoke(IpcChannels.ConvSearch, { projectPath, query }) as Promise<any>,
  getConv: (id: string, openingTab = false) => ipcRenderer.invoke(IpcChannels.ConvGet, openingTab ? { id, openingTab: true } : id),
  // 一次性文本补全（优化输入等）：不创建对话，返回模型纯文本结果
  // requestId 可选：带上后可用 llmCompleteAbort(requestId) 取消进行中的补全
  llmComplete: (req: { prompt: string; selectedModel?: import("../shared/types").SelectedModel; followGlobal?: boolean; convId?: string; projectPath?: string; requestId?: string }) =>
    ipcRenderer.invoke(IpcChannels.LlmComplete, req),
  llmCompleteAbort: (requestId: string) => ipcRenderer.invoke(IpcChannels.LlmCompleteAbort, requestId),
  // 语音输入（macOS 系统 Speech 听写）：start/stop + 识别事件推送
  captureScreenshot: (): Promise<void> => ipcRenderer.invoke(IpcChannels.ScreenshotCapture),
  voiceStart: (locale: string) => ipcRenderer.invoke(IpcChannels.VoiceStart, locale) as Promise<{ ok: boolean; error?: string }>,
  voiceStop: () => ipcRenderer.invoke(IpcChannels.VoiceStop) as Promise<{ ok: boolean }>,
  voiceAudio: (b64: string) => { ipcRenderer.send(IpcChannels.VoiceAudio, b64); },
  // 语音诊断打点（渲染层）：汇入主进程 ~/Library/Logs/Sage/voice.log
  voiceDiag: (msg: string) => { ipcRenderer.send(IpcChannels.VoiceDiag, msg); },
  // 麦克风 TCC 授权（主进程 askForMediaAccess）：not-determined 时弹系统框
  voiceEnsureMic: (): Promise<{ ok: boolean; status?: string }> => ipcRenderer.invoke('voice:ensure-mic'),
  // TCC 秒拒自救：tccutil 清除本 bundle 的麦克风/语音识别记录，配合 ensure-mic 重新发起授权
  voiceResetMicTcc: (): Promise<{ ok: boolean; status?: string; detail?: string }> => ipcRenderer.invoke('voice:reset-mic-tcc'),
  openSystemPrivacy: (pane: 'camera' | 'microphone' | 'speech' | 'notifications' | 'screen') => ipcRenderer.invoke(IpcChannels.OpenSystemPrivacy, pane) as Promise<{ ok: boolean }>,
  // 系统权限（TCC）总览与测试通知（安全与授权页）：统一状态字符串 + 本构建的签名身份信息
  privacyStatus: () => ipcRenderer.invoke(IpcChannels.PrivacyStatus) as Promise<PrivacyStatusPayload>,
  cameraGrant: () => ipcRenderer.invoke(IpcChannels.PrivacyCameraGrant) as Promise<{ ok: boolean; status?: string; error?: string }>,
  speechGrant: () => ipcRenderer.invoke(IpcChannels.PrivacySpeechGrant) as Promise<{ ok: boolean; status?: string; error?: string }>,
  // MCP 管理：测试连接并拉工具列表（主进程按 transport 分发 stdio/http）
  mcpTest: (server: unknown) => ipcRenderer.invoke(IpcChannels.McpTest, server) as Promise<{ ok: boolean; tools?: Array<{ name: string; description: string }>; error?: string }>,
  notifyTest: () => ipcRenderer.invoke(IpcChannels.NotifyTest) as Promise<{ ok: boolean; granted?: boolean | 'unknown'; error?: string }>,
  // 桌面宠物：交互区切换鼠标穿透 / 跳回主窗口 / 接收后台推送气泡 / 左键拖拽 / 右键退出
  petSetInteractive: (interactive: boolean) => { ipcRenderer.send(IpcChannels.PetSetInteractive, interactive); },
  petOpenMain: (noticeId?: string) => ipcRenderer.invoke(IpcChannels.PetOpenMain, noticeId) as Promise<{ ok: boolean }>,
  petDockState: () => ipcRenderer.invoke(IpcChannels.PetDockState) as Promise<import('../shared/pet').PetEdge | null>,
  petUndock: () => ipcRenderer.send(IpcChannels.PetUndock),
  petIdle: (idle: boolean) => ipcRenderer.send(IpcChannels.PetIdle, idle),
  petSetStyle: (style: 'pixel' | 'comic' | 'dog-pixel' | 'dog-comic' | 'none') => ipcRenderer.invoke(IpcChannels.PetStyle, style) as Promise<void>,
  onPetDock: (cb: (state: import('../shared/pet').PetDockState) => void) => {
    const listener = (_event: unknown, state: Parameters<typeof cb>[0]) => cb(state);
    ipcRenderer.on(IpcChannels.PetDock, listener);
    return () => ipcRenderer.removeListener(IpcChannels.PetDock, listener);
  },
  petDragStart: () => { ipcRenderer.send(IpcChannels.PetDragStart); },
  petDragEnd: () => { ipcRenderer.send(IpcChannels.PetDragEnd); },
  // 宠物窗口尺寸贴合可见内容（主进程保持右下角锚点不动，compose 向左展开）。
  // pin='top'：项目面板开在下方时钉住顶边向下长，胶囊才不会整块往上跳。
  petResize: (w: number, h: number, pin?: 'top' | 'bottom') => { ipcRenderer.send(IpcChannels.PetResize, w, h, pin ?? 'bottom'); },
  // 窗户外面上下还各剩多少屏幕空间（workArea 口径）：项目面板决定向上还是向下开。
  // 宠物窗只包住内容，渲染层自己算不出屏幕坐标，只能问主进程。
  petRoom: () => ipcRenderer.invoke(IpcChannels.PetRoom) as Promise<{ above: number; below: number } | null>,
  petExit: () => { ipcRenderer.send(IpcChannels.PetExit); },
  petActivity: (item: import('../shared/pet-notifications').PetActivity) => ipcRenderer.send(IpcChannels.PetActivity, item),
  onPetReveal: (cb: (target: import('../shared/pet-notifications').PetNoticeTarget) => void) => {
    petRevealListeners.add(cb);
    if (pendingPetReveal) {const target=pendingPetReveal;pendingPetReveal=undefined;cb(target);}
    return () => {petRevealListeners.delete(cb);};
  },
  onPetPush: (cb: (e: import('../shared/pet-notifications').PetNotice) => void) => {
    const listener = (_evt: any, payload: import('../shared/pet-notifications').PetNotice) => cb(payload);
    ipcRenderer.on(IpcChannels.PetPush, listener);
    return () => ipcRenderer.removeListener(IpcChannels.PetPush, listener);
  },
  onVoiceEvent: (cb: (e: { t: string; text?: string; message?: string; auth?: string; which?: string }) => void) => {
    const listener = (_evt: any, payload: { t: string; text?: string; message?: string; auth?: string }) => cb(payload);
    ipcRenderer.on(IpcChannels.VoiceEvent, listener);
    return () => { ipcRenderer.removeListener(IpcChannels.VoiceEvent, listener); };
  },
  sendConv: (
    id: string,
    text: string,
    images?: Array<{ name: string; mimeType: string; dataBase64: string }>,
    /** 执行模式：仅对话第一句生效。 */
    mode?: 'agent' | 'experts' | 'auto',
    clientMessageId?: string,
  ) => ipcRenderer.invoke(IpcChannels.ConvSend, { id, text, images, mode, clientMessageId }),
  /** 插话：执行过程中注入消息，下一个安全边界生效（不停止当前执行）。图片与文字同属一个整体一并携带。 */
  interjectChat: (
    id: string,
    text: string,
    images?: Array<{ name: string; mimeType: string; dataBase64: string }>,
    queueId?: string,
  ) => ipcRenderer.invoke(IpcChannels.ConvInterject, { id, text, images, queueId }),
  /** 专家团模式：计划确认 / 重新规划 / 取消。 */
  expertsConfirmPlan: (convId: string, action: 'confirm' | 'replan' | 'cancel', feedback?: string) =>
    ipcRenderer.invoke(IpcChannels.ExpertsConfirmPlan, { convId, action, feedback }),
  expertsRetryFailed: (convId: string) =>
    ipcRenderer.invoke(IpcChannels.ExpertsRetryFailedTasks, { convId }),
  abortConv: (id: string, reason?: 'project-switch') => ipcRenderer.invoke(IpcChannels.ConvAbort, id, reason),
  /** 查询对话是否真的在执行（权威判据：后端 aborters / convDraining）。 */
  isConvRunning: (id: string) => ipcRenderer.invoke(IpcChannels.ConvIsRunning, id),
  respondPermission: (requestId: string, decision: 'allow' | 'deny' | 'allow-conv' | 'allow-conv-command', updatedInput?: any, message?: string) =>
    ipcRenderer.invoke(IpcChannels.ConvPermissionResponse, { requestId, decision, updatedInput, message }),
  /** 澄清回答回填（AskUser 工具的问题卡片）。 */
  respondClarify: (requestId: string, answer: string) =>
    ipcRenderer.invoke(IpcChannels.ConvClarifyResponse, { requestId, answer }),
  updateConvMeta: (id: string, patch: any) =>
    ipcRenderer.invoke(IpcChannels.ConvUpdateMeta, { id, patch }),
  deleteConv: (id: string, projectPath?: string) =>
    ipcRenderer.invoke(IpcChannels.ConvDelete, { id, projectPath }),
  deleteConvMessage: (convId: string, msgId: string | string[]) =>
    ipcRenderer.invoke(IpcChannels.ConvDeleteMessage, { convId, msgId }),
  compactConversation: (convId: string, keepRecentTurns?: number) =>
    ipcRenderer.invoke(IpcChannels.ConvCompact, { convId, keepRecentTurns }),
  removeQueuedMessage: (convId: string, queueId: string) =>
    ipcRenderer.invoke(IpcChannels.ConvQueueRemove, { convId, queueId }),
  reorderQueuedMessages: (convId: string, queueIds: string[]) =>
    ipcRenderer.invoke(IpcChannels.ConvQueueReorder, { convId, queueIds }),
  resumeQueue: (convId: string) =>
    ipcRenderer.invoke(IpcChannels.ConvQueueResume, { convId }),
  retryQueue: (convId: string) =>
    ipcRenderer.invoke(IpcChannels.ConvQueueRetry, { convId }),
  getQueuedFailed: (convId: string) =>
    ipcRenderer.invoke(IpcChannels.ConvQueueGetFailed, { convId }),
  listQueuedMessages: (convId: string) =>
    ipcRenderer.invoke(IpcChannels.ConvQueueList, convId),

  // Files
  listFiles: (projectPath: string, relPath?: string) =>
    ipcRenderer.invoke(IpcChannels.FilesList, { projectPath, relPath }),
  readFile: (projectPath: string, relPath: string) =>
    ipcRenderer.invoke(IpcChannels.FilesRead, { projectPath, relPath }),
  /** 取文件元信息（大小 / 修改时间），保存后刷新头部「最后更新时间」。 */
  fileStat: (projectPath: string, relPath: string) =>
    ipcRenderer.invoke(IpcChannels.FilesStat, { projectPath, relPath }),
  readFileAsBase64: (projectPath: string, relPath: string) =>
    ipcRenderer.invoke(IpcChannels.FilesReadAsBase64, { projectPath, relPath }),
  writeFile: (projectPath: string, relPath: string, content: string) =>
    ipcRenderer.invoke(IpcChannels.FilesWrite, { projectPath, relPath, content }),
  searchFiles: (projectPath: string, query: string, limit?: number, scope?: string) =>
    ipcRenderer.invoke(IpcChannels.FilesSearch, { projectPath, query, limit, scope }),
  searchFileContents: (projectPath: string, query: string, scope?: string) =>
    ipcRenderer.invoke(IpcChannels.FilesSearchContent, { projectPath, query, scope }),
  mkdir: (projectPath: string, relPath: string) =>
    ipcRenderer.invoke(IpcChannels.FilesMkdir, { projectPath, relPath }),
  createFile: (projectPath: string, relPath: string, content?: string) =>
    ipcRenderer.invoke(IpcChannels.FilesCreate, { projectPath, relPath, content }),

  // Multi-window
  openNewWindow: (projectPath?: string) =>
    ipcRenderer.invoke(IpcChannels.WindowOpen, { projectPath }),
  getAutoSelectProject: () =>
    ipcRenderer.invoke(IpcChannels.WindowGetAutoSelectProject),

  gitBranchAction: (projectPath: string, request: import('../shared/git-branch-action').GitBranchRequest): Promise<void> => ipcRenderer.invoke('git:branch-action', { projectPath, request }),
  // Git / DeepWiki
  getGitRepoInfo: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.GitRepoInfo, projectPath),
  gitBranchList: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.GitBranchList, projectPath),
  gitCurrentBranch: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.GitCurrentBranch, projectPath),
  gitCheckout: (projectPath: string, branch: string) =>
    ipcRenderer.invoke(IpcChannels.GitCheckout, { projectPath, branch }),
  gitBranchCreate: (projectPath: string, name: string, opts?: { base?: string; checkout?: boolean }) =>
    ipcRenderer.invoke(IpcChannels.GitBranchCreate, { projectPath, name, opts }),
  gitBranchDelete: (projectPath: string, name: string, opts?: { force?: boolean }) =>
    ipcRenderer.invoke(IpcChannels.GitBranchDelete, { projectPath, name, opts }),
  gitPull: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.GitPull, projectPath),
  gitPush: (projectPath: string, opts?: { setUpstream?: boolean; forceWithLease?: boolean; remote?: string }) =>
    ipcRenderer.invoke(IpcChannels.GitPush, { projectPath, opts }),
  gitStatus: (projectPath: string): Promise<import('./git-utils').GitFileStatus[]> =>
    ipcRenderer.invoke(IpcChannels.GitStatus, projectPath),
  gitStage: (projectPath: string, paths: string[]) =>
    ipcRenderer.invoke(IpcChannels.GitStage, { projectPath, paths }),
  gitUnstage: (projectPath: string, paths: string[]) =>
    ipcRenderer.invoke(IpcChannels.GitUnstage, { projectPath, paths }),
  gitCommit: (projectPath: string, message: string) =>
    ipcRenderer.invoke(IpcChannels.GitCommit, { projectPath, message }),
  gitDiff: (projectPath: string, ref1?: string, ref2?: string) =>
    ipcRenderer.invoke(IpcChannels.GitDiff, { projectPath, ref1, ref2 }),
  gitFileDiff: (projectPath: string, filePath: string, ref1?: string, ref2?: string) =>
    ipcRenderer.invoke(IpcChannels.GitFileDiff, { projectPath, filePath, ref1, ref2 }),
  gitLog: (projectPath: string, opts?: { limit?: number; ref?: string; path?: string; skip?: number }) =>
    ipcRenderer.invoke(IpcChannels.GitLog, { projectPath, opts }),
  gitLogGraph: (projectPath: string, opts?: { limit?: number; ref?: string; refs?: string[]; only?: boolean; path?: string; skip?: number }) =>
    ipcRenderer.invoke(IpcChannels.GitLogGraph, { projectPath, opts }) as Promise<any>,
  gitBrowserRefs: (root:string,force?:boolean)=>ipcRenderer.invoke(IpcChannels.GitBrowserRefs,root,force) as Promise<Awaited<ReturnType<typeof import('./git-browser').gitBrowserRefs>>>,
  gitBrowserCommit: (root:string,ref:string)=>ipcRenderer.invoke(IpcChannels.GitBrowserCommit,{root,ref}) as Promise<Awaited<ReturnType<typeof import('./git-browser').gitBrowserCommit>>>,
  gitBrowserFile: (root:string,ref:string,file:string,patch=false,base64=false)=>ipcRenderer.invoke(IpcChannels.GitBrowserFile,{root,ref,file,patch,base64}) as Promise<{text:string;binary:boolean;base64?:boolean}>,
  gitBrowserFetch: (root:string)=>ipcRenderer.invoke(IpcChannels.GitBrowserFetch,root),
  gitShow: (projectPath: string, ref: string) =>
    ipcRenderer.invoke(IpcChannels.GitShow, { projectPath, ref }),
  gitDiffFiles: (projectPath: string, ref1: string, ref2?: string) =>
    ipcRenderer.invoke(IpcChannels.GitDiffFiles, { projectPath, ref1, ref2 }),
  gitDiscoverRepos: (projectPath: string, force = false) =>
    ipcRenderer.invoke(IpcChannels.GitDiscoverRepos, projectPath, force) as Promise<any>,
  gitInit: (projectPath: string, relDir?: string) =>
    ipcRenderer.invoke(IpcChannels.GitInit, { projectPath, relDir }) as Promise<any>,
  openPdf: (projectPath: string, relPath: string, external = false) =>
    ipcRenderer.invoke(IpcChannels.OpenPdf, { projectPath, relPath, external }) as Promise<{ok:boolean;url?:string;error?:string}>,
  openExternal: (url: string) =>
    ipcRenderer.invoke(IpcChannels.OpenExternal, url),
  saveLink: (url: string): Promise<LinkDownloadResult> => ipcRenderer.invoke(LinkDownloadChannel, url),

  // Terminal
  terminalCreate: (cwd: string) =>
    ipcRenderer.invoke(IpcChannels.TerminalCreate, { cwd }),
  terminalWrite: (id: string, data: string) =>
    ipcRenderer.send(IpcChannels.TerminalData, { id, data }),
  terminalAcknowledge: (id: string, count: number, ready = false) =>
    ipcRenderer.send(IpcChannels.TerminalAcknowledge, {id, count, ready}),
  terminalResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IpcChannels.TerminalResize, { id, cols, rows }),
  terminalDispose: (id: string) =>
    ipcRenderer.invoke(IpcChannels.TerminalDispose, { id }),
  onTerminalOutput: (cb: (e: { id: string; data: string }) => void) => {
    const listener = (_evt: any, payload: { id: string; data: string }) => cb(payload);
    ipcRenderer.on(IpcChannels.TerminalOutput, listener);
    return () => ipcRenderer.removeListener(IpcChannels.TerminalOutput, listener);
  },
  onTerminalExit: (cb: (e: { id: string; code: number }) => void) => {
    const listener = (_evt: any, payload: { id: string; code: number }) => cb(payload);
    ipcRenderer.on(IpcChannels.TerminalExit, listener);
    return () => ipcRenderer.removeListener(IpcChannels.TerminalExit, listener);
  },

  onStream: (cb: (e: any) => void) => {
    const listener = (_evt: any, payload: any) => cb(payload);
    ipcRenderer.on(IpcChannels.StreamEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannels.StreamEvent, listener);
  },
  onChat: (cb: (e: any) => void) => {
    const listener = (_evt: any, payload: any) => cb(payload);
    ipcRenderer.on(IpcChannels.ChatEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ChatEvent, listener);
  },
  // 跨窗口的对话清单变化（宠物/其它窗口新建、删除、归档）：ChatEvent 只发给发起方，
  // 主窗口靠这条把缺的那条对话补进左栏（不整表重拉，见 appStore.syncConvListChanged）。
  onConvListChanged: (cb: (e: any) => void) => {
    const listener = (_evt: any, payload: any) => cb(payload);
    ipcRenderer.on(IpcChannels.ConvListChanged, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ConvListChanged, listener);
  },

  // Request Monitor
  listMonitor: () => ipcRenderer.invoke(IpcChannels.MonitorList),
  clearMonitor: (projectPath?: string) =>
    ipcRenderer.invoke(IpcChannels.MonitorClear, projectPath),
  loadMonitorProject: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.MonitorLoadProject, projectPath),
  loadMonitorAll: () => ipcRenderer.invoke(IpcChannels.MonitorLoadAll) as Promise<import('../shared/types').MonitorRecord[]>,
  onMonitor: (cb: (e: import('../shared/types').MonitorEventPayload) => void) => {
    const listener = (_evt: any, payload: any) => cb(payload);
    ipcRenderer.on(IpcChannels.MonitorEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannels.MonitorEvent, listener);
  },

  // Scheduled Tasks
  listScheduled: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.ScheduledList, projectPath),
  createScheduled: (projectPath: string, name: string, prompt: string, schedule: any, options?: import('../shared/types').ScheduledTaskInput) =>
    ipcRenderer.invoke(IpcChannels.ScheduledCreate, { projectPath, name, prompt, schedule, options }),
  updateScheduled: (taskId: string, patch: any, expectedUpdatedAt?:string) =>
    ipcRenderer.invoke(IpcChannels.ScheduledUpdate, { taskId, patch, expectedUpdatedAt }),
  deleteScheduled: (taskId: string) =>
    ipcRenderer.invoke(IpcChannels.ScheduledDelete, taskId),
  toggleScheduled: (taskId: string, enabled: boolean) =>
    ipcRenderer.invoke(IpcChannels.ScheduledToggle, { taskId, enabled }),
  respondScheduledApproval: (projectPath:string,runId:string,requestId:string,decision:'allow'|'deny') => ipcRenderer.invoke(IpcChannels.ScheduledApproval,{projectPath,runId,requestId,decision}),
  runScheduledNow: (taskId: string) =>
    ipcRenderer.invoke(IpcChannels.ScheduledRunNow, taskId),
  listScheduledRuns: (projectPath: string, taskId?: string) =>
    ipcRenderer.invoke(IpcChannels.ScheduledListRuns, { projectPath, taskId }),
  onScheduled: (cb: (e: import('../shared/types').ScheduledEventPayload) => void) => {
    const listener = (_evt: any, payload: any) => cb(payload);
    ipcRenderer.on(IpcChannels.ScheduledEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ScheduledEvent, listener);
  },
  // Channels (通知渠道)
  listChannelTypes: () =>
    ipcRenderer.invoke(IpcChannels.ChannelListTypes),
  listChannels: (projectPath: string) =>
    ipcRenderer.invoke(IpcChannels.ChannelList, projectPath),
  saveChannel: (projectPath: string, channel: any) =>
    ipcRenderer.invoke(IpcChannels.ChannelSave, { projectPath, channel }),
  deleteChannel: (projectPath: string, channelId: string) =>
    ipcRenderer.invoke(IpcChannels.ChannelDelete, { projectPath, channelId }),
  testChannel: (type: string, config: Record<string, string>, projectPath?: string) =>
    ipcRenderer.invoke(IpcChannels.ChannelTest, { type, config, projectPath }),
  setTelegramWebhook: (config: Record<string, string>, webhookUrl: string) =>
    ipcRenderer.invoke(IpcChannels.ChannelTelegramSetWebhook, { config, webhookUrl }),
  deleteTelegramWebhook: (config: Record<string, string>) =>
    ipcRenderer.invoke(IpcChannels.ChannelTelegramDeleteWebhook, { config }),

  // 渠道诊断（“测试成功但没收到”时，让面板自己指出链路断在哪一环）
  listChannelDiag: (filter?: { channelKey?: string; projectPath?: string; since?: number }) =>
    ipcRenderer.invoke(IpcChannels.ChannelDiagList, filter) as Promise<import('../shared/channel-diagnostics').ChannelDiagEvent[]>,
  clearChannelDiag: () => ipcRenderer.invoke(IpcChannels.ChannelDiagClear),
  getChannelDiagPath: (scope?: { projectPath?: string; channelKey?: string }) =>
    ipcRenderer.invoke(IpcChannels.ChannelDiagPath, scope) as Promise<string>,
  getFeishuConnStatus: () =>
    ipcRenderer.invoke(IpcChannels.ChannelWsStatus) as Promise<Array<{ appId: string; state: string; channelCount: number; lastConnectTime?: number; reconnectAttempts: number }>>,
  onChannelDiag: (cb: (e: import('../shared/channel-diagnostics').ChannelDiagEvent) => void) => {
    const listener = (_evt: any, payload: any) => cb(payload);
    ipcRenderer.on(IpcChannels.ChannelDiagEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannels.ChannelDiagEvent, listener);
  },

  // 对话-渠道双向打通
  getConvChannels: (projectPath: string, convId: string) =>
    ipcRenderer.invoke(IpcChannels.ConvChannelsGet, { projectPath, convId }),
  setConvChannels: (projectPath: string, convId: string, args: {
    inbound?: string[];
    outbound?: string[];
    broadcastUser?: string[];
    broadcastInbound?: string[];
    broadcastAssistant?: string[];
  }) =>
    ipcRenderer.invoke(IpcChannels.ConvChannelsSet, { projectPath, convId, ...args }),
  getInboundUrl: (channel: any, port?: number) =>
    ipcRenderer.invoke(IpcChannels.ChannelInboundUrl, { channel, port }),
  startInboundServer: (port?: number) =>
    ipcRenderer.invoke(IpcChannels.ChannelInboundStart, { port }),
  stopInboundServer: () =>
    ipcRenderer.invoke(IpcChannels.ChannelInboundStop),
  // Rotate Webhook Token (via relay admin API, self-service from client)
  rotateWebhookToken: () =>
    ipcRenderer.invoke(IpcChannels.RelayRotateWebhook),
  // Relay 长连接（本地无公网 IP 场景）
  startRelay: () =>
    ipcRenderer.invoke(IpcChannels.RelayStart),
  stopRelay: () =>
    ipcRenderer.invoke(IpcChannels.RelayStop),
  setRelayClientName: (name:string):Promise<{ok:boolean;clientName?:string;error?:string}> => ipcRenderer.invoke(IpcChannels.RelayClientNameSet,name),
  getRelayStatus: (): Promise<RelayStatusPayload> =>
    ipcRenderer.invoke(IpcChannels.RelayStatusGet),
  onRelayStatus: (cb: (e: RelayStatusPayload) => void) => {
    const listener = (_evt: any, payload: any) => cb(payload);
    ipcRenderer.on(IpcChannels.RelayStatus, listener);
    return () => ipcRenderer.removeListener(IpcChannels.RelayStatus, listener);
  },
  onInboundEvent: (cb: (e: import('../shared/types').InboundEventPayload) => void) => {
    const listener = (_evt: any, payload: any) => cb(payload);
    ipcRenderer.on(IpcChannels.InboundEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannels.InboundEvent, listener);
  },

  onAutoSelectProject: (cb: (path: string) => void) => {
    const listener = (_evt: any, path: string) => cb(path);
    ipcRenderer.on(IpcChannels.WindowAutoSelectProject, listener);
    return () => ipcRenderer.removeListener(IpcChannels.WindowAutoSelectProject, listener);
  },
  onSettingsChanged: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(IpcChannels.SettingsChanged, listener);
    return () => ipcRenderer.removeListener(IpcChannels.SettingsChanged, listener);
  },

  /** Handler called by main process during window close (async). */
  onCheckRunningTasks: (cb: () => { hasTasks: boolean; title: string; message: string; confirmBtn: string; cancelBtn: string }) => {
    ipcRenderer.on(IpcChannels.WindowBeforeClose, () => {
      const result = cb();
      ipcRenderer.send(IpcChannels.WindowCloseCheckResult, result);
    });
  },

  /** 应用菜单「关于 Sage」点击事件（主进程 → 渲染层）。 */
  onMenuAction: (cb: (action: 'newChat' | 'openFolder') => void) => {
    const listener=(_event: Electron.IpcRendererEvent,action:'newChat'|'openFolder')=>cb(action);
    ipcRenderer.on('menu:action',listener);
    return ()=>ipcRenderer.removeListener('menu:action',listener);
  },
  onMenuAbout: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('menu:about', listener);
    return () => ipcRenderer.removeListener('menu:about', listener);
  },

  // ── Memory（长期记忆系统）────────────────────────────────────────────────
  memoryList: (projectPath: string, convId?: string) =>
    ipcRenderer.invoke('memory:list', projectPath, convId),
  memoryConvCounts: (projectPath: string) =>
    ipcRenderer.invoke('memory:conv-counts', projectPath),
  /** 分层清理历史重复记忆；返回被删掉的条数与备份文件。 */
  memoryDedupe: (args: { projectPath: string; convId?: string; selection?: {scope:'user'|'project'|'conversation';ids:string[];content:string;tags:string[]} }) =>
    ipcRenderer.invoke('memory:dedupe', args),
  memoryAdd: (args: { projectPath: string; content: string; tags: string[]; scope?: 'project' | 'user' | 'conversation'; convId?: string }) =>
    ipcRenderer.invoke('memory:add', args),
  memoryUpdate: (args: { projectPath: string; id: string; content?: string; tags?: string[]; convId?: string }) =>
    ipcRenderer.invoke('memory:update', args),
  memoryDelete: (args: { projectPath: string; id: string; convId?: string }) =>
    ipcRenderer.invoke('memory:delete', args),

  // ── 浏览器证书风险放行（用户在中止页同意风险后批准该 origin）──
  browserCertApprove: (origin: string): Promise<boolean> =>
    ipcRenderer.invoke('browser-cert-approve', origin),

  // ── 模型能力小样本探测 + 缓存（vision/tool 真实校验）──
  modelCapsReport: (): Promise<import('../shared/model-probe-report').ProbeReport> => ipcRenderer.invoke('model-caps-report'),
  modelCapsRetry: (request: import('../shared/model-probe-report').ProbeRetry = {}): Promise<import('../shared/model-probe-report').ProbeReport> => ipcRenderer.invoke('model-caps-retry', request),
  modelCapsGet: (): Promise<Record<string, import('../shared/model-types').ModelTypeCaps>> =>
    ipcRenderer.invoke('model-caps-get'),
  modelCapsProbe: (items: Array<{ providerId: string; modelId: string }>): Promise<Record<string, import('../shared/model-types').ModelTypeCaps>> =>
    ipcRenderer.invoke('model-caps-probe', items),

  // ── 剪贴板兜底：渲染层 navigator.clipboard 被拒时改由主进程写入 ──
  clipWriteText: (text: string): Promise<boolean> => ipcRenderer.invoke('clip:write-text', text),
  readPreviewImage: (source: string): Promise<{mimeType: string; bytes: Uint8Array}> => ipcRenderer.invoke('preview:read-image', source),
  clipWriteImage: (bytes: Uint8Array): Promise<boolean> => ipcRenderer.invoke('clip:write-image', bytes),
  clipWriteRich: (html: string, plain: string): Promise<boolean> => ipcRenderer.invoke('clip:write-rich', { html, plain }),
};

contextBridge.exposeInMainWorld('api', api);

export type SageApi = typeof api;
