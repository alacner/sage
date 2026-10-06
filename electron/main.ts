import { WindowPreviews } from './utils/window-previews';
import {PetNoticeRegistry, type PetNoticeTarget} from '../shared/pet-notifications';
import {approveBrowserCertificate,handleBrowserCertificate} from './browser-certificates';
import {resolveLanguage} from '../shared/language';
import { fetchProviderModelList, testProviderKeys } from './provider-models';
import { createProviderModelSync, isListSyncedProvider, pruneComposites } from './provider-model-sync';
import { pickApiKey } from './utils/api-key-picker';
import { createOnboardingClaim } from './onboarding';
import { effectiveSecuritySettings } from '../shared/security-settings';
import { detectCodex } from './codex-bridge';
import { contextualPolicy } from './sandbox/conversation-policy';
import { initializePlugins } from './plugins';
import { registerModelProbeHandlers } from './model-probe';
import { registerModelPriceHandlers } from './model-price-cache';
import { diagVoice } from './voice';
import { diagWindow, startWindowDiagnostics, isDockVisible, isAppHidden } from './window-diagnostics';
import { createDockIconGuard } from './dock-icon';
import { loadFnKeyMonitor } from './native-fn-shortcuts';
import { builtinSettingValue } from '../shared/builtin-plugins';
import { includedBackupGroups, backupGroup, validBackupGroups } from '../shared/settings-backup';
import { applySettingsImport } from './settings-import-plan';
import { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, Menu, powerSaveBlocker, session, screen, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRendererNavigation } from './renderer-navigation';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { IpcChannels, type AppSettings } from '../shared/types';
import { registerSpecHandlers, abortAllForWindow, activeUpdateTaskCount } from './ipc';
import { setMonitorWindows, repriceProjectRecords } from './request-monitor';
import { disposeAllForWindow as disposeAllPtysForWindow } from './terminal';
import { detectClaude, setBinaryOverride } from './claude-bridge';
import {
  listProjects,
  listProjectsWithActivity,
  setProjectIcon,
  addProject,
  removeProject,
  touchProject,
  setProjectModel,
  setProjectSelectedModel,
  setProjectSelectedVisionModel,
} from './store';
import type { ProjectEntry } from '../shared/types';
import { setActiveWindow, startScheduler, startInboundInfrastructure, activeScheduledUpdateTaskCount } from './scheduler';
import { settingsVersionPreview } from './settings-preview';
import { fetchRelayModels, relayConnection } from './relay-models';
import { createRelayModelSync } from './relay-model-sync';
import { getConnectedRelay, updateRelayCertificateTrust } from './channels/relay-client';
import { listSystemFonts } from './system-fonts';
import { migrateModelProfiles, migrateExternalCredentialPlugins } from './settings-migrations';
import { encryptSettings, decryptSettings, decryptSecret } from './sandbox/secrets';
import { registerProtectedSettings } from './settings-redaction';
import { loadMcpEnvironmentVariables, mergeMcpEnvironmentVariables } from './mcp-environment';
import { SettingsRepository } from './settings-repository';
import { withMobileProjectDirectoryDefaults } from './mobile-project-creation';
import { publicSettings, applyPublicPatch, writeEncryptedExport, exportSettings, importSettings, mergeImport, PROTECTED } from './settings-transfer';
import { uiZoomFactor } from '../shared/appearance';
import { effectiveAccelerator } from '../shared/shortcuts';
import { initializeComposerShortcuts } from './composer-shortcuts';
import { cancelScreenshotEditorQuit, getScreenshotEditorWindow, openScreenshotEditor, screenshotLifecycle } from './screenshot-editor';
import { petAnchorFromBounds, petPositionFromAnchor, petResizePosition, petEdgeAtBounds, petEdgePosition, petDragEdge, isPetEdge, type PetEdge, type PetAnchor } from '../shared/pet';
import { cancelUpdateDownload, checkForUpdates, cleanupStaleBackups, dismissSuperseded, downloadAndInstall, getUpdateStatus, startUpdater, onStatusChange, probeUpdateService, switchToNewerVersion } from './updater';

const isDev = process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL;

// ── 菜单多语言翻译 ──
type MenuTranslations = {
  about: string;
  checkForUpdates: string;
  updateTo: (version: string) => string;
  services: string;
  hide: string;
  hideOthers: string;
  unhide: string;
  quit: string;
  edit: string;
  view: string;
  window: string;
};

const menuTranslations: Record<string, MenuTranslations> = {
  zh: {
    about: '关于 Sage',
    checkForUpdates: '检查更新…',
    updateTo: (version) => `更新到 ${version}`,
    services: '服务',
    hide: '隐藏 Sage',
    hideOthers: '隐藏其他应用',
    unhide: '全部显示',
    quit: '退出 Sage',
    edit: '编辑',
    view: '视图',
    window: '窗口',
  },
  en: {
    about: 'About Sage',
    checkForUpdates: 'Check for Updates…',
    updateTo: (version) => `Update to ${version}`,
    services: 'Services',
    hide: 'Hide Sage',
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: 'Quit Sage',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
  },
};

function getMenuTranslations(lang: string): MenuTranslations {
  return menuTranslations[resolveLanguage(lang,app.getLocale())];
}

// ── 应用菜单构建 ──
let currentMenuLang = 'zh';
let currentMenuShortcuts:AppSettings['shortcuts'];

function buildAppMenu(): void {
  const t = getMenuTranslations(currentMenuLang);
  const updateStatus = getUpdateStatus();
  
  // 根据更新状态决定菜单项文案
  let updateLabel = t.checkForUpdates;
  let updateClick: () => void;
  
  if ((updateStatus.phase === 'available' || updateStatus.phase === 'ready') && updateStatus.latestVersion) {
    updateLabel = t.updateTo(updateStatus.latestVersion);
    updateClick = () => { void downloadAndInstall(); };
  } else {
    updateClick = () => { void checkForUpdates(false); };
  }
  
  const menu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        {
          label: t.about,
          click: async () => {
            const {clipboard}=await import('electron');const os=await import('node:os');
            let build:{commit?:string;builtAt?:string}={};
            try{build=JSON.parse(await fs.readFile(app.isPackaged?path.join(process.resourcesPath,'build-info.json'):path.join(app.getAppPath(),'resources/build-info.json'),'utf8'));}catch{}
            const info=[`Version: ${app.getVersion()}`,`Commit: ${build.commit??'unknown'}`,`Built: ${build.builtAt??'unknown'}`,`Electron: ${process.versions.electron}`,`Chromium: ${process.versions.chrome}`,`Node.js: ${process.versions.node}`,`V8: ${process.versions.v8}`,`OS: ${os.type()} ${os.arch()} ${os.release()}`].join('\n');
            const en=resolveLanguage((await readSettings()).language,app.getLocale())==='en';
            const result=await dialog.showMessageBox({type:'info',title:en?'About Sage':'关于 Sage',message:'Sage',detail:info,buttons:[en?'OK':'确定',en?'Copy':'复制'],defaultId:0,cancelId:0});
            if(result.response===1)clipboard.writeText('Sage\n'+info);

          },
        },
        {
          label: updateLabel,
          click: updateClick,
        },
        { type: 'separator' },
        { role: 'services', label: t.services },
        { type: 'separator' },
        { role: 'hide', label: t.hide },
        { role: 'hideOthers', label: t.hideOthers },
        { role: 'unhide', label: t.unhide },
        { type: 'separator' },
        { role: 'quit', label: t.quit },
      ],
    },
    { label: resolveLanguage(currentMenuLang,app.getLocale()) === 'en' ? 'File' : '文件', submenu: [
      {label: resolveLanguage(currentMenuLang,app.getLocale()) === 'en' ? 'New Chat' : '新建对话', accelerator:effectiveAccelerator('newConversation',currentMenuShortcuts)??undefined, click: (_item,win) => { const target=win?BrowserWindow.fromId(win.id):BrowserWindow.getFocusedWindow();if(target)target.webContents.send('menu:action','newChat');else void createWindow(); }},
      {type:'separator'},
      {label: resolveLanguage(currentMenuLang,app.getLocale()) === 'en' ? 'Open Folder…' : '打开文件夹…', accelerator:'CommandOrControl+O', click: async (_item,win) => { const target=win?BrowserWindow.fromId(win.id):BrowserWindow.getFocusedWindow();if(target){target.webContents.send('menu:action','openFolder');return;}const selected=await dialog.showOpenDialog({properties:['openDirectory']});if(!selected.canceled&&selected.filePaths[0]){await addProject(selected.filePaths[0]);await rebuildDockMenu();await createWindow({projectPath:selected.filePaths[0]});} }},
      {type:'separator'},
      {role:'close',label:resolveLanguage(currentMenuLang,app.getLocale()) === 'en' ? 'Close' : '关闭'},
    ]},
    { role: 'editMenu', label: t.edit },
    { role: 'viewMenu', label: t.view },
    { role: 'windowMenu', label: t.window },
  ]);
  Menu.setApplicationMenu(menu);
}

/**
 * 根据语言重建应用菜单。
 * 在语言变化时调用（更新状态变化由 updater.onStatusChange 回调触发 buildAppMenu）。
 */
function rebuildAppMenu(lang?: string): void {
  if (lang !== undefined) {
    currentMenuLang = lang;
  }
  buildAppMenu();
}

// 统一应用名称，确保 macOS 应用菜单（About / Hide / Quit）显示 "Sage"。
// 注意：此调用同时会把 userData 目录切到 .../Sage，历史数据已迁移至此。
app.setName('Sage');
const ownsSettingsLock = app.requestSingleInstanceLock();
if (!ownsSettingsLock) app.quit();
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

/**
 * Window registry. Key = webContents.id.
 * 替代旧的 mainWindow 单例，支持多窗口各自管理各自的项目/对话。
 */
