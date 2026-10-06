import {ScheduledIndicator,conversationScheduleState} from './ScheduledIndicator';
import {NewTabMenu} from './NewTabMenu';
import {PluginSlot} from './plugins/PluginWorkbench';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CursorMenu } from './CursorMenu';
import { Columns3, Layers, X, Archive, MessageSquare, FileText, CircleX, Files, SquareTerminal, ArrowRight, Pin, CalendarClock, GitBranch, CloudLightning, Globe, RefreshCw, CopyPlus, Settings, Compass, HelpCircle, TrendingUp, CopyX, Ghost, FileSearch } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useT, displayConvTitle } from '../i18n';
import { langInfoFor } from '../lib/lang';
import { markdownTabTitle } from '../lib/markdownTabTitle';

/**
 * 统一 Tab Bar — 渲染所有类型的 tab（file / terminal / conversation / spec）。
 *
 * 功能：
 * - 数据来源：从 openTabs 统一读取
 * - 点击/关闭 调用统一 API（activateTab / closeTab）
 * - 选中后把完整名称同步到窗口标题栏（tab 自身是省略号截断的，
 *   类似 Sublime Text 在标题栏展示完整文件名的做法）
 * - 左右拖拽重排（浏览器式；固定区/非固定区各自内部重排，不可跨区）
 * - 右键菜单：固定 / 取消固定（固定 tab 置于最左侧；批量关闭时保留固定项）
 */
