import {createMonitorBuffer} from '../../shared/monitor-memory';
import {formatDateTime,useDateTimeSettings} from '../lib/date-time';
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Trash2, Search, Copy, Check, Maximize2, Minimize2, ChevronUp, ChevronDown, PictureInPicture2, PanelBottom, PanelRight } from 'lucide-react';
import { confirmDialog } from '../lib/confirm-dialog';
import { useAppStore } from '../stores/appStore';
import { useT } from '../i18n';
import { messageMonitorRecords } from '../../shared/monitor-navigation';
import { copyMarkdown } from '../lib/clipboard';
import { isAiReviewRecord, monitorModeLabel } from '../../shared/monitor-engine';
import type {
  MonitorRecord,
  MonitorEventPayload,
  MonitorSource,
  MonitorMode,
  MonitorStatus,
} from '../../shared/types';

interface Props {
  onClose: () => void;
}

/** 接口调用成功率曲线（header 迷你 sparkline）：按数据时间范围分 30 个时间桶，
 * 每桶统计已完成调用（success/error/aborted）的成功率；不足 2 条完成记录时不渲染。
 * 曲线始终基于全量 records（不受列表筛选影响），反映当前数据源的整体健康度。 */
function SuccessRateSpark({ records, label }: { records: MonitorRecord[]; label: string }) {
  const { line, area, rate, total } = useMemo(() => {
    const done = records.filter((r) => r.status === 'success' || r.status === 'error' || r.status === 'aborted');
    const empty = { line: '', area: '', rate: 0, total: done.length };
    if (done.length < 2) return empty;
    const min = Math.min(...done.map((r) => r.ts));
    const max = Math.max(...done.map((r) => r.ts));
    const BUCKETS = 30;
    const span = Math.max(1, max - min);
    const buckets = new Map<number, { ok: number; all: number }>();
    for (const r of done) {
      const b = Math.min(BUCKETS - 1, Math.floor(((r.ts - min) / span) * BUCKETS));
      const cur = buckets.get(b) ?? { ok: 0, all: 0 };
      cur.all += 1;
      if (r.status === 'success') cur.ok += 1;
      buckets.set(b, cur);
    }
    // viewBox 0..100 × 0..30，y 上下各留 1px 防止描边裁切；空桶不出点，线按时间比例稀疏连线
    const pts = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([b, { ok, all }]) => [((b / (BUCKETS - 1)) * 100).toFixed(2), (29 - (ok / all) * 28).toFixed(2)] as const);
    const okAll = done.reduce((n, r) => n + (r.status === 'success' ? 1 : 0), 0);
    return {
      line: pts.map(([x, y]) => `${x},${y}`).join(' '),
      area: `M${pts[0][0]},30 L${pts.map(([x, y]) => `${x},${y}`).join(' L')} L${pts[pts.length - 1][0]},30 Z`,
      rate: okAll / done.length,
      total: done.length,
    };
  }, [records]);
  if (!line) return null;
  return (
    <span className="monitor-spark" title={`${label} · ${(rate * 100).toFixed(1)}% · ${total}`}>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={`${label} ${(rate * 100).toFixed(0)}%`}>
        <path className="spark-area" d={area} />
        <polyline className="spark-line" points={line} vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  );
}

type SourceFilter = MonitorSource | 'all';
type ModeFilter = MonitorMode | 'all';
type StatusFilter = MonitorStatus | 'all';
type DetailTab = 'context' | 'request' | 'response' | 'raw' | 'usage';

const SOURCE_OPTIONS: SourceFilter[] = ['all', 'conversation', 'spec', 'loop', 'wiki', 'image', 'other'];
const MODE_OPTIONS: ModeFilter[] = ['all', 'api', 'cli', 'sdk'];
const STATUS_OPTIONS: StatusFilter[] = ['all', 'pending', 'success', 'error', 'aborted'];

/**
 * 请求监控器全屏视图：实时展示所有对底层 Claude 的请求 / 响应，
 * 帮助在 Vibe Coding 时审查 Context。数据来自主进程内存环形缓冲 +
 * .sage/monitor 持久化日志。
 */