const windows = new Map<number, BrowserWindow>();
const composerShortcuts = initializeComposerShortcuts(windows, () => currentMenuShortcuts, undefined, () => {
  void readSettings().then(settings=>openScreenshotEditor(resolveLanguage(settings.language,app.getLocale()))).catch(error=>console.error('[screenshot] Global capture unavailable',error));
});

/**
 * Pending auto-select project paths keyed by webContents.id.
 * Set when createWindow({ projectPath }) is called; consumed by the
 * renderer via WindowGetAutoSelectProject IPC. One-shot: cleared on read.
 */
const pendingAutoSelect = new Map<number, string>();

/**
 * Window ↔ Project mapping. Key = webContents.id, value = projectPath.
 * Updated when the renderer calls ProjectTouch (i.e. selectProject).
 * Used by the Dock menu to find an existing window for a project instead
 * of always creating a new one.
 */
const windowProjects = new Map<number, string>();

/** 当前活跃 window 的 webContents.id（用于 sandbox 策略检查时定位当前项目）。 */
let activeWindowId: number | null = null;

/**
 * Windows that have confirmed close via the "running tasks" dialog.
 * When the user clicks "Close" in the dialog, we add the senderId here,
 * then call win.close() again. The close handler checks this set and
 * skips the dialog on the second pass.
 */
const forceCloseIds = new Set<number>();

/**
 * True once the user has initiated an app quit (Dock → Quit, Cmd+Q, menu Quit).
 * The window `close` handler must preventDefault to run the async
 * "running tasks" check, which cancels Electron's quit sequence. After the
 * window confirms it can close we re-invoke app.quit() to resume quitting.
 */
let isQuitting = false;

/**
 * 电源管理：阻止系统休眠。
 * 当 preventSleep 启用时，使用 powerSaveBlocker 阻止 macOS 进入睡眠/休眠状态。
 * Sage 完全关闭后自动释放，恢复系统默认行为。
 */
let powerSaveBlockerId: number | null = null;

/**
 * 更新电源管理状态。
 * 当 preventSleep 设置变化或窗口数量变化时调用。
 */
function updatePowerSaveBlocker(enable: boolean): void {
  if (enable && powerSaveBlockerId === null) {
    // 启用阻止休眠（'prevent-app-suspension' 允许屏幕休眠，但保持应用运行）
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[PowerSaveBlocker] 已启用阻止应用休眠');
  } else if (!enable && powerSaveBlockerId !== null) {
    // 禁用，恢复系统默认行为
    powerSaveBlocker.stop(powerSaveBlockerId);
    powerSaveBlockerId = null;
    console.log('[PowerSaveBlocker] 已恢复系统默认休眠行为');
  }
}

/**
 * Find an existing, non-destroyed window that is showing the given project.
 * Returns the BrowserWindow if found, otherwise undefined.
 */
export function findWindowForProject(projectPath: string): BrowserWindow | undefined {
  for (const [senderId, path] of windowProjects) {
    if (path !== projectPath) continue;
    const win = windows.get(senderId);
    if (win && !win.isDestroyed()) return win;
    // Stale entry — clean up
    windowProjects.delete(senderId);
  }
  return undefined;
}

/**
 * Focus an existing window for the project, or create a new one.
 */
async function focusOrCreateForProject(projectPath: string) {
  const existing = findWindowForProject(projectPath);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  } else {
    await createWindow({ projectPath });
  }
}

/**
 * macOS Dock menu: 显示最近项目列表，点击后聚焦已有窗口或新建。
 * 每次项目列表变化（添加/删除）后调用 rebuildDockMenu() 刷新。
 */
async function rebuildDockMenu() {
  if (process.platform !== 'darwin') return;
  const projects = await listProjects();
  const items = projects.map((p) => ({
    label: projects.filter(project => project.name === p.name).length > 1 ? `${p.name}（${p.path}）` : p.name,
    toolTip: p.path,
    click: () => { void focusOrCreateForProject(p.path); },
  }));
  const menu = Menu.buildFromTemplate([
    { label: '新建窗口', click: () => { void createWindow(); } },
    { type: 'separator' as const },
    ...(items.length > 0
      ? [{ label: '最近项目', enabled: false } as Electron.MenuItemConstructorOptions, ...items]
      : [{ label: '（无最近项目）', enabled: false } as Electron.MenuItemConstructorOptions]),
  ]);
  if (app.dock) app.dock.setMenu(menu);
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

let settingsRepository: SettingsRepository | undefined;
function repository() {
  return settingsRepository ??= new SettingsRepository(settingsPath(), encryptSettings, (s) => migrateExternalCredentialPlugins(migrateModelProfiles(decryptSettings(s))));
}
export async function readSettings(): Promise<AppSettings> {
  const s = await repository().read();
  registerProtectedSettings(s);
  syncUiZoom(s, false);
  return withMobileProjectDirectoryDefaults(s, app.getPath('home'));
}
/**
 * 界面字号 = 整窗等比缩放（渲染层 CSS 硬编码像素字号过多，逐条改写风险大）。
 * 缓存最近一次比例供新建窗口直接使用，避免启动/开新窗时闪现默认大小。
 */
let uiZoom = 1;
function syncUiZoom(next: AppSettings, applyToWindows: boolean) {
  uiZoom = uiZoomFactor(next.appearance?.uiFontSize);
  if (applyToWindows) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.setZoomFactor(uiZoom);
    }
  }
}
let newWindowAccelerator: string | undefined;
/** 按用户配置（settings.shortcuts diff）重新注册“新开窗口”全局快捷键；null=未分配。 */
function applyNewWindowShortcut(next: AppSettings) {
  if (!app.isReady()) return;
  const accel = effectiveAccelerator('newWindow', next.shortcuts) ?? '';
  if (accel === newWindowAccelerator) return;
  if (newWindowAccelerator) globalShortcut.unregister(newWindowAccelerator);
  newWindowAccelerator = undefined;
  if (accel && !globalShortcut.isRegistered(accel) && globalShortcut.register(accel, () => { void createWindow(); })) newWindowAccelerator = accel;
}
function settingsDidChange(next: AppSettings) {
  updateRelayCertificateTrust(next.relayCertificate);
  registerProtectedSettings(next);
  loadMcpEnvironmentVariables(next.mcpEnvironmentVariables);
  void import('./mcp-chat-tools').then(({ refreshEnabledChatMcpTools }) => refreshEnabledChatMcpTools()).catch(error => console.warn('[mcp] Tool cache refresh failed:', error));
  setBinaryOverride(next.claudeBinaryPath || '');
  updatePowerSaveBlocker(!!next.preventSleep);
  void applyNewWindowShortcut(next);
  applyPetWindow(next);
  markSandboxCacheDirty();
  currentMenuShortcuts=next.shortcuts;
  composerShortcuts.settingsChanged();
  // A remapped capture key may have just released the new-window accelerator.
  void applyNewWindowShortcut(next);
  rebuildAppMenu(next.language);
  syncUiZoom(next, true);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IpcChannels.SettingsChanged);
  }
}
/** All main-process updates share the same read/modify/write transaction queue. */
export async function patchPluginSetting(id: string, key: string, value: unknown, secret = false) {
  const next = await repository().update(cur => secret
    ? ({...cur, pluginSecrets: {...cur.pluginSecrets, [id]: {...cur.pluginSecrets?.[id], [key]: String(value)}}})
    : ({...cur, pluginSettings: {...cur.pluginSettings, [id]: {...cur.pluginSettings?.[id], [key]: value}}}));
  settingsDidChange(next);
}
/** 项目级内置插件配置覆盖（scope='project' 白名单字段），与全局配置同事务队列。 */
export async function patchProjectPluginSetting(project: string, id: string, key: string, value: unknown) {
  const next = await repository().update(cur => ({...cur, projectPluginSettings: {...cur.projectPluginSettings, [project]: {...cur.projectPluginSettings?.[project], [id]: {...cur.projectPluginSettings?.[project]?.[id], [key]: value as string | number | boolean}}}}));
  settingsDidChange(next);
}
export async function rememberFirstSecurityProfile(id: string) {
  const next = await repository().update(cur => cur.defaultSecurityProfileId ? cur : { ...cur, defaultSecurityProfileId: id });
  settingsDidChange(next);
}
export async function patchSettings(patch: Partial<AppSettings>, revision?: string): Promise<AppSettings> {
  const next = await repository().update(cur => ({ ...cur, ...patch }), revision);
  settingsDidChange(next);
  return next;
}

const relayModelSync = createRelayModelSync({
  connected: () => !!getConnectedRelay(),
  connection: settings => {
    relayConnection(settings);
    return { url: settings.relayUrl!, token: settings.relayToken! };
  },
  read: readSettings,
  // Catalog reads are short metadata requests, separate from long-running inference.
  fetch: settings => fetchRelayModels(settings, 5_000),
  commit: async (before, providers, source) => {
    const next = await repository().update(current => {
      // Validate the original catalog source and live credentials inside the CAS transaction.
      relayConnection(current);
      if (current.relayUrl !== source.url || current.relayToken !== source.token) throw Error('中继连接已变化，请刷新模型列表');
      return { ...current, modelProviders: providers };
    }, before._revision ?? 'legacy');
    settingsDidChange(next);
  },
});
/** Mobile model pickers wait for the latest relay catalog, sharing polls within five seconds. */
export async function readModelSettings(): Promise<AppSettings> {
  await relayModelSync.tick(5_000);
  return readSettings();
}
let relayModelNextAt = 0;
let relayModelSyncTimer: ReturnType<typeof setInterval> | undefined;

/**
 * 普通提供商模型清单同步：与中继同步并联的 30s 轮询。
 * 只针对「测试连接」探测出支持模型清单接口（modelsListSupported === true）的提供商；
 * 提交前对复合提供商做联动清理（悬空映射/无成员可服务的声明模型）。
 */
const providerModelSync = createProviderModelSync({
  read: readSettings,
  commit: async (before, providers) => {
    const next = await repository().update(current => ({ ...current, modelProviders: providers }), before._revision ?? 'legacy');
    settingsDidChange(next);
  },
});
let providerModelNextAt = 0;

