import {useWorkflowTabs} from './plugins/WorkflowViews';
import {resolveLanguage} from '../../shared/language';
import {readSidebarLayout,writeSidebarLayout,sidebarOrder,moveSidebarSection} from '../lib/sidebar-layout';
import { ShortcutTooltip } from './ShortcutTooltip';
import { shortcutDisplay } from '../lib/shortcuts';
import {ScheduledIndicator,conversationScheduleState} from './ScheduledIndicator';
import { useCursorMenuStyle } from '../lib/cursor-menu';
import { enabledBuiltins } from '../../shared/builtin-plugins';
import {formatCasualDateTime,formatDateTime,useDateTimeSettings} from '../lib/date-time';
import {PluginSlot} from './plugins/PluginWorkbench';
import { Children, isValidElement, useLayoutEffect, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../stores/appStore';
import { useT, translate, displayConvTitle } from '../i18n';
import { confirmDialog } from '../lib/confirm-dialog';
import { FileTree } from './FileTree';
import { TitleMarquee } from './TitleMarquee';
import { getSidebarTabs } from '../plugins';
import { MessageSquarePlus, MessageSquare, ChevronRight, Settings, HelpCircle, FolderOpen, AlertCircle, StopCircle, CheckCircle2, WifiOff, ExternalLink, CalendarClock, MoreHorizontal, Copy, Check, Trash2, ChevronUp, ChevronDown, CloudLightning, Brain, Archive, Pin, PinOff, Pencil } from 'lucide-react';
import type { ProjectEntry } from '../../shared/types';
import { copyMarkdown } from '../lib/clipboard';

interface Props {
  onNewSpec: () => void;
  onOpenAnalyze: () => void;
  onShowTimeline: () => void;
  onShowScheduled: () => void;
  onShowChannels: () => void;
  onOpenSettings: () => void;
  /** 打开设置页记忆分类并挂载指定对话的对话级记忆层（对话菜单「配置记忆」）。 */
  onOpenMemorySettings: (convId: string) => void;
  onOpenAbout: () => void;
  onOpenWikiDetail: (headingId: string) => void;
}



/* 长标题的溢出跑马灯见 ./TitleMarquee（项目路径行也用同一个）。 */

export function Sidebar({ onNewSpec, onOpenAnalyze, onShowTimeline, onShowScheduled, onShowChannels, onOpenSettings, onOpenMemorySettings, onOpenAbout, onOpenWikiDetail }: Props) {
  useDateTimeSettings();
  const projects = useAppStore((s) => s.projects);
  const currentProject = useAppStore((s) => s.currentProject);
  const conversations = useAppStore((s) => s.conversations);
  // store 含归档对话（供 tab 标题解析）；左栏清单只展示活跃对话
  const currentConversation = useAppStore((s) => s.currentConversation);
  const activeTabId = useAppStore((s) => s.activeTabId);  // 新增：统一 tab 激活状态
  const openTabs = useAppStore((s) => s.openTabs);  // 左下栏按钮选中态：对应 tab 存在即高亮
  // 单例 tab 是否存在（指导/定时/渠道/设置/帮助）
  const tabOpen = (id: string) => openTabs.some((t) => t.id === id);
  const scheduledTasks=useAppStore(s=>s.scheduledTasks);
  const scheduledRuns=useAppStore(s=>s.scheduledRuns);
  const busyConvIds = useAppStore((s) => s.busyConvIds);
  const busyPhase = useAppStore((s) => s.busyPhase);
  const analysisMode = useAppStore((s) => s.analysisMode);
  const retroModules = useAppStore((s) => s.retroModules);
  const retroModuleOrder = useAppStore((s) => s.retroModuleOrder);
  const retroGlobalLog = useAppStore((s) => s.retroGlobalLog);
  const retroStartedAt = useAppStore((s) => s.retroStartedAt);
  const retroLastEventAt = useAppStore((s) => s.retroLastEventAt);
  const retroClaudeCalling = useAppStore((s) => s.retroClaudeCalling);
  const abortAnalysis = useAppStore((s) => s.abortAnalysis);
  const pendingApprovalsByConv = useAppStore((s) => s.pendingApprovalsByConv);
  const wikiGenerating = useAppStore((s) => s.wikiGenerating);
  const pickProject = useAppStore((s) => s.pickProject);
  const selectProject = useAppStore((s) => s.selectProject);
  const removeProject = useAppStore((s) => s.removeProject);
  const clearAllProjects = useAppStore((s) => s.clearAllProjects);
  const createConversation = useAppStore((s) => s.createConversation);
  const shortcutOverrides=useAppStore(s=>s.settings?.shortcuts);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const renameConversation = useAppStore((s) => s.renameConversation);
  const t = useT();

  // Project-scoped preferences are selected synchronously, avoiding a flash of the previous layout.
  const projectPath=currentProject?.path;
  const panelsRef=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{const el=panelsRef.current;if(el)el.scrollTop=readSidebarLayout(projectPath).scrolls?.__panels??0;},[projectPath]);
  const [layoutState,setLayoutState]=useState(()=>({projectPath,layout:readSidebarLayout(projectPath)}));
  const layout=layoutState.projectPath===projectPath?layoutState.layout:readSidebarLayout(projectPath);
  const collapsed=layout.collapsed,sectionSizes=layout.sizes;
  const pinnedConversations=conversations.filter(c=>c.pinned ?? layout.pinnedConversations?.includes(c.id)).map(c=>c.id);
  const visibleConversations=conversations.filter(c=>!c.archived).sort((a,b)=>Number(pinnedConversations.includes(b.id))-Number(pinnedConversations.includes(a.id)) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const toggleConversationPin=async(id:string)=>{
    try {
      const result=await window.api.updateConvMeta(id,{pinned:!pinnedConversations.includes(id)});
      if(!result?.ok)throw Error('置顶保存失败');
      await useAppStore.getState().syncConvListChanged({projectPath:projectPath!,convId:id,reason:'updated'});
    } catch(error) { useAppStore.getState().setConvError(String(error)); }
  };
  // Migrate renderer-local pins without overwriting a mobile unpin (false).
  useEffect(()=>{
    const ids=conversations.filter(c=>c.pinned===undefined && layout.pinnedConversations?.includes(c.id)).map(c=>c.id);
    if(!projectPath||!ids.length)return;
    let alive=true;
    void Promise.all(ids.map(id=>window.api.updateConvMeta(id,{pinned:true}))).then(()=>{
      if(alive)void useAppStore.getState().syncConvListChanged({projectPath,reason:'updated'});
    }).catch(error=>useAppStore.getState().setConvError(String(error)));
    return()=>{alive=false;};
  },[projectPath,conversations,layout.pinnedConversations]);
  useEffect(()=>{
    const sync=(event:StorageEvent)=>{if(event.key==='sidebarLayout:'+projectPath)setLayoutState({projectPath,layout:readSidebarLayout(projectPath)});};
    window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);
  },[projectPath]);

  const setCollapsed=(update:(previous:Record<string,boolean>)=>Record<string,boolean>)=>setLayoutState(previous=>{
    const current=previous.projectPath===projectPath?previous.layout:readSidebarLayout(projectPath);
    return{projectPath,layout:writeSidebarLayout(projectPath,{collapsed:update(current.collapsed)})};
  });
  const resizeSections=(sizes:Record<string,number>)=>setLayoutState(previous=>{
    const current=previous.projectPath===projectPath?previous.layout:readSidebarLayout(projectPath);
    return{projectPath,layout:writeSidebarLayout(projectPath,{sizes:{...current.sizes,...sizes}})};
  });
  const sectionResizeProps=(id:string)=>({weight:sectionSizes[id],onResize:resizeSections,onMove:moveSection,scrolls:layout.scrolls,projectPath});
  const isCollapsed=(id:string)=>collapsed[id]??(id!=='conversations');
  const toggleSection=(id:string)=>setCollapsed(previous=>({...previous,[id]:!(previous[id]??(id!=='conversations'))}));

  // Plugin-contributed sidebar tabs (files tab is built-in; specs/docs/wiki/git come from plugins)
  // Only show tabs for plugins that are enabled in the current project
  const pluginSettings = useAppStore(s => s.settings);
  const enabledPlugins = enabledBuiltins(pluginSettings, currentProject);
  const workflowTabs=useWorkflowTabs();
  const pluginTabs = [...getSidebarTabs(enabledPlugins),...workflowTabs];

  const order=sidebarOrder(layout.order,['conversations','files',...pluginTabs.map(pt=>pt.id)]);
  function moveSection(source:string,target:string,after=false){setLayoutState({projectPath,layout:writeSidebarLayout(projectPath,{order:moveSidebarSection(order,source,target,after)})});}
  // Reveal the file section when searching or locating a file from a tab.
  const pendingFileTreeSearch = useAppStore((s) => s.pendingFileTreeSearch);
  const fileToReveal = useAppStore(s => s.fileToReveal);
  useEffect(() => {
    if (pendingFileTreeSearch || fileToReveal) {
      setCollapsed(previous=>({...previous,files:false}));
      requestAnimationFrame(()=>document.getElementById('sidebar-section-files')?.scrollIntoView({block:'nearest'}));
    }
  }, [pendingFileTreeSearch, fileToReveal]);

  // 双击编辑对话标题
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // 对话右键/更多菜单（归档 / 复制 ID / 删除）
  const [menuConvId, setMenuConvId] = useState<string | null>(null);
  const [menuCopied, setMenuCopied] = useState(false);
  const [conversationPreview, setConversationPreview] = useState<{
    title: string;
    updatedAt: string;
    top: number;
    left: number;
  } | null>(null);
  const { ref: previewRef, style: previewStyle } = useCursorMenuStyle(conversationPreview?.left ?? 0, conversationPreview?.top ?? 0, !!conversationPreview);
  // 浮窗归属的那一行（收起判定要看它还在不在 DOM 里）
  const previewAnchor = useRef<HTMLElement | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(()=>()=>clearTimeout(previewTimer.current),[]);
  // 菜单锚点位置（fixed 坐标，用于 Portal 定位）
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; right: number } | null>(null);
  const { ref: moreMenuRef, style: moreMenuStyle } = useCursorMenuStyle(menuAnchor ? window.innerWidth - menuAnchor.right - 180 : 0, menuAnchor?.top ?? 0, !!menuConvId && !!menuAnchor);
  const menuTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onMenuCopyId = async (id: string) => {
    const ok = await copyMarkdown(id);
    if (ok) {
      setMenuCopied(true);
      clearTimeout(menuTimer.current);
      menuTimer.current = setTimeout(() => {
        setMenuCopied(false);
        setMenuConvId(null);
      }, 1500);
    }
  };

  // 菜单归档：归档后对话从左栏清单剔除（设置页「归档对话」中可解档/管理）
  const onMenuArchive = async (id: string) => {
    const proj = useAppStore.getState().currentProject;
    if (!proj) return;
    const r = (await window.api.convSetArchived?.(proj.path, id, true)) as
      | { ok: boolean; error?: string }
      | undefined;
    // 主进程会拒绝还在执行的对话：不成功就得说清楚，不能静默假装已归档
    if (r && !r.ok) {
      useAppStore.getState().setBanner(r.error ?? translate('settings.conv.archiveFail'));
      return;
    }
    await useAppStore.getState().refreshConversations();
  };

  // 开始编辑对话标题
  const startRename = useCallback((c: { id: string; title: string }) => {
    setEditingConvId(c.id);
    setEditTitle(displayConvTitle(c.title));
  }, []);

  // 提交重命名
  const commitRename = useCallback(() => {
    if (editingConvId) {
      const newTitle = editTitle.trim();
      if (newTitle) {
        renameConversation(editingConvId, newTitle);
      }
      setEditingConvId(null);
      setEditTitle('');
    }
  }, [editingConvId, editTitle, renameConversation]);

  // 取消重命名
  const cancelRename = useCallback(() => {
    setEditingConvId(null);
    setEditTitle('');
  }, []);

  const showConversationPreview = useCallback((c: { title: string; updatedAt: string }, element: HTMLElement) => {
    clearTimeout(previewTimer.current);
    setConversationPreview(null);
    previewAnchor.current = element;
    previewTimer.current = setTimeout(()=>{
    if(!element.isConnected || previewAnchor.current!==element)return;
    const rect = element.getBoundingClientRect();
    const previewWidth = Math.min(360, Math.max(220, window.innerWidth - rect.right - 24));
    const left = rect.right + 8 + previewWidth <= window.innerWidth - 8
      ? rect.right + 8
      : Math.max(8, rect.left - previewWidth - 8);
    // The preview is capped at 128px high; keep it inside the viewport when
    // hovering a conversation near the bottom of the list.
    const top = rect.bottom + 4;
    previewAnchor.current = element;
    setConversationPreview({ title: displayConvTitle(c.title), updatedAt: c.updatedAt, top, left });
    },600);
  }, []);

  const hideConversationPreview = useCallback(() => {
    clearTimeout(previewTimer.current);
    previewAnchor.current = null;
    setConversationPreview(null);
  }, []);

  /*
   * 浮窗原本只靠那一行的 mouseleave 收起，但行随时可能被换掉：切项目、归档/删除对话、
   * 点击后清单按更新时间重排——节点不在了就不会再有 mouseleave，浮窗于是永远钉在原位，
   * 显示的还是上一个项目的对话（用户反馈的“右边悬浮不消失”）。同理，鼠标移出窗口、
   * 切到别的 App 时也没有 mouseleave。这里补三条兜底：指针落到别处、窗口失焦/滚动/缩放、
   * 项目或清单内容变化。
   */
  useEffect(() => {
    const hide = () => hideConversationPreview();
    const onPointerOver = (event: Event) => {
      const anchor = previewAnchor.current;
      const target = event.target as Node | null;
      // 锚点已卸载（切项目/归档/删除/重排）→ 浮窗没了归属，直接收
      if (!anchor || !anchor.isConnected || !target || !anchor.contains(target)) hide();
    };
    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('blur', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [conversationPreview, hideConversationPreview]);

  // 换了项目或清单重排：旧锚点即使还连着，也已经不代表当前范围
  const conversationListKey = visibleConversations.map((c) => c.id).join(',');
  const previewProjectPath = currentProject?.path ?? '';
  useEffect(() => {
    hideConversationPreview();
  }, [previewProjectPath, conversationListKey, hideConversationPreview]);

  // 编辑输入框自动聚焦
  useEffect(() => {
    if (editingConvId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingConvId]);

  return (
    <aside className="sidebar">

      {currentProject ? (
        <div className="sidebar-panels" ref={panelsRef} key={projectPath} onScroll={event=>{if(event.target!==event.currentTarget)return;const saved=readSidebarLayout(projectPath);writeSidebarLayout(projectPath,{scrolls:{...saved.scrolls,__panels:event.currentTarget.scrollTop}});}}>
          <OrderedSidebarSections order={order}>
          <SidebarSection {...sectionResizeProps('conversations')} id="conversations" title={t('sidebar.conversations')} icon={<MessageSquare size={16}/>} collapsed={isCollapsed('conversations')} onToggle={()=>toggleSection('conversations')} actions={
              <ShortcutTooltip label={t('sidebar.conversations.new')} shortcut={shortcutDisplay('newConversation',shortcutOverrides)}>
              <button
                className="icon-btn"
                onClick={createConversation}
                aria-label={t('sidebar.conversations.new')}
              ><MessageSquarePlus size={16}/></button>
              </ShortcutTooltip>}>
            <ul className="list conversation-list">
              {visibleConversations.length === 0 ? (
                <li className="muted small">{t('sidebar.conversations.empty')}</li>
              ) : null}
              {visibleConversations.map((c) => {
                const isBusy = !!busyConvIds[c.id];
                const scheduleState=conversationScheduleState(c.id,scheduledTasks,scheduledRuns);
                const hasScheduled=scheduleState.hasTasks;
                const channelCount=new Set([
                  ...(c.inboundChannelIds??c.channelIds??[]),...(c.outboundChannelIds??c.channelIds??[]),
                  ...(c.broadcastUserChannelIds??c.broadcastChannelIds??[]),
                  ...(c.broadcastInboundChannelIds??c.broadcastChannelIds??[]),...(c.broadcastAssistantChannelIds??[]),
                ]).size;
                const channelHint=resolveLanguage(pluginSettings?.language,pluginSettings?._systemLocale)==='en'?`Linked channels: ${channelCount}`:`已关联 ${channelCount} 个渠道`;

                const hasPending = (pendingApprovalsByConv[c.id]?.length ?? 0) > 0;
                const title = displayConvTitle(c.title);
                // 统一 tab 模型：通过 activeTabId 判断是否高亮
                const isConvActive = activeTabId === `conv:${c.id}`;
                return (
                  <li
                    key={c.id}
                    className={`list-item ${isConvActive ? 'active' : ''}${pinnedConversations.includes(c.id)?' is-pinned':''}${channelCount?' has-channel':''}${channelCount&&(hasScheduled||isBusy)?' has-secondary-status':''}`}
                    onClick={() => selectConversation(c.id)}
                    onMouseEnter={(e) => {
                      if (editingConvId !== c.id) showConversationPreview(c, e.currentTarget);
                    }}
                    onMouseLeave={() => hideConversationPreview()}
                  >
                    <div className={`list-item-title${isBusy ? ' list-item-title--busy' : ''}`}>
                      {hasPending ? <span className="conv-approval-badge" title={t('sidebar.conversations.needsApproval')}><AlertCircle size={12} /></span> : null}
                      {editingConvId === c.id ? (
                        <input
                          ref={editInputRef}
                          className="conv-rename-input"
                          type="text"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              commitRename();
                            } else if (e.key === 'Escape') {
                              cancelRename();
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          placeholder={t('sidebar.conversations.renamePlaceholder')}
                        />
                      ) : (
                        <TitleMarquee
                          text={title}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            startRename(c);
                          }}
                        />
                      )}
                    </div>
                    {c.unread && <span role="img" aria-label={resolveLanguage(pluginSettings?.language,pluginSettings?._systemLocale)==='en'?'Unread reply':'未读回复'} title={resolveLanguage(pluginSettings?.language,pluginSettings?._systemLocale)==='en'?'Unread reply':'未读回复'} style={{width:5,height:5,borderRadius:'50%',background:'var(--textDim)',opacity:.65,flexShrink:0,marginInline:5}}/>}
                    {channelCount>0&&<span className="conv-channel-indicator" title={channelHint} aria-label={channelHint} role="img"><CloudLightning size={14}/></span>}
                    {/* "⋯" 更多菜单（归档 / 复制 ID / 删除） */}
                    <div className={`conv-more-wrap${isBusy||hasScheduled ? ' conv-more-wrap--busy' : ''}`}>
                      {hasScheduled ? <ScheduledIndicator animated={!scheduleState.stopped} stopped={scheduleState.stopped}/> : isBusy ? <span className="conv-busy-spinner" title={t('sidebar.conversations.busy')} role="status" aria-label={t('sidebar.conversations.busy')} /> : null}
                      <button
                        className="icon-btn conv-more-btn"
                        title={t('common.more')}
                        onClick={(e) => {
                          e.stopPropagation();
                          const nextId = menuConvId === c.id ? null : c.id;
                          setMenuConvId(nextId);
                          if (nextId) {
                            // 计算按钮在视口中的位置，用于 Portal 菜单定位
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setMenuAnchor({
                              top: rect.bottom + 2,
                              right: window.innerWidth - rect.right,
                            });
                          } else {
                            setMenuAnchor(null);
                          }
                        }}
                      ><MoreHorizontal size={14} /></button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {conversationPreview ? createPortal(
              <div
                className="conversation-title-preview"
                ref={previewRef} style={previewStyle}
                role="tooltip"
                aria-hidden="true"
              >
                <div className="conversation-title-preview-title">{conversationPreview.title}</div>
                <div className="conversation-title-preview-time">{formatCasualDateTime(conversationPreview.updatedAt)}</div>
              </div>,
              document.body,
            ) : null}
          </SidebarSection>

          <PluginSlot slot="sidebar.middle"/><PluginSlot slot="sidebar.tabs"/>
          <SidebarSection {...sectionResizeProps('files')} id="files" title={t('sidebar.files')} icon={<FolderOpen size={16}/>} collapsed={isCollapsed('files')} onToggle={()=>toggleSection('files')}>
            <FileTree/>
          </SidebarSection>
          {pluginTabs.filter(pt=>!pt.visible||pt.visible()).map(pt=>{const Icon=pt.icon;return <SidebarSection {...sectionResizeProps(pt.id)} key={pt.id} id={pt.id} title={t(pt.labelKey)} icon={<Icon size={16}/>} collapsed={isCollapsed(pt.id)} onToggle={()=>toggleSection(pt.id)} actions={pt.headerActions?.()}>{pt.render()}</SidebarSection>;})}
          </OrderedSidebarSections>
        </div>
      ) : (
        <div className="sidebar-section flex-1">
          <div className="empty-sidebar">
            <p className="muted small">{t('sidebar.emptyProject')}</p>
          </div>
        </div>
      )}

      {/* Retro analysis progress panel (sidebar) */}
      {analysisMode === 'retro' && (
        <RetroProgressPanel
          modules={retroModules}
          moduleOrder={retroModuleOrder}
          globalLog={retroGlobalLog}
          startedAt={retroStartedAt}
          lastEventAt={retroLastEventAt}
          claudeCalling={retroClaudeCalling}
          onStop={abortAnalysis}
        />
      )}

      <div className="sidebar-footer">
        <PluginSlot slot="sidebar.bottom"/><PluginSlot slot="menu"/><div className="sidebar-footer-actions">
          <button
            type="button"
            className={`footer-action footer-action-settings ${tabOpen('settings') ? 'active' : ''}`}
            onClick={onOpenSettings}
            title={t('sidebar.settings')}
            aria-label={t('sidebar.settings')}
          >
            <span className="footer-action-icon"><Settings size={16} /></span>
          </button>
          <button
            type="button"
            className={`footer-action footer-action-scheduled ${tabOpen('scheduled') ? 'active' : ''}`}
            onClick={onShowScheduled}
            disabled={!currentProject}
            title={t('scheduled.title')}
            aria-label={t('scheduled.title')}
          >
            <span className="footer-action-icon"><CalendarClock size={16} /></span>
          </button>
          {currentProject && [
            {id:'conversations',label:t('sidebar.conversations'),icon:MessageSquare},
            {id:'files',label:t('sidebar.files'),icon:FolderOpen},
            ...pluginTabs.filter(pt=>!pt.visible||pt.visible()).map(pt=>({id:pt.id,label:t(pt.labelKey),icon:pt.icon})),
          ].filter(section=>isCollapsed(section.id)).map(section=>{const Icon=section.icon;return <button key={section.id} type="button" className="footer-action sidebar-restore-section" data-section={section.id} title={section.label} aria-label={section.label} onClick={()=>toggleSection(section.id)}><span className="footer-action-icon"><Icon size={16}/></span></button>;})}
          <button
            type="button"
            className={`footer-action ${tabOpen('help') ? 'active' : ''}`}
            onClick={onOpenAbout}
            title={t('sidebar.about')}
            aria-label={t('sidebar.about')}
          >
            <span className="footer-action-icon"><HelpCircle size={16} /></span>
          </button>
        </div>
      </div>

      {/* 对话更多菜单（通过 Portal 渲染到 body，避免被 .list 的 overflow 和 sidebar 的 backdrop-filter 层叠上下文裁剪） */}
      {menuConvId && menuAnchor && (() => {
        const menuConv = conversations.find((x) => x.id === menuConvId);
        if (!menuConv) return null;
        return createPortal(
          <>
            <div
              className="conv-more-backdrop"
              onClick={() => {
                setMenuConvId(null);
                setMenuAnchor(null);
              }}
            />
            <div
              className="conv-more-menu conv-more-menu--portal"
              ref={moreMenuRef} style={{ ...moreMenuStyle, position: 'fixed', right: 'auto' }}
            >
              <button className="conv-more-item conv-pin-action" onClick={event=>{event.stopPropagation();toggleConversationPin(menuConv.id);setMenuConvId(null);setMenuAnchor(null);}}>
                {pinnedConversations.includes(menuConv.id)?<PinOff size={13}/>:<Pin size={13}/>}
                <span>{resolveLanguage(pluginSettings?.language,pluginSettings?._systemLocale)==='en'?(pinnedConversations.includes(menuConv.id)?'Unpin conversation':'Pin conversation'):(pinnedConversations.includes(menuConv.id)?'取消置顶':'置顶对话')}</span>
              </button>
              <button className="conv-more-item" onClick={event=>{event.stopPropagation();setMenuConvId(null);setMenuAnchor(null);startRename(menuConv);}}>
                <Pencil size={13}/><span>{resolveLanguage(pluginSettings?.language,pluginSettings?._systemLocale)==='en'?'Rename':'重命名'}</span>
              </button>
              {/* 配置对话记忆：直达设置页「对话记忆」分类，并挂载该对话的对话级记忆层 */}
              <button
                className="conv-more-item"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuConvId(null);
                  setMenuAnchor(null);
                  onOpenMemorySettings(menuConv.id);
                }}
              >
                <Brain size={13} />
                <span>{t('sidebar.convMemory')}</span>
              </button>
              <button
                className="conv-more-item"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuConvId(null);
                  setMenuAnchor(null);
                  void onMenuArchive(menuConv.id);
                }}
              >
                <Archive size={13} />
                <span>{t('sidebar.archive')}</span>
              </button>
              <button
                className="conv-more-item"
                onClick={async (e) => {
                  e.stopPropagation();
                  await onMenuCopyId(menuConv.id);
                }}
              >
                {menuCopied && menuConvId === menuConv.id ? <Check size={13} /> : <Copy size={13} />}
                <span>{menuCopied && menuConvId === menuConv.id ? t('common.copied') : t('sidebar.copyId')}</span>
              </button>
              <button
                className="conv-more-item danger"
                onClick={async (e) => {
                  e.stopPropagation();
                  setMenuConvId(null);
                  setMenuAnchor(null);
                  const isEmpty = !menuConv.messages || menuConv.messages.length === 0;
                  if (isEmpty || (await confirmDialog({ message: t('sidebar.conversations.deleteConfirm', { title: displayConvTitle(menuConv.title) }), danger: true }))) {
                    deleteConversation(menuConv.id);
                  }
                }}
              >
                <Trash2 size={13} />
                <span>{t('common.delete')}</span>
              </button>
            </div>
          </>,
          document.body,
        );
      })()}
    </aside>
  );
}

