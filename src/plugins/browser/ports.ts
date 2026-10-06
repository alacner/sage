/**
 * Browser Plugin — 本机端口访问统计
 *
 * 右侧浏览器每次导航到 localhost/127.0.0.1 的显式端口时计数 +1，
 * 侧边栏「常用本机端口」只展示打开过的端口（默认不显示），
 * 按计数降序排列（最常用排前面）。统计持久化于 localStorage。
 */
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'sage.browser.portStats';
const CHANGE_EVENT = 'sage:port-stats-changed';

export type PortStats = Record<string, number>;

export function loadPortStats(): PortStats {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const out: PortStats = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/^\d+$/.test(k) && typeof v === 'number' && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function savePortStats(stats: PortStats): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    /* 忽略配额/隐私模式异常 */
  }
}

/** 订阅端口统计变化（侧边栏排序实时刷新）。 */
export function usePortStats(): PortStats {
  const [stats, setStats] = useState<PortStats>(() => loadPortStats());
  useEffect(() => {
    const handler = () => setStats(loadPortStats());
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, []);
  return stats;
}

/** 导航到本机显式端口时计数 +1（非本机/无端口忽略）。 */
export function recordPortVisit(url: string): void {
  if (!url || url.startsWith('about:')) return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  const host = u.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return;
  if (!u.port) return;
  const stats = loadPortStats();
  stats[u.port] = (stats[u.port] || 0) + 1;
  savePortStats(stats);
}

/**
 * 侧边栏展示顺序：仅打开过的端口；计数降序，同计数按端口号升序。
 */
export function sortedLocalPorts(stats: PortStats): string[] {
  return Object.keys(stats).sort((a, b) => {
    const ca = stats[a] || 0;
    const cb = stats[b] || 0;
    if (ca !== cb) return cb - ca;
    return Number(a) - Number(b);
  });
}