/**
 * 沙箱策略覆盖项缓存（写入失效模式 / write-invalidate cache）。
 *
 * 性能优化：AI 每次工具调用都要读 sandbox 策略，如果每次都从磁盘读 projects.json
 * 会很慢。改为"写入失效"模式——缓存命中直接返回，只在用户改配置后标记 dirty，
 * 下次调用才重新加载。这样正常使用零 IO，改配置后下次调用立即生效。
 */
let sandboxOverridesCache: ProjectEntry['sandboxOverrides'] | undefined = undefined;
let sandboxCacheValid = false;

/** 标记 sandbox 缓存失效，下次 getSandboxOverrides() 会从磁盘重新加载。 */
function markSandboxCacheDirty(): void {
  sandboxCacheValid = false;
}

/** 获取当前沙箱策略覆盖项（缓存命中直接返回，缓存失效时从 disk 重新加载）。 */
export function getSandboxOverrides(): ProjectEntry['sandboxOverrides'] {
  const activePolicy = contextualPolicy();
  if (activePolicy) return effectiveSecuritySettings(activePolicy);
  if (sandboxCacheValid) return sandboxOverridesCache ? effectiveSecuritySettings(sandboxOverridesCache) : undefined;
  
  try {
    // 缓存失效 → 从磁盘加载，回填缓存
    const projectsPath = path.join(app.getPath('userData'), 'projects.json');
    const content = readFileSync(projectsPath, 'utf-8');
    const projects = JSON.parse(content) as ProjectEntry[];
    
    // 找当前活跃窗口的 sandboxOverrides
    if (activeWindowId !== null) {
      const projectPath = windowProjects.get(activeWindowId);
      if (projectPath) {
        const proj = projects.find((p) => p.path === projectPath);
        sandboxOverridesCache = proj?.sandboxOverrides;
        sandboxCacheValid = true;
        return sandboxOverridesCache ? effectiveSecuritySettings(sandboxOverridesCache) : undefined;
      }
    }
    
    // fallback: 无活跃窗口时返回第一个项目的配置
    sandboxOverridesCache = projects[0]?.sandboxOverrides;
    sandboxCacheValid = true;
    return sandboxOverridesCache ? effectiveSecuritySettings(sandboxOverridesCache) : undefined;
  } catch {
    sandboxOverridesCache = undefined;
    sandboxCacheValid = true; // 避免反复重试
    return undefined;
  }
}

async function createWindow(opts?: { projectPath?: string }): Promise<BrowserWindow> {
  const restoreRecent = ![...windows.values()].some(w => !w.isDestroyed() && w !== petWindow);
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 360,
    titleBarStyle: 'hiddenInset',
    // 红绿灯垂直钉在 28px 标题栏中线（12px 灯组 → y=(28-12)/2），
    // 与 .titlebar-actions 三个图标（flex 居中于同一 28px）共用一条横向中心线
    trafficLightPosition: { x: 20, y: 8 },
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  const senderId = win.webContents.id;
  windows.set(senderId, win);
  // Resolve and register before loading the renderer, so its startup IPC cannot race us.
  const initialProjectPath = opts?.projectPath ?? (restoreRecent ? (await listProjects().catch(() => []))[0]?.path : undefined);
  if (initialProjectPath) pendingAutoSelect.set(senderId, initialProjectPath);
  // 新建窗口直接套用当前界面字号缩放，避免先以默认大小闪现再跳变
  win.webContents.setZoomFactor(uiZoom);

  // 交通灯垂直居中于 28px 标题栏（灯直径 12px → y=8），
  // 与右侧三个入口图标（PanelLeft/搜索/活动，中心 14px）同一水平线。
  if (process.platform === 'darwin') win.setWindowButtonPosition({ x: 12, y: 8 });

  // 导航守卫：对话/文档里的链接一律用系统浏览器打开，绝不允许在应用窗口内
  // 导航到外部页面（否则整个 UI 会被外部页面占用且无法返回）。
  const rendererEntry = isDev ? 'http://localhost:5173/'
    : pathToFileURL(path.join(__dirname, '..', '..', 'dist', 'index.html')).href;

  // 点击 <a href> 触发的同窗口导航。
  win.webContents.on('will-navigate', (event, url) => {
    if (isRendererNavigation(url, rendererEntry)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isRendererNavigation(url, rendererEntry)) event.preventDefault();
  });

  // target=_blank / window.open 触发的新窗口请求。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.once('ready-to-show', () => {
    win.show();
    // macOS: ensure the new window is focused and brought to front
    win.focus();
    app.focus({ steal: true });
    // Track active window for scheduler event delivery
    setActiveWindow(senderId);
  });

  // Update active window on focus
  win.on('focus', () => {
    activeWindowId = win.webContents.id;
    // 窗口切换时标记缓存失效，下次读取会从磁盘重新加载（取当前窗口的配置）
    markSandboxCacheDirty();
  });

  if (isDev) {
    await win.loadURL('http://localhost:5173/');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  win.on('close', (e) => {
    // If already confirmed via dialog, proceed directly.
    if (forceCloseIds.has(senderId)) {
      forceCloseIds.delete(senderId);
      abortAllForWindow(senderId);
      disposeAllPtysForWindow(senderId);
      return;
    }

    // Ask renderer (async) whether there are running tasks.
    if (!win.isDestroyed()) {
      e.preventDefault();
      win.webContents.send(IpcChannels.WindowBeforeClose);
    }
  });
  win.on('closed', () => {
    windows.delete(senderId);
    windowProjects.delete(senderId);
    // Clear active window if it was this one
    setActiveWindow(null);
    // If an app quit was in progress, the initial quit was cancelled by the
    // close handler's preventDefault. Resume it now that this window is gone.
    if (isQuitting) app.quit();
  });

  return win;
}

// ── 桌面宠物（Codex 风格常驻入口）────────────────────────────────
// 透明无边框置顶小窗，默认整窗鼠标穿透（forward 保留 mousemove 供渲染层做
// 靠近检测）；指针进入交互区后渲染层上报 set-interactive，恢复可点击。
let petWindow: BrowserWindow | null = null;
/** Application policy and icon paint are separate signals. The guard waits for
 * dock.show(), paints an explicit native tile and records accepted submissions.
 * Its lifetime is independent of the pet and screenshot utility windows. */
let dockWatchdog: NodeJS.Timeout | null = null;

function dockIconCandidates(): string[] {
  return app.isPackaged
    ? [path.join(process.resourcesPath, 'dock-icon.png'), path.join(process.resourcesPath, 'icon.icns')]
    : [path.join(__dirname, '..', '..', 'build', 'icon.png'), path.join(__dirname, '..', '..', 'build', 'icon.icns')];
}
let dockGuard: ReturnType<typeof createDockIconGuard> | undefined;
function getDockGuard() {
  if (process.platform !== 'darwin') return;
  const dock = app.dock;
  if (!dock) return;
  return dockGuard ??= createDockIconGuard({ platform: process.platform, dock,
    candidates: dockIconCandidates,
    image: file => existsSync(file) ? nativeImage.createFromPath(file) : undefined,
    native: loadFnKeyMonitor() ?? {}, log: diagWindow,
    schedule: (callback, delay) => setTimeout(callback, delay), cancel: clearTimeout,
  });
}
function ensureDockIcon(): void { getDockGuard()?.ensureIcon(); }
function ensureDockVisible(): void { void getDockGuard()?.ensureVisible(); }
function refreshDockIcon(reason: string): void { getDockGuard()?.refresh(reason); }
function startDockWatchdog(): void {
  if (process.platform !== 'darwin' || dockWatchdog) return;
  diagWindow(`dock startup pid=${process.pid} version=${app.getVersion()} executable=${process.execPath}`);
  refreshDockIcon('startup');
  dockWatchdog = setInterval(() => { getDockGuard()?.tick(); }, 2000);
  dockWatchdog.unref();
  for (const event of ['workspace','presented','closed']) screenshotLifecycle.on(event, () => refreshDockIcon(`screenshot ${event}`));
  app.on('activate', () => refreshDockIcon('app activate'));
  app.on('did-become-active', () => refreshDockIcon('app became active'));
  app.on('before-quit', () => { getDockGuard()?.stop(); if (dockWatchdog) clearInterval(dockWatchdog); });
}
// 初始只给宠物及下方入口的大小；实际尺寸由渲染层按内容实时上报 pet:resize 调整（窗口始终贴合可见内容，
// 不再用一块 680×460 的透明大窗盖住桌面），拖拽时保持右下角锚点不动 → compose 向左展开。
let petDockEdge: PetEdge | null = null;
let petEmergeEdge: PetEdge | null = null;
let petIsIdle = true;
let petIsDragging = false;
let petDockArmed = false;
let petPendingEdge: PetEdge | null = null;
let petCreating = false;
let petWanted = false;
let petHasAvatar = true;
const PET_WIDTH = 116;
const PET_HEIGHT = 158; // avatar + stable launcher footer + transparent margins

// 宠物位置持久化（0.6.513）：用户拖到哪儿，下次启动还在哪儿。
// 记「右下角锚点」而不是左上角：窗口紧贴内容、默认向左/向上展开（见 petResizePosition），
// 右下角才是那个「展开输入条、收起气泡都不动」的点；记左上角等于记了一次展开中的临时位置。
// 存 userData/pet-state.json 而不进 settings：这是本机窗口状态，不该跟着配置备份/迁移
// 跑到另一台机器上（分辨率、屏幕布局完全不同，那边只会被钳到一个无意义的位置）。
function petStatePath() {
  return path.join(app.getPath('userData'), 'pet-state.json');
}
/** undefined = 还没读盘（首次访问才去读文件）；null = 没有/不可用的历史位置。 */
let petAnchor: PetAnchor | null | undefined;