/**
 * Per-conversation knobs (requireApproval + permission mode) now live in the
 * chat input toolbar (left of the optimize button) — see ChatView.
 */

// ─── Retro Analysis Progress Panel (Multi-module) ───────────────────────

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

type RetroModule = {
  specId: string;
  title: string;
  currentPhase: 'requirements' | 'design' | 'tasks' | 'done';
  streams: Record<'requirements' | 'design' | 'tasks', { text: string; logs: string[] }>;
};

function RetroProgressPanel({
  modules,
  moduleOrder,
  globalLog,
  startedAt,
  lastEventAt,
  claudeCalling,
  onStop,
}: {
  modules: Record<string, RetroModule>;
  moduleOrder: string[];
  globalLog: string[];
  startedAt: number | null;
  lastEventAt: number | null;
  claudeCalling: boolean;
  onStop: () => void;
}) {
  const t = useT();
  const [elapsed, setElapsed] = useState(0);
  const [staleSeconds, setStaleSeconds] = useState(0);

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      setStaleSeconds(0);
      return;
    }
    const tick = () => {
      setElapsed(Date.now() - startedAt);
      if (lastEventAt) {
        setStaleSeconds(Math.floor((Date.now() - lastEventAt) / 1000));
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt, lastEventAt]);

  const phases = ['requirements', 'design', 'tasks'] as const;
  const orderedModules = moduleOrder.map((id) => modules[id]).filter(Boolean);

  // Find the currently active module (first one that's not 'done')
  const activeModule = orderedModules.find((m) => m.currentPhase !== 'done');
  // Show global log when no modules have been created yet
  const showGlobalLog = orderedModules.length === 0;
  // All known modules done but analysis still running → waiting for next
  const waitingForNext = !showGlobalLog && !activeModule;
  // Network stall: no events for 30+ seconds AND Claude is not currently being called
  // (If claudeCalling is true, LLM is just thinking slowly, not a real network issue)
  const stalled = staleSeconds >= 30 && !claudeCalling;
  // Last completed module (for context during transition)
  const lastDone = orderedModules.length > 0
    ? orderedModules[orderedModules.length - 1]
    : null;

  return (
    <div className="retro-sidebar-panel">
      <div className="retro-sidebar-header">
        <span className="dot-pulse" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-primary)', display: 'inline-block' }} />
        <span className="muted small" style={{ fontWeight: 500 }}>{t('analyze.retroRunning')}</span>
        <span className="muted small" style={{ marginLeft: 'auto' }}>{formatElapsed(elapsed)}</span>
      </div>

      {showGlobalLog ? (
        // Module identification phase — show global log
        <div className="retro-sidebar-stream">
          {globalLog.length > 0 ? globalLog[globalLog.length - 1] : '…'}
        </div>
      ) : (
        <>
          {/* Module list with phase badges */}
          <div className="retro-sidebar-modules">
            {orderedModules.map((mod) => {
              const isActive = mod === activeModule;
              return (
                <div
                  key={mod.specId}
                  className={`retro-sidebar-module ${isActive ? 'active' : ''} ${mod.currentPhase === 'done' ? 'done' : ''}`}
                >
                  <span className="retro-sidebar-module-name">{mod.title}</span>
                  <div className="retro-sidebar-phases">
                    {phases.map((ph) => {
                      const phaseDone = mod.streams[ph].text.length > 0 && mod.currentPhase !== ph;
                      const isCurrent = mod.currentPhase === ph;
                      return (
                        <span
                          key={ph}
                          className={`retro-sidebar-phase-badge ${phaseDone ? 'done' : isCurrent ? 'active' : 'pending'}`}
                        >
                          {phaseDone ? <CheckCircle2 size={10} /> : t(`spec.tab.${ph}`).slice(0, 3)}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {activeModule ? (
            <>
              <div className="muted small" style={{ marginBottom: 2, marginTop: 4 }}>
                {activeModule.title} — {t(`spec.tab.${activeModule.currentPhase}`)}
              </div>
              <div className="retro-sidebar-stream">
                {activeModule.currentPhase === 'done'
                  ? '…'
                  : activeModule.streams[activeModule.currentPhase]?.text || '…'}
              </div>
            </>
          ) : waitingForNext ? (
            <>
              <div className="muted small" style={{ marginBottom: 2, marginTop: 4 }}>
                {lastDone && <><CheckCircle2 size={10} style={{ verticalAlign: 'middle', marginRight: 2 }} /> {lastDone.title}</>}
              </div>
              <div className="retro-sidebar-stream">
                {globalLog.length > 0 ? globalLog[globalLog.length - 1] : '…'}
              </div>
            </>
          ) : null}
        </>
      )}

      {/* Status indicator */}
      {claudeCalling ? (
        // LLM is thinking — show a different message (not a network stall)
        staleSeconds >= 30 ? (
          <div className="retro-sidebar-thinking" style={{ marginTop: 6, marginBottom: 2 }}>
            <span className="dot-pulse" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-primary)', display: 'inline-block' }} />
            <span className="muted small">
              {staleSeconds >= 120
                ? `${t('analyze.llmThinking')}（${Math.floor(staleSeconds / 60)}${t('common.minutes')}）`
                : `${t('analyze.llmThinking')}（${staleSeconds}${t('common.seconds')}）`}
            </span>
          </div>
        ) : null
      ) : stalled ? (
        // Real network stall — Claude is not calling, no events coming in
        <div className="retro-sidebar-stall" style={{ marginTop: 6, marginBottom: 2 }}>
          <WifiOff size={12} />
          <span className="muted small">
            {staleSeconds >= 120
              ? `${t('analyze.noResponse')}（${Math.floor(staleSeconds / 60)}${t('common.minutes')}）`
              : `${t('analyze.noResponse')}（${staleSeconds}${t('common.seconds')}）`}
          </span>
        </div>
      ) : null}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
        {stalled && !claudeCalling ? (
          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              // Retry: clear state first, then restart after a brief delay
              // to let the abort signal propagate
              useAppStore.setState({
                analysisMode: undefined,
                retroStartedAt: null,
                retroLastEventAt: null,
                retroClaudeCalling: false,
              });
              setTimeout(() => {
                useAppStore.getState().retroAnalyze();
              }, 300);
            }}
          >
            <WifiOff size={12} style={{ transform: 'rotate(180deg)' }} /> {t('analyze.retry')}
          </button>
        ) : null}
        <button className="btn-ghost btn-sm" onClick={onStop}>
          <StopCircle size={12} /> {t('phase.stop')}
        </button>
      </div>
    </div>
  );
}

function SidebarSection({id,title,icon,collapsed,onToggle,actions,children,weight,onResize,onMove,scrolls,projectPath}:{id:string;title:string;icon:ReactNode;collapsed:boolean;onToggle:()=>void;actions?:ReactNode;children:ReactNode;weight?:number;onResize:(sizes:Record<string,number>)=>void;onMove:(source:string,target:string,after?:boolean)=>void;scrolls?:Record<string,number>;projectPath?:string}){
 const section=useRef<HTMLElement>(null);
 const [dropAfter,setDropAfter]=useState<boolean|null>(null);
 const stopResize=useRef<(()=>void)>();
 useLayoutEffect(()=>{
  const root=section.current;if(!root)return;
  const saved=Object.entries(readSidebarLayout(projectPath).scrolls??{}).filter(([key])=>key.startsWith(id+':'));
  const restore=()=>{for(let i=saved.length-1;i>=0;i--){const [key,value]=saved[i],el=root.querySelector<HTMLElement>('.'+CSS.escape(key.slice(id.length+1)));if(el&&el.scrollHeight-el.clientHeight>=value){el.scrollTop=value;saved.splice(i,1);}}};
  restore();const observer=new MutationObserver(restore);observer.observe(root,{childList:true,subtree:true});
  const stop=()=>{saved.length=0;observer.disconnect();};root.addEventListener('wheel',stop,{passive:true});root.addEventListener('pointerdown',stop);return()=>{observer.disconnect();root.removeEventListener('wheel',stop);root.removeEventListener('pointerdown',stop);};
 },[projectPath,id,collapsed]);
 useEffect(()=>()=>stopResize.current?.(),[]);
 const snapshot=()=>{
  const sections=Array.from(section.current?.parentElement?.querySelectorAll<HTMLElement>('.sidebar-stack-section:not([hidden])')??[]);
  const index=sections.findIndex(element=>element===section.current),next=sections[index+1];
  if(!next)return;
  return{sizes:Object.fromEntries(sections.map(element=>[element.dataset.section!,element.getBoundingClientRect().height])),next:next.dataset.section!};
 };
 const resize=(state:{sizes:Record<string,number>;next:string},delta:number)=>{
  const total=state.sizes[id]+state.sizes[state.next];
  if(total<260)return;
  const height=Math.max(130,Math.min(total-130,state.sizes[id]+delta));
  onResize({...state.sizes,[id]:height,[state.next]:total-height});
 };
 return <section ref={section} data-section={id} onScrollCapture={event=>{const el=event.target as HTMLElement;if(!el.classList.length||el.scrollHeight<=el.clientHeight)return;const current=readSidebarLayout(projectPath);writeSidebarLayout(projectPath,{scrolls:{...current.scrolls,[id+':'+el.classList[0]]:el.scrollTop}});}} onDragOver={event=>{if(!event.dataTransfer.types.includes('application/x-sage-sidebar-section'))return;event.preventDefault();event.dataTransfer.dropEffect='move';const rect=event.currentTarget.getBoundingClientRect();setDropAfter(event.clientY>rect.top+rect.height/2);}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDropAfter(null);}} onDrop={event=>{const source=event.dataTransfer.getData('application/x-sage-sidebar-section');if(!source)return;event.preventDefault();event.stopPropagation();const rect=event.currentTarget.getBoundingClientRect();onMove(source,id,event.clientY>rect.top+rect.height/2);setDropAfter(null);}} hidden={collapsed} id={'sidebar-section-'+id} style={Number.isFinite(weight)&&(weight??0)>0?{flex:`${weight} 0 0px`}:undefined} className={'sidebar-stack-section sidebar-stack-'+id+(collapsed?' is-collapsed':'')+(dropAfter===null?'':dropAfter?' drop-after':' drop-before')}>
  <div className="sidebar-stack-heading" draggable onDragStart={event=>{if((event.target as HTMLElement).closest('button:not(.sidebar-stack-toggle)')){event.preventDefault();return;}event.dataTransfer.setData('application/x-sage-sidebar-section',id);event.dataTransfer.effectAllowed='move';}} onDragEnd={()=>setDropAfter(null)} onKeyDown={event=>{if(!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key))return;const sections=Array.from(section.current?.parentElement?.querySelectorAll<HTMLElement>('.sidebar-stack-section:not([hidden])')??[]),index=sections.indexOf(section.current!),next=sections[index+(event.key==='ArrowUp'?-1:1)];if(next){event.preventDefault();onMove(id,next.dataset.section!,event.key==='ArrowDown');}}}><button type="button" className="sidebar-stack-toggle" aria-expanded={!collapsed} aria-controls={'sidebar-body-'+id} onClick={onToggle}><span className="sidebar-stack-icon">{icon}</span><span>{title}</span></button>{actions}</div>
  <div id={'sidebar-body-'+id} className="sidebar-stack-body" hidden={collapsed}>{children}</div>
  <div className="sidebar-stack-resizer" role="separator" aria-orientation="horizontal" aria-label={title} tabIndex={0}
   onMouseDown={event=>{if(event.button!==0)return;const state=snapshot();if(!state)return;event.preventDefault();stopResize.current?.();const y=event.clientY,handle=event.currentTarget;handle.classList.add('dragging');const move=(e:MouseEvent)=>resize(state,e.clientY-y);const up=()=>{document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);handle.classList.remove('dragging');stopResize.current=undefined;};stopResize.current=up;document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);}}
   onKeyDown={event=>{if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;event.preventDefault();const state=snapshot();if(state)resize(state,event.key==='ArrowDown'?16:-16);}}/>
 </section>;
}

function OrderedSidebarSections({order,children}:{order:string[];children:ReactNode}){
 const items=Children.toArray(children);const sections=items.filter(item=>isValidElement<{id?:string}>(item)&&item.props.id).sort((a,b)=>order.indexOf((a as React.ReactElement).props.id)-order.indexOf((b as React.ReactElement).props.id));
 let index=0;return <>{items.map(item=>isValidElement<{id?:string}>(item)&&item.props.id?sections[index++]:item)}</>;
}
