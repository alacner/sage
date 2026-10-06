import { LinkContextMenu } from './components/LinkContextMenu';
import { useConversationReadReceipts } from './lib/conversation-read-receipts';
import { WindowScreenshot } from './components/WindowScreenshot';
import {resolveLanguage} from '../shared/language';
import {activeRecordExists as selectActiveRecordExists} from './lib/active-record';
import {NewSpecForm,AnalyzeDialog,TimelineView,WorkflowView,useSpecsEnabled} from './components/plugins/WorkflowViews';
import {readSidebarLayout,writeSidebarLayout} from './lib/sidebar-layout';
import { enabledBuiltins } from '../shared/builtin-plugins';
import { Onboarding } from './components/Onboarding';
import {PluginView, PluginNotifications, PluginSlot} from './components/plugins/PluginWorkbench';
import {usePluginColorGroups} from './components/plugins/usePluginColors';
import { useCallback, useEffect, useRef, useState, Component, lazy, Suspense } from 'react';
import { Copy, Check } from 'lucide-react';
import { useAppStore, saveTabsToStorage } from './stores/appStore';
import { useT, translate, displayConvTitle } from './i18n';
import { applyTheme, applyAppearance, resolveActiveTheme, type Theme } from './theme';
import { copyMarkdown } from './lib/clipboard';
import { useShortcut } from './lib/shortcuts';
import { ConfirmDialogHost } from './lib/confirm-dialog';
import { probeAllServices } from './lib/service-health';
import { Sidebar } from './components/Sidebar';
import { TitleBarActions } from './components/TitleBarActions';
import { FeedbackEntry } from './components/FeedbackDialog';
import { Welcome } from './components/Welcome';
import { ChatView } from './components/ChatView';
import { FileTabs } from './components/FileTabs';
import { StatusBar } from './components/StatusBar';
import { UpdateDialog } from './components/UpdateDialog';
import { getTabRenderer, getMainView } from './plugins';
import { BrowserWorkspace } from './plugins/browser/components/BrowserWorkspace';

import { SettingsBackup } from './components/SettingsBackup';
import type { SettingsTab } from './components/SettingsView';

const FileEditor = lazy(() => import('./components/FileEditor').then(m => ({ default: m.FileEditor })));
const TerminalView = lazy(() => import('./components/TerminalView').then(m => ({ default: m.TerminalView })));
const AboutModal = lazy(() => import('./components/AboutModal').then(m => ({ default: m.AboutModal })));
const RequestMonitor = lazy(() => import('./components/RequestMonitor').then(m => ({ default: m.RequestMonitor })));
const ScheduledTasksView = lazy(() => import('./components/ScheduledTasksView').then(m => ({ default: m.ScheduledTasksView })));
const ChannelsView = lazy(() => import('./components/ChannelsView').then(m => ({ default: m.ChannelsView })));
const SettingsView = lazy(() => import('./components/SettingsView').then(m => ({ default: m.SettingsView })));
const UsageAnalytics = lazy(() => import('./components/UsageAnalytics').then(m => ({ default: m.UsageAnalytics })));
const ContextAuditViewer = lazy(() => import('./components/ContextAuditViewer').then(m => ({ default: m.ContextAuditViewer })));