async function loadPetAnchor(): Promise<PetAnchor | null> {
  if (petAnchor !== undefined) return petAnchor;
  try {
    const saved = JSON.parse(await fs.readFile(petStatePath(), 'utf-8'));
    const a = saved?.anchor;
    petDockEdge = isPetEdge(saved?.edge) ? saved.edge : null;
    // 只认能还原出数字锚点的存档：脏数据当没有，而不是把窗口摆到 NaN 坐标
    petAnchor = a && Number.isFinite(a.right) && Number.isFinite(a.bottom) ? { right: a.right, bottom: a.bottom } : null;
  } catch {
    petAnchor = null; // 首次运行本来就没这个文件
  }
  return petAnchor;
}

async function writePetAnchor(): Promise<void> {
  if (!petAnchor) return; // 没动过就不写，避免把存档刷成 null
  try {
    await fs.mkdir(path.dirname(petStatePath()), { recursive: true });
    await fs.writeFile(petStatePath(), JSON.stringify({ anchor: petAnchor, edge: petDockEdge, savedAt: new Date().toISOString() }), 'utf-8');
  } catch { /* 写失败下次再说，不该卡住宠物交互 */ }
}

let petStateTimer: NodeJS.Timeout | null = null;
/** 拖拽每 16ms 搬一次窗口、内容展开也会搬：合并写盘，松手/退出时再 flush 一次。 */
function schedulePetAnchorWrite(): void {
  if (petStateTimer) return;
  petStateTimer = setTimeout(() => { petStateTimer = null; void writePetAnchor(); }, 400);
  petStateTimer.unref(); // 不能挡住退出（与 dock 看门狗同理）
}
function flushPetAnchor(): void {
  if (petStateTimer) { clearTimeout(petStateTimer); petStateTimer = null; }
  void writePetAnchor();
}
/** 把当前窗口实测位置记进锚点缓存（拖拽结束 / 内容缩放 / 销毁退出前）。 */
function rememberPetAnchor(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const b = win.getBounds();
  petAnchor = petAnchorFromBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
}
/** 所有在线显示器的可见区（workArea 已扣掉菜单栏 / Dock）。 */
function petWorkAreas() {
  return screen.getAllDisplays().map((d) => ({ ...d.workArea }));
}

async function createPetWindow(): Promise<void> {
  if (petCreating || (petWindow && !petWindow.isDestroyed())) return;
  petCreating = true;
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    // 上次的位置只在「仍落在某个在线显示器的可见区内」时还原；拔了副屏回到 null，
    // 继续用默认右下角，否则宠物会被摆到屏幕外看不见（macOS 不会自动拉回）。
    const restored = petPositionFromAnchor(
      await loadPetAnchor(), { width: PET_WIDTH, height: PET_HEIGHT }, petWorkAreas(), petDockEdge,
    );
    if (!petWanted) return;
    if (!restored || !petHasAvatar) petDockEdge = null;
    petIsDragging = false; petIsIdle = petHasAvatar; petDockArmed = false; petPendingEdge = null; petEmergeEdge = null;
    const win = new BrowserWindow({
      width: PET_WIDTH,
      height: PET_HEIGHT,
      x: restored?.x ?? wa.x + wa.width - PET_WIDTH - 16,
      y: restored?.y ?? wa.y + wa.height - PET_HEIGHT - 8,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    petWindow = win;
    diagWindow(`pet create: before flags dock=${isDockVisible()} appHidden=${isAppHidden()}`);
    win.setAlwaysOnTop(true, 'floating');
    // ⚠ skipTransformProcessType 不能省。Electron 在传 visibleOnFullScreen:true 时会顺手把
    // app 的 activation policy 切成 Accessory（实现里叫 “transform process type”）：Dock 图标
    // 当场消失，macOS 还会把这个 app 的普通窗口隐到后台——这正是“打开宠物后 Dock 和主窗口
    // 一起消失”。对照实验（标准 Electron v31.7.7 发行包，.tmp/elg/probe/main.js）：
    //   A { visibleOnFullScreen: true }                                    → dock true→false 并持续整个观测窗口（旧代码）
    //   B { visibleOnFullScreen: false }                                    → dock 全程 true，但宠物不覆盖全屏 Space
    //   C + skipTransformProcessType: true                                  → dock 全程 true，宠物照样可见
    // 采用 C：既保住“宠物浮在全屏应用之上”的原意，又不碰 activation policy。
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    diagWindow(`pet create: after setVisibleOnAllWorkspaces dock=${isDockVisible()} appHidden=${isAppHidden()}`);
    refreshDockIcon('pet workspace flags');
    // 兜底保险：万一 Electron 升级后又改变实现，当场确保 Dock 可见；常驻看门狗由
    // startDockWatchdog()（app ready 时启动）负责，不随宠物销毁。app.dock 只存在于 macOS。
    ensureDockVisible();
    // 宠物不得出现在 Dock 右键菜单 / 窗口菜单里。构造参数 skipTaskbar:true 在 macOS 上是空实现
    // （Electron NativeWindowMac::SetSkipTaskbar 什么也不做），所以宠物一开就会被列成一条普通窗口，
    // 标题用的就是 index.html 里的 <title>Sage</title>——菜单里因而多出一条和主窗口一模一样、
    // 但谁也不知道是什么的东西。宠物是背景入口、不是文档窗口，本来就不需要被人知道。
    // excludedFromShownWindowsMenu 才是 macOS 真正的开关（空标题会被 Blink 回退成文件名，见 App.tsx）。
    if (process.platform === 'darwin') win.excludedFromShownWindowsMenu = true;
    win.setIgnoreMouseEvents(petHasAvatar, { forward: true });
    // 注册进 windows 表：emitChat 按 senderId 找窗口，宠物自己的快速对话事件靠此送达。
    // 注意：id 必须提前捕获——'closed' 后再访问 win.webContents 会抛
    // "TypeError: Object has been destroyed"（主进程未捕获则直接崩）。
    const senderId = win.webContents.id;
    windows.set(senderId, win);
    win.webContents.setZoomFactor(uiZoom);
  
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); }); // 不抢焦点，宠物只是背景入口
  
    win.on('closed', () => {
      windows.delete(senderId);
      if (petWindow === win) petWindow = null;
    });
  
    if (isDev) {
      await win.loadURL('http://localhost:5173/?view=pet');
    } else {
      await win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), { query: { view: 'pet' } });
    }
  } finally {
    petCreating = false;
    // A rapid off/on can close the old window while its navigation is still pending.
    if (petWanted && (!petWindow || petWindow.isDestroyed())) void createPetWindow().catch(error => console.error('Pet window failed to reopen', error));
  }
}

function destroyPetWindow(): void {
  refreshDockIcon('pet close');
  diagWindow(`pet destroy: dock=${isDockVisible()} appHidden=${isAppHidden()} alive=${!!petWindow && !petWindow.isDestroyed()}`);
  // 先落盘再关窗：窗口一关就读不到 bounds 了（重启后宠物应当还在原地）
  if (petWindow && !petWindow.isDestroyed()) rememberPetAnchor(petWindow);
  flushPetAnchor();
  if (petWindow && !petWindow.isDestroyed()) petWindow.close();
  petWindow = null;
  // 宠物销毁后 accessory 状态可能残留（翻面是异步的）：主动拉回一次，看门狗随后兜底
  ensureDockVisible();
}

/** 设置变更/启动时同步宠物窗口存在性（开关在 设置→通用）。 */
function applyPetWindow(settings: AppSettings): void {
  petWanted = !!settings.petEnabled;
  petHasAvatar = settings.petStyle !== 'none';
  if (!petHasAvatar) {
    const wasDocked = !!(petDockEdge || petEmergeEdge);
    petDockEdge = null; petEmergeEdge = null; petDockArmed = false; petPendingEdge = null; petIsIdle = false;
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.setIgnoreMouseEvents(false);
      if (wasDocked) {
        petWindow.webContents.send(IpcChannels.PetDock, {edge: null});
        schedulePetAnchorWrite();
      }
    }
  }
  if (settings.petEnabled) void createPetWindow().catch(error => console.error("Pet window failed to open", error));
  else destroyPetWindow();
}

/** 主进程向宠物推一条气泡（定时任务完成等后台消息）。 */
const petNotices = new PetNoticeRegistry();
export function pushPetMessage(payload: { id?:string; title?: string; body: string }, target:PetNoticeTarget={kind:'activity'}, windowId?:number): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const key = payload.id || JSON.stringify([payload.title,payload.body]);
  if (!petNotices.accept(key)) return;
  const id = crypto.randomUUID();
  petNotices.add(id,target,windowId);
  petWindow.webContents.send(IpcChannels.PetPush, {id,title:payload.title?.slice(0,160),body:payload.body.slice(0,600)});
}

function tuckPetAtEdge(): void {
  const win = petWindow;
  if (!petHasAvatar || !win || win.isDestroyed() || !petDockArmed || !petIsIdle || petIsDragging || petDockEdge) return;
  const edge = petPendingEdge ?? petEdgeAtBounds(win.getBounds(), screen.getDisplayMatching(win.getBounds()).workArea);
  petDockArmed = false; petPendingEdge = null;
  if (!edge) return;
  petDockEdge = edge;
  win.setIgnoreMouseEvents(false);
  win.webContents.send(IpcChannels.PetDock, {edge});
  schedulePetAnchorWrite();
}

