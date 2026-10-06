import {usePluginSnapshot} from './plugins/PluginWorkbench';
import {PluginSlot} from './plugins/PluginWorkbench';
import { useEffect, useRef, useState } from 'react';
import { Activity, BarChart2, Radio, Smartphone, TrendingUp } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { UsageStats, MonitorRecord, RelayStatus } from '../../shared/types';
import { useT } from '../i18n';
import { BackendEngineIcon } from './BackendEngineIcon';
import { relayErrorLabel } from '../lib/relay-status-text';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * 按 token 用量估算费用（USD）。单价参考 Claude Sonnet 定价（每百万 token）：
 * 输入 $3、输出 $15、缓存读取 $0.30、缓存写入 $3.75。
 * 仅在后端未上报真实 costUsd 时用于推算展示。
 */
const PRICE_PER_MTOK = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
function estimateCostUsd(s: UsageStats): number {
  return (
    s.inputTokens * PRICE_PER_MTOK.input +
    s.outputTokens * PRICE_PER_MTOK.output +
    s.cacheReadTokens * PRICE_PER_MTOK.cacheRead +
    s.cacheCreationTokens * PRICE_PER_MTOK.cacheWrite
  ) / 1_000_000;
}

export function StatusBar() {
  const t = useT();
  const monitorOpen = useAppStore(s=>s.monitorOpen);
  const updateStatus = useAppStore((s) => s.updateStatus);
  const preferredBackend = useAppStore((s) => s.settings?.backendEngine ?? 'api');
  const busy = useAppStore((s) => s.busyPhase);
  const currentProject = useAppStore((s) => s.currentProject);
  const conversations = useAppStore((s) => s.conversations);
  const projectStats = useAppStore((s) => s.projectStats);
  const hasTerminals = useAppStore((s) => s.openTabs.some((t) => t.kind === 'terminal'));
  const createTerminal = useAppStore((s) => s.createTerminal);

  // 图标使用插件清单里的单色几何，直连 API 使用 Sage 的鼠尾草。
  const apiProtocol = useAppStore((s) => s.settings?.apiProtocol ?? 'anthropic');
  const {snapshot}=usePluginSnapshot();
  const engine=snapshot?.plugins.find(p=>p.manifest.id===preferredBackend&&p.manifest.engine);
  const mode=preferredBackend==='api'?'Sage':engine?.manifest.name??preferredBackend;
  const ready=preferredBackend==='api'||!!engine?.enabled;
  const modeTooltip=preferredBackend==='api'?t('status.sageMode',{protocol:apiProtocol}):engine?.enabled?engine.manifest.name:'CLI 插件未安装或未在当前项目启用 / CLI plugin unavailable';

  // 项目级聚合统计：累加所有对话的 totalUsage + historicalUsage（已删除对话的历史数据）。
  // 有项目即返回（即使全 0），以便统计弹层始终可查看监控请求数。
  const stats: UsageStats | null = (() => {
    if (!currentProject) return null;
    const total: UsageStats = {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
    };
    // 1. 累加当前对话的 totalUsage
    for (const c of conversations) {
      if (!c.totalUsage) continue;
      total.inputTokens += c.totalUsage.inputTokens;
      total.outputTokens += c.totalUsage.outputTokens;
      total.cacheReadTokens += c.totalUsage.cacheReadTokens;
      total.cacheCreationTokens += c.totalUsage.cacheCreationTokens;
      total.costUsd += c.totalUsage.costUsd;
    }
    // 2. 加上 historicalUsage（已删除对话的历史累计）
    if (projectStats?.historicalUsage) {
      total.inputTokens += projectStats.historicalUsage.inputTokens;
      total.outputTokens += projectStats.historicalUsage.outputTokens;
      total.cacheReadTokens += projectStats.historicalUsage.cacheReadTokens;
      total.cacheCreationTokens += projectStats.historicalUsage.cacheCreationTokens;
      total.costUsd += projectStats.historicalUsage.costUsd;
    }
    return total;
  })();

  // 费用展示：优先用后端上报的真实费用，否则按 token 用量估算（标注 ~）。
  const reportedCost = stats?.costUsd ?? 0;
  const isEstimatedCost = reportedCost <= 0;
  const displayCost = stats ? (isEstimatedCost ? estimateCostUsd(stats) : reportedCost) : 0;
  const costLabel = `${isEstimatedCost ? '~' : ''}$${displayCost.toFixed(4)}`;

  const [showPopover, setShowPopover] = useState(false);
  const [monitorCount, setMonitorCount] = useState<number | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // ── 中继（relay）连接状态 ───────────────────────────────────────────
  // 仅当用户配置了 relayUrl + relayToken（即 settings 里 relayEnabled 标记）
  // 时才显示。通过 getRelayStatus 获取初始值 + onRelayStatus 实时推送。
  const settings = useAppStore((s) => s.settings);
  const relayEnabled = !!(
    settings?.relayEnabled &&
    settings?.relayUrl?.trim() &&
    settings?.relayToken?.trim()
  );
  const [relayConnStatus, setRelayConnStatus] = useState<RelayStatus | null>(null);
  const [relayError, setRelayError] = useState<string | undefined>(undefined);
  const [mobileOnline, setMobileOnline] = useState(0);

  useEffect(() => {
    if (!relayEnabled) {
      setRelayConnStatus(null);
      setRelayError(undefined);
      setMobileOnline(0);
      return;
    }
    let disposed = false;
    let receivedEvent = false;
    const applyStatus = (r: any) => {
      if (disposed) return;
      setRelayConnStatus(r?.status ?? 'disconnected');
      setRelayError(r?.error);
      setMobileOnline(r?.status === 'connected' && Number.isFinite(r.mobileOnline) ? Math.max(0, Math.floor(r.mobileOnline)) : 0);
    };
    const off = window.api.onRelayStatus?.((e: any) => {
      receivedEvent = true;
      applyStatus(e);
    });
    void window.api.getRelayStatus?.().then((r: any) => {
      if (!receivedEvent) applyStatus(r);
    }).catch(() => { /* A live status event or the next reconnect will refresh the indicator. */ });
    return () => {
      disposed = true;
      off?.();
    };
  }, [relayEnabled]);

  // 弹层打开时拉取当前项目的监控请求数（合并内存实时记录 + 持久化记录，按 id 去重）。
  useEffect(() => {
    if (!showPopover || !currentProject) return;
    let disposed = false;
    (async () => {
      try {
        const ids = new Set<string>();
        const live = (await window.api.listMonitor()) as MonitorRecord[];
        for (const r of live) {
          if (r.projectPath === currentProject.path) ids.add(r.id);
        }
        const persisted = (await window.api.loadMonitorProject(currentProject.path)) as MonitorRecord[];
        for (const r of persisted) ids.add(r.id);
        if (!disposed) setMonitorCount(ids.size);
      } catch {
        if (!disposed) setMonitorCount(0);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [showPopover, currentProject?.path]);

  // 点击外部关闭 popover
  useEffect(() => {
    if (!showPopover) return;
    const onDoc = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setShowPopover(false);
    };
    // 延迟一帧，防止本次 click 立即触发
    requestAnimationFrame(() => document.addEventListener('mousedown', onDoc));
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showPopover]);

  return (
    <footer className="status-bar"><PluginSlot slot="status"/>
      <button
        type="button"
        className={`status-bar-indicator status-bar-engine ${ready ? '' : 'unavailable'}`}
        title={`${modeTooltip}
${t('settings.nav.general')}`}
        aria-label={`${mode} · ${t('settings.nav.general')}`}
        onClick={() => useAppStore.getState().openSettingsTab({ initialTab: 'general' })}
      >
        <BackendEngineIcon engineId={preferredBackend} icon={engine?.manifest.icon} />
      </button>
      {relayEnabled && relayConnStatus ? (
        <button
          type="button"
          className={`status-bar-indicator relay-status relay-${relayConnStatus}`}
          onClick={() => useAppStore.getState().openSettingsTab({ initialTab: 'relay' })}
          aria-label={t(relayConnStatus === 'connected' ? 'status.relayDotOn' : relayConnStatus === 'connecting' ? 'status.relayDotConnecting' : relayConnStatus === 'error' ? 'status.relayDotError' : 'status.relayDotOff')}
          title={
            relayConnStatus === 'connected'
              ? t('status.relayConnected', { url: settings?.relayUrl ?? '' })
              : relayConnStatus === 'connecting'
                ? t('status.relayConnecting', { url: settings?.relayUrl ?? '' })
                : relayConnStatus === 'error'
                  ? t('status.relayFailed', { error: relayErrorLabel(relayError) ?? t('status.relayUnknown'), url: settings?.relayUrl ?? '' })
                  : t('status.relayOff', { url: settings?.relayUrl ?? '' })
          }
        >
          <Radio size={14} aria-hidden="true" />
        </button>
      ) : null}
      {relayEnabled && relayConnStatus === 'connected' && mobileOnline > 0 ? (
        <span className="status-bar-indicator status-bar-mobile" role="img" aria-label={t('status.mobileOnline', { count: mobileOnline })} title={t('status.mobileOnline', { count: mobileOnline })}>
          <Smartphone size={14} aria-hidden="true" />
        </span>
      ) : null}
      <button type="button" className={`status-bar-monitor ${monitorOpen ? 'active' : ''}`} title={t('monitor.title')} aria-label={t('monitor.title')} aria-pressed={monitorOpen} onClick={()=>{const s=useAppStore.getState();s.setMonitorOpen(!s.monitorOpen);}}><Activity size={14}/></button>
      {stats ? (
        <div ref={popoverRef} style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            className={`status-bar-stats ${showPopover ? 'active' : ''}`}
            onClick={() => setShowPopover(!showPopover)}
            title={t('status.statsTitle')}
          >
            <BarChart2 size={12} />
            <span>{formatTokens(stats.inputTokens + stats.outputTokens)} {t('unit.tokens')}</span>
            <span className="status-bar-stats-sep">·</span>
            <span>{costLabel}</span>
          </button>
          {showPopover ? (
            <div className="status-bar-popover">
              <div className="status-bar-popover-title">{t('status.statsTitle')}</div>
              <div className="stat-row">
                <span>{t('status.inTokens')}</span>
                <strong>{stats.inputTokens.toLocaleString()}</strong>
              </div>
              <div className="stat-row">
                <span>{t('status.outTokens')}</span>
                <strong>{stats.outputTokens.toLocaleString()}</strong>
              </div>
              <div className="stat-row">
                <span>{t('status.cacheRead')}</span>
                <strong>{stats.cacheReadTokens.toLocaleString()}</strong>
              </div>
              <div className="stat-row">
                <span>{t('status.cacheWrite')}</span>
                <strong>{stats.cacheCreationTokens.toLocaleString()}</strong>
              </div>
              <div className="stat-divider" />
              <div className="stat-row">
                <span className="stat-cost-label">{t('status.costTotal')}<small>{t('status.costQualifier')}</small></span>
                <strong>{costLabel}</strong>
              </div>
              <div className="stat-row">
                <span>{t('status.convCount')}</span>
                <strong>{conversations.length}</strong>
              </div>
              <div className="stat-row">
                <span>{t('status.monitorCount')}</span>
                <strong>{monitorCount === null ? '…' : monitorCount.toLocaleString()}</strong>
              </div>
              <div className="stat-divider" />
              <button
                className="stat-view-analytics"
                onClick={() => {
                  setShowPopover(false);
                  useAppStore.getState().openSingletonTab('analytics');
                }}
              >
                <TrendingUp size={14} />
                <span>{t('status.viewAnalytics')}</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {busy ? <span className="busy">● {busy}…</span> : null}
      <span className="flex-spacer" />
      {/* 自动更新状态指示 */}
      {(() => {
        if (!updateStatus) return null;
        if (updateStatus.phase === 'downloading') {
          return (
            <button
              type="button"
              className="status-bar-update downloading"
              title={t('status.dlTitle')}
              onClick={() => useAppStore.getState().setUpdateDialogOpen(true)}
            >
              <span>{t('status.dlLabel', { progress: typeof updateStatus.progress === 'number' ? `${updateStatus.progress}%` : '…' })}</span>
            </button>
          );
        }
        if (updateStatus.phase === 'installing') {
          return (
            <span className="status-bar-update installing" title={t('status.installTitle')}>
              <span>{t('status.installLabel')}</span>
            </span>
          );
        }
        if (updateStatus.phase === 'available' || updateStatus.phase === 'ready') {
          return (
            <button
              className="status-bar-update available"
              title={t('status.foundTitle', { version: updateStatus.latestVersion ?? '' })}
              onClick={() => useAppStore.getState().setUpdateDialogOpen(true)}
            >
              <span>{t(updateStatus.phase === 'ready' ? 'status.readyLabel' : 'status.foundLabel', { version: updateStatus.latestVersion ?? '' })}</span>
            </button>
          );
        }
        if (updateStatus.phase === 'checking') {
          return (
            <span className="status-bar-update checking" title={t('status.checkTitle')}>
              <span>{t('status.checkLabel')}</span>
            </span>
          );
        }
        return null;
      })()}
      {currentProject ? (
        <button
          className={`status-bar-btn ${hasTerminals ? 'active' : ''}`}
          onClick={() => void createTerminal()}
          title="New Terminal (Ctrl+`)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </button>
      ) : null}
    </footer>
  );
}
