import {WindowOverlay} from '../../components/WindowOverlay';
/**
 * Browser Plugin — 收藏（Bookmarks）
 *
 * 收藏持久化于 localStorage（与自定义设备同层），侧边栏收藏宫格与
 * 工具栏收藏按钮共用：
 * - 图标只取网站自带 favicon（page-favicon-updated 回写），不可手工修改；
 *   缺失/加载失败时 UI 回退默认地球图标；
 * - 重新进入站点时若网站图标更新，touchBookmarkFavicon 同步刷新收藏图标。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Globe, X } from 'lucide-react';
import { useT } from '../../i18n';

export interface BrowserBookmark {
  id: string;
  url: string;
  name: string;
  /** 网站 favicon（URL 或 data:）；undefined = 尚未取得，UI 显示默认图标。 */
  favicon?: string;
  createdAt: number;
}

const STORAGE_KEY = 'sage.browser.bookmarks';
const CHANGE_EVENT = 'sage:bookmarks-changed';

export function loadBookmarks(): BrowserBookmark[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter((b) => b && typeof b.url === 'string' && typeof b.name === 'string');
  } catch {
    return [];
  }
}

function saveBookmarks(list: BrowserBookmark[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* 忽略配额/隐私模式异常 */
  }
}

/** 订阅收藏变化（增删改 / 图标回写都会触发）。 */
export function useBookmarks(): BrowserBookmark[] {
  const [list, setList] = useState<BrowserBookmark[]>(() => loadBookmarks());
  useEffect(() => {
    const handler = () => setList(loadBookmarks());
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, []);
  return list;
}

export function addBookmark(input: { url: string; name: string; favicon?: string }): BrowserBookmark {
  const entry: BrowserBookmark = {
    id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    ...input,
  };
  saveBookmarks([...loadBookmarks(), entry]);
  return entry;
}

export function updateBookmark(id: string, patch: Partial<Pick<BrowserBookmark, 'name' | 'favicon' | 'url'>>): void {
  saveBookmarks(loadBookmarks().map((b) => (b.id === id ? { ...b, ...patch } : b)));
}

export function removeBookmark(id: string): void {
  saveBookmarks(loadBookmarks().filter((b) => b.id !== id));
}

/** 页面图标更新后同步写回同站点（origin 相同）的收藏（未收藏/图标相同则无操作）。 */
export function touchBookmarkFavicon(url: string, favicon?: string): void {
  if (!url || !favicon || url.startsWith('about:')) return;
  const origin = originOf(url);
  const list = loadBookmarks();
  const target = list.find((b) => originOf(b.url) === origin);
  if (!target || target.favicon === favicon) return;
  saveBookmarks(list.map((b) => (b.id === target.id ? { ...b, favicon } : b)));
}

// ── 站点图标缓存（origin → favicon）──
// 侧边栏添加/编辑收藏时若该域名打开过，立即命中缓存图标（与右侧添加同口径），
// 后续重新进入站点图标更新时经 rememberFavicon + touchBookmarkFavicon 同步。
const FAVICON_CACHE_KEY = 'sage.browser.favicons';
const FAVICON_CACHE_MAX = 300;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function loadFaviconCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(FAVICON_CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/** 记录站点图标（按 origin）；超出上限淘汰最早写入项。 */
export function rememberFavicon(url: string, favicon?: string): void {
  if (!url || !favicon || url.startsWith('about:')) return;
  const cache = loadFaviconCache();
  const key = originOf(url);
  if (cache[key] === favicon) return;
  cache[key] = favicon;
  const keys = Object.keys(cache);
  if (keys.length > FAVICON_CACHE_MAX) delete cache[keys[0]];
  try {
    localStorage.setItem(FAVICON_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* 忽略配额/隐私模式异常 */
  }
}

/** 查询域名图标缓存（origin 优先，回退完整 url）。 */
export function lookupFavicon(url: string): string | undefined {
  const cache = loadFaviconCache();
  return cache[originOf(url)] ?? cache[url];
}

/** 收藏图标：网站 favicon 优先，缺失/加载失败回退默认地球图标。 */
export function BookmarkIcon({ favicon, name }: { favicon?: string; name: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [favicon]);
  if (!favicon || broken) {
    return <span className="browser-bookmark-icon fallback" aria-hidden><Globe size={16} /></span>;
  }
  return <img className="browser-bookmark-icon" src={favicon} alt={name} onError={() => setBroken(true)} />;
}

/**
 * 收藏命名弹窗：名称可改；图标不提供编辑入口（固定取网站 favicon）。
 * allowUrlEdit = 需填/改网址（侧边栏添加、右键编辑）；工具栏收藏按钮只改名称。
 * editMode = 编辑已有收藏（标题区分「添加」）。
 * 弹窗经 portal 挂到 body：避免侧边栏祖先 transform 把 fixed 定位困在左栏内；
 * 蒙版透明（不用变灰遮罩），点击蒙版区域关闭。
 */
export function BookmarkDialog({
  initialName = '',
  initialUrl = '',
  allowUrlEdit = false,
  editMode = false,
  onSave,
  onClose,
}: {
  initialName?: string;
  initialUrl?: string;
  allowUrlEdit?: boolean;
  editMode?: boolean;
  onSave: (value: { url: string; name: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState(initialUrl);
  const t = useT();
  const valid = !!name.trim() && (!allowUrlEdit || !!url.trim());

  return createPortal(
    <WindowOverlay className="browser-bookmark-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form
        className="cdf-dialog browser-bookmark-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave({ url: url.trim(), name: name.trim() });
        }}
      >
        <div className="cdf-head">
          <span className="cdf-title">
            {t(editMode ? 'browser.bookmarkEdit' : allowUrlEdit ? 'browser.bookmarkAdd' : 'browser.bookmarkPage')}
          </span>
          <button type="button" className="icon-btn" title={t('common.close')} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="cdf-body">
          {allowUrlEdit ? (
            <div className="cdf-group">
              <div className="cdf-label">{t('browser.bookmarkUrl')}</div>
              <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoFocus />
            </div>
          ) : null}
          <div className="cdf-group">
            <div className="cdf-label">{t('browser.bookmarkName')}</div>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus={!allowUrlEdit} />
          </div>
        </div>
        <div className="cdf-foot">
          <button type="button" className="bdm-cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="bdm-add" disabled={!valid}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </WindowOverlay>,
    document.body,
  );
}