function registerPetHandlers(): void {
  const ownsPet = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => !!petWindow && !petWindow.isDestroyed()
    && event.sender === petWindow.webContents && event.senderFrame === event.sender.mainFrame;
  ipcMain.on(IpcChannels.PetActivity, (event, item) => {
    const win = windows.get(event.sender.id);
    if (!win || win.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return;
    if (!item || !['update','channel','system'].includes(item.kind) || typeof item.title !== 'string') return;
    pushPetMessage({title:item.title.slice(0,160),body:typeof item.detail==='string'?item.detail.slice(0,600):''}, {kind:'activity',item:{kind:item.kind,title:item.title.slice(0,160),detail:typeof item.detail==='string'?item.detail.slice(0,600):undefined}}, event.sender.id);
  });
  ipcMain.handle(IpcChannels.PetDockState, event => ownsPet(event) ? petDockEdge : null);
  ipcMain.on(IpcChannels.PetIdle, (event, idle: boolean) => {
    if (!ownsPet(event)) return;
    petIsIdle = petHasAvatar && idle === true;
    if (petIsIdle) tuckPetAtEdge();
  });
  ipcMain.handle(IpcChannels.PetStyle, async (event, style: string) => {
    if (!ownsPet(event) || !['pixel', 'comic', 'dog-pixel', 'dog-comic', 'none'].includes(style)) throw Error('Invalid pet style');
    await patchSettings({petStyle: style as 'pixel' | 'comic' | 'dog-pixel' | 'dog-comic' | 'none'});
  });
  ipcMain.on(IpcChannels.PetUndock, event => {
    if (!ownsPet(event) || !petDockEdge) return;
    const edge = petDockEdge;
    petDockEdge = null; petEmergeEdge = edge; petDockArmed = false; petPendingEdge = null;
    const win = petWindow!;
    const b = win.getBounds();
    const pos = petEdgePosition(b, screen.getDisplayMatching(b).workArea, edge, 36);
    // Move immediately, including a diagonal exit from a corner. A later content
    // resize uses the same inset, so animation timing cannot strand the head.
    win.setPosition(pos.x, pos.y, false);
    rememberPetAnchor(win);
    win.webContents.send(IpcChannels.PetDock, {edge: null, emergeFrom: edge});
    schedulePetAnchorWrite();
  });
  ipcMain.on(IpcChannels.PetSetInteractive, (event, interactive: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== petWindow || win.isDestroyed()) return;
    if (interactive || petDockEdge || !petHasAvatar) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  });
  // 拖拽：渲染层按住左键发起，主进程轮询光标位置平移窗口（透明窗无系统拖拽区，
  // 且窗口跟随光标移动不会反馈循环）；松手由 pet:drag-end 终止。
  // 坐标钳在当前显示器 workArea 内：窗口已贴合内容，整屏任意位置可达（旧版大窗顶边被菜单栏
  // 限制，宠物只能拖到屏幕下半部）。
  let petDragTimer: NodeJS.Timeout | null = null;
  ipcMain.on(IpcChannels.PetDragStart, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== petWindow || win.isDestroyed()) return;
    petIsDragging = true;
    petDockArmed = false; petPendingEdge = null;
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    const dragZoom = win.webContents.getZoomFactor() || 1;
    const [startW,startH] = win.getSize();
    let offsetX = petHasAvatar && !petDockEdge ? startW-58*dragZoom : cursor.x-x;
    let offsetY = petHasAvatar && !petDockEdge ? startH-120*dragZoom : cursor.y-y;
    let lastSize = win.getSize().join(',');
    if (petDragTimer) clearInterval(petDragTimer);
    petDragTimer = setInterval(() => {
      if (!petWindow || petWindow.isDestroyed()) { if (petDragTimer) clearInterval(petDragTimer); petDragTimer = null; petIsDragging = false; return; }
      const c = screen.getCursorScreenPoint();
      const [w, h] = petWindow.getSize();
      const wa = screen.getDisplayNearestPoint(c).workArea;
      // Keep a held pet tucked while the pointer follows an edge. Moving inward
      // releases the full body without ending pointer capture or restarting drag.
      const nearEdge = petHasAvatar ? petDragEdge(c, wa) : null;
      if (nearEdge !== petDockEdge) {
        petDockEdge = nearEdge; petEmergeEdge = null;
        petWindow.webContents.send(IpcChannels.PetDock, {edge:nearEdge, dragging:true});
      }
      if (lastSize !== [w,h].join(',')) {
        lastSize = [w,h].join(',');
        const zoom = petWindow.webContents.getZoomFactor() || 1;
        offsetX = nearEdge ? w/2 : w-58*zoom;
        offsetY = nearEdge ? h/2 : h-146*zoom; // 144px hanging body, scruff at 36%, 46px footer + margins
      }
      const nx = Math.max(wa.x, Math.min(c.x - offsetX, wa.x + wa.width - w));
      const ny = Math.max(wa.y, Math.min(c.y - offsetY, wa.y + wa.height - h));
      const pos = nearEdge ? petEdgePosition({x:nx,y:ny,width:w,height:h}, wa, nearEdge) : {x:nx,y:ny};
      // Zoomed scruff offsets and odd-sized heads produce fractional DIP values;
      // Electron's native setPosition requires integers even between edge states.
      petWindow.setPosition(Math.round(pos.x), Math.round(pos.y));
    }, 16);
  });
  const stopPetDrag = () => {
    if (!petDragTimer) return;
    petIsDragging = false;
    if (petDragTimer) { clearInterval(petDragTimer); petDragTimer = null; }
    if (petWindow && !petWindow.isDestroyed()) {
      const b = petWindow.getBounds();
      petPendingEdge = petEdgeAtBounds(b, screen.getDisplayMatching(b).workArea);
    }
    petDockArmed = !!petPendingEdge; tuckPetAtEdge();
    // 松手即落盘（不走 400ms 消抖）：用户拖完立刻 cmd-Q 也是常态
    if (petWindow && !petWindow.isDestroyed()) rememberPetAnchor(petWindow);
    flushPetAnchor();
  };
  ipcMain.on(IpcChannels.PetDragEnd, event => { if (ownsPet(event)) stopPetDrag(); });
  // 渲染层按可见内容（眼睛/胶囊/输入条/气泡）实测尺寸上报，窗口紧贴内容；
  // 默认右下角锚点不动（compose/项目胶囊向左展开时右侧语音/提交按钮零位移）；
  // 左侧放不下（宠物靠近屏幕左缘）时改为钉住左缘向右展开，并钉在 workArea 内，
  // 避免窗口被推出屏幕导致宠物“突然跳没”。
  // pin='top'：项目面板开在下方（屏幕上方放不下）时钉住顶边向下长，胶囊才不会跟着跳。
  ipcMain.on(IpcChannels.PetResize, (event, w: number, h: number, pin?: 'top' | 'bottom') => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== petWindow || win.isDestroyed()) return;
    if (!(w > 0) || !(h > 0)) return;
    const zoom = win.webContents.getZoomFactor() || 1;
    const [cw, ch] = win.getContentSize();
    const nw = Math.min(Math.round(w * zoom), 720);
    const nh = Math.min(Math.round(h * zoom), 620);
    if (nw === cw && nh === ch) return;
    const [x, y] = win.getPosition();
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const ordinary = petResizePosition({ x, y, prevWidth: cw, prevHeight: ch, width: nw, height: nh, workArea: wa, pin });
    const edge = petDockEdge || petEmergeEdge;
    const pos = edge ? petEdgePosition({...ordinary, width: nw, height: nh}, wa, edge, petEmergeEdge ? 36 : 0) : ordinary;
    petEmergeEdge = null;
    win.setContentSize(nw, nh, false);
    win.setPosition(pos.x, pos.y, false);
    // 展开/收起会碰到 workArea 钳位（靠屏幕左缘、pin='top' 往下长等），钳完的角才是真位置
    rememberPetAnchor(win);
    schedulePetAnchorWrite();
  });
  // 宠物窗上下各还剩多少屏幕空间（workArea 口径）：渲染层据此决定项目面板
  // 向上还是向下开。窗口只包住内容，光看 window.screen 算不准多屏/DPI。
  ipcMain.handle(IpcChannels.PetRoom, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== petWindow || win.isDestroyed()) return null;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    return { above: b.y - wa.y, below: wa.y + wa.height - (b.y + b.height) };
  });
  // 右键菜单「退出」：持久关闭宠物开关，settingsDidChange 会自动销毁窗口且重启不再拉起。
  ipcMain.on(IpcChannels.PetExit, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== petWindow) return;
    stopPetDrag();
    void patchSettings({ petEnabled: false });
  });
  ipcMain.handle(IpcChannels.PetOpenMain, async (event, noticeId?:string) => {
    if (!ownsPet(event)) return {ok:false};
    const notice = petNotices.get(noticeId);
    let win = notice?.windowId ? windows.get(notice.windowId) : undefined;
    if (!win || win.isDestroyed()) win = [...windows.values()].find(w=>!w.isDestroyed());
    if (!win) win = await createWindow();
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    if (process.platform === 'darwin') app.focus({steal:true});
    if (notice) win.webContents.send(IpcChannels.PetReveal, notice.target);
    return {ok:true};
  });
}