export function FileTabs() {
  const t = useT();
  const storedTabs = useAppStore((s) => s.openTabs);
  const en = useAppStore(s => s.settings?.language === 'en');
  const [grouped, setGrouped] = useState(() => localStorage.getItem('tabGrouping') === 'kind');
  // Group only the displayed order, preserving the user's free arrangement.
  const openTabs = grouped ? Array.from(new Set(storedTabs.map(tab => tab.kind))).flatMap(kind => storedTabs.filter(tab => tab.kind === kind)) : storedTabs;
  const changeGrouping = (value: boolean) => { setGrouped(value); localStorage.setItem('tabGrouping', value ? 'kind' : 'free'); };
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activateTab = useAppStore((s) => s.activateTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const closeAllTabs = useAppStore((s) => s.closeAllTabs);
  const moveTab = useAppStore((s) => s.moveTab);
  const togglePinTab = useAppStore((s) => s.togglePinTab);
  const createTerminal = useAppStore((s) => s.createTerminal);
  const conversations = useAppStore((s) => s.conversations);
  const specs = useAppStore((s) => s.specs);
  const scheduledTasks=useAppStore(s=>s.scheduledTasks);
  const scheduledRuns=useAppStore(s=>s.scheduledRuns);
  const busyConvIds = useAppStore((s) => s.busyConvIds);

  const listRef = useRef<HTMLDivElement>(null);
  // tabScrollTick：每次 selectConversation / selectSpec 都递增，
  // 保证重复点击同一个对话也会重新滚动定位（仅靠 activeTabId 去重会漏）。
  const tabScrollTick = useAppStore((s) => s.tabScrollTick);
  // active tab 滚动定位：
  // - 手动计算 scrollLeft 滚动 .file-tabs-list（不用 scrollIntoView，
  //   它在 flex 横滚容器里不够可靠，且会连带滚动其它祖先）
  // - 双 rAF：新建的 tab 需要两帧才能拿到正确的布局位置
  useLayoutEffect(() => {
    if (!activeTabId || openTabs.length === 0) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const list = listRef.current;
        if (!list) return;
        const el = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
        if (!el) return;
        const listRect = list.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        if (elRect.left < listRect.left) {
          list.scrollTo({ left: list.scrollLeft - (listRect.left - elRect.left) - 12, behavior: 'smooth' });
        } else if (elRect.right > listRect.right) {
          list.scrollTo({ left: list.scrollLeft + (elRect.right - listRect.right) + 12, behavior: 'smooth' });
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [activeTabId, openTabs.length, tabScrollTick, grouped]);

  // 右键菜单状态
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  // ── 拖拽重排状态（浏览器式）────────────────────────────────────
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [overTabId, setOverTabId] = useState<string | null>(null);

  // 点击外部关闭右键菜单
  // 用 mousedown + target 检查：菜单内部点击不关闭（让 click 执行），
  // 菜单外部点击才关闭
  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.file-tab-context-menu')) return;
      setCtxMenu(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [ctxMenu]);

  // 窗口标题由 App.tsx 统一设置（单一来源），这里不再重复设置，避免互相覆盖。

  // 关闭所有对话 tab（只关 tab，不清左栏对话列表；固定项保留）
  const closeAllConversations = () => {
    const convTabs = openTabs.filter((t) => t.kind === 'conversation' && !t.pinned);
    for (const t of convTabs) void closeTab(t.id);
  };
  // Only close archived conversation tabs; keep their records and pinned tabs.
  const closeAllArchivedConversations = () => {
    const archivedIds = new Set(conversations.filter(c => c.archived).map(c => c.id));
    for (const tab of openTabs) {
      if (tab.kind === 'conversation' && !tab.pinned && archivedIds.has(tab.convId)) void closeTab(tab.id);
    }
  };
  // 关闭所有终端 tab（固定项保留）
  const closeAllTerminals = () => {
    const termTabs = openTabs.filter((t) => t.kind === 'terminal' && !t.pinned);
    for (const t of termTabs) void closeTab(t.id);
  };
  // 关闭所有文件 tab（只关 file 类型，不影响对话和终端；固定项保留）
  const closeAllFileTabs = () => {
    const fileTabs = openTabs.filter((t) => t.kind === 'file' && !t.pinned);
    for (const t of fileTabs) void closeTab(t.id);
  };

  // 没有任何 tab 时不渲染
  if (openTabs.length === 0) return null;

  // 获取右键 tab 的索引（在 openTabs 中的位置）
  const getTabIdx = (tabId: string) => openTabs.findIndex((t) => t.id === tabId);

  // 渲染单个 tab 按钮
  const renderTabButton = (tab: any, isActive: boolean, dragHandlers: any) => {
    switch (tab.kind) {
      case 'plugin': return <button key={tab.id} className={`file-tab ${isActive?'active':''}`} onClick={()=>activateTab(tab.id)} {...dragHandlers}><span>{tab.data.title}</span><span className="file-tab-close" role="button" onClick={e=>{e.stopPropagation();void closeTab(tab.id);}}>×</span></button>;
      case 'file': {
        const dirty = tab.data.content !== tab.data.originalContent;
        const lang = langInfoFor(tab.data.relPath);
        const name = markdownTabTitle(tab.data);
        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            className={`file-tab ${isActive ? 'active' : ''}${tab.pinned ? ' pinned' : ''}${dragTabId === tab.id ? ' dragging' : ''}${overTabId === tab.id ? ' drag-over' : ''}`}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(tab.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            title={`${name}\n${tab.data.relPath}`}
            style={{ borderBottomColor: isActive ? lang.color : 'transparent' }}
            {...dragHandlers}
          >
            <span className="file-tab-dot" style={{ color: lang.color }} aria-hidden>●</span>
            <span className="file-tab-name">{name}</span>
            {dirty ? <span className="file-tab-dirty" title={t('tabs.unsaved')}>●</span> : null}
            <span
              className="file-tab-close"
              role="button"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
            >
              <X size={11} strokeWidth={2.5} />
            </span>
          </button>
        );
      }

      case 'terminal': {
        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            className={`file-tab ${isActive ? 'active' : ''} ${tab.data.exited ? 'exited' : ''}${tab.pinned ? ' pinned' : ''}${dragTabId === tab.id ? ' dragging' : ''}${overTabId === tab.id ? ' drag-over' : ''}`}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(tab.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            title={`${tab.data.title} — ${tab.data.cwd}`}
            style={{ borderBottomColor: isActive ? 'var(--accent)' : 'transparent' }}
            {...dragHandlers}
          >
            <span className="file-tab-term-icon" aria-hidden>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </span>
            <span className="file-tab-name">{tab.data.title}</span>
            <span
              className="file-tab-close"
              role="button"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
            >
              <X size={11} strokeWidth={2.5} />
            </span>
          </button>
        );
      }

      case 'conversation': {
        const conv = conversations.find((c) => c.id === tab.convId);
        if (!conv) return null;
        const isBusy = !!busyConvIds[conv.id];
        const scheduleState=conversationScheduleState(conv.id,scheduledTasks,scheduledRuns);
        const hasScheduled=scheduleState.hasTasks;
        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            className={`file-tab ${isActive ? 'active' : ''}${tab.pinned ? ' pinned' : ''}${dragTabId === tab.id ? ' dragging' : ''}${overTabId === tab.id ? ' drag-over' : ''}`}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(tab.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            title={displayConvTitle(conv.title)}
            style={{ borderBottomColor: isActive ? 'var(--color-primary, #4A90E2)' : 'transparent' }}
            {...dragHandlers}
          >
            <span className="file-tab-icon-wrap" style={{ width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {hasScheduled ? <ScheduledIndicator size={14} animated={!scheduleState.stopped} stopped={scheduleState.stopped}/> : <MessageSquare size={12} className={isBusy ? 'conv-tab-busy' : ''} aria-hidden style={isBusy ? { color: 'var(--accent, #7c6aef)', fill: 'currentColor' } : { color: 'var(--muted)' }} />}
            </span>
            <span className="file-tab-name">{displayConvTitle(conv.title)}</span>
            <span
              className="file-tab-close"
              role="button"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
            >
              <X size={11} strokeWidth={2.5} />
            </span>
          </button>
        );
      }

      case 'spec': {
        const spec = specs.find((s) => s.id === tab.specId);
        if (!spec) return null;
        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            className={`file-tab ${isActive ? 'active' : ''}${tab.pinned ? ' pinned' : ''}${dragTabId === tab.id ? ' dragging' : ''}${overTabId === tab.id ? ' drag-over' : ''}`}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(tab.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            title={spec.title}
            style={{ borderBottomColor: isActive ? 'var(--color-success, #50C878)' : 'transparent' }}
            {...dragHandlers}
          >
            <FileText size={12} className="file-tab-icon" aria-hidden />
            <span className="file-tab-name">{spec.title}</span>
            <span
              className="file-tab-close"
              role="button"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
            >
              <X size={11} strokeWidth={2.5} />
            </span>
          </button>
        );
      }

      case 'scheduled': {
        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            className={`file-tab ${isActive ? 'active' : ''}${tab.pinned ? ' pinned' : ''}${dragTabId === tab.id ? ' dragging' : ''}${overTabId === tab.id ? ' drag-over' : ''}`}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(tab.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            title={t('scheduled.title')}
            style={{ borderBottomColor: isActive ? 'var(--accent, #7c6aef)' : 'transparent' }}
            {...dragHandlers}
          >
            <CalendarClock size={12} className="file-tab-icon" aria-hidden />
            <span className="file-tab-name">{t('scheduled.title')}</span>
            <span
              className="file-tab-close"
              role="button"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
            >
              <X size={11} strokeWidth={2.5} />
            </span>
          </button>
        );
      }

      case 'channels': {
        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            className={`file-tab ${isActive ? 'active' : ''}${tab.pinned ? ' pinned' : ''}${dragTabId === tab.id ? ' dragging' : ''}${overTabId === tab.id ? ' drag-over' : ''}`}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(tab.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            title={t('channels.title')}
            style={{ borderBottomColor: isActive ? 'var(--accent, #7c6aef)' : 'transparent' }}
            {...dragHandlers}
          >
            <CloudLightning size={12} className="file-tab-icon" aria-hidden />
            <span className="file-tab-name">{t('channels.title')}</span>
            <span
              className="file-tab-close"
              role="button"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
            >
              <X size={11} strokeWidth={2.5} />
            </span>
          </button>
        );
      }

      case 'settings': {
        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            className={`file-tab ${isActive ? 'active' : ''}${tab.pinned ? ' pinned' : ''}${dragTabId === tab.id ? ' dragging' : ''}${overTabId === tab.id ? ' drag-over' : ''}`}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(tab.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            title={t('settings.title')}
            style={{ borderBottomColor: isActive ? 'var(--accent, #7c6aef)' : 'transparent' }}
            {...dragHandlers}
          >
            {/* 与左下栏「设置」按钮同款齿轮图标，保持左栏与 tab 一致 */}
            <Settings size={12} className="file-tab-icon" aria-hidden />
            <span className="file-tab-name">{t('settings.title')}</span>
            <span
              className="file-tab-close"
              role="button"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
            >
              <X size={11} strokeWidth={2.5} />
            </span>
          </button>
        );
      }

      case 'steering':
      case 'help':
      case 'analytics':
      case 'ctx-audit': {
        const meta = {
          steering: { icon: Compass, labelKey: 'sidebar.steering' },
          help: { icon: HelpCircle, labelKey: 'sidebar.about' },
          analytics: { icon: TrendingUp, labelKey: 'tabs.analytics' },
          'ctx-audit': { icon: FileSearch, labelKey: 'ctxAudit.title' },
        }[tab.kind as 'steering' | 'help' | 'analytics' | 'ctx-audit'];
        const Icon = meta.icon;
        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            className={`file-tab ${isActive ? 'active' : ''}${tab.pinned ? ' pinned' : ''}${dragTabId === tab.id ? ' dragging' : ''}${overTabId === tab.id ? ' drag-over' : ''}`}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(tab.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            title={t(meta.labelKey)}
            style={{ borderBottomColor: isActive ? 'var(--accent, #7c6aef)' : 'transparent' }}
            {...dragHandlers}
          >
            <Icon size={12} className="file-tab-icon" aria-hidden />
            <span className="file-tab-name">{t(meta.labelKey)}</span>
            <span
              className="file-tab-close"
              role="button"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
            >
              <X size={11} strokeWidth={2.5} />
            </span>
          </button>
        );
      }

      case 'browser': {
        const title = tab.data.title || tab.data.url || t('tabs.browserFallback');
        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            className={`file-tab ${isActive ? 'active' : ''}${tab.pinned ? ' pinned' : ''}${dragTabId === tab.id ? ' dragging' : ''}${overTabId === tab.id ? ' drag-over' : ''}`}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(tab.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            title={tab.data.url || title}
            style={{ borderBottomColor: isActive ? 'var(--info, #38bdf8)' : 'transparent' }}
            {...dragHandlers}
          >
            {tab.data.incognito ? (
              <Ghost size={12} className="file-tab-incognito" aria-hidden />
            ) : tab.data.favicon ? (
              <img src={tab.data.favicon} className="file-tab-favicon" alt="" aria-hidden />
            ) : (
              <Globe size={12} className="file-tab-icon" aria-hidden />
            )}
            <span className="file-tab-name">{title}</span>
            <span
              className="file-tab-close"
              role="button"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
            >
              <X size={11} strokeWidth={2.5} />
            </span>
          </button>
        );
      }

      case 'git-history': {
        const title = tab.data.title || t('tabs.submitHistory');
        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            className={`file-tab ${isActive ? 'active' : ''}${tab.pinned ? ' pinned' : ''}${dragTabId === tab.id ? ' dragging' : ''}${overTabId === tab.id ? ' drag-over' : ''}`}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(tab.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            title={title}
            style={{ borderBottomColor: isActive ? 'var(--color-primary, #4A90E2)' : 'transparent' }}
            {...dragHandlers}
          >
            <GitBranch size={12} className="file-tab-icon" aria-hidden />
            <span className="file-tab-name">{title}</span>
            <span
              className="file-tab-close"
              role="button"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
            >
              <X size={11} strokeWidth={2.5} />
            </span>
          </button>
        );
      }

      case 'git-commit': {
        const title = tab.data.title || tab.data.sha.slice(0, 7);
        return (
          <button
            key={tab.id}
            data-tab-id={tab.id}
            type="button"
            className={`file-tab ${isActive ? 'active' : ''}${tab.pinned ? ' pinned' : ''}${dragTabId === tab.id ? ' dragging' : ''}${overTabId === tab.id ? ' drag-over' : ''}`}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(tab.id);
              setCtxMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
            }}
            title={title}
            style={{ borderBottomColor: isActive ? 'var(--color-primary, #4A90E2)' : 'transparent' }}
            {...dragHandlers}
          >
            <GitBranch size={12} className="file-tab-icon" aria-hidden />
            <span className="file-tab-name">{title}</span>
            <span
              className="file-tab-close"
              role="button"
              title={t('common.close')}
              onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}
            >
              <X size={11} strokeWidth={2.5} />
            </span>
          </button>
        );
      }

      default:
        return null;
    }
  };

  return (
    <>
    <div className="file-tabs"><PluginSlot slot="tab"/>
      {/* Pinned tabs: 固定在左侧，不随滚动 */}
      {openTabs.filter(t => t.pinned).length > 0 && (
        <div className="file-tabs-pinned">
          {openTabs.filter(t => t.pinned).map((tab) => {
            const isActive = tab.id === activeTabId;
            const dragHandlers = {
              draggable: true,
              onDragStart: (e: React.DragEvent) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', tab.id);
                setDragTabId(tab.id);
              },
              onDragEnd: () => { setDragTabId(null); setOverTabId(null); },
              onDragOver: (e: React.DragEvent) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (tab.id !== dragTabId) setOverTabId(tab.id);
              },
              onDrop: (e: React.DragEvent) => {
                e.preventDefault();
                if (dragTabId && dragTabId !== tab.id) moveTab(dragTabId, tab.id);
                setDragTabId(null);
                setOverTabId(null);
              },
            };
            return renderTabButton(tab, isActive, dragHandlers);
          })}
        </div>
      )}
      {/* Unpinned tabs: 可滚动区域 */}
      <div className="file-tabs-list" ref={listRef}>
        {openTabs.filter(t => !t.pinned).map((tab) => {
          const isActive = tab.id === activeTabId;
          const dragHandlers = {
            draggable: true,
            onDragStart: (e: React.DragEvent) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', tab.id);
              setDragTabId(tab.id);
            },
            onDragEnd: () => { setDragTabId(null); setOverTabId(null); },
            onDragOver: (e: React.DragEvent) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (tab.id !== dragTabId) setOverTabId(tab.id);
            },
            onDrop: (e: React.DragEvent) => {
              e.preventDefault();
              if (dragTabId && dragTabId !== tab.id) moveTab(dragTabId, tab.id);
              setDragTabId(null);
              setOverTabId(null);
            },
          };
          return renderTabButton(tab, isActive, dragHandlers);
        })}

      </div>
      <NewTabMenu />
      <button type="button" className="tab-grouping-control" aria-pressed={grouped}
        aria-label={en ? 'Group tabs by type' : '同类聚合标签'}
        title={grouped ? (en ? 'Grouped by type · Click for free order' : '同类聚合 · 点击切换为自由排列') : (en ? 'Free order · Click to group by type' : '自由排列 · 点击切换为同类聚合')}
        onClick={() => changeGrouping(!grouped)}>
        {grouped ? <Layers size={16} aria-hidden/> : <Columns3 size={16} aria-hidden/>}
      </button>
    </div>

    {/* 右键菜单（贴光标弹，视口下方放不下时自动翻向上方，见 shared/popover-placement） */}
    {ctxMenu && (
      <CursorMenu
        className="file-tab-context-menu"
        x={ctxMenu.x}
        y={ctxMenu.y}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 浏览器 tab 专属：重新加载 / 复制标签页 */}
        {(() => {
          const cur = openTabs.find((t) => t.id === ctxMenu.tabId);
          if (!cur || cur.kind !== 'browser') return null;
          return (
            <>
              <button
                className="ftcm-item"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('sage:browser-reload', { detail: ctxMenu.tabId }));
                  setCtxMenu(null);
                }}
              >
                <RefreshCw size={14} /> {t('tabs.reload')}
              </button>
              <button
                className="ftcm-item"
                onClick={() => {
                  useAppStore.getState().openBrowserTab(cur.data.url, { forceNew: true });
                  setCtxMenu(null);
                }}
              >
                <CopyPlus size={14} /> {t('tabs.duplicate')}
              </button>
              <div className="ftcm-sep" />
            </>
          );
        })()}
        {/* 固定 / 取消固定：固定后置于最左侧；再点一次取消 */}
        {(() => {
          const cur = openTabs.find((t) => t.id === ctxMenu.tabId);
          return (
            <button className="ftcm-item" onClick={() => { togglePinTab(ctxMenu.tabId); setCtxMenu(null); }}>
              <Pin size={14} fill="currentColor" /> {cur?.pinned ? t('tabs.unpin') : t('tabs.pin')}
            </button>
          );
        })()}
        <div className="ftcm-sep" />
        <button className="ftcm-item" onClick={() => { void closeTab(ctxMenu.tabId); setCtxMenu(null); }}>
          <CircleX size={14} /> {t('tabs.closeCurrent')}
        </button>
        <button className="ftcm-item" onClick={() => {
          const keepIdx = getTabIdx(ctxMenu.tabId);
          // 固定项 + 当前项保留
          const toClose = openTabs.filter((t, i) => i !== keepIdx && !t.pinned);
          for (const t of toClose) void closeTab(t.id);
          setCtxMenu(null);
        }}>
          <Files size={14} /> {t('tabs.closeOthers')}
        </button>
        <div className="ftcm-sep" />
        {/* 关闭所有：跨类型一次关掉对话 + 文件 + 终端 + …，固定项保留。
            走 store.closeAllTabs（未保存二次确认、终端 PTY 回收
            都在那里），不要再自己 filter 一遍 openTabs，否则两条路径的确认逻辑迟早分叉。 */}
        <button className="ftcm-item" onClick={() => { void closeAllTabs(); setCtxMenu(null); }}>
          <CopyX size={14} /> {t('tabs.closeAll')}
        </button>
        <button className="ftcm-item" onClick={() => { closeAllConversations(); setCtxMenu(null); }}>
          <SquareTerminal size={14} /> {t('tabs.closeAllConvs')}
        </button>
        <button className="ftcm-item" onClick={() => { closeAllArchivedConversations(); setCtxMenu(null); }}>
          <Archive size={14} /> {t('tabs.closeAllArchived')}
        </button>
        <button className="ftcm-item" onClick={() => { closeAllFileTabs(); setCtxMenu(null); }}>
          <Files size={14} /> {t('tabs.closeAllFiles')}
        </button>
        <button className="ftcm-item" onClick={() => { closeAllTerminals(); setCtxMenu(null); }}>
          <SquareTerminal size={14} /> {t('tabs.closeAllTerminals')}
        </button>
        <div className="ftcm-sep" />
        <button className="ftcm-item" onClick={() => {
          const keepIdx = getTabIdx(ctxMenu.tabId);
          // 固定项保留
          for (let i = openTabs.length - 1; i > keepIdx; i--) {
            if (!openTabs[i].pinned) void closeTab(openTabs[i].id);
          }
          setCtxMenu(null);
        }}>
          <ArrowRight size={14} /> {t('tabs.closeRight')}
        </button>
        {/* 定位文件：只对文件 tab 显示，放到最后 */}
        {(() => {
          const cur = openTabs.find((t) => t.id === ctxMenu.tabId);
          if (cur?.kind !== 'file' || cur.data.source === 'virtual' || !useAppStore.getState().currentProject || cur.id !== `file:${cur.data.relPath}`) return null;
          return (
            <>
              <div className="ftcm-sep" />
              <button className="ftcm-item" onClick={() => {
                useAppStore.getState().revealFileInTree(cur.data.relPath);
                setCtxMenu(null);
              }}>
                <Pin size={14} /> {t('tabs.reveal')}
              </button>
            </>
          );
        })()}
      </CursorMenu>
    )}
    </>
  );
}
