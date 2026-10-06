import {ProjectSwitcher} from './ProjectSwitcher';
import { AnchoredPopover } from './AnchoredPopover';
import {formatCasualDateTime,formatDateTime,useDateTimeSettings} from '../lib/date-time';
import { useEffect, useMemo, useState } from 'react';
import { Bell, Download, MessageSquare, PanelLeft, Search, Trash2, X } from 'lucide-react';
import { useAppStore, type ActivityItem } from '../stores/appStore';
import { useT, displayConvTitle } from '../i18n';

/** 对话搜索 popover：复用后端 conv:search 三层搜索（标题/内容/记忆）；空查询展示最近对话。 */
function ConvSearchPopover({ onClose }: { onClose: () => void }) {
  useDateTimeSettings();
  const t = useT();
  const conversations = useAppStore((s) => s.conversations);
  const currentProject = useAppStore((s) => s.currentProject);
  const selectConversation = useAppStore((s) => s.selectConversation);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<
    Record<string, { inTitle: boolean; inContent: boolean; inMemory: boolean }> | null
  >(null);

  // 250ms 防抖：空查询立即回退到最近列表
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setHits(null);
      return;
    }
    if (!currentProject) return;
    const timer = setTimeout(() => {
      void window.api
        .convSearch(currentProject.path, query)
        .then(
          (r: {
            ok: boolean;
            hits?: Array<{ id: string; inTitle: boolean; inContent: boolean; inMemory: boolean }>;
          }) => {
            if (!r?.ok || !r.hits) return;
            const map: Record<string, { inTitle: boolean; inContent: boolean; inMemory: boolean }> = {};
            for (const h of r.hits) map[h.id] = h;
            setHits(map);
          },
        );
    }, 250);
    return () => clearTimeout(timer);
  }, [q, currentProject]);

  const list = useMemo(() => {
    const base = hits ? conversations.filter((c) => hits[c.id]) : conversations.slice(0, 8);
    return base.slice(0, 30);
  }, [hits, conversations]);

  return (
    <>
      <div className="titlebar-popover-backdrop" onClick={onClose} />
      <AnchoredPopover className="titlebar-popover titlebar-conversation-search">
        <div className="titlebar-popover-head">
          <Search size={16} aria-hidden/>
          <input
            className="titlebar-popover-input"
            placeholder={t('titlebar.searchPlaceholder')}
            value={q}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="titlebar-popover-list">
          {list.length === 0 ? (
            <div className="titlebar-empty">{hits ? t('titlebar.emptyNoMatch') : t('titlebar.emptyNoConv')}</div>
          ) : (
            list.map((c) => {
              const h = hits?.[c.id];
              return (
                <button
                  key={c.id}
                  type="button"
                  className="titlebar-hit"
                  title={displayConvTitle(c.title || '新对话')}
                  onClick={() => {
                    void selectConversation(c.id);
                    onClose();
                  }}
                >
                  <MessageSquare size={16} className="titlebar-hit-icon" aria-hidden/>
                  <span className="titlebar-hit-body">
                  <span className="titlebar-hit-title">{displayConvTitle(c.title || '新对话')}</span>
                  <span className="titlebar-hit-meta">
                    {c.updatedAt ? <span>{formatCasualDateTime(c.updatedAt)}</span> : null}
                    {h?.inTitle ? <span className="conv-match-badge">{t('titlebar.badgeTitle')}</span> : null}
                    {h?.inContent ? <span className="conv-match-badge">{t('titlebar.badgeContent')}</span> : null}
                    {h?.inMemory ? <span className="conv-match-badge">{t('titlebar.badgeMemory')}</span> : null}
                  </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}

/** 活动流 popover：打开即标记已读（未读徽标清零）。 */
function ActivityPopover({ onClose }: { onClose: () => void }) {
  useDateTimeSettings();
  const t = useT();
  const items = useAppStore((s) => s.activityItems);
  useEffect(() => {
    useAppStore.getState().markActivityRead();
  }, []);
  const iconFor = (k: ActivityItem['kind']) =>
    k === 'update' ? Download : k === 'channel' ? MessageSquare : Bell;
  return (
    <>
      <div className="titlebar-popover-backdrop" onClick={onClose} />
      <AnchoredPopover className="titlebar-popover">
        <div className="titlebar-popover-head titlebar-activity-head">
          <span className="titlebar-popover-title">{t('titlebar.activity')}</span>
          <div className="titlebar-activity-actions">
            <button type="button" className="icon-btn" title={t('titlebar.clearActivity')} aria-label={t('titlebar.clearActivity')} disabled={!items.length} onClick={() => useAppStore.getState().clearActivity()}><Trash2 size={14} /></button>
            <button type="button" className="icon-btn" title={t('common.close')} aria-label={t('common.close')} onClick={onClose}><X size={14} /></button>
          </div>
        </div>
        <div className="titlebar-popover-list">
          {items.length === 0 ? (
            <div className="titlebar-empty">{t('titlebar.noActivity')}</div>
          ) : (
            items.map((it) => {
              const Icon = iconFor(it.kind);
              return (
                <div key={it.id} className="titlebar-act">
                  <Icon size={14} className="titlebar-act-icon" />
                  <div className="titlebar-act-body">
                    <span className="titlebar-act-title">{it.title}</span>
                    {it.detail ? <span className="titlebar-act-detail">{it.detail}</span> : null}
                  </div>
                  <span className="titlebar-act-ts">
                    {formatDateTime(it.ts)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}

/**
 * 标题栏左侧动作组（红绿灯右侧）：
 * 1) 侧栏开关（PanelLeft）；2) 对话搜索（Search）；3) 活动流（Bell + 未读徽标）。
 */
export function TitleBarActions() {
  const t = useT();
  const sidebarHidden = useAppStore((s) => s.sidebarHidden);
  const setSidebarHidden = useAppStore((s) => s.setSidebarHidden);
  const unread = useAppStore(
    (s) => s.activityItems.filter((i) => i.ts > s.activityReadTs).length,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  useEffect(() => {
    const show = () => {setActivityOpen(true);setSearchOpen(false);};
    window.addEventListener('sage:show-activity',show);
    return () => window.removeEventListener('sage:show-activity',show);
  }, []);

  return (
    <div className="titlebar-actions">
      <button
        type="button"
        className="titlebar-btn"
        title={sidebarHidden ? t('titlebar.showSidebar') : t('titlebar.hideSidebar')}
        onClick={() => setSidebarHidden(!sidebarHidden)}
      >
        <PanelLeft size={14} />
      </button>
      <ProjectSwitcher/>
      <div className="titlebar-popover-wrap">
        <button
          type="button"
          className={`titlebar-btn ${searchOpen ? 'active' : ''}`}
          title={t('titlebar.searchTitle')}
          onClick={() => {
            setSearchOpen((v) => !v);
            setActivityOpen(false);
          }}
        >
          <Search size={14} />
        </button>
        {searchOpen ? <ConvSearchPopover onClose={() => setSearchOpen(false)} /> : null}
      </div>
      <div className="titlebar-popover-wrap">
        <button
          type="button"
          className={`titlebar-btn ${activityOpen ? 'active' : ''}`}
          title={t('titlebar.activity')}
          onClick={() => {
            setActivityOpen((v) => !v);
            setSearchOpen(false);
          }}
        >
          <Bell size={14} />
          {unread > 0 ? <span className="titlebar-badge">{unread > 99 ? '99+' : unread}</span> : null}
        </button>
        {activityOpen ? <ActivityPopover onClose={() => setActivityOpen(false)} /> : null}
      </div>
    </div>
  );
}