function registerAppHandlers() {
  // Renderer responds to WindowBeforeClose with running-tasks info.
  ipcMain.on(IpcChannels.WindowCloseCheckResult, (event, result: {
    hasTasks: boolean; title: string; message: string; confirmBtn: string; cancelBtn: string;
  }) => {
    const senderId = event.sender.id;
    const win = windows.get(senderId);
    if (!win || win.isDestroyed()) return;

    if (!result.hasTasks) {
      // No running tasks — close directly.
      forceCloseIds.add(senderId);
      win.close();
      return;
    }

    // Show native dialog with localized text from the renderer.
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: result.title || 'Tasks Running',
      message: result.message || 'Tasks are running. Closing will abort them.',
      buttons: [result.cancelBtn || 'Cancel', result.confirmBtn || 'Close'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 1) {
      // User confirmed close.
      forceCloseIds.add(senderId);
      win.close();
    } else {
      // choice === 0 (Cancel): keep the window open. If this was part of an
      // app quit, cancel the quit so a later manual close doesn't quit.
      isQuitting = false;
      cancelScreenshotEditorQuit();
    }
  });

  ipcMain.handle(IpcChannels.RelayModelsSchedule, () => ({ nextAt: getConnectedRelay() ? relayModelNextAt : 0, refreshing: relayModelSync.isRefreshing() }));
  ipcMain.handle(IpcChannels.RelayModelsList, async () => fetchRelayModels(await readSettings()));
    // 提供商模型清单：倒计时调度（照抄中继模式）+ 手动立即刷新单个提供商。
    ipcMain.handle(IpcChannels.ProviderModelsSchedule, async () => {
      const s = await readSettings().catch(() => null);
      const anyListProvider = (s?.modelProviders ?? []).some(p => p.enabled && isListSyncedProvider(p));
      return { nextAt: anyListProvider ? providerModelNextAt : 0, refreshing: providerModelSync.isRefreshing() };
    });
    ipcMain.handle(IpcChannels.ProviderModelsRefresh, async (_e, providerId: string) => {
      const before = await readSettings();
      const provider = (before.modelProviders ?? []).find(p => p.id === providerId);
      if (!provider) throw new Error('提供商不存在');
      if ((provider.kind ?? 'normal') !== 'normal') throw new Error('仅普通提供商支持模型清单刷新');
      // 密文绝不允许直接发出；decryptSecret 对明文幂等。
      const res = await fetchProviderModelList({ apiKey: decryptSecret(pickApiKey(provider.apiKey)), baseUrl: provider.baseUrl || undefined, protocol: provider.protocol, lang: resolveLanguage(before.language) });
      if (!res.ok || !res.models.length) return { ok: false, listSupported: res.listSupported, error: res.error ?? '模型列表为空', models: [] as string[], named: [] };
      const models = res.models.slice().sort((a, b) => a.localeCompare(b));
      const named = res.named.slice().sort((a, b) => a.id.localeCompare(b.id));
      // 手动刷新成功即确认支持清单接口；成员模型变化后做复合提供商联动清理。
      const providers = pruneComposites((before.modelProviders ?? []).map(p => p.id === providerId ? { ...p, models, relayModels: named, modelsListSupported: true } : p));
      const next = await repository().update(current => ({ ...current, modelProviders: providers }), before._revision ?? 'legacy');
      settingsDidChange(next);
      return { ok: true, listSupported: true, models, named };
    });
  const claimOnboarding = createOnboardingClaim(path.join(app.getPath('userData'), 'onboarding-state.json'));
  ipcMain.handle('app:onboarding:claim', (event) => {
    if (!windows.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) throw new Error('Untrusted sender');
    return claimOnboarding();
  });
  ipcMain.handle(IpcChannels.AppSettingsGet, async () => publicSettings(await readSettings(),app.getLocale()));
  ipcMain.handle('fonts:list', () => listSystemFonts());
  ipcMain.handle(IpcChannels.AppSettingsSet, async (_e, patch: Partial<AppSettings>, revision: string) => {
    if (typeof revision !== 'string') throw new Error('缺少配置版本，请重新加载');
    const next = await repository().update(cur => applyPublicPatch(cur, patch), revision);
    settingsDidChange(next);
    return publicSettings(withMobileProjectDirectoryDefaults(next, app.getPath('home')),app.getLocale());
  });
  ipcMain.handle(IpcChannels.McpEnvironmentSet, async (_e, values: Record<string,string>, baselineNames: string[]) => {
    const next = await repository().update(cur => ({
      ...cur,
      mcpEnvironmentVariables: mergeMcpEnvironmentVariables(cur.mcpEnvironmentVariables, values, baselineNames),
    }));
    settingsDidChange(next);
    return publicSettings(withMobileProjectDirectoryDefaults(next, app.getPath('home')),app.getLocale());
  });
  ipcMain.handle(IpcChannels.SettingsExport, async (_e, args) => {
    const s = await readSettings();
    const encrypted = await exportSettings(s, args.password, args.policy, args.groups);
    const picked = await dialog.showSaveDialog({ title: '导出加密配置', defaultPath: `sage-settings-${new Date().toISOString().replace(/[:.]/g, '-')}.sageconfig`, filters: [{ name: 'Sage 加密配置', extensions: ['sageconfig'] }] });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    await writeEncryptedExport(picked.filePath, encrypted);
    return { canceled: false };
  });
  const importPreviews = new WindowPreviews<{ticket:string; incoming:AppSettings; revision?:string; expires:number}>();
  ipcMain.handle(IpcChannels.SettingsImportPreview, async (event, password:string) => {
    importPreviews.delete(event.sender.id);
    const picked=await dialog.showOpenDialog({title:'预览配置备份',properties:['openFile'],filters:[{name:'Sage 加密配置',extensions:['sageconfig']}]});
    if(picked.canceled||!picked.filePaths[0])return {canceled:true};
    const file=picked.filePaths[0];
    if((await fs.stat(file)).size>10*1024*1024)throw Error('备份超过 10 MB 限制');
    const incoming=migrateModelProfiles(await importSettings(await fs.readFile(file,'utf8'),password));
    const available=includedBackupGroups(incoming),current=await readSettings().catch(()=>null);
    const ticket=crypto.randomUUID();
    importPreviews.set(event.sender,{ticket,incoming,revision:current?current._revision??'legacy':undefined,expires:Date.now()+15*60*1000});
    return {canceled:false,preview:{ticket,currentReadable:!!current,groups:available.map(id=>({id,fields:Object.keys(incoming).filter(k=>!k.startsWith('_')&&backupGroup(k)===id),...(id==='models'?{providerCount:incoming.modelProviders?.length??0}:{})}))}};
  });
  ipcMain.handle(IpcChannels.SettingsImportApply, async (event,ticket:string,groups:unknown) => {
    const draft=importPreviews.get(event.sender.id);
    if(!draft||draft.ticket!==ticket||draft.expires<Date.now())throw Error('导入预览已过期，请重新选择备份');
    const selected=validBackupGroups(groups);
    const next=draft.revision===undefined
      ? await repository().replaceFromBackup(applySettingsImport({},draft.incoming,selected))
      : await repository().update(current=>applySettingsImport(current,draft.incoming,selected),draft.revision);
    importPreviews.delete(event.sender.id);settingsDidChange(next);
    return {settings:publicSettings(withMobileProjectDirectoryDefaults(next, app.getPath('home')),app.getLocale())};
  });
  ipcMain.handle(IpcChannels.SettingsImport, async (_e, args) => {
    const picked = await dialog.showOpenDialog({ title: '导入加密配置', properties: ['openFile'], filters: [{ name: 'Sage 加密配置', extensions: ['sageconfig'] }] });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const file = picked.filePaths[0];
    if ((await fs.stat(file)).size > 10 * 1024 * 1024) throw new Error('备份超过 10 MB 限制');
    const incoming = migrateModelProfiles(await importSettings(await fs.readFile(file, 'utf8'), args.password));
    const cur = await readSettings().catch(() => null);
    if (!cur && args.mode !== 'replace') throw new Error('当前配置不可读，请选择替换模式从备份恢复');
    const replace = args.mode === 'replace';
    const decision = await dialog.showMessageBox({ type: 'question', title: '确认导入配置', message: `已验证加密备份：${incoming.modelProviders?.length ?? 0} 个模型提供商`, detail: replace ? '将替换全局配置。当前文件先保存为历史版本；现有敏感字段保护策略不会解除。' : '合并全局配置：保留现有同 ID 提供商，添加新提供商；备份中的其他设置覆盖对应项。当前文件先保存为历史版本。', buttons: ['取消', '导入'], defaultId: 0, cancelId: 0 });
    if (decision.response !== 1) return { canceled: true };
    const selective = (incoming as any)._backupSections !== undefined;
    const next = selective
      ? (cur ? await repository().update(current=>applySettingsImport(current,incoming,includedBackupGroups(incoming)),cur._revision??'legacy') : await repository().replaceFromBackup(applySettingsImport({},incoming,includedBackupGroups(incoming))))
      : replace
      ? await repository().replaceFromBackup(incoming, cur ? cur._revision ?? 'legacy' : undefined)
      : await repository().update(current => mergeImport(current, incoming), cur!._revision ?? 'legacy');
    settingsDidChange(next);
    return { canceled: false, settings: publicSettings(withMobileProjectDirectoryDefaults(next, app.getPath('home')),app.getLocale()) };
  });
  ipcMain.handle(IpcChannels.SettingsVersions, async () => repository().versions());
  ipcMain.handle(IpcChannels.SettingsVersionPreview, async (_e, name: string) => {
    const {current,version} = await repository().preview(name);
    return settingsVersionPreview(name,current,version);
  });
  ipcMain.handle(IpcChannels.SettingsRestore, async (_e, name: string, revision: string) => {
    const decision = await dialog.showMessageBox({ type: 'question', title: '恢复历史配置', message: '恢复此历史版本？当前配置会先保存为新历史版本。', buttons: ['取消', '恢复'], defaultId: 0, cancelId: 0 });
    if (decision.response !== 1) return { canceled: true };
    const next = await repository().restore(name, revision);
    settingsDidChange(next);
    return { canceled: false, settings: publicSettings(withMobileProjectDirectoryDefaults(next, app.getPath('home')),app.getLocale()) };
  });

  /** 返回沙箱所有默认值常量，供渲染层设置面板展示。 */
  ipcMain.handle(IpcChannels.SandboxDefaultsGet, async () => {
    const { DEFAULT_STRIP_ENV_KEYS, DEFAULT_SAFE_ENV_KEYS, DEFAULT_SAFE_PATH_PREFIXES } = await import('./sandbox/env');
    const { DEFAULT_DENY_READ_PREFIXES, DEFAULT_DENY_WRITE_PREFIXES, DEFAULT_DENY_WRITE_SEGMENTS, DEFAULT_SAFE_SYSTEM_PREFIXES } = await import('./sandbox/fs-policy');
    const { DEFAULT_HARD_DENIED_PATTERNS } = await import('./sandbox/bash-policy');
    const { DEFAULT_ALLOWED_HOSTS } = await import('./sandbox/net-policy');
    const { runtimeAvailable } = await import('./sandbox/runtime');
    return {
      runtimeAvailable: runtimeAvailable(),
      env: {
        stripKeys: [...DEFAULT_STRIP_ENV_KEYS],
        safeKeys: [...DEFAULT_SAFE_ENV_KEYS],
        safePathPrefixes: [...DEFAULT_SAFE_PATH_PREFIXES],
      },
      fs: {
        denyRead: [...DEFAULT_DENY_READ_PREFIXES],
        denyWrite: [...DEFAULT_DENY_WRITE_PREFIXES],
        denyWriteSegments: [...DEFAULT_DENY_WRITE_SEGMENTS],
        safeSystemPrefixes: [...DEFAULT_SAFE_SYSTEM_PREFIXES],
      },
      bash: {
        hardDenied: [...DEFAULT_HARD_DENIED_PATTERNS],
      },
      net: {
        allowedHosts: [...DEFAULT_ALLOWED_HOSTS],
      },
    };
  });

  /** 设置当前审计上下文的项目路径（决定审计日志写到哪个项目目录）。 */
  ipcMain.handle(IpcChannels.AuditLogSetProject, async (_e, projectPath: string | null) => {
    try {
      const { setAuditProject } = await import('./sandbox/audit-log');
      setAuditProject(projectPath);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  /** 读取沙箱审计日志（最近 limit 条，倒序返回）。 */
  ipcMain.handle(IpcChannels.AuditLogGet, async (_e, opts?: import('../shared/types').AuditQuery) => {
    try {
      const { readAuditLog } = await import('./sandbox/audit-log');
      return readAuditLog(opts ?? {}, (await listProjects()).map(p=>p.path));
    } catch (err: any) {
      return { error: err?.message ?? String(err), entries: [] };
    }
  });

  /** 在 Finder 中显示审计日志文件。 */
  ipcMain.handle(IpcChannels.AuditLogOpenInFinder, async () => {
    try {
      const { getAuditLogPath } = await import('./sandbox/audit-log');
      shell.showItemInFolder(getAuditLogPath());
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  // Settings UI explicitly calls "ClaudeStatus" to verify the binary, so we
  // force-refresh here to defeat the cache. Hot-path calls inside
  // sendMessage/spec-engine use the unforced default and stay fast.
  ipcMain.handle(IpcChannels.CodexStatus, async () => detectCodex((await readSettings()).codexBinaryPath));
  ipcMain.handle(IpcChannels.ClaudeStatus, async () => detectClaude(true));

  // 应用版本号（关于/帮助页展示，动态读取避免硬编码过时）
  ipcMain.handle(IpcChannels.AppVersion, () => app.getVersion());
  ipcMain.handle(IpcChannels.ApiUserAgentVersions, async () => (await import('./utils/api-user-agent')).getApiUserAgentVersions());

  // ── 自动更新 ────────────────────────────────────────────────────────
  ipcMain.handle(IpcChannels.UpdateCheck, async () => {
    const status = await checkForUpdates(false);
    return status;
  });
  ipcMain.handle(IpcChannels.UpdateInstall, async (_event, restart?: boolean) => {
    await downloadAndInstall(restart === true);
    return getUpdateStatus();
  });
  ipcMain.handle(IpcChannels.UpdateCancel, () => cancelUpdateDownload());
  ipcMain.handle(IpcChannels.UpdateSwitch, async () => {
    return switchToNewerVersion();
  });
  ipcMain.handle(IpcChannels.UpdateDismissSuperseded, () => {
    return dismissSuperseded();
  });
  ipcMain.handle(IpcChannels.UpdateStatus, () => getUpdateStatus());

  // 更新源自检：主进程 GET 一次 latest-mac.json（不受 CORS 限制）；入参为设置页可选的自定义地址覆盖
  ipcMain.handle(IpcChannels.UpdateProbe, async (_e, urlOverride?: string) => probeUpdateService(urlOverride));

  // 测试 API 连接：配了模型就真调第一个模型，没配就只测接口连通性（口径见 testProviderKeys）。
  ipcMain.handle(
    IpcChannels.ApiTestConnection,
    async (_e, args: { apiKey: string; baseUrl?: string; protocol?: 'anthropic' | 'openai'; providerId?: string; models?: string[] }) => {
      let { apiKey, baseUrl, protocol = 'anthropic' } = args;
      let models = args.models;
      const settings = await readSettings();
      // 失败文案在主进程产出 → 必须跟着界面语言走，不能只在渲染层翻译。
      const lang = resolveLanguage(settings.language);
      const protectedRequest = apiKey === PROTECTED || baseUrl === PROTECTED;
      if (protectedRequest) {
        const stored = settings.modelProviders?.find(p => p.id === args.providerId);
        if (!stored) throw new Error(lang === 'en' ? 'Protected provider not found' : '受保护提供商不存在');
        // Resolve the entire connection together; never send a saved key to a renderer-selected host.
        apiKey = stored.apiKey; baseUrl = stored.baseUrl; protocol = stored.protocol;
        // 受保护提供商：被测模型同样以服务端存的可能为准，不看渲染层传来的参数。
        models = stored.models;
      } else {
        // Renderer ciphertext is not a decryption API.
        if (/^(aes:|enc:)/.test(apiKey)) throw new Error(lang === 'en' ? 'Use the provider connection test instead' : '请使用提供商连接测试');
      }
      try {
        // 密文绝不允许被当 API key 发出，且多 key 是整串一起加密的 → 先解密再拆（decryptSecret 对明文幂等）。
        // 逐把验证与「测了什么」的聚合规则见 testProviderKeys。
        const res = await testProviderKeys({ apiKey: decryptSecret(apiKey), baseUrl: baseUrl || undefined, protocol, models, lang });
        return { ok: res.ok, error: res.error, models: res.models, listSupported: res.listSupported, named: res.named, keys: res.keys, tested: res.tested, model: res.model };
      } catch (err: any) {
        const msg = protectedRequest
          ? (lang === 'en' ? 'Connection test failed, please check the provider status' : '连接测试失败，请检查提供商状态')
          : (err?.message ?? String(err));
        return { ok: false, error: msg, models: [] as string[], named: [], keys: [] as import('../shared/types').ApiKeyTestResult[], listSupported: undefined };
      }
    },
  );

  ipcMain.handle(IpcChannels.ProjectPick, async (event) => {
    // 使用发起请求的窗口作为 dialog parent——多窗口下每个窗口独立 pick。
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return null;
    const r = await dialog.showOpenDialog(senderWin, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择一个项目目录',
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    const entry = await addProject(p);
    await (await import('./scheduler')).loadTasksForProject(p);
    void rebuildDockMenu(); // 刷新 Dock 最近项目
    return entry;
  });

  ipcMain.handle(IpcChannels.ProjectList, async () => listProjectsWithActivity());
  ipcMain.handle(IpcChannels.ProjectSetIcon, async (_event, args: { projectPath: string; icon?: string }) => {
    const project = await setProjectIcon(args.projectPath, args.icon);
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send('mobile-management:changed', { section: 'project-icon', projectPath: project.path });
    return project;
  });

  // 把指定目录直接注册为项目（文件树右键「作为 Sage 项目打开」）。
  ipcMain.handle(IpcChannels.ProjectAdd, async (_e, projectPath: string) => {
    if (!projectPath || typeof projectPath !== 'string') return null;
    try {
      const st = await fs.stat(projectPath);
      if (!st.isDirectory()) return null;
      const entry = await addProject(projectPath);
      await (await import('./scheduler')).loadTasksForProject(projectPath);
      void rebuildDockMenu(); // 刷新 Dock 最近项目
      return entry;
    } catch {
      return null;
    }
  });
  ipcMain.handle(
    IpcChannels.ProjectRemove,
    async (_e, projectPath: string, purgeData?: boolean) => {
      await removeProject(projectPath, !!purgeData);
      void rebuildDockMenu(); // 刷新 Dock 最近项目
    },
  );

  ipcMain.handle(IpcChannels.ProjectTouch, async (event, projectPath: string) => {
    await touchProject(projectPath);
    await (await import('./scheduler')).loadTasksForProject(projectPath);
    // Track which window is showing which project for Dock menu focus-or-create.
    windowProjects.set(event.sender.id, projectPath);
    // 切换项目时标记缓存失效，下次读取会从磁盘重新加载（取新项目的配置）
    markSandboxCacheDirty();
  });

  // 设置项目级启用的插件列表（持久化到 projects.json）。
  ipcMain.handle(
    IpcChannels.ProjectSetEnabledPlugins,
    async (_e, args: { projectPath: string; enabledPlugins: string[] }) => {
      const { projectPath, enabledPlugins } = args;
      const { setProjectEnabledPlugins } = await import('./store');
      const entry = await setProjectEnabledPlugins(projectPath, enabledPlugins);
      void rebuildDockMenu();
      return entry;
    },
  );

  ipcMain.handle(
    IpcChannels.ProjectSetModel,
    async (_e, projectPath: string, modelProfileId?: string) => {
      await setProjectModel(projectPath, modelProfileId);
    },
  );

  ipcMain.handle(
    IpcChannels.ProjectSetSelectedModel,
    async (_e, projectPath: string, selected: { providerId: string; modelId: string } | null) => {
      await setProjectSelectedModel(projectPath, selected);
    },
  );

  ipcMain.handle(
    IpcChannels.ProjectSetSelectedVisionModel,
    async (_e, projectPath: string, selected: { providerId: string; modelId: string } | null) => {
      await setProjectSelectedVisionModel(projectPath, selected);
    },
  );

  ipcMain.handle(
    IpcChannels.ProjectSetSandboxOverrides,
    async (_e, projectPath: string, overrides: ProjectEntry['sandboxOverrides']) => {
      const { setProjectSandboxOverrides } = await import('./store');
      const { validateSecuritySettings, normalizeSecuritySettings } = await import('../shared/security-settings');
      const error = validateSecuritySettings(overrides ?? {});
      // 抛出 i18n 键（可含插值参数），由渲染层负责翻译展示
      if (error) throw new Error(error.params ? `${error.key}:${JSON.stringify(error.params)}` : error.key);
      await setProjectSandboxOverrides(projectPath, normalizeSecuritySettings(overrides ?? {}));
      // 审计日志：记录沙箱策略变更
      try {
        const { audit } = await import('./sandbox/audit-log');
        audit({
          ts: new Date().toISOString(),
          source: 'tool',
          tool: 'ProjectSetSandboxOverrides',
          action: 'approve',
          detail: { reason: `用户修改项目 ${projectPath} 的沙箱策略` },
        });
      } catch { /* ignore */ }
      // 标记 sandbox 缓存失效（下次 getSandboxOverrides 会重新加载）
      markSandboxCacheDirty();
    },
  );

  // ── Project Stats (persistent accumulated stats) ──────────────────────
  ipcMain.handle(IpcChannels.ProjectStatsGet, async (_e, projectPath: string) => {
    const { readProjectStats } = await import('./store');
    return readProjectStats(projectPath);
  });

  // ── Global Stats (aggregated across all projects) ─────────────────────
  ipcMain.handle(IpcChannels.GlobalStatsGet, async () => {
    const { readGlobalStats } = await import('./store');
    return readGlobalStats();
  });

  ipcMain.handle(IpcChannels.SpecOpenInFinder, async (_e, p: string) => {
    shell.showItemInFolder(p);
  });

  // Multi-window: open a new window, optionally auto-selecting a project.
  // If the same project is already open in another window, focus that window instead.
  ipcMain.handle(IpcChannels.WindowOpen, async (_e, args?: { projectPath?: string }) => {
    const targetProjectPath = args?.projectPath;

    // If a specific project is requested, check if it's already open
    if (targetProjectPath) {
      // Find existing window showing this project
      for (const [senderId, path] of windowProjects) {
        if (path === targetProjectPath) {
          const existingWindow = windows.get(senderId);
          if (existingWindow && !existingWindow.isDestroyed()) {
            // Focus the existing window instead of creating a new one
            existingWindow.focus();
            return { ok: true, focusedExisting: true };
          }
        }
      }
    }

    // No existing window found, create a new one
    await createWindow({ projectPath: targetProjectPath });
    return { ok: true, focusedExisting: false };
  });

  // Renderer queries pending auto-select project path (one-shot, cleared on read).
  ipcMain.handle(IpcChannels.WindowGetAutoSelectProject, (e) => {
    const path = pendingAutoSelect.get(e.sender.id);
    if (path) pendingAutoSelect.delete(e.sender.id);
    return path ?? null;
  });
}

// Security: ensure webview guests don't gain node access.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (_event, webPreferences, _params) => {
    // Strip preload scripts and enforce isolation.
    delete webPreferences.preload;
    (webPreferences as any).preloadURL = undefined;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
});

// ── 浏览器插件（<webview>）证书错误处理 ──
// 用户在中止页「接受风险并继续」后批准的 origin（进程内内存，重启失效）。
ipcMain.handle('browser-cert-approve', (event, origin: string) => {
  if (!windows.has(event.sender.id) || event.senderFrame !== event.sender.mainFrame) return false;
  return approveBrowserCertificate(origin);
});
app.on('certificate-error', (event, webContents, url, _error, _certificate, callback) => {
  handleBrowserCertificate(event, webContents, url, callback, async () => { const settings=await readSettings();return {ignoreAll:builtinSettingValue(settings,null,'browser','ignoreCertErrors')===true,ignoreLocal:builtinSettingValue(settings,null,'browser','ignoreLocalCertErrors')!==false}; });
});

app.whenReady().then(async () => {
  if (!ownsSettingsLock) return;
  // 媒体（麦克风/摄像头）权限显式放行：不设 handler 时 Electron 可能直接拒绝
  // getUserMedia，导致系统 TCC 从不弹框、Sage 不进隐私列表。仅放行媒体，其余收紧。
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const grant = permission === 'media';
    diagVoice(`permission request: ${permission} -> ${grant ? 'grant' : 'deny'}`);
    callback(grant);
  });
  // Keep the settings/recovery UI available when credentials or storage are unavailable.
  const settings = await readSettings().catch(() => ({} as AppSettings));
  loadMcpEnvironmentVariables(settings.mcpEnvironmentVariables);
  void import('./mcp-chat-tools').then(({ refreshEnabledChatMcpTools }) => refreshEnabledChatMcpTools()).catch(error => console.warn('[mcp] Initial tool cache warmup failed:', error));
  if (settings.claudeBinaryPath) setBinaryOverride(settings.claudeBinaryPath);
  // 初始化电源管理：如果启用了 preventSleep，立即阻止系统休眠
  updatePowerSaveBlocker(!!settings.preventSleep);
  registerAppHandlers();
  registerPetHandlers();
  await initializePlugins(id => windows.has(id));
  (await import('./browser-preview-bridge')).initializeBrowserPreviewBridge(id => windows.has(id));
  registerSpecHandlers(() => windows);
  registerModelProbeHandlers(() => activeUpdateTaskCount() + activeScheduledUpdateTaskCount() === 0);
  registerModelPriceHandlers();
  setMonitorWindows(() => windows);
  // Warm the claude detection cache so the first user send doesn't pay
  // the 4-5s zsh + claude --version cost. Fire-and-forget; if it fails
  // the first real call will retry.

  void rebuildDockMenu();
  startDockWatchdog(); // Dock 图标与宠物解耦：常驻看门狗，不允许被（异步）翻成隐藏
  // 可见性取证时线（~/Library/Logs/Sage/windows.log）：只在 dock / app.isHidden /
  // 窗口可见性等状态**变化**时写一行，正常运行几乎不增长。
  startWindowDiagnostics({
    getWindows: () => {
      const screenshot = getScreenshotEditorWindow();
      return screenshot ? [...windows.values(), screenshot] : [...windows.values()];
    },
    roleOf: (w) => (w === petWindow ? 'pet' : w === getScreenshotEditorWindow() ? 'screenshot' : 'main'),
  });

  // 启动调度器 + 入站通路（渠道双向打通）
  // - 配置了 relay → WebSocket 长连接到公网中继（本地无公网 IP 场景）
  // - 未配置 relay → 本地 HTTP 服务器兜底
  startScheduler(() => windows);
  relayModelNextAt = Date.now() + 30_000;
  providerModelNextAt = Date.now() + 30_000;
  relayModelSyncTimer = setInterval(() => {
    relayModelNextAt = Date.now() + 30_000;
    providerModelNextAt = Date.now() + 30_000;
    void relayModelSync.tick();
    void providerModelSync.tick();
  }, 30_000);
  relayModelSyncTimer.unref();
  void startInboundInfrastructure(() => windows).catch(() => {
    console.warn('[Settings] 入站服务暂未启动，请先恢复可读配置');
  });

  // 启动自动更新调度（配置了更新服务器时定时静默检查）
  startUpdater(() => windows, () => activeUpdateTaskCount() + activeScheduledUpdateTaskCount());

  // 清理上次更新残留的备份 bundle（Sage.app.backup*）。
  // 更新时旧 app 被改名备份，但当时的进程仍持有文件句柄导致当场删不掉
  // （ENOTEMPTY）；本次启动时旧进程已退出，句柄释放，可安全删除。
  cleanupStaleBackups();

  // ── 应用菜单：多语言支持 + 动态更新状态 ──
  // 初始化时从设置读取语言
  readSettings().then((settings) => {
    currentMenuLang = (settings.language as string) || 'zh';
    currentMenuShortcuts=settings.shortcuts;
    buildAppMenu();
  }).catch(() => {
    buildAppMenu();
  });

  // 更新状态变化时重建菜单（发现新版本 → 「检查更新…」变为「更新到 x.y.z」）
  onStatusChange(() => {
    buildAppMenu();
  });

  // ── 自动加载所有项目的定时任务到缓存 ──
  // 这样定时任务可以在用户未打开视图时也能自动执行
  listProjects().then(async (projects) => {
    const { loadTasksForProject } = await import('./scheduler');
    for (const p of projects) {
      try {
        await loadTasksForProject(p.path);
        console.log(`[scheduler] ✓ 已加载项目 "${p.name}" 的定时任务`);
      } catch (e) {
        console.error(`[scheduler] ✗ 加载项目 "${p.name}" 的定时任务失败:`, e);
      }
    }
  }).catch((e) => {
    console.error('[scheduler] 加载定时任务失败:', e);
  });

  await createWindow();

  // 新开窗口快捷键：跟随 settings.shortcuts 自定义（未分配则不注册）
  const bootSettings = await readSettings();
  await applyNewWindowShortcut(bootSettings);
  // 桌面宠物：开关持久化在通用设置，启动时同步窗口存在性
  applyPetWindow(bootSettings);

  if (process.platform === 'darwin') {
    app.on('activate', async () => {
      // The screenshot overlay owns this activation, including its hidden first paint.
      if (getScreenshotEditorWindow()) { await openScreenshotEditor(); return; }
      // 宠物窗口不算普通主窗口：只剩宠物时 Dock 点击仍应重建主窗口
      if (![...windows.values()].some((w) => !w.isDestroyed() && w !== petWindow)) {
        await createWindow();
      }
    });
  }
});

app.on('before-quit', () => {
  // 宠物还开着就退出（没松手、没关窗）：先把当前位置写盘，下次启动还在原地
  if (petWindow && !petWindow.isDestroyed()) rememberPetAnchor(petWindow);
  flushPetAnchor();
  relayModelSync.stop();
  providerModelSync.stop();
  if (relayModelSyncTimer) clearInterval(relayModelSyncTimer);
  isQuitting = true;
  // 释放电源阻止，恢复系统默认休眠行为
  if (powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId);
    powerSaveBlockerId = null;
    console.log('[PowerSaveBlocker] 应用退出，已恢复系统默认休眠行为');
  }
});

app.on('window-all-closed', () => {
  // 宠物窗口不计：只剩宠物时 Windows/Linux 也应退出（macOS 保留常驻）
  const mains = BrowserWindow.getAllWindows().filter((w) => w !== petWindow);
  if (mains.length === 0 && process.platform !== 'darwin') app.quit();
});
