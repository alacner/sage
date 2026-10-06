import { useEffect, useMemo, useState } from 'react';
import { FileSearch } from 'lucide-react';
import { useT } from '../i18n';
import { formatDateTime } from '../lib/date-time';
import { contextAuditEnumLabel, contextAuditModeLabel, contextAuditSummaryLabel } from '../lib/context-audit-labels';
import type { ContextCompactionAudit } from '../../shared/types';

/** 主进程返回的按对话分桶的审计数据。 */
interface ConvBucket {
  convId: string;
  convTitle: string;
  projectPath: string;
  audits: ContextCompactionAudit[];
}

interface AuditRow {
  convId: string;
  convTitle: string;
  audit: ContextCompactionAudit;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function countBy(rows: AuditRow[], key: (r: AuditRow) => string): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()];
}

/** 横向条形图：标签 + 条 + 数值；wide 用于长文本标签（如对话标题）。 */
function BarChart({ title, data, labelOf, wide }: {
  title: string;
  data: Array<[string, number]>;
  labelOf?: (k: string) => string;
  wide?: boolean;
}) {
  const max = Math.max(1, ...data.map((d) => d[1]));
  return (
    <div className={`ctx-audit-chart${wide ? ' wide' : ''}`}>
      <div className="ctx-audit-chart-title">{title}</div>
      {data.length === 0 ? (
        <div className="muted small">—</div>
      ) : data.map(([k, v]) => (
        <div className={`ctx-audit-chart-row${wide ? ' wide' : ''}`} key={k}>
          <span className="ctx-audit-chart-label" title={k}>{labelOf ? labelOf(k) : k}</span>
          <div className="ctx-audit-chart-bar"><div style={{ width: `${(v / max) * 100}%` }} /></div>
          <span className="ctx-audit-chart-value">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** 竖向柱状图：近 N 天趋势。 */
function DayChart({ title, data }: { title: string; data: Array<[string, number]> }) {
  const max = Math.max(1, ...data.map((d) => d[1]));
  return (
    <div className="ctx-audit-chart">
      <div className="ctx-audit-chart-title">{title}</div>
      <div className="ctx-audit-daychart">
        {data.map(([day, v], i) => (
          <div className="ctx-audit-daycol" key={day} title={`${day}: ${v}`}>
            <div className="ctx-audit-daybar" style={{ height: `${v > 0 ? Math.max(8, (v / max) * 100) : 2}%`, opacity: v > 0 ? 1 : 0.25 }} />
            {/* 隔日显示日期，避免 14 列标签挤叠在一起 */}
            <span className="ctx-audit-daylabel">{i % 2 === 1 ? day.slice(5) : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 上下文整理记录查看器（以独立 tab 面板打开）。
 * 跨项目/跨对话汇总全部整理审计，支持按对话/触发方式/压缩模式/摘要策略
 * 筛选，并提供各维度统计图与明细列表。
 */
export function ContextAuditViewer() {
  const t = useT();
  const [buckets, setBuckets] = useState<ConvBucket[] | null>(null);
  const [convFilter, setConvFilter] = useState('all');
  const [triggerFilter, setTriggerFilter] = useState('all');
  const [modeFilter, setModeFilter] = useState('all');
  const [strategyFilter, setStrategyFilter] = useState('all');

  // 以 tab 面板形式挂载：挂载即拉取跨项目/跨对话审计数据。
  useEffect(() => {
    let alive = true;
    window.api.contextAuditList?.()
      .then((rows: ConvBucket[]) => { if (alive) setBuckets(rows ?? []); })
      .catch(() => { if (alive) setBuckets([]); });
    return () => { alive = false; };
  }, []);

  const rows = useMemo<AuditRow[]>(() => {
    const out: AuditRow[] = [];
    for (const b of buckets ?? []) {
      for (const a of b.audits) out.push({ convId: b.convId, convTitle: b.convTitle, audit: a });
    }
    out.sort((x, y) => (x.audit.at < y.audit.at ? 1 : -1));
    return out;
  }, [buckets]);

  const filtered = useMemo(() => rows.filter((r) =>
    (convFilter === 'all' || r.convId === convFilter) &&
    (triggerFilter === 'all' || r.audit.trigger === triggerFilter) &&
    (modeFilter === 'all' || r.audit.mode === modeFilter) &&
    (strategyFilter === 'all' || r.audit.summaryStrategy === strategyFilter),
  ), [rows, convFilter, triggerFilter, modeFilter, strategyFilter]);

  const convTitleOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of buckets ?? []) map.set(b.convId, b.convTitle);
    return (id: string) => map.get(id) ?? id;
  }, [buckets]);

  const stats = useMemo(() => {
    const byTrigger = countBy(filtered, (r) => r.audit.trigger);
    const byMode = countBy(filtered, (r) => r.audit.mode).sort((a, b) => b[1] - a[1]);
    const byStrategy = countBy(filtered, (r) => r.audit.summaryStrategy).sort((a, b) => b[1] - a[1]);
    const byConv = countBy(filtered, (r) => r.convId).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const days: Array<[string, number]> = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      days.push([formatDateTime(d.toISOString(), 'YYYY-MM-DD'), 0]);
    }
    const dayMap = new Map(days);
    for (const r of filtered) {
      const k = formatDateTime(r.audit.at, 'YYYY-MM-DD');
      if (dayMap.has(k)) dayMap.set(k, (dayMap.get(k) ?? 0) + 1);
    }
    return { byTrigger, byMode, byStrategy, byConv, byDay: [...dayMap.entries()] };
  }, [filtered]);

  const triggerLabel = (k: string) => k === 'automatic' ? t('chat.contextAudit.automatic') : t('chat.contextAudit.manual');
  // 压缩模式 / 摘要策略枚举本地化（存储值保持英文 key）；筛选器与图表按单值取词
  const modeLabel = (k: string) => contextAuditEnumLabel(t, 'ctxAudit.mode', k);
  const strategyLabel = (k: string) => contextAuditEnumLabel(t, 'ctxAudit.strategy', k);

  return (
    <div className="ctx-audit-pane">
      <div className="ctx-audit-pane-inner">
        <div className="update-modal-header">
          <h2><FileSearch size={15} style={{ marginRight: 6, verticalAlign: -2 }} />{t('ctxAudit.title')}</h2>
        </div>

        <div className="ctx-audit-filters">
          <label>
            <span className="muted small">{t('ctxAudit.filterConv')}</span>
            <select value={convFilter} onChange={(e) => setConvFilter(e.target.value)}>
              <option value="all">{t('ctxAudit.all')}</option>
              {(buckets ?? []).map((b) => (
                <option key={b.convId} value={b.convId}>{b.convTitle}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="muted small">{t('ctxAudit.filterTrigger')}</span>
            <select value={triggerFilter} onChange={(e) => setTriggerFilter(e.target.value)}>
              <option value="all">{t('ctxAudit.all')}</option>
              <option value="automatic">{t('chat.contextAudit.automatic')}</option>
              <option value="manual">{t('chat.contextAudit.manual')}</option>
            </select>
          </label>
          <label>
            <span className="muted small">{t('ctxAudit.filterMode')}</span>
            <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value)}>
              <option value="all">{t('ctxAudit.all')}</option>
              {['auto', 'conservative', 'balanced', 'aggressive'].map((m) => <option key={m} value={m}>{modeLabel(m)}</option>)}
            </select>
          </label>
          <label>
            <span className="muted small">{t('ctxAudit.filterStrategy')}</span>
            <select value={strategyFilter} onChange={(e) => setStrategyFilter(e.target.value)}>
              <option value="all">{t('ctxAudit.all')}</option>
              {['auto', 'truncate', 'llm'].map((m) => <option key={m} value={m}>{strategyLabel(m)}</option>)}
            </select>
          </label>
          <span className="muted small ctx-audit-total">{t('ctxAudit.total', { count: filtered.length })}</span>
        </div>

        {buckets === null ? (
          <div className="ctx-audit-empty muted small">{t('ctxAudit.loading')}</div>
        ) : rows.length === 0 ? (
          <div className="ctx-audit-empty muted small">{t('ctxAudit.empty')}</div>
        ) : (
          <>
            <div className="ctx-audit-charts">
              <BarChart title={t('ctxAudit.chartTrigger')} data={stats.byTrigger} labelOf={triggerLabel} />
              <BarChart title={t('ctxAudit.chartMode')} data={stats.byMode} labelOf={modeLabel} />
              <BarChart title={t('ctxAudit.chartStrategy')} data={stats.byStrategy} labelOf={strategyLabel} />
              <BarChart title={t('ctxAudit.chartConv', { n: 6 })} data={stats.byConv} labelOf={convTitleOf} wide />
              <DayChart title={t('ctxAudit.chartDay')} data={stats.byDay} />
            </div>

            <div className="ctx-audit-table">
              <div className="ctx-audit-row ctx-audit-head">
                <span>{t('ctxAudit.col.time')}</span>
                <span>{t('ctxAudit.col.conv')}</span>
                <span>{t('ctxAudit.col.trigger')}</span>
                <span>{t('ctxAudit.col.mode')}</span>
                <span>{t('ctxAudit.col.strategy')}</span>
                <span>{t('ctxAudit.col.tokens')}</span>
                <span>{t('ctxAudit.col.turns')}</span>
              </div>
              {filtered.length === 0 ? (
                <div className="ctx-audit-empty muted small">{t('ctxAudit.empty')}</div>
              ) : filtered.map((r) => (
                <div className="ctx-audit-row" key={r.audit.id}>
                  <span title={r.audit.at}>{formatDateTime(r.audit.at, 'MM-DD HH:mm')}</span>
                  <span className="ctx-audit-conv" title={r.convTitle}>{r.convTitle}</span>
                  <span>{triggerLabel(r.audit.trigger)}</span>
                  <span title={`${r.audit.mode}${r.audit.resolvedMode && r.audit.resolvedMode !== r.audit.mode ? ` → ${r.audit.resolvedMode}` : ''}`}>{contextAuditModeLabel(t, r.audit)}</span>
                  <span title={`${r.audit.summaryStrategy}${r.audit.resolvedSummaryStrategy && r.audit.resolvedSummaryStrategy !== r.audit.summaryStrategy ? ` → ${r.audit.resolvedSummaryStrategy}` : ''}`}>{contextAuditSummaryLabel(t, r.audit)}</span>
                  <span>{formatTokens(r.audit.beforeEstimatedTokens ?? 0)} → {formatTokens(r.audit.afterEstimatedTokens ?? 0)}</span>
                  <span>
                    {r.audit.summarizedTurns ?? 0}
                    {(r.audit.occurrences ?? 1) > 1 ? <em className="ctx-audit-occ"> ×{r.audit.occurrences}</em> : null}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