export default function App() {
  useConversationReadReceipts();
  const pluginColorGroups=usePluginColorGroups();
  const openTabs = useAppStore(s=>s.openTabs);
  const refreshClaude = useAppStore((s) => s.refreshClaude);
  const refreshSettings = useAppStore((s) => s.refreshSettings);
  const settings = useAppStore((s) => s.settings);
  useEffect(() => {
    if (!useAppStore.getState().openTabs.some(tab => tab.id === 'file:sage-plugin-manual')) return;
    let alive = true;
    window.api.plugins('manual').then(doc => {
      if (!alive) return;
      useAppStore.setState(state => ({openTabs: state.openTabs.map(tab => tab.id === 'file:sage-plugin-manual' && tab.kind === 'file' ? {...tab, data: {...tab.data, relPath: doc.name, content: doc.content, originalContent: doc.content, size: new TextEncoder().encode(doc.content).length}} : tab)}));
    }).catch(error => { if (alive) useAppStore.getState().setBanner(String(error)); });
    return () => { alive = false; };
  }, [settings?.language]);
  const settingsLoadError = useAppStore((s) => s.settingsLoadError);
  const t = useT();
  const refreshProjects = useAppStore((s) => s.refreshProjects);
  const refreshSpecs = useAppStore((s) => s.refreshSpecs);
  const refreshFileTree = useAppStore((s) => s.refreshFileTree);
  const applyStreamEvent = useAppStore((s) => s.applyStreamEvent);
  const applyChatEvent = useAppStore((s) => s.applyChatEvent);
  const applyScheduledEvent = useAppStore((s) => s.applyScheduledEvent);
  const applyInboundEvent = useAppStore((s) => s.applyInboundEvent);
  const currentProject = useAppStore((s) => s.currentProject);
  const openTabsCount = useAppStore((s) => s.openTabs.length);
  // 渲染主内容区用（独立订阅，不受标题 selector 影响）
  const activeTab = useAppStore((s) => s.openTabs.find((t) => t.id === s.activeTabId));
  const activeRecordExists = useAppStore(selectActiveRecordExists);
  const deepwikiOpen = useAppStore((s) => s.deepwikiOpen);
  const gitRepoInfo = useAppStore((s) => s.gitRepoInfo);
  const errorBanner = useAppStore((s) => s.errorBanner);
  const setBanner = useAppStore((s) => s.setBanner);
  const setProjectError = useAppStore((s) => s.setProjectError);
  const setConvError = useAppStore((s) => s.setConvError);
  const convId = useAppStore((s) => {
    if (!s.activeTabId?.startsWith('conv:')) return undefined;
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab && tab.kind === 'conversation' ? tab.convId : undefined;
  });
  const convError = useAppStore((s) => (convId ? s.convErrors[convId] : undefined));
  // 横幅优先展示对话级错误（绑定到当前对话），无则展示项目级错误（全局）。
  const activeError = convError ?? errorBanner;
  const dismissError = () => {
    if (convError) setConvError(undefined);
    else setBanner(undefined);
  };
  const pendingCloseWikiDetail = useAppStore((s) => s.pendingCloseWikiDetail);
  const theme = (useAppStore((s) => s.settings?.theme) as Theme | string | undefined) ?? 'system';
  const themes = useAppStore((s) => s.settings?.themes);
  const appearance = useAppStore((s) => s.settings?.appearance);
  const builtinThemeOverrides = useAppStore((s) => s.settings?.builtinThemeOverrides);

  // Auto-close wiki detail panel when wikiQnA creates a conversation
  useEffect(() => {
    if (pendingCloseWikiDetail) {
      setShowWikiDetail(false);
      useAppStore.setState({ pendingCloseWikiDetail: false });
    }
  }, [pendingCloseWikiDetail]);

  const [showNewSpec, setShowNewSpec] = useState(false);
  const [showAnalyze, setShowAnalyze] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  // 请求监控 dock 开合态：提升到 store，与左下栏按钮选中态共享
  const showMonitor = useAppStore((s) => s.monitorOpen);
  const monitorLayout = useAppStore((s) => s.monitorLayout);
    const monitorFullscreen = useAppStore((s) => s.monitorFullscreen);
  const sidebarHidden = useAppStore((s) => s.sidebarHidden);
  const [bannerCopied, setBannerCopied] = useState(false);
  const bannerCopyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onCopyBanner = useCallback(async () => {
    if (!activeError) return;
    const ok = await copyMarkdown(activeError);
    if (ok) {
      setBannerCopied(true);
      clearTimeout(bannerCopyTimer.current);
      bannerCopyTimer.current = setTimeout(() => setBannerCopied(false), 1500);
    }
  }, [activeError]);
  useEffect(() => () => clearTimeout(bannerCopyTimer.current), []);
  const [showWikiDetail, setShowWikiDetail] = useState(false);
  const [selectedWikiHeading, setSelectedWikiHeading] = useState<string | undefined>();
  const [wikiNavKey, setWikiNavKey] = useState(0);
  const handleOpenWikiDetail = useCallback((headingId: string) => {
    setSelectedWikiHeading(headingId);
    setShowWikiDetail(true);
    setWikiNavKey((k) => k + 1); // always increments → ProjectWiki effect fires every click
  }, []);

  // ── 侧边栏拖拽调整宽度（响应式：随窗口尺寸自适应） ──────
  const SIDEBAR_ABS_MIN = 140; // 窗口极小时允许压缩到的绝对下限
  const SIDEBAR_MIN = 180;     // 常规最小宽度
  const SIDEBAR_DEFAULT = 240;
  const SIDEBAR_ABS_MAX = 560; // 大屏下允许的绝对上限
  /**
   * 根据窗口宽度动态计算 [min, max] 允许范围。
   * - 主区域预留量随窗口尺寸缩放：小窗口预留 220px，大窗口预留 360px
   * - 大屏（≥1600）允许侧边栏更宽（最高 560px），最多不超过窗口 40%
   * - 窗口极窄（<520）时允许侧边栏压缩到 140px
   */
  const computeRange = () => {
    const winW = window.innerWidth;
    const reserve = winW < 900 ? 220 : winW < 1400 ? 300 : 360;
    const upperCap = winW >= 1600 ? SIDEBAR_ABS_MAX : 500;
    const proportional = Math.floor(winW * 0.4);
    const max = Math.max(SIDEBAR_ABS_MIN, Math.min(upperCap, proportional, winW - reserve));
    const min = winW < 520 ? SIDEBAR_ABS_MIN : SIDEBAR_MIN;
    return { min, max: Math.max(min, max) };
  };

  /** 用户保存的偏好宽度（可能超出当前窗口允许范围）。*/
  const widthProject=currentProject?.path;
  const [widthState,setWidthState]=useState(()=>({projectPath:widthProject,width:readSidebarLayout(widthProject).width}));
  const savedWidth=widthState.projectPath===widthProject?widthState.width:readSidebarLayout(widthProject).width;
  const [range, setRange] = useState(computeRange);

  // 监听窗口 resize，动态计算允许范围，并把用户保存的宽度 clamp 到当前允许范围。
  useEffect(() => {
    const compute = () => setRange(computeRange());
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, []);

  const sidebarWidth = Math.min(range.max, Math.max(range.min, savedWidth));

  const onResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    let latestWidth=savedWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      // 拖拽时的上下限按当前窗口重新计算，防止拖出可视范围。
      const { min, max } = computeRange();
      const next = Math.min(max, Math.max(min, ev.clientX));
      latestWidth=next;
      setWidthState({projectPath:widthProject,width:next});
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      writeSidebarLayout(widthProject,{width:latestWidth});
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [widthProject,savedWidth]);

  // ── 监控停靠面板拖拽调宽（停靠在右侧，向左拖变宽） ──────
  const MONITOR_MIN = 360;
  const MONITOR_MAX = 900;
  const MONITOR_DEFAULT = 520;
  const [monitorSaved, setMonitorSaved] = useState(() => readDimension('monitorWidth', MONITOR_DEFAULT));
  const monitorWidth = Math.min(MONITOR_MAX, Math.max(MONITOR_MIN, monitorSaved));
  const monitorWidthRef = useRef(monitorSaved);
  monitorWidthRef.current = monitorSaved;

  const onMonitorResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const maxByWindow = Math.max(MONITOR_MIN, window.innerWidth - 360);
      const next = Math.min(MONITOR_MAX, maxByWindow, Math.max(MONITOR_MIN, window.innerWidth - ev.clientX));
      setMonitorSaved(next);
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('monitorWidth', String(monitorWidthRef.current)); } catch { /* Keep the in-memory layout. */ }
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // 监控底栏（右栏下面）高度：与 dock 宽度同一套拖拽记忆机制
  const MONITOR_H_DEFAULT = 320;
  const MONITOR_H_MIN = 160;
  const MONITOR_H_MAX = 640;
  const [monitorHeightSaved, setMonitorHeightSaved] = useState(() => readDimension('monitorHeight', MONITOR_H_DEFAULT));
  const monitorHeight = Math.min(MONITOR_H_MAX, Math.max(MONITOR_H_MIN, monitorHeightSaved));
  const monitorHeightRef = useRef(monitorHeightSaved);
  monitorHeightRef.current = monitorHeightSaved;
  const onMonitorHeightResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(MONITOR_H_MAX, Math.max(MONITOR_H_MIN, window.innerHeight - ev.clientY));
      setMonitorHeightSaved(next);
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('monitorHeight', String(monitorHeightRef.current)); } catch { /* Keep the in-memory layout. */ }
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // 监控浮动窗口：标题栏拖动，位置 localStorage 记忆
  const [floatPos, setFloatPos] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = localStorage.getItem('monitorFloatPos');
      if (saved) {
        const p = JSON.parse(saved);
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
      }
    } catch { /* 回退默认位置 */ }
    return { x: Math.max(80, window.innerWidth - 620), y: 90 };
  });
  const floatDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const onFloatBarPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    floatDragRef.current = { dx: e.clientX - floatPos.x, dy: e.clientY - floatPos.y };
  };
  const onFloatBarPointerMove = (e: React.PointerEvent) => {
    if (!floatDragRef.current) return;
    setFloatPos({
      x: Math.max(0, Math.min(window.innerWidth - 120, e.clientX - floatDragRef.current.dx)),
      y: Math.max(0, Math.min(window.innerHeight - 48, e.clientY - floatDragRef.current.dy)),
    });
  };
  const onFloatBarPointerUp = () => {
    if (!floatDragRef.current) return;
    floatDragRef.current = null;
    try { localStorage.setItem('monitorFloatPos', JSON.stringify(floatPos)); } catch { /* 忽略 */ }
  };

  useEffect(() => {
    refreshClaude();
    refreshSettings();
    refreshProjects();
    const offMenuAction=window.api.onMenuAction?.(async action=>{
      const store=useAppStore.getState();
      if(action==='openFolder'){await store.pickProject();return;}
      if(action==='newChat'){
        if(!store.currentProject)await store.pickProject();
        if(useAppStore.getState().currentProject)await useAppStore.getState().createConversation();
      }
    });
    const offPetReveal = window.api.onPetReveal?.(target => {
      if (target.kind === 'activity') {
        const item = target.item;
        // The source window may have closed; restore just this clicked notice without
        // forwarding it back to the pet or replaying an old activity list.
        if (item && !useAppStore.getState().activityItems.some(a=>a.title===item.title && a.detail===item.detail))
          useAppStore.setState(state=>({activityItems:[{...item,id:`pet-${Date.now()}`,ts:Date.now()},...state.activityItems].slice(0,100)}));
        window.dispatchEvent(new Event('sage:show-activity')); return;
      }
      void (async () => {
        await useAppStore.getState().refreshProjects();
        const project = useAppStore.getState().projects.find(p=>p.path===target.projectPath);
        if (!project) return;
        if (useAppStore.getState().currentProject?.path!==project.path) await useAppStore.getState().selectProject(project);
        await useAppStore.getState().refreshScheduledRuns();
        const store = useAppStore.getState();
        if (store.currentProject?.path!==project.path) return;
        const run = store.scheduledRuns.find(r=>r.id===target.runId);
        store.openScheduledTab();
        if (run) {
          const {openScheduledRunConversation} = await import('./lib/scheduled-conversation');
          await openScheduledRunConversation(run,resolveLanguage(store.settings?.language,store.settings?._systemLocale)==='en',id=>store.selectConversation(id));
        }
      })().catch(()=>useAppStore.getState().openScheduledTab());
    });
    const offStream = window.api.onStream((e) => applyStreamEvent(e));
    const offChat = window.api.onChat((e) => applyChatEvent(e));
    const offScheduled = window.api.onScheduled((e) => applyScheduledEvent(e));
    // Inbound message from external platform (wechat/dingtalk/feishu) →
    // 写入 inboundHistory + 弹 toast 通知（若投递到当前对话则直接刷新）。
    const offInbound = window.api.onInboundEvent?.((e) => {
      applyInboundEvent(e);
      // 没有对话绑定渠道时，额外弹 error banner 提示用户
      if (e.status === 'no_binding') {
        setBanner(translate('app.channelUnbound', { channel: e.channelName || translate('app.unknownChannel') }));
      }
    });
    // Multi-window: query pending auto-select project path (one-shot, cleared on read).
    void window.api.getAutoSelectProject().then(async (projectPath) => {
      if (!projectPath) return;
      // Wait for refreshProjects to populate the list, then select.
      await useAppStore.getState().refreshProjects();
      const match = useAppStore.getState().projects.find((p) => p.path === projectPath);
      if (match) await useAppStore.getState().selectProject(match);
    });
    // Cross-window settings sync: another window changed settings.
    const offSettingsChanged = window.api.onSettingsChanged(() => {
      void useAppStore.getState().refreshSettings();
    });
    const offMobileManagementChanged = window.api.onMobileManagementChanged?.((event) => {
      if (event.section === 'project-model' || event.section === 'project-icon' || event.section === 'project-list') void useAppStore.getState().refreshProjects().catch(() => {});
    });
    // 宠物／另一扇窗口新建、删除、归档了对话：左栏当场补上／摘掉那一条
    const offConvListChanged = window.api.onConvListChanged((p: any) => {
      void useAppStore.getState().syncConvListChanged(p);
    });
    // 自动更新状态推送：发现新版本时自动弹出更新窗口
    const offUpdate = window.api.onUpdateStatus((s) => {
      const prev = useAppStore.getState().updateStatus;
      useAppStore.setState({ updateStatus: s });
      if (s.phase === 'available' && prev?.phase !== 'available') {
        useAppStore.setState({ updateDialogOpen: true });
        useAppStore.getState().pushActivity({
          kind: 'update',
          title: translate('app.updateAvailableTitle', { version: s.latestVersion ?? '' }),
          detail: s.notes?.slice(0, 100),
        });
      }
      if (s.phase === 'error' && prev?.phase !== 'error' && s.latestVersion) {
        useAppStore.getState().pushActivity({
          kind: 'update',
          title: translate('app.updateFailedTitle', { version: s.latestVersion }),
          detail: s.error?.slice(0, 100),
        });
      }
      // 下载中发现了更新的版本：弹窗提示「切换到新版本 / 继续当前下载」
      if (s.supersededBy && s.supersededBy !== prev?.supersededBy) {
        useAppStore.setState({ updateDialogOpen: true });
        useAppStore.getState().pushActivity({
          kind: 'update',
          title: translate('app.updateSupersededTitle', { version: s.supersededBy }),
          detail: s.notes?.slice(0, 100),
        });
      }
    });
    return () => {
      offMenuAction?.();
      offPetReveal?.();
      offStream();
      offChat();
      offScheduled();
      offInbound?.();
      offSettingsChanged();
      offMobileManagementChanged?.();
      offConvListChanged();
      offUpdate();
    };
  }, [applyStreamEvent, applyChatEvent, applyScheduledEvent, applyInboundEvent, refreshClaude, refreshProjects, refreshSettings]);

  // Window close: main process asks if there are running tasks.
  // Registered ONCE — callback reads store at invocation time, no stale closures.
  useEffect(() => {
    window.api.onCheckRunningTasks(() => {
      const s = useAppStore.getState();
      const hasTasks =
        s.wikiGenerating ||
        Object.keys(s.busyConvIds).length > 0 ||
        !!s.busyPhase ||
        !!s.analysisMode || s.settingsDirty;
      return {
        hasTasks,
        title: translate('app.closeConfirmTitle'),
        message: s.settingsDirty ? translate('settings.dirtyClose') : translate('app.closeConfirmMessage'),
        confirmBtn: translate('app.closeConfirmBtn'),
        cancelBtn: translate('app.closeCancelBtn'),
      };
    });
  }, []);

  // 应用关闭前保存当前 tabs 到 localStorage
  useEffect(() => {
    const onBeforeUnload = () => {
      const state = useAppStore.getState();
      const projectPath = state.currentProject?.path;
      if (projectPath) {
        // 渲染进程为 Vite ESM（无 require），必须静态导入保存函数
        saveTabsToStorage(projectPath, state.openTabs, state.activeTabId);
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Auto-refresh on window focus
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastRun = 0;
    const tick = () => {
      const now = Date.now();
      if (now - lastRun < 2000) return;
      lastRun = now;
      if (!useAppStore.getState().currentProject) return;
      void useAppStore.getState().refreshSpecs();
      void useAppStore.getState().refreshFileTree();
    };
    const onFocus = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 150);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onFocus();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshSpecs, refreshFileTree]);

  // ── 网络中断/休眠/切换网络 自动恢复 ─────────────────────────────────────────
  // 监听 online/offline/visibilitychange 事件：
  // - 用户回到前台或重连网络时，检查当前对话是否"假busy"（busy 但无活动）
  // - 如果是，清理 busy 状态，让用户可以继续操作
  useEffect(() => {
    const recover = () => {
      const { busyConvIds, conversations } = useAppStore.getState();
      const busyIds = Object.keys(busyConvIds);
      if (busyIds.length === 0) return;
      
      busyIds.forEach((convId) => {
        const conv = conversations.find((c) => c.id === convId);
        if (!conv || !conv.messages.length) return;
        
        const lastMsg = conv.messages[conv.messages.length - 1];
        const lastTs = lastMsg?.ts ? new Date(lastMsg.ts).getTime() : 0;
        const nowTs = Date.now();
        // 超过 30 秒没活动 → 视为卡死
        if (lastTs && nowTs - lastTs > 30 * 1000) {
          console.log(`[NetworkMonitor] Conv ${convId} appears stale (last activity ${Math.round((nowTs - lastTs) / 1000)}s ago), recovering`);
          // 清理 busy 状态，让用户可以继续操作
          useAppStore.getState().abortChat(convId);
        }
      });
    };
    
    window.addEventListener('online', recover);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recover();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // 当前激活 tab 的"完整名称"（Sublime 式：显示在顶部标题栏）。
  // 用稳定的字符串 selector 订阅所有影响标题的数据，避免 useMemo 中间环节
  // 在某些 re-render 路径下不触发（之前 fullTitle 没显示就是这个问题）。
  const tabTitleForHeader = useAppStore((s) => {
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    if (!tab) return '';
    switch (tab.kind) {
      case 'file': return `f:${tab.data.relPath}`;
      case 'terminal': return `t:${tab.data.title}`;
      case 'conversation':
        return `c:${s.conversations.find((c) => c.id === tab.convId)?.title ?? ''}`;
      case 'spec':
        return `s:${s.specs.find((x) => x.id === tab.specId)?.title ?? ''}`;
      case 'browser':
        return `b:${(tab.data as any)?.title || (tab.data as any)?.url || 'Browser'}`;
      default: return '';
    }
  });

  // 窗口标题：单一来源（只在这里设置，避免与子组件互相覆盖）。
  // 有选中 tab → 「完整tab名 — 项目名」；无 tab → 「项目名」；无项目 → 'Sage'。
  // 对话 tab 的默认标题是哨兵值「新对话」，渲染时按当前语言本地化。
  const headerTabTitle = tabTitleForHeader
    ? (tabTitleForHeader.startsWith('c:')
        ? displayConvTitle(tabTitleForHeader.slice(2))
        : tabTitleForHeader.slice(2))
    : '';
  useEffect(() => {
    if (!currentProject) {
      // 不能给空串：Blink 对空标题会回退到文档 URL 的末段，于是 macOS Dock 右键
      // 菜单/窗口菜单里这条窗口就成了谁也看不懂的 "index.html"。宁可显示应用名，
      // 也不留空。（宠物窗不靠标题管理：它直接被排除出窗口菜单，见 electron/main.ts）
      document.title = 'Sage';
    } else if (headerTabTitle) {
      document.title = `${headerTabTitle} — ${currentProject.name}`;
    } else {
      document.title = currentProject.name;
    }
  }, [headerTabTitle, currentProject]);

  // 切换项目时重置 wiki 详情面板
  useEffect(() => {
    setShowWikiDetail(false);
    setSelectedWikiHeading(undefined);
  }, [currentProject]);

  // Apply theme（自定义主题 id 套用其 base 调色板）
  useEffect(() => {
    applyTheme(theme, themes);
  }, [theme, themes]);

  // Apply appearance overrides (theme colors / fonts / code font size)
  // 自定义/内置扩展主题（含用户微调层）作为 custom 排在内置覆盖之后注入，同特异性下胜出
  useEffect(() => {
    applyAppearance(appearance, resolveActiveTheme(theme, themes, builtinThemeOverrides).custom,pluginColorGroups);
  }, [appearance, themes, theme, builtinThemeOverrides,pluginColorGroups]);

  // 反馈 / 更新服务器地址自检：启动一次 + 每 5 分钟（标题栏反馈入口与设置页绿点依赖此结果）
  useEffect(() => {
    void probeAllServices();
    const timer = setInterval(() => void probeAllServices(), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  // 切换终端（默认 ⌃/⌘+`，可在 设置→键盘快捷键 自定义）：
  // 无终端则新建；已激活则隐藏（回到底层 spec/conv）；否则激活最后一个。
  useShortcut('toggleTerminal', () => {
    const state = useAppStore.getState();
    const termTabs = state.openTabs.filter((t) => t.kind === 'terminal');
    if (termTabs.length === 0) {
      void state.createTerminal();
    } else if (state.activeTabId?.startsWith('terminal:')) {
      useAppStore.setState({ activeTabId: undefined });
    } else {
      state.activateTerminal(termTabs.length - 1);
    }
  });

  const showTabs = currentProject && openTabsCount > 0;
  const hasTerminalTabs = useAppStore((s) => s.openTabs.some((t) => t.kind === 'terminal'));

  /**
   * 不依赖项目的单例页（设置 / 帮助）：未选中项目时也要能打开——
   * 左下栏这两个按钮始终可点（其余按钮在无项目时是 disabled 的），
   * 若主区仍渲染 Welcome，点击后会出现"按钮高亮但页面不变"的假死。
   */
  const renderProjectAgnosticTab = (tab: NonNullable<typeof activeTab>) => {
    switch (tab.kind) {
      case 'settings':
        // 加载门控：设置未成功加载前不挂载设置页——否则各表单会以默认值快照，
        // 用户此时保存会用默认值覆盖磁盘上的真实配置
        if (settings === undefined) {
          return (
            <div className="settings-load-gate">
              {settingsLoadError ? (
                <>
                  <div>{t('app.settingsLoadFailed')}{settingsLoadError}</div>
                  <div className="muted small">
                    {t('app.settingsLoadGate')}
                  </div>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    onClick={() => void refreshSettings()}
                  >
                    {t('common.retry')}
                  </button>
                  <SettingsBackup />
                </>
              ) : (
                <div>{t('app.settingsLoading')}</div>
              )}
            </div>
          );
        }
        return (
          <Suspense fallback={<PanelLoading />}>
            <SettingsView
              initialTab={tab.data?.initialTab as SettingsTab | undefined}
              memoryConvId={tab.data?.memoryConvId}
              auditProfileId={tab.data?.auditProfileId}
              auditConvId={tab.data?.auditConvId}
              navigationId={tab.data?.navigationId}
            />
          </Suspense>
        );
      case 'help':
        return <Suspense fallback={<PanelLoading />}><AboutModal pane onClose={() => void useAppStore.getState().closeTab(tab.id)} /></Suspense>;
      case 'ctx-audit':
        return (
          <Suspense fallback={<PanelLoading />}>
            <ContextAuditViewer />
          </Suspense>
        );
      default:
        return null;
    }
  };
  const isProjectAgnosticTab = (kind?: string) => kind === 'settings' || kind === 'help' || kind === 'ctx-audit';

  return (
    <div className="app-shell">
      <LinkContextMenu/>
      <div className="titlebar">
        {/* 红绿灯右侧动作组：侧栏开关 / 对话搜索 / 活动流 */}
        <TitleBarActions />
        <PluginSlot slot="titlebar.left"/>
        {/* 完整显示当前 tab 名称（不截断），无选中 tab 时留空 */}
        <span className="titlebar-text">{headerTabTitle}</span>
        {/* 最右反馈入口（与活动铃铛并排一行的右端） */}
        <FeedbackEntry />
        <PluginSlot slot="titlebar.right"/>
      </div>
      <Onboarding />
      <div className="app-body">
        {!sidebarHidden && (
          <>
        <div style={{ width: sidebarWidth, flexShrink: 0, display: 'flex' }}>
          <Sidebar
            onNewSpec={() => setShowNewSpec(true)}
            onOpenAnalyze={() => {
              // No specs → auto-start retro analysis (no dialog)
              const state = useAppStore.getState();
              if (state.specs.length === 0) {
                void state.retroAnalyze();
              } else {
                setShowAnalyze(true);
              }
            }}
            onShowTimeline={() => setShowTimeline(true)}
            onShowScheduled={() => useAppStore.getState().toggleSingletonTab('scheduled')}
            onShowChannels={() => useAppStore.getState().toggleSingletonTab('channels')}
            onOpenSettings={() => useAppStore.getState().toggleSingletonTab('settings')}
            onOpenMemorySettings={(convId) =>
              useAppStore.getState().openSettingsTab({ initialTab: 'conv-memory', memoryConvId: convId })
            }
            onOpenAbout={() => useAppStore.getState().toggleSingletonTab('help')}
            onOpenWikiDetail={handleOpenWikiDetail}
          />
        </div>
        <div
          className="sidebar-resizer"
          onMouseDown={onResizerMouseDown}
        />
          </>
        )}
        <main className="main-pane">
          {/* 右栏内部横向布局：导航条由 ChatView 内部渲染（对齐聊天区） */}
          <div className="main-pane-body">
            <div className="main-pane-content">
              {activeError ? (
                <div className="banner banner-error" role="alert">
                  <span className="banner-text">{activeError}</span>
                  <button
                    className="banner-copy-btn"
                    title={bannerCopied ? t('common.copied') : t('app.copyErrorInfo')}
                    onClick={onCopyBanner}
                  >
                    {bannerCopied ? <Check size={13} /> : <Copy size={13} />}
                  </button>
                  <button type="button" aria-label={t('common.close')} onClick={dismissError}>×</button>
                </div>
              ) : null}
              {showTabs ? <FileTabs /> : null}
              {!currentProject ? (
                // 无项目：设置/帮助这类与项目无关的单例页照常打开，其余情况显示欢迎页
                activeTab && isProjectAgnosticTab(activeTab.kind) ? (
                  renderProjectAgnosticTab(activeTab)
                ) : (
                  <Welcome />
                )
              ) : activeTab ? (
                // 统一 tab 模型：根据 activeTab.kind 渲染
                (() => {
                  switch (activeTab.kind) {
                    case 'plugin': return null; // Plugin views stay mounted below to preserve form drafts.
                    case 'file':
                      return <Suspense fallback={<PanelLoading />}><FileEditor key={activeTab.id} /></Suspense>;
                    case 'terminal':
                      return null;  // TerminalView below handles display
                    case 'conversation': {
                      if (!activeRecordExists) return <EmptyProject onNewSpec={() => setShowNewSpec(true)} />;
                      return (
                        <ChatErrorBoundary>
                          <ChatView />
                        </ChatErrorBoundary>
                      );
                    }
                    case 'spec': {
                      if (!activeRecordExists) return <EmptyProject onNewSpec={() => setShowNewSpec(true)} />;
                      return <WorkflowView plugin="specs" view="spec"/>;
                    }
                    case 'scheduled':
                      return (
                        <Suspense fallback={<PanelLoading />}>
                          <ScheduledTasksView
                            onViewConversation={(convId) => {
                              return useAppStore.getState().selectConversation(convId);
                            }}
                          />
                        </Suspense>
                      );
                    case 'channels':
                      return <Suspense fallback={<PanelLoading />}><ChannelsView /></Suspense>;
                    case 'settings':
                      return renderProjectAgnosticTab(activeTab);
                    case 'steering': {
                      return <WorkflowView plugin="specs" view="steering"/>;
                    }
                    case 'help':
                      return renderProjectAgnosticTab(activeTab);
                    case 'ctx-audit':
                      return renderProjectAgnosticTab(activeTab);
                    case 'analytics':
                      return (
                        <Suspense fallback={<PanelLoading />}>
                          <AnalyticsPanel tabId={activeTab.id} />
                        </Suspense>
                      );
                    case 'browser': {
                      const BrowserRenderer = getTabRenderer('browser', enabledBuiltins(settings, currentProject));
                      if (!BrowserRenderer) {
                        return (
                          <div className="empty-state" style={{ padding: 24 }}>
                            <h2>{t('app.browserPluginDisabled')}</h2>
                            <p className="muted">{t('app.browserPluginDisabledHelp')}</p>
                          </div>
                        );
                      }
                      return null;
                    }
                    case 'git-history': {
                      const HistoryRenderer = getTabRenderer('git-history', enabledBuiltins(settings, currentProject));
                      if (!HistoryRenderer) return <div>Git History renderer not found</div>;
                      return <HistoryRenderer key={activeTab.id} />;
                    }
                    case 'git-commit': {
                      const CommitRenderer = getTabRenderer('git-commit', enabledBuiltins(settings, currentProject));
                      if (!CommitRenderer) return <div>Git Commit renderer not found</div>;
                      return <CommitRenderer key={activeTab.id} />;
                    }
                    default:
                      return <EmptyProject onNewSpec={() => setShowNewSpec(true)} />;
                  }
                })()
              ) : showTimeline ? (
                <TimelineView
                  onSelectSpec={(id) => {
                    useAppStore.getState().selectSpec(id);
                    setShowTimeline(false);
                  }}
                  onClose={() => setShowTimeline(false)}
                />
              ) : showWikiDetail ? (
                (() => {
                  return <WorkflowView plugin="docs" view="wiki-detail"/>;
                })()
              ) : deepwikiOpen && gitRepoInfo ? (
                (() => {
                  return <WorkflowView plugin="docs" view="deepwiki"/>;
                })()
              ) : (
                <EmptyProject onNewSpec={() => setShowNewSpec(true)} />
              )}
              {/* TerminalView stays mounted to preserve xterm scrollback;
                  hides itself via CSS when no terminal tab is active. */}
              {currentProject && openTabs.filter(t=>t.kind==='plugin').map(t=>t.kind==='plugin'?<div key={t.id} style={{display:activeTab?.id===t.id?'flex':'none',flex:1,minHeight:0}}><PluginView plugin={t.data.plugin} contribution={t.data.contribution}/></div>:null)}
              {currentProject && enabledBuiltins(settings, currentProject).includes('browser') && <ChatErrorBoundary key={currentProject.path} label={t('app.browserLabel')}><BrowserWorkspace /></ChatErrorBoundary>}
              {currentProject && hasTerminalTabs ? <Suspense fallback={<PanelLoading />}><TerminalView /></Suspense> : null}
            </div>
          </div>
          {/* 监控展示方式二：右栏下面（底栏，顶边可拖拽调高）；全屏时隐藏外壳，避免残留空框 */}
          {showMonitor && !monitorFullscreen && monitorLayout === 'bottom' ? (
            <>
              <div className="monitor-bottom-resizer" onMouseDown={onMonitorHeightResizerMouseDown} />
              <div className="monitor-bottom" style={{ height: monitorHeight, flexShrink: 0 }}>
                <Suspense fallback={<PanelLoading />}><RequestMonitor onClose={() => useAppStore.getState().setMonitorOpen(false)} /></Suspense>
              </div>
            </>
          ) : null}
        </main>
        {showMonitor && !monitorFullscreen && monitorLayout === 'right' ? (
          <>
            <div className="monitor-dock-resizer" onMouseDown={onMonitorResizerMouseDown} />
            <div className="monitor-dock" style={{ width: monitorWidth, flexShrink: 0 }}>
              <Suspense fallback={<PanelLoading />}><RequestMonitor onClose={() => useAppStore.getState().setMonitorOpen(false)} /></Suspense>
            </div>
          </>
        ) : null}

      </div>
      {/* 监控展示方式一：完全浮动窗口，盖在界面上，标题栏可拖动，右下角可拉伸；全屏时不渲染框体（内容 fixed 飞出后会与框体分离） */}
      {showMonitor && !monitorFullscreen && monitorLayout === 'float' ? (
        <div className="monitor-float" style={{ left: floatPos.x, top: floatPos.y }}>
          <div
            className="monitor-float-bar"
            onPointerDown={onFloatBarPointerDown}
            onPointerMove={onFloatBarPointerMove}
            onPointerUp={onFloatBarPointerUp}
            onDoubleClick={() => useAppStore.getState().setMonitorFullscreen(!useAppStore.getState().monitorFullscreen)}
            title={t('monitor.fullscreen')}
          >
            <span>{t('monitor.title')}</span>
            <span className="monitor-float-grip">⣿</span>
          </div>
          <div className="monitor-float-body">
            <Suspense fallback={<PanelLoading />}><RequestMonitor onClose={() => useAppStore.getState().setMonitorOpen(false)} /></Suspense>
          </div>
        </div>
      ) : null}
      {/* 全屏放大：脱离三种布局外壳直接铺满，退出走内容区的还原按钮 */}
      {showMonitor && monitorFullscreen ? (
        <Suspense fallback={<PanelLoading />}><RequestMonitor onClose={() => useAppStore.getState().setMonitorOpen(false)} /></Suspense>
      ) : null}
      <PluginSlot slot="panel"/><PluginNotifications/><StatusBar />
      {showNewSpec ? (
        <NewSpecForm onClose={() => setShowNewSpec(false)} />
      ) : null}
      {showAnalyze ? (
        <AnalyzeDialog onClose={() => setShowAnalyze(false)} />
      ) : null}
      <UpdateDialog />
      {/* 全局确认对话框宿主：替代原生 confirm（按钮文案跟随应用语言） */}
      <ConfirmDialogHost />
      <WindowScreenshot active={activeTab?.kind !== 'conversation' || !activeRecordExists} />
    </div>
  );
}

function readDimension(key: string, fallback: number): number {
  try { const value = Number(localStorage.getItem(key)); return Number.isFinite(value) && value > 0 ? value : fallback; }
  catch { return fallback; }
}

function PanelLoading() {
  const t = useT();
  return <div className="panel-loading" role="status" aria-live="polite">{t('common.loading')}</div>;
}

function AnalyticsPanel({tabId}: {tabId: string}) {
  const conversations = useAppStore(s => s.conversations);
  return <UsageAnalytics pane conversations={conversations} onClose={() => void useAppStore.getState().closeTab(tabId)} />;
}

function EmptyProject({ onNewSpec }: { onNewSpec: () => void }) {
  const specsEnabled=useSpecsEnabled();
  const project = useAppStore((s) => s.currentProject);
  const createConversation = useAppStore((s) => s.createConversation);
  const t = useT();
  return (
    <div className="empty-state">
      <h2>{project?.name}</h2>
      <p className="muted">{project?.path}</p>
      <p>{t('app.empty.choose')}</p>
      <div className="empty-actions">
        <button className="btn-primary" onClick={() => createConversation()}>{t('app.empty.newChat')}</button>
        {specsEnabled && <button className="btn-ghost" onClick={onNewSpec}>{t('app.empty.newSpec')}</button>}
      </div>
      <p className="muted small" style={{ marginTop: 24 }}>
        {t('app.empty.hint')}
      </p>
    </div>
  );
}

class ChatErrorBoundary extends Component<{ children: React.ReactNode; label?: string }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: React.ReactNode; label?: string }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`${this.props.label ?? translate('app.conversationLabel')}渲染错误:`, error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="empty-state" style={{ padding: 24 }}>
          <h2>{translate('app.renderError', { label: this.props.label ?? translate('app.conversationLabel') })}</h2>
          <p className="muted">{this.state.error?.message ?? translate('app.unknownError')}</p>
          <pre className="muted small" style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>
            {this.state.error?.stack ?? ''}
          </pre>
          <button
            className="btn-primary"
            style={{ marginTop: 16 }}
            onClick={() => this.setState({ hasError: false, error: undefined })}
          >
            {translate('common.retry')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
