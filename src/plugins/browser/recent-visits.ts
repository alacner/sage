/**
 * Browser Plugin — 最后访问记录（项目维度）
 *
 * 右侧浏览器每次导航拿到标题时记一条（按 URL 去重并置顶），
 * 按项目分区存 localStorage，上限取插件配置 browser.recentVisitLimit（默认 100）；
 * 侧边栏「最后访问记录」列表订阅变更事件实时刷新。
 */
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'sage.browser.recentVisits';
const CHANGE_EVENT = 'sage:recent-visits-changed';
export const DEFAULT_RECENT_LIMIT = 100;

export interface RecentVisit {
  url: string;
  title: string;
  favicon?: string;
  at: number;
}

type Store = Record<string, RecentVisit[]>;

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? (obj as Store) : {};
  } catch {
    return {};
  }
}

function saveStore(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* 忽略配额/隐私模式异常 */
  }
}

export function loadRecentVisits(projectPath: string): RecentVisit[] {
  const list = loadStore()[projectPath];
  return Array.isArray(list) ? list.filter((v) => v && typeof v.url === 'string') : [];
}

/** 记录一次访问：按 URL 去重置顶，标题/图标合并旧值，按上限截断。 */
export function recordRecentVisit(
  projectPath: string,
  entry: { url: string; title?: string; favicon?: string },
  limit: number,
): void {
  if (!projectPath || !entry.url || entry.url.startsWith('about:')) return;
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_RECENT_LIMIT;
  const store = loadStore();
  const list = Array.isArray(store[projectPath]) ? store[projectPath] : [];
  const old = list.find((v) => v.url === entry.url);
  const rest = list.filter((v) => v.url !== entry.url);
  rest.unshift({
    url: entry.url,
    title: entry.title || old?.title || '',
    favicon: entry.favicon || old?.favicon,
    at: Date.now(),
  });
  store[projectPath] = rest.slice(0, max);
  saveStore(store);
}

/** 删除单条访问记录。 */
export function removeRecentVisit(projectPath: string, url: string): void {
  if (!projectPath || !url) return;
  const store = loadStore();
  if (!Array.isArray(store[projectPath])) return;
  const list = store[projectPath].filter((v) => v.url !== url);
  if (list.length === store[projectPath].length) return;
  if (list.length) store[projectPath] = list;
  else delete store[projectPath];
  saveStore(store);
}

/** 清空当前项目的全部访问记录。 */
export function clearRecentVisits(projectPath: string): void {
  if (!projectPath) return;
  const store = loadStore();
  if (!(projectPath in store)) return;
  delete store[projectPath];
  saveStore(store);
}

/** 订阅当前项目的最后访问记录（侧边栏实时刷新）。 */
export function useRecentVisits(projectPath: string | undefined): RecentVisit[] {
  const [visits, setVisits] = useState<RecentVisit[]>(() => (projectPath ? loadRecentVisits(projectPath) : []));
  useEffect(() => {
    const reload = () => setVisits(projectPath ? loadRecentVisits(projectPath) : []);
    reload();
    window.addEventListener(CHANGE_EVENT, reload);
    return () => window.removeEventListener(CHANGE_EVENT, reload);
  }, [projectPath]);
  return visits;
}
