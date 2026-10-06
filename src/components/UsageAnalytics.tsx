import {WindowOverlay} from './WindowOverlay';
import {ActivityHeatmap} from './ActivityHeatmap';
import {formatDateTime,useDateTimeSettings} from '../lib/date-time';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Globe, LayoutGrid, Layers, BarChart3 } from 'lucide-react';
import type { ChatMessage, UsageStats, GlobalStats, ConversationMeta, ModelProvider } from '../../shared/types';
import { useAppStore } from '../stores/appStore';
import { useT, translate } from '../i18n';
import { describeModelId } from '../../shared/model-id-label';

// ═══════════════════════════════════════════════════════════════════════════════
// 类型与常量
// ═══════════════════════════════════════════════════════════════════════════════

type TimeGranularity = 'minute' | 'hour' | 'day' | 'month' | 'year';
type Dimension = 'project' | 'global';
type SubCategory = 'overview' | 'provider' | 'model';

/** 网格显示顺序（从精细到宏观） */
const GRANULARITIES: TimeGranularity[] = ['minute', 'hour', 'day', 'month', 'year'];

interface TimeSeriesPoint {
  timestamp: number;
  label: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const GRANULARITY_LABELS: Record<TimeGranularity, string> = {
  minute: 'ua.gran.minute',
  hour: 'ua.gran.hour',
  day: 'ua.gran.day',
  month: 'ua.gran.month',
  year: 'ua.gran.year',
};

/** 每个粒度的时间范围说明 */
const GRANULARITY_DESC: Record<TimeGranularity, string> = {
  minute: 'ua.granDesc.minute',
  hour: 'ua.granDesc.hour',
  day: 'ua.granDesc.day',
  month: 'ua.granDesc.month',
  year: 'ua.granDesc.year',
};

/** 每个粒度保留的数据点上限 */
const GRANULARITY_MAX_POINTS: Record<TimeGranularity, number> = {
  minute: 60,
  hour: 48,
  day: 30,
  month: 12,
  year: 20,
};

/** 每行的高度（统一减小，确保一页显示） */
const ROW_HEIGHT: Record<TimeGranularity, number> = {
  minute: 120,
  hour: 110,
  day: 110,
  month: 110,
  year: 110,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════════

/** 按 token 用量估算费用（USD）。单价参考 Claude Sonnet 定价（每百万 token）。 */
const PRICE_PER_MTOK = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
function estimateCostUsd(s: UsageStats): number {
  return (
    s.inputTokens * PRICE_PER_MTOK.input +
    s.outputTokens * PRICE_PER_MTOK.output +
    s.cacheReadTokens * PRICE_PER_MTOK.cacheRead +
    s.cacheCreationTokens * PRICE_PER_MTOK.cacheWrite
  ) / 1_000_000;
}

/**
 * 将 ISO 时间戳对齐到指定粒度的起始时间。
 */
function alignTimestamp(iso: string, granularity: TimeGranularity): number {
  const d = new Date(iso);
  switch (granularity) {
    case 'minute':
      d.setSeconds(0, 0);
      return d.getTime();
    case 'hour':
      d.setMinutes(0, 0, 0);
      return d.getTime();
    case 'day':
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    case 'month':
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    case 'year':
      d.setMonth(0, 1);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
  }
}

function formatTimestamp(ts: number, granularity: TimeGranularity): string { return formatDateTime(ts); }

/**
 * 从对话消息中提取时间序列数据（按粒度聚合，截断到 maxPoints）。
 */
function extractTimeSeries(
  conversations: Array<{ messages: ChatMessage[] }>,
  granularity: TimeGranularity,
  maxPoints: number,
): TimeSeriesPoint[] {
  const buckets = new Map<number, TimeSeriesPoint>();

  for (const conv of conversations) {
    for (const msg of conv.messages) {
      if (msg.role !== 'assistant' || !msg.usage || !msg.ts) continue;
      const ts = alignTimestamp(msg.ts, granularity);
      if (!buckets.has(ts)) {
        buckets.set(ts, {
          timestamp: ts,
          label: formatTimestamp(ts, granularity),
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        });
      }
      const point = buckets.get(ts)!;
      point.inputTokens += msg.usage.inputTokens + msg.usage.cacheReadTokens + msg.usage.cacheCreationTokens;
      point.outputTokens += msg.usage.outputTokens;
      point.costUsd += msg.usage.costUsd > 0
        ? msg.usage.costUsd
        : estimateCostUsd(msg.usage);
    }
  }

  const sorted = Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp);
  // 截断到 maxPoints（保留最新的）
  if (sorted.length > maxPoints) {
    return sorted.slice(sorted.length - maxPoints);
  }
  return sorted;
}

/**
 * 按 provider 分组提取时间序列数据。
 * 每个 provider 独立聚合每个粒度的数据。
 *
 * 统计粒度是「每次调用请求」（消息级）而非对话：
 *   归属 = msg.providerId（本轮实际产生调用的提供商）。
 *   保证同一对话中途切换提供商后，每轮归到当时的真实提供商。
 *
 * 复合类型「双算」：一条消息同时计入
 *   - 用户选中的复合维度（msg.selectedProviderId）
 *   - 实际产生调用的成员（msg.providerId）
 * 复合本身不产生真实调用，但作为一个独立的统计维度展示（带复合标注）。
 * 普通类型两者相同，不重复计入。
 */
function extractTimeSeriesByProvider(
  conversations: Array<{ messages: ChatMessage[]; providerId?: string; modelId?: string }>,
  granularity: TimeGranularity,
  maxPoints: number,
): Map<string, TimeSeriesPoint[]> {
  // provider -> timestamp -> point
  const buckets = new Map<string, Map<number, TimeSeriesPoint>>();

  const addPoint = (providerId: string, msg: ChatMessage) => {
    if (!buckets.has(providerId)) {
      buckets.set(providerId, new Map());
    }
    const providerBuckets = buckets.get(providerId)!;
    const ts = alignTimestamp(msg.ts!, granularity);
    if (!providerBuckets.has(ts)) {
      providerBuckets.set(ts, {
        timestamp: ts,
        label: formatTimestamp(ts, granularity),
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
    }
    const point = providerBuckets.get(ts)!;
    point.inputTokens += msg.usage!.inputTokens + msg.usage!.cacheReadTokens + msg.usage!.cacheCreationTokens;
    point.outputTokens += msg.usage!.outputTokens;
    point.costUsd += msg.usage!.costUsd > 0
      ? msg.usage!.costUsd
      : estimateCostUsd(msg.usage!);
  };

  for (const conv of conversations) {
    const convFallback = conv.providerId || 'unknown';

    for (const msg of conv.messages) {
      if (msg.role !== 'assistant' || !msg.usage || !msg.ts) continue;
      // 实际产生调用的提供商（复合=挑中的成员）
      const actual = msg.providerId || convFallback;
      addPoint(actual, msg);
      // 复合双算：用户选中的复合维度（与实际不同时额外计入）
      const selected = msg.selectedProviderId;
      if (selected && selected !== actual) {
        addPoint(selected, msg);
      }
    }
  }

  // 转换为 Map<providerId, TimeSeriesPoint[]>
  const result = new Map<string, TimeSeriesPoint[]>();
  for (const [providerId, providerBuckets] of buckets) {
    const sorted = Array.from(providerBuckets.values()).sort((a, b) => a.timestamp - b.timestamp);
    if (sorted.length > maxPoints) {
      result.set(providerId, sorted.slice(sorted.length - maxPoints));
    } else {
      result.set(providerId, sorted);
    }
  }
  return result;
}

/**
 * 按 model 分组提取时间序列数据。
 * 每个 model 独立聚合每个粒度的数据（忽略 providerId）。
 * 统计粒度同样是「每次调用请求」（消息级）。
 *
 * 复合类型「双算」：同时计入复合声明的模型名（msg.selectedModelId）
 * 和成员实际模型名（msg.modelId），两者相同时不重复计入。
 */
function extractTimeSeriesByModel(
  conversations: Array<{ messages: ChatMessage[]; modelId?: string }>,
  granularity: TimeGranularity,
  maxPoints: number,
): Map<string, TimeSeriesPoint[]> {
  // model -> timestamp -> point
  const buckets = new Map<string, Map<number, TimeSeriesPoint>>();

  const addPoint = (modelId: string, msg: ChatMessage) => {
    if (!buckets.has(modelId)) {
      buckets.set(modelId, new Map());
    }
    const modelBuckets = buckets.get(modelId)!;
    const ts = alignTimestamp(msg.ts!, granularity);
    if (!modelBuckets.has(ts)) {
      modelBuckets.set(ts, {
        timestamp: ts,
        label: formatTimestamp(ts, granularity),
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
    }
    const point = modelBuckets.get(ts)!;
    point.inputTokens += msg.usage!.inputTokens + msg.usage!.cacheReadTokens + msg.usage!.cacheCreationTokens;
    point.outputTokens += msg.usage!.outputTokens;
    point.costUsd += msg.usage!.costUsd > 0
      ? msg.usage!.costUsd
      : estimateCostUsd(msg.usage!);
  };

  for (const conv of conversations) {
    const convFallback = conv.modelId || 'unknown';

    for (const msg of conv.messages) {
      if (msg.role !== 'assistant' || !msg.usage || !msg.ts) continue;
      const actual = describeModelId(msg.modelId || convFallback).trim();
      addPoint(actual, msg);
      // 复合双算：复合声明的模型名（与实际不同时额外计入）
      const selected = msg.selectedModelId ? describeModelId(msg.selectedModelId).trim() : undefined;
      if (selected && selected !== actual) {
        addPoint(selected, msg);
      }
    }
  }

  // 转换为 Map<modelId, TimeSeriesPoint[]>
  const result = new Map<string, TimeSeriesPoint[]>();
  for (const [modelId, modelBuckets] of buckets) {
    const sorted = Array.from(modelBuckets.values()).sort((a, b) => a.timestamp - b.timestamp);
    if (sorted.length > maxPoints) {
      result.set(modelId, sorted.slice(sorted.length - maxPoints));
    } else {
      result.set(modelId, sorted);
    }
  }
  return result;
}

/**
 * 计算 Y 轴"漂亮"刻度（1/2/5 的倍数）
 * 返回从 0 到 niceMax 的刻度数组
 */
function computeYTicks(maxValue: number, count = 4): number[] {
  if (maxValue <= 0) return [0];
  const rough = maxValue / (count - 1);
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  let niceStep: number;
  if (norm <= 1) niceStep = pow;
  else if (norm <= 2) niceStep = 2 * pow;
  else if (norm <= 5) niceStep = 5 * pow;
  else niceStep = 10 * pow;

  const niceMax = Math.ceil(maxValue / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let v = 0; v <= niceMax; v += niceStep) {
    ticks.push(v);
    if (ticks.length > 10) break; // 安全保护
  }
  return ticks;
}

/**
 * 智能 X 轴标签抽样：根据可用宽度和最小间距决定显示哪些点。
 * 始终包含第一个和最后一个。
 */
function sampleIndices(total: number, maxLabels: number): number[] {
  if (total === 0) return [];
  if (total <= maxLabels) return Array.from({ length: total }, (_, i) => i);
  const step = (total - 1) / (maxLabels - 1);
  const indices: number[] = [];
  for (let i = 0; i < maxLabels; i++) {
    indices.push(Math.round(i * step));
  }
  // 去重（step 很小时可能重复）
  return Array.from(new Set(indices));
}

/**
 * 格式化 Y 轴数值（带单位）
 */
function formatYValue(value: number, unit: 'tokens' | 'usd'): string {
  if (unit === 'usd') {
    if (value === 0) return '$0';
    if (value >= 1) return `$${value.toFixed(2)}`;
    if (value >= 0.01) return `$${value.toFixed(3)}`;
    return `$${value.toFixed(4)}`;
  }
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SVG 路径工具
// ═══════════════════════════════════════════════════════════════════════════════

type Point = { x: number; y: number };

/**
 * 将点序列转成 Catmull-Rom → Cubic Bezier 平滑路径。
 */
function smoothPath(points: Point[], tension = 1): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[0];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? points[points.length - 1];

    const cp1x = p1.x + (p2.x - p0.x) / 6 * tension;
    const cp1y = p1.y + (p2.y - p0.y) / 6 * tension;
    const cp2x = p2.x - (p3.x - p1.x) / 6 * tension;
    const cp2y = p2.y - (p3.y - p1.y) / 6 * tension;

    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 运行维度聚合：按天汇总 Token 构成 / 调用耗时 / Turn 数
// ═══════════════════════════════════════════════════════════════════════════════

export interface DayMetrics {
  /** 当天本地零点时间戳 */
  ts: number;
  /** MM-DD 标签 */
  day: string;
  /** 缓存读取输入 */
  cacheRead: number;
  /** 缓存写入 */
  cacheWrite: number;
  /** 非缓存输入 */
  input: number;
  /** 回复输出 */
  output: number;
  /** 总 Token（四段之和） */
  total: number;
  /** Turn 数（assistant 消息条数） */
  turns: number;
  /** 出错 Turn 数 */
  errored: number;
  /** 单轮耗时样本（updatedAt - ts，毫秒） */
  durations: number[];
}

/** 按天聚合消息级 usage / 耗时 / Turn 数据（统计口径与 extractTimeSeries 一致）。 */
function buildDayMetrics(conversations: Array<{ messages: ChatMessage[] }>): DayMetrics[] {
  const buckets = new Map<number, DayMetrics>();
  for (const conv of conversations) {
    for (const msg of conv.messages) {
      if (msg.role !== 'assistant' || !msg.ts) continue;
      const ts = alignTimestamp(msg.ts, 'day');
      let b = buckets.get(ts);
      if (!b) {
        b = { ts, day: '', cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0, turns: 0, errored: 0, durations: [] };
        buckets.set(ts, b);
      }
      b.turns += 1;
      if (msg.error) b.errored += 1;
      if (msg.usage) {
        b.cacheRead += msg.usage.cacheReadTokens;
        b.cacheWrite += msg.usage.cacheCreationTokens;
        b.input += msg.usage.inputTokens;
        b.output += msg.usage.outputTokens;
      }
      if (msg.updatedAt) {
        const d = new Date(msg.updatedAt).getTime() - new Date(msg.ts).getTime();
        // 0 < d < 30min 视为有效单轮耗时样本（排除挂起/跨天异常值）
        if (d > 0 && d < 30 * 60 * 1000) b.durations.push(d);
      }
    }
  }
  const sorted = Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
  for (const b of sorted) {
    b.total = b.cacheRead + b.cacheWrite + b.input + b.output;
    b.day = formatTimestamp(b.ts, 'day');
  }
  return sorted;
}

/** 分位数（p 取 0~1）。 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round((s.length - 1) * p))];
}

/** 毫秒 → "45s" / "36m 2s" / "3h 4m" / "1d 3h"。 */
function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  return `${Math.floor(hr / 24)}d ${hr % 24}h`;
}

/** 连续活跃天数：current 截至今天（或昨天），longest 为历史最长。 */
function computeStreaks(activeDayTs: number[]): { current: number; longest: number } {
  const DAY = 86400000;
  const set = new Set(activeDayTs);
  if (set.size === 0) return { current: 0, longest: 0 };
  const sorted = Array.from(set).sort((a, b) => a - b);
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === DAY) { run++; longest = Math.max(longest, run); } else run = 1;
  }
  const today = alignTimestamp(new Date().toISOString(), 'day');
  let cursor = set.has(today) ? today : today - DAY;
  let current = 0;
  while (set.has(cursor)) { current++; cursor -= DAY; }
  return { current, longest };
}

/** 图表通用几何：固定 viewBox 宽度，左右留双 Y 轴边距。 */
const UA_W = 720;
const UA_PAD = { l: 48, r: 48, t: 16, b: 22 };

function uaLegend(items: Array<{ color: string; label: string; line?: boolean }>) {
  return (
    <div className="ua-legend">
      {items.map((it) => (
        <span key={it.label} className="ua-legend-item">
          <span className={it.line ? 'ua-legend-line' : 'ua-legend-dot'} style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** 测量容器像素宽度：SVG 按 1:1 像素渲染，保证各行图表横坐标长度与字号完全一致。 */
function useMeasureWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) setWidth(en.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

interface TipState { idx: number; px: number; py: number; lines: string[]; }

/** 图表悬停浮层：像素坐标定位在图表容器内，首行为时间标签。 */
function TipBox({ tip }: { tip: TipState | null }) {
  if (!tip) return null;
  return (
    <div className="ua-tip" style={{ left: tip.px, top: tip.py }}>
      {tip.lines.map((l, i) => (
        <div key={i} className={i === 0 ? 'ua-tip-head' : undefined}>{l}</div>
      ))}
    </div>
  );
}

/** 按像素 x 找最近数据列下标。 */
function nearestIdx(mx: number, count: number, xOf: (i: number) => number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < count; i++) {
    const d = Math.abs(xOf(i) - mx);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Token 变化：四段堆叠柱（缓存输入/缓存写入/非缓存输入/回复输出）+ 缓存命中率折线（右轴）。 */
function TokenMixChart({ data, height }: { data: DayMetrics[]; height: number }) {
  const t = useT();
  const [boxRef, boxW] = useMeasureWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const W = Math.max(320, Math.round(boxW || UA_W));
  const innerW = W - UA_PAD.l - UA_PAD.r;
  const innerH = height - UA_PAD.t - UA_PAD.b;
  const yTicks = computeYTicks(Math.max(1, ...data.map((d) => d.total)));
  const yMax = yTicks[yTicks.length - 1] || 1;
  const step = innerW / Math.max(1, data.length);
  const barW = Math.max(3, Math.min(24, step * 0.62));
  const y = (v: number) => UA_PAD.t + innerH - (v / yMax) * innerH;
  const hitLine = data.map((d, i) => {
    const inp = d.input + d.cacheRead + d.cacheWrite;
    const rate = inp > 0 ? d.cacheRead / inp : 0;
    return { x: UA_PAD.l + i * step + step / 2, y: UA_PAD.t + innerH - rate * innerH };
  });
  const labelIdx = sampleIndices(data.length, 6);
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const i = nearestIdx(e.clientX - r.left, data.length, (k) => UA_PAD.l + k * step + step / 2);
    const d = data[i];
    const inp = d.input + d.cacheRead + d.cacheWrite;
    setTip({
      idx: i,
      px: UA_PAD.l + i * step + step / 2,
      py: e.clientY - r.top,
      lines: [
        d.day,
        t('ua.tip.cacheIn', { v: formatTokens(d.cacheRead) }),
        t('ua.tip.cacheWrite', { v: formatTokens(d.cacheWrite) }),
        t('ua.tip.nonCacheIn', { v: formatTokens(d.input) }),
        t('ua.tip.replyOut', { v: formatTokens(d.output) }),
        t('ua.tip.hitRate', { v: inp > 0 ? ((d.cacheRead / inp) * 100).toFixed(1) : '0.0' }),
      ],
    });
  };
  return (
    <div className="ua-chart" ref={boxRef}>
      {uaLegend([
        { color: '#93c5fd', label: t('ua.legend.cacheIn') },
        { color: '#94a3b8', label: t('ua.legend.cacheWrite') },
        { color: '#3b82f6', label: t('ua.legend.nonCacheIn') },
        { color: '#10b981', label: t('ua.legend.replyOut') },
        { color: '#f59e0b', label: t('ua.legend.hitRate'), line: true },
      ])}
      <svg viewBox={`0 0 ${W} ${height}`} className="ua-svg" preserveAspectRatio="none">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={UA_PAD.l} x2={W - UA_PAD.r} y1={y(t)} y2={y(t)} className="ua-gridline" />
            <text x={UA_PAD.l - 6} y={y(t) + 3} className="ua-tick ua-tick-l" textAnchor="end">{formatYValue(t, 'tokens')}</text>
          </g>
        ))}
        {[0, 0.5, 1].map((r) => (
          <text key={r} x={W - UA_PAD.r + 6} y={UA_PAD.t + innerH - r * innerH + 3} className="ua-tick ua-tick-r" textAnchor="start">
            {r * 100}%
          </text>
        ))}
        {data.map((d, i) => {
          const x = UA_PAD.l + i * step + (step - barW) / 2;
          const segs = [
            { v: d.cacheRead, c: '#93c5fd' },
            { v: d.cacheWrite, c: '#94a3b8' },
            { v: d.input, c: '#3b82f6' },
            { v: d.output, c: '#10b981' },
          ];
          let acc = 0;
          return (
            <g key={d.ts}>
              {segs.map((s, si) => {
                if (s.v <= 0) return null;
                const y1 = y(acc + s.v);
                const h = Math.max(0.5, y(acc) - y1);
                acc += s.v;
                return <rect key={si} x={x} y={y1} width={barW} height={h} fill={s.c} opacity={0.85} />;
              })}
            </g>
          );
        })}
        <path d={smoothPath(hitLine)} fill="none" stroke="#f59e0b" strokeWidth={1.5} />
        {hitLine.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={2} fill="#f59e0b" />)}
        {labelIdx.map((i) => (
          <text key={i} x={UA_PAD.l + i * step + step / 2} y={height - 6} className="ua-tick" textAnchor="middle">{data[i].day}</text>
        ))}
        {tip && (
          <g pointerEvents="none">
            <line x1={hitLine[tip.idx].x} x2={hitLine[tip.idx].x} y1={UA_PAD.t} y2={UA_PAD.t + innerH} className="ua-guide" />
            <circle cx={hitLine[tip.idx].x} cy={hitLine[tip.idx].y} r={3.5} fill="#f59e0b" stroke="var(--bg-1)" strokeWidth={1.5} />
          </g>
        )}
        <rect x={UA_PAD.l} y={UA_PAD.t} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

/** 模型调用耗时：单轮耗时（消息创建→完成）P50 / P95 折线。 */
function LatencyChart({ data, height }: { data: DayMetrics[]; height: number }) {
  const t = useT();
  const [boxRef, boxW] = useMeasureWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const W = Math.max(320, Math.round(boxW || UA_W));
  const innerW = W - UA_PAD.l - UA_PAD.r;
  const innerH = height - UA_PAD.t - UA_PAD.b;
  const pts = data.map((d, i) => ({
    x: UA_PAD.l + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW),
    p50: percentile(d.durations, 0.5),
    p95: percentile(d.durations, 0.95),
    n: d.durations.length,
  }));
  const maxMs = Math.max(1000, ...pts.map((p) => p.p95));
  const yTicks = computeYTicks(maxMs / 1000);
  const yMax = (yTicks[yTicks.length - 1] || maxMs / 1000) * 1000;
  const y = (ms: number) => UA_PAD.t + innerH - (ms / yMax) * innerH;
  const labelIdx = sampleIndices(data.length, 6);
  const path = (key: 'p50' | 'p95') => smoothPath(pts.filter((p) => p.n > 0).map((p) => ({ x: p.x, y: y(p[key]) })));
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const i = nearestIdx(e.clientX - r.left, pts.length, (k) => pts[k].x);
    const p = pts[i];
    setTip({
      idx: i,
      px: p.x,
      py: e.clientY - r.top,
      lines: p.n > 0
        ? [data[i].day, `P50 ${(p.p50 / 1000).toFixed(1)}s`, `P95 ${(p.p95 / 1000).toFixed(1)}s`, t('ua.tip.samples', { n: p.n })]
        : [data[i].day, t('ua.tip.noSamples')],
    });
  };
  return (
    <div className="ua-chart" ref={boxRef}>
      {uaLegend([
        { color: '#3b82f6', label: 'P50', line: true },
        { color: '#f59e0b', label: 'P95', line: true },
      ])}
      <svg viewBox={`0 0 ${W} ${height}`} className="ua-svg" preserveAspectRatio="none">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={UA_PAD.l} x2={W - UA_PAD.r} y1={y(t * 1000)} y2={y(t * 1000)} className="ua-gridline" />
            <text x={UA_PAD.l - 6} y={y(t * 1000) + 3} className="ua-tick ua-tick-l" textAnchor="end">{t}s</text>
          </g>
        ))}
        <path d={path('p95')} fill="none" stroke="#f59e0b" strokeWidth={1.5} />
        <path d={path('p50')} fill="none" stroke="#3b82f6" strokeWidth={1.5} />
        {pts.filter((p) => p.n > 0).map((p) => (
          <g key={p.x}>
            <circle cx={p.x} cy={y(p.p50)} r={2.5} fill="#3b82f6" />
            <circle cx={p.x} cy={y(p.p95)} r={2.5} fill="#f59e0b" />
          </g>
        ))}
        {labelIdx.map((i) => (
          <text key={i} x={pts[i].x} y={height - 6} className="ua-tick" textAnchor="middle">{data[i].day}</text>
        ))}
        {tip && pts[tip.idx].n > 0 && (
          <g pointerEvents="none">
            <line x1={pts[tip.idx].x} x2={pts[tip.idx].x} y1={UA_PAD.t} y2={UA_PAD.t + innerH} className="ua-guide" />
            <circle cx={pts[tip.idx].x} cy={y(pts[tip.idx].p50)} r={3.5} fill="#3b82f6" stroke="var(--bg-1)" strokeWidth={1.5} />
            <circle cx={pts[tip.idx].x} cy={y(pts[tip.idx].p95)} r={3.5} fill="#f59e0b" stroke="var(--bg-1)" strokeWidth={1.5} />
          </g>
        )}
        <rect x={UA_PAD.l} y={UA_PAD.t} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

/** Turn 维度：每日 Turn 数柱状 + 平均 Token/Turn 折线（右轴）。 */
function TurnChart({ data, height }: { data: DayMetrics[]; height: number }) {
  const t = useT();
  const [boxRef, boxW] = useMeasureWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  const W = Math.max(320, Math.round(boxW || UA_W));
  const innerW = W - UA_PAD.l - UA_PAD.r;
  const innerH = height - UA_PAD.t - UA_PAD.b;
  const yTicks = computeYTicks(Math.max(1, ...data.map((d) => d.turns)));
  const yMax = yTicks[yTicks.length - 1] || 1;
  const avg = data.map((d) => (d.turns > 0 ? d.total / d.turns : 0));
  const avgTicks = computeYTicks(Math.max(1, ...avg));
  const avgMax = avgTicks[avgTicks.length - 1] || 1;
  const step = innerW / Math.max(1, data.length);
  const barW = Math.max(3, Math.min(24, step * 0.62));
  const y = (v: number) => UA_PAD.t + innerH - (v / yMax) * innerH;
  const ya = (v: number) => UA_PAD.t + innerH - (v / avgMax) * innerH;
  const labelIdx = sampleIndices(data.length, 6);
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const i = nearestIdx(e.clientX - r.left, data.length, (k) => UA_PAD.l + k * step + step / 2);
    setTip({
      idx: i,
      px: UA_PAD.l + i * step + step / 2,
      py: e.clientY - r.top,
      lines: [data[i].day, t('ua.tip.turns', { n: data[i].turns }), t('ua.tip.avgTurn', { v: formatTokens(avg[i]) })],
    });
  };
  return (
    <div className="ua-chart" ref={boxRef}>
      {uaLegend([
        { color: '#3b82f6', label: t('ua.legend.turns') },
        { color: '#f59e0b', label: t('ua.legend.avgTurn'), line: true },
      ])}
      <svg viewBox={`0 0 ${W} ${height}`} className="ua-svg" preserveAspectRatio="none">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={UA_PAD.l} x2={W - UA_PAD.r} y1={y(t)} y2={y(t)} className="ua-gridline" />
            <text x={UA_PAD.l - 6} y={y(t) + 3} className="ua-tick ua-tick-l" textAnchor="end">{t}</text>
          </g>
        ))}
        {avgTicks.map((t) => (
          <text key={t} x={W - UA_PAD.r + 6} y={ya(t) + 3} className="ua-tick ua-tick-r" textAnchor="start">{formatYValue(t, 'tokens')}</text>
        ))}
        {data.map((d, i) => (
          <rect
            key={d.ts}
            x={UA_PAD.l + i * step + (step - barW) / 2}
            y={y(d.turns)}
            width={barW}
            height={Math.max(0.5, UA_PAD.t + innerH - y(d.turns))}
            fill="#3b82f6"
            opacity={0.75}
          />
        ))}
        <path
          d={smoothPath(data.map((d, i) => ({ x: UA_PAD.l + i * step + step / 2, y: ya(avg[i]) })))}
          fill="none"
          stroke="#f59e0b"
          strokeWidth={1.5}
        />
        {labelIdx.map((i) => (
          <text key={i} x={UA_PAD.l + i * step + step / 2} y={height - 6} className="ua-tick" textAnchor="middle">{data[i].day}</text>
        ))}
        {tip && (
          <g pointerEvents="none">
            <line x1={UA_PAD.l + tip.idx * step + step / 2} x2={UA_PAD.l + tip.idx * step + step / 2} y1={UA_PAD.t} y2={UA_PAD.t + innerH} className="ua-guide" />
            <circle cx={UA_PAD.l + tip.idx * step + step / 2} cy={ya(avg[tip.idx])} r={3.5} fill="#f59e0b" stroke="var(--bg-1)" strokeWidth={1.5} />
          </g>
        )}
        <rect x={UA_PAD.l} y={UA_PAD.t} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

const PM_MODEL_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
const PM_OTHER_COLOR = '#94a3b8';

/**
 * 提供商×模型用量水平堆叠条形图：每行一个提供商，条长 = 总 Tokens，
 * 段按模型着色（Top 5 模型 + 其他）。比雷达图直观，且高度与右侧热力图齐平。
 */
function ProviderModelMix({ matrix, providers }: { matrix: Map<string, Map<string, number>>; providers: ModelProvider[] }) {
  const t = useT();
  // 与 ProviderView 一致的命名口径：解析为提供商显示名，找不到即已删除/未指定
  const providerName = (pid: string) =>
    pid === 'unknown' ? t('ua.unknownModel') : providers.find((p) => p.id === pid)?.name || t('ua.deletedProvider');
  const modelTotals = new Map<string, number>();
  const rows: Array<{ id: string; total: number; segs: Array<{ model: string; v: number }> }> = [];
  for (const [pid, models] of matrix) {
    let total = 0;
    for (const [mid, v] of models) {
      modelTotals.set(mid, (modelTotals.get(mid) ?? 0) + v);
      total += v;
    }
    rows.push({ id: pid, total, segs: Array.from(models.entries()).map(([model, v]) => ({ model, v })) });
  }
  rows.sort((a, b) => b.total - a.total);
  const top = rows.slice(0, 5);
  const models = Array.from(modelTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m]) => m);
  const colorOf = (m: string) => {
    const i = models.indexOf(m);
    return i >= 0 ? PM_MODEL_COLORS[i] : PM_OTHER_COLOR;
  };
  const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  if (top.length === 0) {
    return (
      <div className="ua-pmb">
        <div className="ua-pmb-title">{t('ua.pmb.title')}</div>
        <div className="ua-pmb-empty">{t('ua.pmb.empty')}</div>
      </div>
    );
  }
  const maxTotal = Math.max(1, ...top.map((r) => r.total));
  return (
    <div className="ua-pmb">
      <div className="ua-pmb-title">{t('ua.pmb.title')}</div>
      <div className="ua-pmb-rows">
        {top.map((r) => (
          <div key={r.id} className="ua-pmb-row">
            <div className="ua-pmb-label" title={providerName(r.id)}>{short(providerName(r.id), 14)}</div>
            <div className="ua-pmb-track">
              <div className="ua-pmb-bar" style={{ width: `${(r.total / maxTotal) * 100}%` }}>
                {r.segs
                  .filter((s) => s.v > 0)
                  .sort((a, b) => b.v - a.v)
                  .map((s) => (
                    <div
                      key={s.model}
                      className="ua-pmb-seg"
                      style={{ width: `${(s.v / r.total) * 100}%`, background: colorOf(s.model) }}
                      title={`${providerName(r.id)} · ${describeModelId(s.model)} · ${formatTokens(s.v)} ${t('unit.tokens')}`}
                    />
                  ))}
              </div>
            </div>
            <div className="ua-pmb-total">{formatTokens(r.total)}</div>
          </div>
        ))}
      </div>
      <div className="ua-legend ua-pmb-legend">
        {models.map((m, i) => (
          <span key={m} className="ua-legend-item" title={m}>
            <span className="ua-legend-dot" style={{ background: PM_MODEL_COLORS[i] }} />
            {short(describeModelId(m), 16)}
          </span>
        ))}
        <span className="ua-legend-item">
          <span className="ua-legend-dot" style={{ background: PM_OTHER_COLOR }} />
          {t('ua.pmb.other')}
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CombinedChart 组件（单图叠加 3 条线：输入/输出 tokens + 费用，双 Y 轴）
// ═══════════════════════════════════════════════════════════════════════════════

interface CombinedChartProps {
  data: TimeSeriesPoint[];
  height: number;
  showXAxis?: boolean;
  showLegend?: boolean;
}

function CombinedChart({ data, height, showXAxis = false, showLegend = false }: CombinedChartProps) {
  const t = useT();
  const [boxRef, boxW] = useMeasureWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  // 按容器像素宽度 1:1 渲染（与运行维度三图同一口径），横坐标长度行行一致
  const svgWidth = Math.max(320, Math.round(boxW || 700));
  const padding = {
    top: 36, // 为图例留空间
    right: 50,
    bottom: showXAxis ? 30 : 8,
    left: 50,
  };
  const chartW = svgWidth - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // 计算各指标最大值
  const maxInput = Math.max(...data.map((d) => d.inputTokens), 0);
  const maxOutput = Math.max(...data.map((d) => d.outputTokens), 0);
  const maxCost = Math.max(...data.map((d) => d.costUsd), 0);

  // tokens 轴（左）：取 input/output 中较大的
  const maxTokens = Math.max(maxInput, maxOutput);
  const tokensTicks = computeYTicks(maxTokens, 4);
  const tokensMax = tokensTicks[tokensTicks.length - 1] || 1;

  // 费用轴（右）
  const costTicks = computeYTicks(maxCost, 4);
  const costMax = costTicks[costTicks.length - 1] || 1;

  // 构建点序列（3 条线）
  const inputPoints = data.map((d, i) => {
    const x = data.length === 1
      ? padding.left + chartW / 2
      : padding.left + (i / (data.length - 1)) * chartW;
    const y = padding.top + chartH - (d.inputTokens / tokensMax) * chartH;
    return { x, y };
  });

  const outputPoints = data.map((d, i) => {
    const x = data.length === 1
      ? padding.left + chartW / 2
      : padding.left + (i / (data.length - 1)) * chartW;
    const y = padding.top + chartH - (d.outputTokens / tokensMax) * chartH;
    return { x, y };
  });

  const costPoints = data.map((d, i) => {
    const x = data.length === 1
      ? padding.left + chartW / 2
      : padding.left + (i / (data.length - 1)) * chartW;
    const y = padding.top + chartH - (d.costUsd / costMax) * chartH;
    return { x, y };
  });

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const i = nearestIdx(e.clientX - r.left, data.length, (k) => inputPoints[k].x);
    const d = data[i];
    setTip({
      idx: i,
      px: inputPoints[i].x,
      py: e.clientY - r.top,
      lines: [d.label, t('ua.tip.input', { v: formatTokens(d.inputTokens) }), t('ua.tip.output', { v: formatTokens(d.outputTokens) }), t('ua.tip.cost', { v: d.costUsd.toFixed(4) })],
    });
  };

  // 曲线 + 填充
  const inputLinePath = smoothPath(inputPoints);
  const inputAreaPath = inputPoints.length > 1
    ? `${inputLinePath} L ${inputPoints[inputPoints.length - 1].x} ${padding.top + chartH} L ${inputPoints[0].x} ${padding.top + chartH} Z`
    : '';

  const outputLinePath = smoothPath(outputPoints);
  const outputAreaPath = outputPoints.length > 1
    ? `${outputLinePath} L ${outputPoints[outputPoints.length - 1].x} ${padding.top + chartH} L ${outputPoints[0].x} ${padding.top + chartH} Z`
    : '';

  const costLinePath = smoothPath(costPoints);
  const costAreaPath = costPoints.length > 1
    ? `${costLinePath} L ${costPoints[costPoints.length - 1].x} ${padding.top + chartH} L ${costPoints[0].x} ${padding.top + chartH} Z`
    : '';

  // X 轴标签抽样（每 70px 一个标签）
  const maxLabels = Math.max(2, Math.floor(chartW / 70));
  const xIndices = sampleIndices(data.length, maxLabels);
  const baseLine = padding.top + chartH;

  // 图例（可选，只在第一个图表显示）：水平居中，与运行维度三图的 HTML 图例位置统一
  const legendY = 14;
  const legendX = svgWidth / 2 - 84;

  return (
    <div className="combined-chart" ref={boxRef}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${svgWidth} ${height}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="grad-input" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="grad-output" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="grad-cost" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* 图例（仅当 showLegend 为 true 时显示） */}
        {showLegend && (
          <>
            <circle cx={legendX} cy={legendY} r="4" fill="#3b82f6" />
            <text x={legendX + 8} y={legendY + 3} fontSize="10" fill="var(--text-muted)">{t('ua.sum.in')}</text>
            <circle cx={legendX + 60} cy={legendY} r="4" fill="#10b981" />
            <text x={legendX + 68} y={legendY + 3} fontSize="10" fill="var(--text-muted)">{t('ua.sum.out')}</text>
            <circle cx={legendX + 120} cy={legendY} r="4" fill="#f59e0b" />
            <text x={legendX + 128} y={legendY + 3} fontSize="10" fill="var(--text-muted)">{t('ua.sum.cost')}</text>
          </>
        )}

        {/* 左侧 Y 轴（tokens）网格线和刻度 */}
        {tokensTicks.map((tick, i) => {
          const y = padding.top + chartH - (tick / tokensMax) * chartH;
          return (
            <g key={`lt-${i}`}>
              <line
                x1={padding.left}
                y1={y}
                x2={padding.left + chartW}
                y2={y}
                stroke="var(--border)"
                strokeDasharray="2,3"
                strokeWidth="0.5"
                opacity="0.4"
              />
              <text
                x={padding.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="9"
                fill="#3b82f6"
                opacity="0.7"
                fontFamily="system-ui, -apple-system, sans-serif"
              >
                {formatYValue(tick, 'tokens')}
              </text>
            </g>
          );
        })}

        {/* 右侧 Y 轴（费用）刻度 */}
        {costTicks.map((tick, i) => {
          const y = padding.top + chartH - (tick / costMax) * chartH;
          return (
            <text
              key={`rt-${i}`}
              x={padding.left + chartW + 6}
              y={y + 3}
              textAnchor="start"
              fontSize="9"
              fill="#f59e0b"
              opacity="0.7"
              fontFamily="system-ui, -apple-system, sans-serif"
            >
              {formatYValue(tick, 'usd')}
            </text>
          );
        })}

        {/* 填充区域（先画，在线之下） */}
        {inputAreaPath && <path d={inputAreaPath} fill="url(#grad-input)" />}
        {outputAreaPath && <path d={outputAreaPath} fill="url(#grad-output)" />}
        {costAreaPath && <path d={costAreaPath} fill="url(#grad-cost)" />}

        {/* 曲线 */}
        {inputLinePath && (
          <path
            d={inputLinePath}
            fill="none"
            stroke="#3b82f6"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {outputLinePath && (
          <path
            d={outputLinePath}
            fill="none"
            stroke="#10b981"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {costLinePath && (
          <path
            d={costLinePath}
            fill="none"
            stroke="#f59e0b"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* 数据点（数据少时显示） */}
        {data.length <= 20 && (
          <>
            {inputPoints.map((p, i) => (
              <circle key={`ip-${i}`} cx={p.x} cy={p.y} r="2" fill="#3b82f6" />
            ))}
            {outputPoints.map((p, i) => (
              <circle key={`op-${i}`} cx={p.x} cy={p.y} r="2" fill="#10b981" />
            ))}
            {costPoints.map((p, i) => (
              <circle key={`cp-${i}`} cx={p.x} cy={p.y} r="2" fill="#f59e0b" />
            ))}
          </>
        )}

        {/* X 轴标签 */}
        {showXAxis && xIndices.map((idx) => {
          const x = data.length === 1
            ? padding.left + chartW / 2
            : padding.left + (idx / (data.length - 1)) * chartW;
          return (
            <g key={`x-${idx}`}>
              <line
                x1={x}
                y1={baseLine}
                x2={x}
                y2={baseLine + 3}
                stroke="var(--border)"
                strokeWidth="1"
                opacity="0.6"
              />
              <text
                x={x}
                y={baseLine + 16}
                textAnchor="middle"
                fontSize="9"
                fill="var(--text-muted)"
                fontFamily="system-ui, -apple-system, sans-serif"
              >
                {data[idx].label}
              </text>
            </g>
          );
        })}

        {/* 基线 */}
        <line
          x1={padding.left}
          y1={baseLine}
          x2={padding.left + chartW}
          y2={baseLine}
          stroke="var(--border)"
          strokeWidth="1"
          opacity="0.6"
        />
        {tip && (
          <g pointerEvents="none">
            <line x1={inputPoints[tip.idx].x} x2={inputPoints[tip.idx].x} y1={padding.top} y2={baseLine} className="ua-guide" />
            <circle cx={inputPoints[tip.idx].x} cy={inputPoints[tip.idx].y} r={3.5} fill="#3b82f6" stroke="var(--bg-1)" strokeWidth={1.5} />
            <circle cx={outputPoints[tip.idx].x} cy={outputPoints[tip.idx].y} r={3.5} fill="#10b981" stroke="var(--bg-1)" strokeWidth={1.5} />
            <circle cx={costPoints[tip.idx].x} cy={costPoints[tip.idx].y} r={3.5} fill="#f59e0b" stroke="var(--bg-1)" strokeWidth={1.5} />
          </g>
        )}
        <rect x={padding.left} y={padding.top} width={chartW} height={chartH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CompareChart 组件（多 provider 对比，单指标多线）
// ═══════════════════════════════════════════════════════════════════════════════

interface CompareChartProps {
  data: TimeSeriesPoint[][];
  height: number;
  showXAxis?: boolean;
  labels: string[];
  colors: string[];
  metric: 'input' | 'output' | 'cost';
}

function CompareChart({ data, height, showXAxis = false, labels, colors, metric }: CompareChartProps) {
  const [boxRef, boxW] = useMeasureWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TipState | null>(null);
  // 与其余图表同一口径：按容器像素宽度 1:1 渲染
  const svgWidth = Math.max(320, Math.round(boxW || 700));
  const padding = {
    top: 40,
    right: 60,
    bottom: showXAxis ? 30 : 8,
    left: 60,
  };
  const chartW = svgWidth - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // 找出所有 series 中最大数据点数
  const maxLen = Math.max(...data.map(d => d.length), 0);

  // 计算全局最大值（所有 series 的该指标）
  const getValue = (point: TimeSeriesPoint) => {
    if (metric === 'input') return point.inputTokens;
    if (metric === 'output') return point.outputTokens;
    return point.costUsd;
  };

  const maxValue = Math.max(
    ...data.flatMap(series => series.map(getValue)),
    0
  );

  const unit = metric === 'cost' ? 'usd' as const : 'tokens' as const;
  const yTicks = computeYTicks(maxValue, 4);
  const yMax = yTicks[yTicks.length - 1] || 1;

  const baseLine = padding.top + chartH;

  // 为每个 series 生成路径和填充
  const seriesData = data.map((series, idx) => {
    const color = colors[idx] || `hsl(${idx * 60}, 60%, 50%)`;
    const label = labels[idx] || `Provider ${idx + 1}`;

    // 合并时间轴：所有 series 的 timestamp 去重排序
    const allTimestamps = new Set<number>();
    for (const point of series) {
      allTimestamps.add(point.timestamp);
    }
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);

    // 构建 timestamp -> point 映射
    const pointMap = new Map<number, TimeSeriesPoint>();
    for (const point of series) {
      pointMap.set(point.timestamp, point);
    }

    // 生成点序列（附带标签与数值，供悬停浮层使用）
    const points = sortedTimestamps.map((ts, i) => {
      const point = pointMap.get(ts)!;
      const value = getValue(point);
      const x = sortedTimestamps.length === 1
        ? padding.left + chartW / 2
        : padding.left + (i / (sortedTimestamps.length - 1)) * chartW;
      const y = padding.top + chartH - (value / yMax) * chartH;
      return { x, y, label: point.label, value };
    });

    const linePath = smoothPath(points);
    const areaPath = points.length > 1
      ? `${linePath} L ${points[points.length - 1].x} ${baseLine} L ${points[0].x} ${baseLine} Z`
      : '';

    return {
      color,
      label,
      linePath,
      areaPath,
      points,
      timestamps: sortedTimestamps,
    };
  });

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    if (!seriesData.length || !seriesData[0].points.length) return;
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const picks = seriesData.map((s) => nearestIdx(mx, s.points.length, (k) => s.points[k].x));
    setTip({
      idx: picks[0],
      px: seriesData[0].points[picks[0]].x,
      py: e.clientY - r.top,
      lines: [
        seriesData[0].points[picks[0]].label,
        ...seriesData.map((s, si) => {
          const p = s.points[picks[si]];
          return `${s.label} ${metric === 'cost' ? `$${p.value.toFixed(4)}` : formatTokens(p.value)}`;
        }),
      ],
    });
  };

  // X 轴标签抽样：取第一个 series 的标签
  const maxLabels = Math.max(2, Math.floor(chartW / 70));
  const firstSeries = data[0] || [];
  const xIndices = sampleIndices(firstSeries.length, maxLabels);

  // 图例
  const legendY = 14;
  const legendItems: Array<{ x: number; color: string; label: string }> = [];
  let legendX = padding.left;
  for (const s of seriesData) {
    legendItems.push({ x: legendX, color: s.color, label: s.label });
    legendX += s.label.length * 6 + 30;
  }

  return (
    <div className="combined-chart" ref={boxRef}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${svgWidth} ${height}`}
        preserveAspectRatio="none"
      >
        {/* 图例 */}
        {legendItems.map((item, i) => (
          <g key={`legend-${i}`}>
            <circle cx={item.x} cy={legendY} r="4" fill={item.color} />
            <text x={item.x + 8} y={legendY + 3} fontSize="10" fill="var(--text-muted)">{item.label}</text>
          </g>
        ))}

        {/* Y 轴网格线和刻度 */}
        {yTicks.map((tick, i) => {
          const y = padding.top + chartH - (tick / yMax) * chartH;
          return (
            <g key={`yt-${i}`}>
              <line
                x1={padding.left}
                y1={y}
                x2={padding.left + chartW}
                y2={y}
                stroke="var(--border)"
                strokeDasharray="2,3"
                strokeWidth="0.5"
                opacity="0.4"
              />
              <text
                x={padding.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize="9"
                fill="var(--text-muted)"
                fontFamily="system-ui, -apple-system, sans-serif"
              >
                {formatYValue(tick, unit)}
              </text>
            </g>
          );
        })}

        {/* 每个 series 的填充区域和线条 */}
        {seriesData.map((s, idx) => (
          <g key={`series-${idx}`}>
            {s.areaPath && (
              <path
                d={s.areaPath}
                fill={s.color}
                fillOpacity="0.1"
              />
            )}
            {s.linePath && (
              <path
                d={s.linePath}
                fill="none"
                stroke={s.color}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            {/* 数据点（数据少时显示） */}
            {s.points.length <= 20 && s.points.map((p, i) => (
              <circle key={`pt-${idx}-${i}`} cx={p.x} cy={p.y} r="2" fill={s.color} />
            ))}
          </g>
        ))}

        {/* X 轴标签 */}
        {showXAxis && xIndices.map((idx) => {
          const x = firstSeries.length === 1
            ? padding.left + chartW / 2
            : padding.left + (idx / (firstSeries.length - 1)) * chartW;
          return (
            <g key={`x-${idx}`}>
              <line
                x1={x}
                y1={baseLine}
                x2={x}
                y2={baseLine + 3}
                stroke="var(--border)"
                strokeWidth="1"
                opacity="0.6"
              />
              <text
                x={x}
                y={baseLine + 16}
                textAnchor="middle"
                fontSize="9"
                fill="var(--text-muted)"
                fontFamily="system-ui, -apple-system, sans-serif"
              >
                {firstSeries[idx]?.label}
              </text>
            </g>
          );
        })}

        {/* 基线 */}
        <line
          x1={padding.left}
          y1={baseLine}
          x2={padding.left + chartW}
          y2={baseLine}
          stroke="var(--border)"
          strokeWidth="1"
          opacity="0.6"
        />
        {tip && seriesData[0]?.points[tip.idx] && (
          <g pointerEvents="none">
            <line x1={seriesData[0].points[tip.idx].x} x2={seriesData[0].points[tip.idx].x} y1={padding.top} y2={baseLine} className="ua-guide" />
            {seriesData.map((s, si) => {
              const gx = seriesData[0].points[tip.idx].x;
              const k = nearestIdx(gx, s.points.length, (kk) => s.points[kk].x);
              return <circle key={si} cx={s.points[k].x} cy={s.points[k].y} r={3.5} fill={s.color} stroke="var(--bg-1)" strokeWidth={1.5} />;
            })}
          </g>
        )}
        <rect x={padding.left} y={padding.top} width={chartW} height={chartH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setTip(null)} />
      </svg>
      <TipBox tip={tip} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 主组件
// ═══════════════════════════════════════════════════════════════════════════════

export function UsageAnalytics({ conversations, onClose, pane }: {
  conversations: ConversationMeta[];
  onClose: () => void;
  /** 右栏 tab 形态：铺满主面板，无遮罩、Esc 不关闭 */
  pane?: boolean;
}) {
  const dateTimeSettings=useDateTimeSettings();
  // 当前维度：项目 or 全局
  const t = useT();
  const [dimension, setDimension] = useState<Dimension>('project');
  // 二级分类：总览 or 模型提供商
  const [subCategory, setSubCategory] = useState<SubCategory>('overview');
  
  // 读取项目维度的 historicalUsage
  const projectHistoricalUsage = useAppStore((s) => s.projectStats?.historicalUsage);
  
  // providers 列表（用于按 provider 分组时显示名称）
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  
  // 全局维度的状态
  const [globalConversations, setGlobalConversations] = useState<ConversationMeta[]>([]);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [loadingGlobal, setLoadingGlobal] = useState(false);

  // 时间范围拖放：当前显示的 provider（仅 provider 视图使用）
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  // 加载 providers
  useEffect(() => {
    (async () => {
      try {
        const settings = await window.api.getSettings();
        setProviders(settings?.modelProviders ?? []);
      } catch (err) {
        console.error('[UsageAnalytics] Failed to load providers:', err);
      }
    })();
  }, []);

  // 当切换到全局维度时，加载所有项目的对话
  useEffect(() => {
    if (dimension !== 'global' || globalConversations.length > 0) return;
    
    setLoadingGlobal(true);
    (async () => {
      try {
        // 1. 获取全局统计
        const stats = await window.api.getGlobalStats();
        setGlobalStats(stats);
        
        // 2. 获取所有项目
        const projects = await window.api.listProjects();
        
        // 3. 遍历所有项目，收集所有对话（含 providerId）
        const allConvs: ConversationMeta[] = [];
        for (const proj of projects) {
          const convs: ConversationMeta[] = await window.api.listConvs(proj.path);
          for (const conv of convs) {
            // 只取有 usage 数据的对话
            if (conv.messages.some(m => m.usage)) {
              allConvs.push(conv);
            }
          }
        }
        setGlobalConversations(allConvs);
      } catch (err) {
        console.error('[UsageAnalytics] Failed to load global data:', err);
      } finally {
        setLoadingGlobal(false);
      }
    })();
  }, [dimension, globalConversations.length]);

  // 根据维度选择数据源（带 providerId）
  const currentConversations = dimension === 'project' ? conversations : globalConversations;
  const historicalUsage = dimension === 'project' ? projectHistoricalUsage : globalStats?.historicalUsage;

  // 带 providerId 和 modelId 的对话列表
  // 注意归属优先级：优先 selectedModel（用户在对话里明确选中的，稳定），
  // 再 fallback 到 conv.providerId（最近一次实际使用，会随发消息变化）。
  // 这样对话中途切换提供商时，老消息不会整体跳到新提供商（串号）。
  // 新消息本身带 msg.providerId，按消息级归属不受此影响。
  const conversationsWithProvider = useMemo(() => {
    return currentConversations.map(conv => {
      const providerId = conv.selectedModel?.providerId || conv.providerId || 'unknown';
      const modelId = conv.selectedModel?.modelId || conv.modelId || 'unknown';
      
      return {
        messages: conv.messages,
        providerId,
        modelId,
        convTitle: conv.title || '',
      };
    });
  }, [currentConversations]);

  // 一次性提取所有粒度的数据（总览）
  const allSeries = useMemo(() => {
    const result: Record<TimeGranularity, TimeSeriesPoint[]> = {
      minute: [], hour: [], day: [], month: [], year: [],
    };
    for (const g of GRANULARITIES) {
      result[g] = extractTimeSeries(conversationsWithProvider, g, GRANULARITY_MAX_POINTS[g]);
    }
    return result;
  }, [conversationsWithProvider, dateTimeSettings]);

  // 按天聚合的运行维度指标（Token 构成 / 单轮耗时 / Turn），总览卡片与热力图数据源
  const dayMetrics = useMemo(() => buildDayMetrics(conversationsWithProvider), [conversationsWithProvider, dateTimeSettings]);
  const daySeries = useMemo(() => dayMetrics.slice(-30), [dayMetrics]);
  const lifetime = useMemo(() => {
    let total = 0;
    let peak = 0;
    for (const m of dayMetrics) { total += m.total; peak = Math.max(peak, m.total); }
    let longestChat = 0;
    for (const conv of currentConversations) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const m of conv.messages) {
        if (!m.ts) continue;
        const t = new Date(m.ts).getTime();
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
      if (hi > lo) longestChat = Math.max(longestChat, hi - lo);
    }
    return { total, peak, longestChat };
  }, [dayMetrics, currentConversations]);
  const streaks = useMemo(
    () => computeStreaks(dayMetrics.filter((m) => m.turns > 0).map((m) => m.ts)),
    [dayMetrics],
  );
  const turnSummary = useMemo(() => {
    let turns = 0;
    let errored = 0;
    for (const m of dayMetrics) { turns += m.turns; errored += m.errored; }
    return { turns, rate: turns > 0 ? (1 - errored / turns) * 100 : 0 };
  }, [dayMetrics]);

  // 按 provider 分组的数据（仅 provider 视图使用）
  const providerSeries = useMemo(() => {
    const result: Record<TimeGranularity, Map<string, TimeSeriesPoint[]>> = {
      minute: new Map(), hour: new Map(), day: new Map(), month: new Map(), year: new Map(),
    };
    for (const g of GRANULARITIES) {
      result[g] = extractTimeSeriesByProvider(conversationsWithProvider, g, GRANULARITY_MAX_POINTS[g]);
    }
    return result;
  }, [conversationsWithProvider, dateTimeSettings]);

  // 按 provider 汇总的总览数据
  // 统计粒度：每次调用请求（消息级）。归属 = msg.providerId（本轮实际
  // 产生调用的提供商），切换提供商后每轮归到当时的真实提供商。
  // 复合类型双算：同时计入用户选中的复合维度（msg.selectedProviderId）
  // 和实际成员（msg.providerId），复合本身不产生调用，仅作为统计维度。
  const providerTotals = useMemo(() => {
    const totals = new Map<string, { input: number; output: number; cost: number; count: number }>();
    const addTotal = (pid: string, msg: ChatMessage) => {
      if (!totals.has(pid)) {
        totals.set(pid, { input: 0, output: 0, cost: 0, count: 0 });
      }
      const t = totals.get(pid)!;
      t.input += msg.usage!.inputTokens + msg.usage!.cacheReadTokens + msg.usage!.cacheCreationTokens;
      t.output += msg.usage!.outputTokens;
      t.cost += msg.usage!.costUsd > 0 ? msg.usage!.costUsd : estimateCostUsd(msg.usage!);
      t.count += 1;
    };
    for (const conv of conversationsWithProvider) {
      const convFallback = conv.providerId || 'unknown';
      for (const msg of conv.messages) {
        if (msg.role !== 'assistant' || !msg.usage) continue;
        const actual = msg.providerId || convFallback;
        addTotal(actual, msg);
        const selected = msg.selectedProviderId;
        if (selected && selected !== actual) addTotal(selected, msg);
      }
    }
    return totals;
  }, [conversationsWithProvider, dateTimeSettings]);

  // 按 model 分组的数据（仅 model 视图使用）
  const modelSeries = useMemo(() => {
    const result: Record<TimeGranularity, Map<string, TimeSeriesPoint[]>> = {
      minute: new Map(), hour: new Map(), day: new Map(), month: new Map(), year: new Map(),
    };
    for (const g of GRANULARITIES) {
      result[g] = extractTimeSeriesByModel(conversationsWithProvider, g, GRANULARITY_MAX_POINTS[g]);
    }
    return result;
  }, [conversationsWithProvider, dateTimeSettings]);

  // 按 model 汇总的总览数据
  // 统计粒度：每次调用请求（消息级）。归属 = msg.modelId（本轮实际调用的模型）。
  // 复合类型双算：同时计入复合声明的模型名（msg.selectedModelId）
  // 和成员实际模型名（msg.modelId），两者相同时不重复计入。
  const modelTotals = useMemo(() => {
    const totals = new Map<string, { input: number; output: number; cost: number; count: number }>();
    const addTotal = (mid: string, msg: ChatMessage) => {
      if (!totals.has(mid)) {
        totals.set(mid, { input: 0, output: 0, cost: 0, count: 0 });
      }
      const t = totals.get(mid)!;
      t.input += msg.usage!.inputTokens + msg.usage!.cacheReadTokens + msg.usage!.cacheCreationTokens;
      t.output += msg.usage!.outputTokens;
      t.cost += msg.usage!.costUsd > 0 ? msg.usage!.costUsd : estimateCostUsd(msg.usage!);
      t.count += 1;
    };
    for (const conv of conversationsWithProvider) {
      const convFallback = conv.modelId || 'unknown';
      for (const msg of conv.messages) {
        if (msg.role !== 'assistant' || !msg.usage) continue;
        const actual = describeModelId(msg.modelId || convFallback).trim();
        addTotal(actual, msg);
        const selected = msg.selectedModelId ? describeModelId(msg.selectedModelId).trim() : undefined;
        if (selected && selected !== actual) addTotal(selected, msg);
      }
    }
    return totals;
  }, [conversationsWithProvider, dateTimeSettings]);

  // 提供商 × 模型用量矩阵（雷达图用）：provider → model → 总 Tokens。
  // 归属口径与 providerTotals/modelTotals 一致：msg 级实际提供商/模型。
  const providerModelMatrix = useMemo(() => {
    const matrix = new Map<string, Map<string, number>>();
    const add = (pid: string, mid: string, tokens: number) => {
      mid = describeModelId(mid).trim();
      let row = matrix.get(pid);
      if (!row) {
        row = new Map();
        matrix.set(pid, row);
      }
      row.set(mid, (row.get(mid) ?? 0) + tokens);
    };
    for (const conv of conversationsWithProvider) {
      const convP = conv.providerId || 'unknown';
      const convM = conv.modelId || 'unknown';
      for (const msg of conv.messages) {
        if (msg.role !== 'assistant' || !msg.usage) continue;
        const tokens =
          msg.usage.inputTokens + msg.usage.outputTokens + msg.usage.cacheReadTokens + msg.usage.cacheCreationTokens;
        add(msg.providerId || convP, msg.modelId || convM, tokens);
      }
    }
    return matrix;
  }, [conversationsWithProvider, dateTimeSettings]);

  const hasHistoricalData = historicalUsage && (
    historicalUsage.inputTokens > 0 || historicalUsage.outputTokens > 0 || historicalUsage.costUsd > 0
  );

  // 是否有任何粒度的数据
  const hasAnyData = GRANULARITIES.some((g) => allSeries[g].length > 0);

  // 历史累计总量
  const historicalTotal = useMemo(() => {
    if (!historicalUsage) return { input: 0, output: 0, cost: 0 };
    return {
      input: historicalUsage.inputTokens + historicalUsage.cacheReadTokens + historicalUsage.cacheCreationTokens,
      output: historicalUsage.outputTokens,
      // Deleted conversations only retain aggregate tokens. When their legacy
      // cost was never stored, show the persisted Sonnet fallback rather than $0.
      cost: historicalUsage.costUsd || estimateCostUsd(historicalUsage),
    };
  }, [historicalUsage]);

  // 当前数据总量（跨所有粒度取最大值，避免重复累加）
  const currentTotal = useMemo(() => {
    let maxInput = 0, maxOutput = 0, maxCost = 0;
    for (const g of GRANULARITIES) {
      const data = allSeries[g];
      const tIn = data.reduce((s, d) => s + d.inputTokens, 0);
      const tOut = data.reduce((s, d) => s + d.outputTokens, 0);
      const tCost = data.reduce((s, d) => s + d.costUsd, 0);
      maxInput = Math.max(maxInput, tIn);
      maxOutput = Math.max(maxOutput, tOut);
      maxCost = Math.max(maxCost, tCost);
    }
    return { input: maxInput, output: maxOutput, cost: maxCost };
  }, [allSeries]);

  useEffect(() => {
    if (pane) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pane]);

  const body = (
    <div className="usage-analytics usage-grid-layout" onClick={(e) => { if (!pane) e.stopPropagation(); }}>
        {/* ── 维度切换 Tab ── */}
        <div className="usage-dimension-tabs">
          <button
            className={`dimension-tab ${dimension === 'project' ? 'active' : ''}`}
            onClick={() => setDimension('project')}
          >
            <FolderOpen size={14} />
            <span>{t('ua.dimProject')}</span>
          </button>
          <button
            className={`dimension-tab ${dimension === 'global' ? 'active' : ''}`}
            onClick={() => setDimension('global')}
          >
            <Globe size={14} />
            <span>{t('ua.dimGlobal')}</span>
          </button>
        </div>

        {/* ── 二级分类 Tab ── */}
        <div className="usage-subcategory-tabs">
          <button
            className={`subcategory-tab ${subCategory === 'overview' ? 'active' : ''}`}
            onClick={() => setSubCategory('overview')}
          >
            <LayoutGrid size={14} />
            <span>{t('ua.subOverview')}</span>
          </button>
          <button
            className={`subcategory-tab ${subCategory === 'provider' ? 'active' : ''}`}
            onClick={() => setSubCategory('provider')}
          >
            <Layers size={14} />
            <span>{t('ua.subProvider')}</span>
          </button>
          <button
            className={`subcategory-tab ${subCategory === 'model' ? 'active' : ''}`}
            onClick={() => setSubCategory('model')}
          >
            <BarChart3 size={14} />
            <span>{t('ua.subModel')}</span>
          </button>
        </div>

        {/* ── 汇总统计条 ── */}
        <div className="usage-summary-bar">
          <div className="summary-item">
            <span className="summary-dot" style={{ background: '#3b82f6' }} />
            <span className="summary-label">{t('ua.sum.in')}</span>
            <span className="summary-value">{formatTokens(currentTotal.input)}</span>
          </div>
          <div className="summary-item">
            <span className="summary-dot" style={{ background: '#10b981' }} />
            <span className="summary-label">{t('ua.sum.out')}</span>
            <span className="summary-value">{formatTokens(currentTotal.output)}</span>
          </div>
          <div className="summary-item">
            <span className="summary-dot" style={{ background: '#f59e0b' }} />
            <span className="summary-label">{t('ua.sum.cost')}</span>
            <span className="summary-value">${currentTotal.cost.toFixed(4)}</span>
          </div>
          {hasHistoricalData && (
            <div className="summary-history">
              {t('ua.hist', { in: formatTokens(historicalTotal.input), out: formatTokens(historicalTotal.output), cost: historicalTotal.cost.toFixed(4) })}
            </div>
          )}
        </div>

        {/* ── 网格主体 ── */}
        {loadingGlobal ? (
          <div className="usage-grid-empty">
            <div className="empty-icon">⏳</div>
            <div className="empty-title">{t('ua.loadingGlobal')}</div>
          </div>
        ) : !hasAnyData && providerTotals.size === 0 && subCategory !== 'overview' ? (
          <div className="usage-grid-empty">
            <div className="empty-icon">📊</div>
            <div className="empty-title">{t('ua.emptyTitle')}</div>
            <div className="empty-desc">
              {dimension === 'project' 
                ? t('ua.emptyHintProject') 
                : t('ua.emptyHintGlobal')}
            </div>
          </div>
        ) : subCategory === 'overview' ? (
          /* ── 总览视图：卡片+雷达+热力图（随主体滚动）+ 运行维度三图 + 5 个时间维度图表 ── */
          <div className="usage-grid-body">
            {/* ── 生命周期总览卡片：仅总览展示，随主体一起滚动不固定 ── */}
            <div className="ua-cards">
              <div className="ua-card">
                <div className="ua-card-value">{formatTokens(lifetime.total)}</div>
                <div className="ua-card-label">{t('ua.card.total')}</div>
              </div>
              <div className="ua-card">
                <div className="ua-card-value">{formatTokens(lifetime.peak)}</div>
                <div className="ua-card-label">{t('ua.card.peak')}</div>
              </div>
              <div className="ua-card">
                <div className="ua-card-value">{lifetime.longestChat > 0 ? fmtDuration(lifetime.longestChat) : '—'}</div>
                <div className="ua-card-label">{t('ua.card.longest')}</div>
              </div>
              <div className="ua-card">
                <div className="ua-card-value">{t('ua.card.days', { n: streaks.current })}</div>
                <div className="ua-card-label">{t('ua.card.curStreak')}</div>
              </div>
              <div className="ua-card">
                <div className="ua-card-value">{t('ua.card.days', { n: streaks.longest })}</div>
                <div className="ua-card-label">{t('ua.card.bestStreak')}</div>
              </div>
            </div>

            {/* ── 雷达图（提供商×模型）+ Token activity 热力图 ── */}
            <div className="ua-heat-row">
              <div className="ua-heat-title">{t('analytics.tokenActivity')}</div>
              <div className="ua-heat-flex">
                <ProviderModelMix matrix={providerModelMatrix} providers={providers} />
                <ActivityHeatmap metrics={dayMetrics} />
              </div>
            </div>

            {/* ── 运行维度：Token 变化 / 调用耗时 / Turn（置于格子图之后、粒度图之前） ── */}
            <div className={`grid-row ${daySeries.length === 0 ? 'empty' : ''}`}>
              <div className="grid-row-label">
                <div className="gran-name">{t('ua.g1.name')}</div>
                <div className="gran-desc">{t('ua.g1.desc')}</div>
              </div>
              <div className="grid-row-chart">
                {daySeries.length === 0 ? (
                  <div className="combined-chart-empty">{t('ua.noData')}</div>
                ) : (
                  <TokenMixChart data={daySeries} height={92} />
                )}
              </div>
            </div>

            <div className={`grid-row ${daySeries.length === 0 ? 'empty' : ''}`}>
              <div className="grid-row-label">
                <div className="gran-name">{t('ua.g2.name')}</div>
                <div className="gran-desc">{t('ua.g2.desc')}</div>
              </div>
              <div className="grid-row-chart">
                {daySeries.length === 0 ? (
                  <div className="combined-chart-empty">{t('ua.noData')}</div>
                ) : (
                  <LatencyChart data={daySeries} height={92} />
                )}
              </div>
            </div>

            <div className={`grid-row ${daySeries.length === 0 ? 'empty' : ''}`}>
              <div className="grid-row-label">
                <div className="gran-name">{t('ua.g3.name')}</div>
                <div className="gran-desc">
                  {t('ua.g3.desc')}
                  {turnSummary.turns > 0 && (
                    <>{t('ua.g3.extra', { turns: turnSummary.turns, rate: turnSummary.rate.toFixed(1) })}</>
                  )}
                </div>
              </div>
              <div className="grid-row-chart">
                {daySeries.length === 0 ? (
                  <div className="combined-chart-empty">{t('ua.noData')}</div>
                ) : (
                  <TurnChart data={daySeries} height={92} />
                )}
              </div>
            </div>

            {GRANULARITIES.map((gran, i) => {
              const data = allSeries[gran];
              const height = ROW_HEIGHT[gran];
              const isEmpty = data.length === 0;

              return (
                <div key={gran} className={`grid-row ${isEmpty ? 'empty' : ''} ${gran === 'minute' ? 'large' : ''}`}>
                  <div className="grid-row-label">
                    <div className="gran-name">{t(GRANULARITY_LABELS[gran])}</div>
                    <div className="gran-desc">{t(GRANULARITY_DESC[gran])}</div>
                    {data.length > 0 && (
                      <div className="gran-summary">
                        <span className="gran-summary-item">
                          <span className="gran-summary-dot" style={{ background: '#3b82f6' }} />
                          {formatTokens(data.reduce((s, d) => s + d.inputTokens, 0))}
                        </span>
                        <span className="gran-summary-item">
                          <span className="gran-summary-dot" style={{ background: '#10b981' }} />
                          {formatTokens(data.reduce((s, d) => s + d.outputTokens, 0))}
                        </span>
                        <span className="gran-summary-item">
                          <span className="gran-summary-dot" style={{ background: '#f59e0b' }} />
                          ${data.reduce((s, d) => s + d.costUsd, 0).toFixed(4)}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="grid-row-chart">
                    {isEmpty ? (
                      <div className="combined-chart-empty">{t('ua.noData')}</div>
                    ) : (
                      <CombinedChart data={data} height={height} showXAxis={true} showLegend={i === 0} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : subCategory === 'provider' ? (
          /* ── 模型提供商视图 ── */
          <ProviderView
            providers={providers}
            providerTotals={providerTotals}
            providerSeries={providerSeries}
            selectedProviderId={selectedProviderId}
            onSelectProvider={setSelectedProviderId}
          />
        ) : (
          /* ── 模型视图 ── */
          <ModelView
            modelTotals={modelTotals}
            modelSeries={modelSeries}
            providers={providers}
          />
        )}

        {/* ── 页脚 ── */}
        <div className="usage-analytics-footer">
          <p className="muted small">
            {t('ua.priceNote')}
          </p>
        </div>
    </div>
  );

  if (pane) return <div className="pane-host">{body}</div>;
  return <WindowOverlay className="usage-analytics-backdrop" onClick={onClose}>{body}</WindowOverlay>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ProviderView 组件（按模型提供商展示）
// ═══════════════════════════════════════════════════════════════════════════════

interface ProviderViewProps {
  providers: ModelProvider[];
  providerTotals: Map<string, { input: number; output: number; cost: number; count: number }>;
  providerSeries: Record<TimeGranularity, Map<string, TimeSeriesPoint[]>>;
  selectedProviderId: string | null;
  onSelectProvider: (id: string | null) => void;
}

function ProviderView({ providers, providerTotals, providerSeries, selectedProviderId, onSelectProvider }: ProviderViewProps) {
  const t = useT();
  // 时间范围拖放：选中的时间粒度
  const [granularity, setGranularity] = useState<TimeGranularity>('day');
  // 多选对比模式
  const [compareIds, setCompareIds] = useState<string[]>([]);
  // 对比模式是否激活（需要显式点击"对比"按钮才展示图表）
  const [isCompareMode, setIsCompareMode] = useState(false);
  
  // 获取 provider 名称
  const getProviderName = (providerId: string): string => {
    // 对于 'unknown'，显示为"未指定模型"
    if (providerId === 'unknown') {
      return t('ua.unknownModel');
    }
    const p = providers.find(p => p.id === providerId);
    // 找不到说明该 provider 已被删除（历史数据引用的旧 id），
    // 显示友好提示而不是原始 id。
    return p?.name || t('ua.deletedProvider');
  };

  // 判断 provider 是否为复合类型（统计维度用，本身不产生真实调用）
  const isCompositeProvider = (providerId: string): boolean =>
    providers.find(p => p.id === providerId)?.kind === 'composite';

  // 按 totals 排序的 provider 列表
  const sortedProviders = useMemo(() => {
    const entries = Array.from(providerTotals.entries());
    entries.sort((a, b) => b[1].cost - a[1].cost);
    return entries;
  }, [providerTotals]);

  // 当前选中 provider 的时间序列
  const selectedSeries = selectedProviderId
    ? providerSeries[granularity].get(selectedProviderId) ?? []
    : [];

  // 切换 checkbox 选中
  const toggleCompareId = (id: string) => {
    // 注意：prev 只在 setCompareIds 回调作用域内有效，外层需基于当前 compareIds 计算
    const next = compareIds.includes(id) ? compareIds.filter(x => x !== id) : [...compareIds, id];
    setCompareIds(next);
    // 取消勾选时，如果对比模式处于激活状态但选中数不足 2 个，则自动退出对比模式
    if (next.length < 2) {
      setIsCompareMode(false);
    }
  };

  // 对比模式下，生成按指标拆分的图表数据
  const compareChartData = useMemo(() => {
    if (!isCompareMode || compareIds.length < 2) return null;
    const seriesByProvider = new Map<string, TimeSeriesPoint[]>();
    for (const id of compareIds) {
      seriesByProvider.set(id, providerSeries[granularity].get(id) ?? []);
    }
    return seriesByProvider;
  }, [isCompareMode, compareIds, granularity, providerSeries]);

  if (sortedProviders.length === 0) {
    return (
      <div className="usage-grid-empty">
        <div className="empty-icon">📊</div>
        <div className="empty-title">{t('ua.providerEmpty')}</div>
      </div>
    );
  }

  return (
    <div className="provider-view">
      {/* ── Provider 汇总表格 ── */}
      <div className="provider-summary-table">
        <table>
          <thead>
            <tr>
              <th style={{ width: 40 }}></th>
              <th>{t('ua.th.provider')}</th>
              <th>{t('ua.th.inTokens')}</th>
              <th>{t('ua.th.outTokens')}</th>
              <th>{t('ua.th.cost')}</th>
              <th>{t('ua.th.msgs')}</th>
              <th>{t('ua.th.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {sortedProviders.map(([pid, totals]) => (
              <tr key={pid} className={selectedProviderId === pid ? 'selected' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={compareIds.includes(pid)}
                    onChange={() => toggleCompareId(pid)}
                    style={{ accentColor: getProviderColor(pid) }}
                  />
                </td>
                <td className="provider-name-cell">
                  <span className="provider-color-dot" style={{ background: getProviderColor(pid) }} />
                  {isCompositeProvider(pid) && (
                    <span className="model-picker-composite-icon" title={t('ua.compositeHint')}>
                      <Layers size={12} />
                    </span>
                  )}
                  {getProviderName(pid)}
                </td>
                <td>{formatTokens(totals.input)}</td>
                <td>{formatTokens(totals.output)}</td>
                <td>${totals.cost.toFixed(4)}</td>
                <td>{totals.count}</td>
                <td>
                  <button
                    className="provider-view-chart-btn"
                    onClick={() => onSelectProvider(selectedProviderId === pid ? null : pid)}
                  >
                    {selectedProviderId === pid ? t('ua.hideChart') : t('ua.viewTrend')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── 对比操作区 ── */}
      {compareIds.length === 0 && !isCompareMode ? (
        <div className="compare-controls compare-hint">
          <span>{t('ua.compareHint')}</span>
        </div>
      ) : (
        <div className="compare-controls">
          <div className="compare-label">
            <span>{t('ua.compareSelected', { n: compareIds.length })}</span>
            {compareIds.map(id => (
              <span key={id} className="compare-chip" style={{ borderColor: getProviderColor(id), color: getProviderColor(id) }}>
                {isCompositeProvider(id) && <Layers size={11} style={{ marginRight: 3, verticalAlign: 'middle' }} />}
                {getProviderName(id)}
              </span>
            ))}
            <button className="compare-clear-btn" onClick={() => { setCompareIds([]); setIsCompareMode(false); }}>{t('ua.compareClear')}</button>
          </div>
          <div className="compare-actions">
            {!isCompareMode && compareIds.length >= 2 ? (
              <button className="compare-start-btn" onClick={() => setIsCompareMode(true)}>{t('ua.compareStart')}</button>
            ) : null}
            {isCompareMode && (
              <div className="granularity-selector">
                {GRANULARITIES.map(g => (
                  <button
                    key={g}
                    className={`granularity-btn ${granularity === g ? 'active' : ''}`}
                    onClick={() => setGranularity(g)}
                  >
                    {t(GRANULARITY_LABELS[g])}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 对比模式：3 张图表（输入/输出/费用） ── */}
      {compareChartData && (
        <div className="compare-charts-section">
          {(['input', 'output', 'cost'] as const).map(metric => {
            const titles = { input: t('ua.cmp.input'), output: t('ua.cmp.output'), cost: t('ua.cmp.cost') };
            const colors = { input: '#3b82f6', output: '#10b981', cost: '#f59e0b' };
            // 把每个 provider 的数据拆出对应指标，生成多 series 数据
            const multiSeries = compareIds.map(id => {
              const points = compareChartData.get(id) ?? [];
              return {
                name: getProviderName(id),
                color: getProviderColor(id),
                data: points,
              };
            });

            return (
              <div key={metric} className="compare-chart-block">
                <h4>
                  <span className="compare-metric-dot" style={{ background: colors[metric] }} />
                  {titles[metric]}
                </h4>
                <div className="provider-chart">
                  <CompareChart
                    data={multiSeries.map(s => s.data)}
                    height={180}
                    showXAxis={true}
                    labels={multiSeries.map(s => s.name)}
                    colors={multiSeries.map(s => s.color)}
                    metric={metric}
                  />
                </div>
              </div>
            );
          })}
          <div className="time-range-info">
            <span>{t('ua.range', { desc: t(GRANULARITY_DESC[granularity]) })}</span>
          </div>
        </div>
      )}

      {/* ── 选中 provider 的时间序列图表 ── */}
      {selectedProviderId && !compareChartData && (
        <div className="provider-chart-section">
          <div className="provider-chart-header">
            <h3>
              <span className="provider-color-dot" style={{ background: getProviderColor(selectedProviderId) }} />
              {isCompositeProvider(selectedProviderId) && (
                <span className="model-picker-composite-icon" title={t('ua.compositeSimple')}>
                  <Layers size={12} />
                </span>
              )}
              {t('ua.trend', { name: getProviderName(selectedProviderId) })}
            </h3>
            
            {/* 时间粒度选择 */}
            <div className="granularity-selector">
              {GRANULARITIES.map(g => (
                <button
                  key={g}
                  className={`granularity-btn ${granularity === g ? 'active' : ''}`}
                  onClick={() => setGranularity(g)}
                >
                  {t(GRANULARITY_LABELS[g])}
                </button>
              ))}
            </div>
          </div>

          {selectedSeries.length === 0 ? (
            <div className="combined-chart-empty">{t('ua.providerNoData')}</div>
          ) : (
            <div className="provider-chart">
              <CombinedChart
                data={selectedSeries}
                height={180}
                showXAxis={true}
                showLegend={true}
              />
            </div>
          )}

          {/* 时间范围说明 */}
          <div className="time-range-info">
            <span>{t('ua.range', { desc: t(GRANULARITY_DESC[granularity]) })}</span>
            <span>{t('ua.points', { n: selectedSeries.length })}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 为 provider id 生成一致的颜色（基于 hash）
 */
function getProviderColor(providerId: string): string {
  const colors = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
  ];
  let hash = 0;
  for (let i = 0; i < providerId.length; i++) {
    hash = providerId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ModelView 组件（按模型聚合，忽略 providerId）
// ═══════════════════════════════════════════════════════════════════════════════

interface ModelViewProps {
  modelTotals: Map<string, { input: number; output: number; cost: number; count: number }>;
  modelSeries: Record<TimeGranularity, Map<string, TimeSeriesPoint[]>>;
  providers: ModelProvider[];
}

function ModelView({ modelTotals, modelSeries, providers }: ModelViewProps) {
  const t = useT();
  const [granularity, setGranularity] = useState<TimeGranularity>('day');
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);

  // 按 cost 排序的 model 列表
  const sortedModels = useMemo(() => {
    const entries = Array.from(modelTotals.entries());
    entries.sort((a, b) => b[1].cost - a[1].cost);
    return entries;
  }, [modelTotals]);

  // 计算总使用量，用于显示占比
  const totalUsage = useMemo(() => {
    return sortedModels.reduce((sum, [, totals]) => sum + totals.cost, 0);
  }, [sortedModels]);

  // 当前选中 model 的时间序列
  const selectedSeries = selectedModelId
    ? modelSeries[granularity].get(selectedModelId) ?? []
    : [];

  if (sortedModels.length === 0) {
    return (
      <div className="usage-grid-empty">
        <div className="empty-icon">📊</div>
        <div className="empty-title">{t('ua.modelEmpty')}</div>
      </div>
    );
  }

  return (
    <div className="provider-view">
      {/* ── Model 汇总表 ── */}
      <div className="provider-summary-table">
        <table>
          <thead>
            <tr>
              <th>{t('ua.th.model')}</th>
              <th>{t('ua.th.inTokens')}</th>
              <th>{t('ua.th.outTokens')}</th>
              <th>{t('ua.th.cost')}</th>
              <th>{t('ua.th.msgs')}</th>
              <th>{t('ua.th.share')}</th>
              <th>{t('ua.th.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {sortedModels.map(([mid, totals]) => {
              const pct = totalUsage > 0 ? (totals.cost / totalUsage * 100).toFixed(1) : '0.0';
              return (
                <tr key={mid} className={selectedModelId === mid ? 'selected' : ''}>
                  <td className="provider-name-cell">
                    <span className="provider-color-dot" style={{ background: getProviderColor(mid) }} />
                    {mid === 'unknown' ? t('ua.unknownModel') : <span title={mid}>{describeModelId(mid)}</span>}
                  </td>
                  <td>{formatTokens(totals.input)}</td>
                  <td>{formatTokens(totals.output)}</td>
                  <td>${totals.cost.toFixed(4)}</td>
                  <td>{totals.count}</td>
                  <td>
                    <div className="usage-pct-bar">
                      <div
                        className="usage-pct-fill"
                        style={{ width: `${pct}%`, background: getProviderColor(mid) }}
                      />
                      <span className="usage-pct-text">{pct}%</span>
                    </div>
                  </td>
                  <td>
                    <button
                      className="provider-view-chart-btn"
                      onClick={() => setSelectedModelId(selectedModelId === mid ? null : mid)}
                    >
                      {selectedModelId === mid ? t('ua.hideChart') : t('ua.viewTrend')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── 选中 model 的趋势图 ── */}
      {selectedModelId && (
        <div className="provider-chart-section">
          <div className="provider-chart-header">
            <h3>
              <span className="provider-color-dot" style={{ background: getProviderColor(selectedModelId) }} />
              {t('ua.trend', { name: selectedModelId === 'unknown' ? t('ua.unknownModel') : describeModelId(selectedModelId) })}
            </h3>
            <div className="granularity-selector">
              {GRANULARITIES.map(g => (
                <button
                  key={g}
                  className={`granularity-btn ${granularity === g ? 'active' : ''}`}
                  onClick={() => setGranularity(g)}
                >
                  {t(GRANULARITY_LABELS[g])}
                </button>
              ))}
            </div>
          </div>

          {selectedSeries.length === 0 ? (
            <div className="combined-chart-empty">{t('ua.modelNoData')}</div>
          ) : (
            <div className="provider-chart">
              <CombinedChart
                data={selectedSeries}
                height={180}
                showXAxis={true}
                showLegend={true}
              />
            </div>
          )}

          <div className="time-range-info">
            <span>{t('ua.range', { desc: t(GRANULARITY_DESC[granularity]) })}</span>
            <span>{t('ua.points', { n: selectedSeries.length })}</span>
          </div>
        </div>
      )}
    </div>
  );
}
