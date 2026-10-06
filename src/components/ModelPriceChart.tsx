import { useState } from 'react';
import { useT } from '../i18n';

type Quote = { input: number | null; output: number | null; cacheRead: number | null };
export type ChartPrice = Quote & { history?: Array<Quote & { date: string }> };
const fields = ['input', 'output', 'cacheRead'] as const;
const classes = ['price-input', 'price-output', 'price-cache'];
export function ModelPriceChart({ price, date, compact = false }: { price?: ChartPrice; date?: string | null; compact?: boolean }) {
  const t = useT();
  const [pointTip, setPointTip] = useState<{ x: number; y: number; label: string; date: string; value: number }>();
  const labels = [t('probeReport.priceInput'), t('probeReport.priceOutput'), t('probeReport.priceCacheRead')];
  const history = (price?.history ?? []).filter(p => Number.isFinite(Date.parse(p.date)) && fields.some(f => Number.isFinite(p[f])))
    .slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  // A current quote is a single observation, not an invented price history.
  const points = history.length ? history : price ? [{ ...price, date: date ?? '' }] : [];
  const values = points.flatMap(p => fields.map(f => p[f])).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const max = Math.max(...values, 0.000001);
  const first = Date.parse(points[0]?.date), last = Date.parse(points.at(-1)?.date ?? '');
  const x = (i: number) => points.length > 1 && last > first ? 52 + (Date.parse(points[i].date) - first) / (last - first) * 260 : 182;
  const y = (value: number) => (compact ? 34 : 112) - value / max * (compact ? 28 : 88);
  const format = (v: number | null | undefined) => typeof v === 'number' && Number.isFinite(v) ? `$${Number(v.toPrecision(5))}` : '—';
  const tipWidth = 194, tipHeight = 21;
  const tipX = pointTip ? Math.max(2, Math.min(328 - tipWidth, pointTip.x + tipWidth + 8 > 328 ? pointTip.x - tipWidth - 8 : pointTip.x + 8)) : 0;
  const tipY = pointTip ? compact ? Math.max(2, Math.min(52 - tipHeight - 2, pointTip.y + 6)) : Math.max(2, Math.min(144 - tipHeight - 2, pointTip.y < 38 ? pointTip.y + 6 : pointTip.y - tipHeight - 6)) : 0;
  return <>
    {values.length ? <svg className="model-price-chart" viewBox={`0 0 330 ${compact ? 52 : 144}`} role="img" aria-label={t('probeReport.priceChart')}>
      {[0, 0.5, 1].map(r => <g key={r}><line x1="52" x2="312" y1={y(max*r)} y2={y(max*r)} className="price-grid"/><text x="47" y={y(max*r)+3} textAnchor="end">{Number((max*r).toPrecision(3))}</text></g>)}
      {fields.map((field, f) => <g key={field} className={classes[f]}>
        {points.map((p, i) => Number.isFinite(p[field]) ? <g key={`${p.date}-${i}`}>
          {i > 0 && Number.isFinite(points[i-1][field]) && <line x1={x(i-1)} y1={y(points[i-1][field]!)} x2={x(i)} y2={y(p[field]!)} className="price-series"/>}
          <circle cx={x(i)} cy={y(p[field]!)} r="4" fill="currentColor" tabIndex={0} aria-label={`${labels[f]} · ${p.date || t('probeReport.priceCurrent')} · ${format(p[field])} ${t('probeReport.priceUnit')}`} onMouseEnter={() => setPointTip({ x: x(i), y: y(p[field]!), label: labels[f], date: p.date || t('probeReport.priceCurrent'), value: p[field]! })} onMouseLeave={() => setPointTip(undefined)} onFocus={() => setPointTip({ x: x(i), y: y(p[field]!), label: labels[f], date: p.date || t('probeReport.priceCurrent'), value: p[field]! })} onBlur={() => setPointTip(undefined)}>
            <title>{`${labels[f]} · ${p.date || t('probeReport.priceCurrent')} · ${format(p[field])} ${t('probeReport.priceUnit')}`}</title>
          </circle>
      </g> : null)}
      </g>)}
      {pointTip && <g className="model-price-point-tooltip" pointerEvents="none"><rect x={tipX} y={tipY} width={tipWidth} height={tipHeight} rx="4"/><text x={tipX+7} y={tipY+14}>{`${pointTip.date} · ${pointTip.label} ${format(pointTip.value)}`}</text></g>}
      <text x={points.length > 1 ? 52 : 182} y={compact ? 48 : 136} textAnchor={points.length > 1 ? 'start' : 'middle'}>{points[0].date || t('probeReport.priceCurrent')}</text>
      {points.length > 1 && <text x="312" y={compact ? 48 : 136} textAnchor="end">{points.at(-1)!.date}</text>}
    </svg> : <p className="muted">{t('probeReport.priceEmpty')}</p>}
    <div className="model-probe-price-legend">{fields.map((field, i) => <span key={field} className={classes[i]}>{labels[i]} {format(price?.[field])}</span>)}</div>
    <small>{t('probeReport.priceUnit')}{history.length < 2 ? ` · ${t('probeReport.priceSingle')}` : ''}</small>
  </>;
}
