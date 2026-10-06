/**
 * Browser Plugin — Sidebar Tab
 *
 * 三段式快捷面板：
 * 1. 新建标签页（空白页）+ 新建无痕标签页（独立内存 session）；
 * 2. 常用本机端口：按右侧浏览器实际访问计数降序排列（最多显示两排，
 *    超出部分裁剪），点击直达 http://localhost:端口；
 * 3. 我的收藏（宫格图标：点击打开对应标签页；右键编辑名称与域名；
 *    悬浮右上角 × 二次确认删除；底部 + 磁贴手动添加；
 *    图标固定取网站 favicon，打开过的域名立即命中图标缓存）。
 */
import { useState } from 'react';
import { Globe, Plus, Ghost, Trash2, X } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { useT, translate } from '../../i18n';
import { confirmDialog } from '../../lib/confirm-dialog';
import { normalizeUrlInput } from './url';
import { usePortStats, sortedLocalPorts } from './ports';
import { useRecentVisits, removeRecentVisit, clearRecentVisits } from './recent-visits';
import {
  useBookmarks,
  addBookmark,
  updateBookmark,
  removeBookmark,
  lookupFavicon,
  BookmarkIcon,
  BookmarkDialog,
} from './bookmarks';

export function BrowserSidebarTab() {
  // 收藏命名弹窗：null 关闭；{ id } 重命名；{ id, edit } 编辑名称+域名；{} 手动添加
  const [dialog, setDialog] = useState<{ id?: string; edit?: boolean } | null>(null);
  const bookmarks = useBookmarks();
  const portStats = usePortStats();
  const project = useAppStore((s) => s.currentProject);
  // 最后访问记录（项目维度）：按访问时间倒序，点击重新打开
  const recent = useRecentVisits(project?.path);
  const t = useT();

  const openBrowser = (url?: string, opts?: { incognito?: boolean }) => {
    // 统一走 store 动作：与其它类型 tab 一致的打开/去重/激活逻辑
    useAppStore.getState().openBrowserTab(url, opts);
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: t('common.delete'),
      message: translate('browser.bookmarkDeleteConfirm', { name }),
      danger: true,
    });
    if (ok) removeBookmark(id);
  };

  // 清空最后访问记录（当前项目）：二次确认；单条删除不需确认
  const handleClearRecent = async () => {
    if (!project || !recent.length) return;
    const ok = await confirmDialog({
      title: t('browser.recentVisitsClear'),
      message: translate('browser.recentVisitsClearConfirm', { n: recent.length }),
      danger: true,
    });
    if (ok) clearRecentVisits(project.path);
  };

  const editing = dialog?.id ? bookmarks.find((b) => b.id === dialog.id) : undefined;
  // 常用本机端口：默认不显示，随打开过的端口增加（按访问计数降序）
  const ports = sortedLocalPorts(portStats);

  return (
    <div className="browser-sidebar-tab">
      {/* 常用本机端口：仅展示打开过的端口；无记录时整段隐藏 */}
      {ports.length ? (
        <div className="browser-side-section">
          <div className="browser-side-title">{t('browser.localPorts')}</div>
          <div className="browser-port-chips">
            {ports.map((port) => (
              <button
                key={port}
                className="browser-port-chip"
                onClick={() => openBrowser(`http://localhost:${port}`)}
              >
                {port}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* 我的收藏：宫格图标，点击打开对应标签页；右键编辑；悬浮 × 二次确认删除 */}
      <div className="browser-side-section">
        <div className="browser-side-title">{t('browser.bookmarks')}</div>
        <div className="browser-bookmarks-grid">
          {bookmarks.map((b) => (
            <div key={b.id} className="browser-bookmark-item">
              <button
                className="browser-bookmark-open"
                onClick={() => openBrowser(b.url)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setDialog({ id: b.id, edit: true });
                }}
              >
                <BookmarkIcon favicon={b.favicon} name={b.name} />
                <span className="browser-bookmark-name">{b.name}</span>
              </button>
              <button
                className="browser-bookmark-del"
                title={t('common.delete')}
                onClick={() => void handleDelete(b.id, b.name)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="browser-bookmark-item add"
            title={t('browser.bookmarkAdd')}
            onClick={() => setDialog({})}
          >
            <span className="browser-bookmark-icon fallback" aria-hidden>
              <Plus size={16} />
            </span>
            <span className="browser-bookmark-name">{t('browser.bookmarkAdd')}</span>
          </button>
        </div>
      </div>

      {/* 最后访问记录：项目维度保留（上限插件配置），点击重新打开；悬浮 × 删单条，标题栏垃圾桶清空全部 */}
      {recent.length ? (
        <div className="browser-side-section">
          <div className="browser-side-title browser-recent-head">
            <span>{t('browser.recentVisits')}</span>
            <button
              type="button"
              className="browser-recent-clear"
              title={t('browser.recentVisitsClear')}
              onClick={() => void handleClearRecent()}
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div className="browser-recent-list">
            {recent.map((v) => (
              <div key={v.url} className="browser-recent-item">
                <button type="button" className="browser-recent-open" onClick={() => openBrowser(v.url)}>
                  {v.favicon ? (
                    <img className="browser-recent-favicon" src={v.favicon} alt="" aria-hidden />
                  ) : (
                    <Globe size={14} aria-hidden />
                  )}
                  <span className="browser-recent-title">{v.title || hostOf(v.url)}</span>
                </button>
                <button
                  type="button"
                  className="browser-recent-del"
                  title={t('common.delete')}
                  onClick={() => project && removeRecentVisit(project.path, v.url)}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 收藏弹窗（portal 到 body）：添加填网址+名称；编辑可改名称+域名；图标不可改 */}
      {dialog ? (
        <BookmarkDialog
          key={dialog.id || 'new'}
          initialName={editing?.name || ''}
          initialUrl={editing?.url || ''}
          allowUrlEdit={!editing || !!dialog.edit}
          editMode={!!editing && !!dialog.edit}
          onSave={({ url, name }) => {
            const normalized = normalizeUrlInput(url);
            if (editing) {
              updateBookmark(editing.id, {
                name,
                url: normalized,
                favicon: lookupFavicon(normalized) ?? editing.favicon,
              });
            } else {
              addBookmark({ url: normalized, name, favicon: lookupFavicon(normalized) });
            }
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/** 标题缺失时的兜底展示：主机名 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function BrowserSidebarActions(){
 const t=useT();
 return <div className="sidebar-section-actions browser-section-actions">
  <button type="button" className="icon-btn" title={t('browser.newTab')} aria-label={t('browser.newTab')} onClick={()=>useAppStore.getState().openBrowserTab('about:blank')}><Plus size={16}/></button>
  <button type="button" className="icon-btn" title={t('browser.newIncognitoTab')} aria-label={t('browser.newIncognitoTab')} onClick={()=>useAppStore.getState().openBrowserTab('about:blank',{incognito:true})}><Ghost size={16}/></button>
 </div>;
}