export function RequestMonitor({ onClose }: Props) {
  useDateTimeSettings();
  const t = useT();
  const currentProject = useAppStore((s) => s.currentProject);
  const target = useAppStore((s) => s.monitorTarget);
  const monitorLayout = useAppStore((s) => s.monitorLayout);
  const setMonitorLayout = useAppStore((s) => s.setMonitorLayout);
  // 全屏放大：提升到 store，供浮动窗口标题栏双击共用
  const fullscreen = useAppStore((s) => s.monitorFullscreen);
  const setFullscreen = useAppStore((s) => s.setMonitorFullscreen);
  const [records, setRecords] = useState<MonitorRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [tab, setTab] = useState<DetailTab>('context');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [scopeCurrent, setScopeCurrent] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const locatedRef = useRef<number>();

  // 用 Map 维护，按 id 去重合并 add / update 事件。
  const mapRef = useRef(createMonitorBuffer());
  // 列表容器 + 是否吸顶（用户是否停留在顶部，决定新记录到来时是否自动滚到最新）。
  const listRef = useRef<HTMLDivElement>(null);
  const stickTopRef = useRef(true);

  const commit = () => {
    const arr = Array.from(mapRef.current.values()).sort((a, b) => b.ts - a.ts);
    setRecords(arr);
  };

  // 初始加载：内存记录 + 当前项目持久化记录，然后订阅实时事件。
  useEffect(() => {
    let disposed = false;
    setLoaded(false);
    (async () => {
      const list = (await window.api.listMonitor()) as MonitorRecord[];
      if (disposed) return;
      for (const r of list) mapRef.current.set(r.id, r);
      if (currentProject) {
        try {
          const persisted = (await window.api.loadMonitorProject(currentProject.path)) as MonitorRecord[];
          if (disposed) return;
          for (const r of persisted) {
            if (!mapRef.current.has(r.id)) mapRef.current.set(r.id, r);
          }
        } catch {
          /* ignore */
        }
      } else {
        // 没有当前项目 = 默认全项目检索：合并所有已登记项目的落盘记录（主进程已去重）
        try {
          const all = (await window.api.loadMonitorAll()) as MonitorRecord[];
          if (disposed) return;
          for (const r of all) {
            if (!mapRef.current.has(r.id)) mapRef.current.set(r.id, r);
          }
        } catch {
          /* ignore */
        }
      }
      if (!disposed) { commit(); setLoaded(true); }
    })();

    const unsub = window.api.onMonitor((evt: MonitorEventPayload) => {
      if (evt.kind === 'clear') {
        if (!evt.projectPath) {
          mapRef.current.clear();
        } else {
          for (const [id, r] of mapRef.current) {
            if (r.projectPath === evt.projectPath) mapRef.current.delete(id);
          }
        }
        commit();
        return;
      }
      if (evt.record) {
        mapRef.current.set(evt.record.id, evt.record);
        commit();
      }
    });

    return () => {
      disposed = true;
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.path]);

  const linked = useMemo(() => target ? messageMonitorRecords(records, target) : undefined, [records,target]);
  useEffect(() => {
    if (!target) return;
    setSearch(''); setSourceFilter('all'); setModeFilter('all'); setStatusFilter('all'); setScopeCurrent(false); setSelectedId(undefined);
    locatedRef.current = undefined;
  }, [target]);
  useEffect(() => {
    if (!target || !linked?.exact || locatedRef.current === target.requestedAt) return;
    const newest = [...linked.records].sort((a,b) => b.ts-a.ts)[0];
    if (newest) { setSelectedId(newest.id); locatedRef.current=target.requestedAt; stickTopRef.current=false; }
  }, [target,linked]);
  useEffect(() => { if (selectedId) listRef.current?.querySelector('.monitor-row.active')?.scrollIntoView({block:'nearest'}); }, [selectedId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (linked?.records ?? records).filter((r) => {
      if (scopeCurrent && currentProject && r.projectPath !== currentProject.path) return false;
      if (sourceFilter !== 'all' && r.source !== sourceFilter) return false;
      if (modeFilter !== 'all' && r.mode !== modeFilter) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (q) {
        const hay = `${r.label ?? ''} ${r.model ?? ''} ${r.engineName ?? ''} ${r.engineId ?? ''} ${r.request?.prompt ?? ''} ${r.response?.text ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [records, linked, scopeCurrent, currentProject, sourceFilter, modeFilter, statusFilter, search]);

  const selected = useMemo(
    () => filtered.find((r) => r.id === selectedId) ?? records.find((r) => r.id === selectedId),
    [filtered, records, selectedId],
  );

  // 新记录到来时若用户仍停留在顶部，则自动滚到最新（列表按时间倒序，最新在最上）。
  const newestId = filtered[0]?.id;
  useEffect(() => {
    if (stickTopRef.current && listRef.current) listRef.current.scrollTop = 0;
  }, [newestId]);

  const handleClear = async () => {
    const scope = scopeCurrent && currentProject ? currentProject.path : undefined;
    // 二次确认：区分「当前项目」与「全部」两种清空范围。
    const confirmMsg = scope ? t('monitor.clearConfirm') : t('monitor.clearConfirmAll');
    if (!(await confirmDialog({ message: confirmMsg, danger: true }))) return;
    await window.api.clearMonitor(scope);
    // clear 事件会回推，这里无需手动更新。
  };

  return (
    <div className={`request-monitor-view${fullscreen ? ' fullscreen' : ''}`}>
      {target ? <div className="monitor-header"><span className="muted small">{t(linked?.exact || !loaded ? 'monitor.messageScope' : 'monitor.messageMissing')}</span><button className="btn-ghost" onClick={() => useAppStore.setState({monitorTarget:undefined})}>{t('monitor.clearMessageScope')}</button></div> : null}
      <div className="monitor-header">
        <div className="monitor-header-left">
          <h2>{t('monitor.title')}</h2>
          <span className="muted small">{t('monitor.count', { count: filtered.length })}</span>
          <SuccessRateSpark records={records} label={t('monitor.successRate')} />
        </div>
        <div className="monitor-header-actions">
          <label className="monitor-scope-toggle" title={currentProject ? t('monitor.scopeHint') : `${t('monitor.scopeHint')} · ${t('monitor.allProjectsHint')}`}>
            <input
              type="checkbox"
              checked={scopeCurrent && !!currentProject}
              onChange={(e) => setScopeCurrent(e.target.checked)}
              disabled={!currentProject}
            />
            <span>{t('monitor.scopeCurrent')}</span>
          </label>
          <button className="btn-ghost small" onClick={handleClear} title={t('monitor.clear')}>
            <Trash2 size={14} /> <span className="monitor-clear-label">{t('monitor.clear')}</span>
          </button>
          {/* 展示方式切换：浮动窗口 / 右栏下面 / 右栏右边（现状 dock） */}
          <div className="monitor-layout-switch" role="group" aria-label={t('monitor.layout.group')}>
            <button
              type="button"
              className={`icon-btn${monitorLayout === 'float' ? ' active' : ''}`}
              onClick={() => setMonitorLayout('float')}
              title={t('monitor.layout.float')}
              aria-pressed={monitorLayout === 'float'}
            ><PictureInPicture2 size={14} /></button>
            <button
              type="button"
              className={`icon-btn${monitorLayout === 'bottom' ? ' active' : ''}`}
              onClick={() => setMonitorLayout('bottom')}
              title={t('monitor.layout.bottom')}
              aria-pressed={monitorLayout === 'bottom'}
            ><PanelBottom size={14} /></button>
            <button
              type="button"
              className={`icon-btn${monitorLayout === 'right' ? ' active' : ''}`}
              onClick={() => setMonitorLayout('right')}
              title={t('monitor.layout.right')}
              aria-pressed={monitorLayout === 'right'}
            ><PanelRight size={14} /></button>
          </div>
          <button
            className="icon-btn"
            onClick={() => setFullscreen(!fullscreen)}
            title={fullscreen ? t('monitor.exitFullscreen') : t('monitor.fullscreen')}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="icon-btn" onClick={onClose} title={t('common.close')}>
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="monitor-filters">
        <div className="monitor-search">
          <Search size={13} />
          <input
            type="text"
            value={search}
            placeholder={t('monitor.search')}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <FilterSelect
          label={t('monitor.filter.source')}
          value={sourceFilter}
          options={SOURCE_OPTIONS}
          render={(v) => (v === 'all' ? t('monitor.all') : t(`monitor.source.${v}`))}
          onChange={(v) => setSourceFilter(v as SourceFilter)}
        />
        <FilterSelect
          label={t('monitor.filter.mode')}
          value={modeFilter}
          options={MODE_OPTIONS}
          render={(v) => (v === 'all' ? t('monitor.all') : t(`monitor.mode.${v}`))}
          onChange={(v) => setModeFilter(v as ModeFilter)}
        />
        <FilterSelect
          label={t('monitor.filter.status')}
          value={statusFilter}
          options={STATUS_OPTIONS}
          render={(v) => (v === 'all' ? t('monitor.all') : t(`monitor.status.${v}`))}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
        />
      </div>

      <div className="monitor-body">
        <div
          className="monitor-list"
          ref={listRef}
          onScroll={(e) => {
            stickTopRef.current = (e.target as HTMLDivElement).scrollTop <= 40;
          }}
        >
          {filtered.length === 0 ? (
            <p className="muted monitor-empty">{t('monitor.empty')}</p>
          ) : (
            filtered.map((r) => (
              <button
                key={r.id}
                className={`monitor-row ${r.id === selectedId ? 'active' : ''}`}
                onClick={(e) => {
                  setSelectedId(r.id);
                  // 定位：把点击的这条滚动到可视区域内。
                  e.currentTarget.scrollIntoView({ block: 'nearest' });
                }}
              >
                <div className="monitor-row-top">
                  <span className={`monitor-badge src-${r.source}`}>{t(`monitor.source.${r.source}`)}</span>
                  <span className={`monitor-badge mode-${r.mode}`} title={r.engineId}>{monitorModeLabel(r, t)}</span>
                  {isAiReviewRecord(r) && <span className="monitor-badge ai-review">{t('monitor.purpose.aiReview')}</span>}
                  <span className={`monitor-badge status-${r.status}`}>{t(`monitor.status.${r.status}`)}</span>
                  {typeof r.request?.iteration === 'number' && (
                    <span className="monitor-badge iter">#{r.request.iteration}</span>
                  )}
                </div>
                <div className="monitor-row-label">{r.label || r.model || r.id}</div>
                <div className="monitor-row-meta muted small">
                  <span>{formatTime(r.ts)}</span>
                  {typeof r.durationMs === 'number' && <span>{formatDuration(r.durationMs)}</span>}
                  {r.usage && (
                    <span>
                      {r.usage.inputTokens}↑ / {r.usage.outputTokens}↓
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="monitor-detail">
          {!selected ? (
            <p className="muted monitor-empty">{t('monitor.selectHint')}</p>
          ) : (
            <>
              <div className="monitor-tabs">
                {(['context', 'request', 'response', 'raw', 'usage'] as DetailTab[]).map((tk) => (
                  <button
                    key={tk}
                    className={`monitor-tab ${tab === tk ? 'active' : ''}`}
                    onClick={() => setTab(tk)}
                  >
                    {t(`monitor.tab.${tk}`)}
                  </button>
                ))}
              </div>
              <div className="monitor-detail-body">
                {tab === 'context' && <ContextPanel rec={selected} t={t} />}
                {tab === 'request' && <JsonBlock value={selected.request} />}
                {tab === 'response' && (
                  selected.error ? (
                    <div className="monitor-copy-wrap">
                      <div className="monitor-copy-actions">
                        <CopySelectionButton />
                        <CopyButton text={selected.error} />
                      </div>
                      <ErrorBlock text={selected.error} />
                    </div>
                  ) : (
                    <JsonBlock value={selected.response ?? {}} />
                  )
                )}
                {tab === 'usage' && <JsonBlock value={selected.usage ?? {}} />}
                {tab === 'raw' && <RawPanel rec={selected} t={t} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ContextPanel({ rec, t }: { rec: MonitorRecord; t: (k: string, v?: Record<string, string | number>) => string }) {
  useDateTimeSettings();
  const providerName = useProviderName(rec);
  // 出/入数据大小：直接对逻辑层 request / response 序列化后取长度。
  // 入 = 发给模型的数据（system + messages + tools 等）；出 = 模型返回（文本 + 工具调用等）。
  // 渲染层现算，无需主进程改动，旧记录同样可用。
  const inputSize = useMemo(() => jsonSize(rec.request), [rec.request]);
  const outputSize = useMemo(() => {
    if (rec.error) return rec.error.length;
    return jsonSize(rec.response);
  }, [rec.response, rec.error]);

  const rows: Array<[string, string]> = [
    [t('monitor.field.source'), t(`monitor.source.${rec.source}`)],
    [t('monitor.field.mode'), monitorModeLabel(rec, t)],
    [t('monitor.field.status'), t(`monitor.status.${rec.status}`)],
    [t('monitor.field.inputSize'), inputSize > 0 ? formatBytes(inputSize) : '—'],
    [t('monitor.field.outputSize'), outputSize > 0 ? formatBytes(outputSize) : '—'],
    [t('monitor.field.label'), rec.label ?? '—'],
    [t('monitor.field.model'), rec.model ? (providerName ? `${providerName}｜${rec.model}` : rec.model) : '—'],
    [t('monitor.field.time'), formatDateTime(rec.ts)],
    [t('monitor.field.duration'), typeof rec.durationMs === 'number' ? formatDuration(rec.durationMs) : '—'],
    [t('monitor.field.project'), rec.projectPath ?? '—'],
  ];
  if (typeof rec.request?.iteration === 'number') {
    rows.push([t('monitor.field.iteration'), String(rec.request.iteration)]);
  }
  return (
    <div className="monitor-context">
      {rows.map(([k, v]) => (
        <div className="monitor-context-row" key={k}>
          <span className="monitor-context-key muted small">{k}</span>
          <span className="monitor-context-val">{v}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 推导该请求实际承载的提供商名（上下文页「提供商｜模型」展示用）：
 * 1. 原始请求 URL 与各提供商 baseUrl 最长前缀匹配（复合类型命中真实成员）；
 * 2. 中继站点 origin 匹配中继提供商；
 * 3. 兜底按模型名归属（旧记录 / CLI 模式无原始 URL）。
 */
function useProviderName(rec: MonitorRecord): string {
  const providers = useAppStore((s) => s.settings?.modelProviders);
  const relayUrl = useAppStore((s) => s.settings?.relayUrl);
  const relayHook = useAppStore((s) => s.settings?.relayHookBaseUrl);
  return useMemo(() => {
    const list = providers ?? [];
    const url = rec.rawRequest?.url ?? '';
    if (url) {
      let best = '';
      let bestLen = 0;
      for (const p of list) {
        const base = (p.baseUrl ?? '').replace(/\/+$/, '');
        if (base && url.startsWith(base) && base.length > bestLen) {
          best = p.name;
          bestLen = base.length;
        }
      }
      if (best) return best;
      try {
        const origin = new URL(url).origin;
        for (const hook of [relayHook, relayUrl]) {
          if (!hook) continue;
          try {
            if (new URL(hook.replace(/\/+$/, '')).origin === origin) return list.find((p) => p.kind === 'relay')?.name ?? '';
          } catch {
            /* 忽略非法配置 */
          }
        }
      } catch {
        /* 忽略非法 URL */
      }
    }
    const model = rec.model ?? '';
    if (!model) return '';
    return list.find((p) => p.models?.includes(model) || p.relayModels?.some((m) => m.id === model))?.name ?? '';
  }, [rec, providers, relayUrl, relayHook]);
}

/** 把任意值序列化后取长度（字符数 ≈ 字节数，足够做量级展示）。失败返回 0。 */
function jsonSize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** 字节数格式化：B / KB / MB，保留 1 位小数。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Raw 页签：展示真实 HTTP 请求/响应的原始数据（URL / headers / body）。
 *  面板顶部提供「整体复制」：请求 + 响应合并为一份 JSON 一次性复制；
 *  每个 section 内还提供完整复制 / 复制选中（选择部分文本后复制）。 */
function RawPanel({ rec, t }: { rec: MonitorRecord; t: (k: string, v?: Record<string, string | number>) => string }) {
  // 一键复制：请求 + 响应合并为一份 JSON，方便整段粘贴排查。
  const combined = useMemo(() => {
    try {
      const obj: Record<string, unknown> = {};
      if (rec.rawRequest) obj.request = rec.rawRequest;
      if (rec.rawResponse) obj.response = rec.rawResponse;
      return JSON.stringify(obj, null, 2);
    } catch {
      return '';
    }
  }, [rec.rawRequest, rec.rawResponse]);

  if (!rec.rawRequest && !rec.rawResponse) {
    return <p className="muted monitor-empty">{t('monitor.raw.none')}</p>;
  }
  return (
    <div className="monitor-raw">
      <div className="monitor-raw-header">
        <CopyButton text={combined} label={t('monitor.raw.copyAll')} />
      </div>
      {rec.rawRequest && (
        <section className="monitor-raw-section">
          <h4 className="monitor-raw-title">{t('monitor.raw.request')}</h4>
          <JsonBlock value={rec.rawRequest} />
        </section>
      )}
      {rec.rawResponse && (
        <section className="monitor-raw-section">
          <h4 className="monitor-raw-title">{t('monitor.raw.response')}</h4>
          <JsonBlock value={rec.rawResponse} />
        </section>
      )}
    </div>
  );
}

/** ErrorBlock：纯文本错误展示，带搜索高亮（复用 JsonBlock 的搜索逻辑）。 */
function ErrorBlock({ text }: { text: string }) {
  // 复用 JsonBlock，传入 showCopy=false（复制按钮已在外层）
  return <JsonBlock value={text} showCopy={false} />;
}

function JsonBlock({ value, showCopy = true }: { value: unknown; showCopy?: boolean }) {
  const t = useT();
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);

  // ── 详情内搜索：在渲染后的 <pre> DOM 中高亮匹配 ──
  const [detailSearch, setDetailSearch] = useState('');
  const [detailSearchOpen, setDetailSearchOpen] = useState(false);
  const [matchIdx, setMatchIdx] = useState(0);
  const preRef = useRef<HTMLPreElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 搜索高亮：TreeWalker 遍历文本节点，拆分插入 <mark>
  useEffect(() => {
    const pre = preRef.current;
    if (!pre) return;
    // 先清除之前的 highlight
    pre.querySelectorAll('mark.monitor-search-hit').forEach((m) => {
      const parent = m.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(m.textContent || ''), m);
        parent.normalize();
      }
    });

    const q = detailSearch.trim();
    if (!q) { setMatchIdx(0); return; }

    // 简单转义
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch);
    let re: RegExp;
    try {
      re = new RegExp(escaped, 'gi');
    } catch {
      setMatchIdx(0);
      return;
    }

    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) textNodes.push(n as Text);

    let currentIdx = 0;
    for (const textNode of textNodes) {
      const text = textNode.textContent || '';
      re.lastIndex = 0;
      const newMatches: Array<{ start: number; end: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        newMatches.push({ start: m.index, end: m.index + m[0].length });
      }
      if (newMatches.length === 0) continue;

      const range = document.createRange();
      range.selectNodeContents(textNode);
      const frag = document.createDocumentFragment();
      let lastEnd = 0;
      for (const match of newMatches) {
        if (match.start > lastEnd) {
          frag.appendChild(document.createTextNode(text.slice(lastEnd, match.start)));
        }
        const mark = document.createElement('mark');
        mark.className = `monitor-search-hit${currentIdx === 0 ? ' current' : ''}`;
        mark.textContent = text.slice(match.start, match.end);
        mark.dataset.searchIdx = String(currentIdx);
        frag.appendChild(mark);
        currentIdx++;
        lastEnd = match.end;
      }
      if (lastEnd < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastEnd)));
      }
      range.deleteContents();
      range.insertNode(frag);
    }

    // 滚动到第一个匹配
    if (currentIdx > 0) {
      const firstMark = pre.querySelector('mark.monitor-search-hit.current');
      firstMark?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setMatchIdx(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailSearch, text]);

  const totalMatches = useMemo(() => {
    if (!detailSearch.trim()) return 0;
    const pre = preRef.current;
    if (!pre) return 0;
    return pre.querySelectorAll('mark.monitor-search-hit').length;
  }, [detailSearch, text]);

  // 跳转到指定匹配
  const gotoMatch = (idx: number) => {
    const pre = preRef.current;
    if (!pre) return;
    const marks = pre.querySelectorAll('mark.monitor-search-hit');
    if (marks.length === 0) return;
    const wrapped = ((idx % marks.length) + marks.length) % marks.length;
    setMatchIdx(wrapped);
    marks.forEach((m) => m.classList.remove('current'));
    const el = marks[wrapped];
    el.classList.add('current');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="monitor-copy-wrap">
      <div className="monitor-copy-actions">
        <button
          className="monitor-copy-btn"
          onClick={() => {
            setDetailSearchOpen(!detailSearchOpen);
            setTimeout(() => searchInputRef.current?.focus(), 50);
          }}
          title={t('monitor.detailSearchTitle')}
        >
          <Search size={13} />
        </button>
        {showCopy && <CopySelectionButton />}
        {showCopy && <CopyButton text={text} />}
      </div>
      {detailSearchOpen && (
        <div className="monitor-detail-search-bar">
          <Search size={12} className="monitor-search-icon" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder={t('monitor.detailSearchPlaceholder')}
            value={detailSearch}
            spellCheck={false}
            onChange={(e) => setDetailSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                gotoMatch(matchIdx + (e.shiftKey ? -1 : 1));
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDetailSearchOpen(false);
                setDetailSearch('');
              }
            }}
          />
          <span className="muted small">
            {detailSearch ? (totalMatches === 0 ? t('monitor.noMatch') : `${matchIdx + 1}/${totalMatches}`) : ''}
          </span>
          <button className="monitor-copy-btn" title={t('monitor.prevMatch')} onClick={() => gotoMatch(matchIdx - 1)} disabled={totalMatches === 0}>
            <ChevronUp size={13} />
          </button>
          <button className="monitor-copy-btn" title={t('monitor.nextMatch')} onClick={() => gotoMatch(matchIdx + 1)} disabled={totalMatches === 0}>
            <ChevronDown size={13} />
          </button>
          <button className="monitor-copy-btn" title={t('monitor.closeSearch')} onClick={() => { setDetailSearchOpen(false); setDetailSearch(''); }}>
            <X size={13} />
          </button>
        </div>
      )}
      <pre ref={preRef} className={`monitor-json${typeof value === 'string' ? ' monitor-error' : ''}`}>{text}</pre>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const onCopy = async () => {
    try {
      if (!await copyMarkdown(text)) { setCopyFailed(true); setTimeout(() => setCopyFailed(false), 1800); return; }
      setCopyFailed(false); setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyFailed(true); setTimeout(() => setCopyFailed(false), 1800);
    }
  };
  const btnLabel = copyFailed ? t('common.copyFailed') : label ?? t('monitor.copy');
  return (
    <button
      className="monitor-copy-btn"
      onClick={onCopy}
      title={copyFailed ? t('common.copyFailed') : copied ? t('monitor.copied') : btnLabel}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      <span>{copied ? t('monitor.copied') : btnLabel}</span>
    </button>
  );
}

/**
 * 复制选中：复制用户在详情区选中的部分文本。
 * onMouseDown preventDefault 防止点击按钮时选区被清除。
 */
function CopySelectionButton() {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'empty' | 'failed'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const flash = (s: 'copied' | 'empty' | 'failed') => {
    setState(s);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState('idle'), 1500);
  };
  const onCopy = async () => {
    const sel = (window.getSelection()?.toString() ?? '').trim();
    if (!sel) {
      flash('empty');
      return;
    }
    try {
      if (!await copyMarkdown(sel)) { flash('failed'); return; }
      flash('copied');
    } catch {
      flash('failed');
    }
  };
  const label =
    state === 'copied' ? t('monitor.copied')
    : state === 'empty' ? t('monitor.noSelection')
    : state === 'failed' ? t('common.copyFailed')
    : t('monitor.copySelected');
  return (
    <button
      className="monitor-copy-btn"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onCopy}
      title={t('monitor.copySelectedHint')}
    >
      {state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
      <span>{label}</span>
    </button>
  );
}

function FilterSelect({
  label,
  value,
  options,
  render,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  render: (v: string) => string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="monitor-filter-select">
      <span className="muted small">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {render(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatTime(ts: number): string { return formatDateTime(ts); }

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
