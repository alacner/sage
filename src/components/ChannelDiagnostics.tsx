import {copyMarkdown} from '../lib/clipboard';
import {RefreshButton} from './RefreshButton';
/**
 * 渠道诊断面板
 *
 * 存在的理由：「点测试 → 提示成功 → 飞书里没看到」这句话里，光靠 ok 无法回答
 * 任何一个具体问题。出站成功只代表飞书 API 收了包，入站没消息可能是长连接没连上、
 * 可能是事件推来了但 chat_id 对不上、也可能是对上了但注入失败。
 * 这个面板把主进程埋的链路事件按「最早断掉的一环」给出结论（diagnoseChannelFlow）。
 *
 * 为什么不在 website/relay 上加日志：飞书 websocket 模式下，出站直连
 * open.feishu.cn，入站由官方 SDK 直连飞书，relay 只透传 webhook 模式的回调，
 * 那条链路根本不经过服务端 —— 要看得清，只能埋在客户端这里。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Check, FileText, Trash2 } from 'lucide-react';
import { translate, useT } from '../i18n';
import { formatDateTime } from '../lib/date-time';
import { channelDiagKey, diagnoseChannelFlow } from '../../shared/channel-diagnostics';
import type { ChannelDiagEvent } from '../../shared/channel-diagnostics';
import type { ChannelConfig } from '../../shared/types';

/** 缓冲区会一直长，面板只渲染最近这么多条（全量在落盘日志里）。 */
const MAX_ROWS = 200;

/** 主进程 feishuConnectionStatus() 的返回形状。 */
interface WsConn {
  appId: string;
  state: string;
  channelCount: number;
  lastConnectTime?: number;
  reconnectAttempts: number;
}

/**
 * 把文案里没能被参数替换的 {xxx} 填成—。
 * detail 里有哪些字段取决于具体事件（token 失败就只有 appId/code），
 * 留着原样花括号会让结论读不通。
 */
function fillParams(text: string, params: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_m, key: string) => String(params[key] ?? '—'));
}

export function ChannelDiagnostics({ channels, scoped = false }: { channels: ChannelConfig[]; scoped?: boolean }) {
  const t = useT();
  const [events, setEvents] = useState<ChannelDiagEvent[]>([]);
  const [logPath, setLogPath] = useState('');
  const [connections, setConnections] = useState<WsConn[]>([]);
  const [selectedFilter, setFilterKey] = useState('');
  const filterKey = scoped && channels[0] ? channelDiagKey(channels[0].type,channels[0].config) : selectedFilter;
  const [copied, setCopied] = useState(false);

  /**
   * 渠道是项目级配置，日志也按「项目 + 渠道」隔离：面板只报本渠道自己那份日志的路径，
   * 拿不到项目时（全局视图）主进程会退到无归属事件的兜底文件。
   */
  const projectPath = channels.find((ch) => ch.projectPath)?.projectPath;
  const scopedChannelKey = scoped && channels[0] ? channelDiagKey(channels[0].type, channels[0].config) : undefined;

  const reload = useCallback(async () => {
    const [list, path, conns] = await Promise.all([
      window.api.listChannelDiag(),
      window.api.getChannelDiagPath({ projectPath, channelKey: scopedChannelKey }),
      window.api.getFeishuConnStatus(),
    ]);
    setEvents(list ?? []);
    setLogPath(path ?? '');
    setConnections(conns ?? []);
  }, [projectPath, scopedChannelKey]);

  useEffect(() => { void reload(); }, [reload]);

  // 主进程每产生一条事件就推一条：入站消息是飞书推过来的，
  // 渲染层没有任何触发动作，不推就只能反复点刷新才能看到新行。
  useEffect(() => {
    const off = window.api.onChannelDiag((e) => {
      setEvents((prev) => [...prev, e].slice(-MAX_ROWS * 2));
    });
    return () => { off(); };
  }, []);

  /**
   * 按渠道过滤时保留没有 channelKey 的事件（全局环节），
   * 否则按某个渠道筛会把 config/token 这类没绑定渠道的行一起滤掉。
   */
  const visible = useMemo(
    () => (filterKey ? events.filter((e) => e.channelKey === filterKey || (!e.channelKey && (!scoped || (e.detail?.appId && channels.some(ch => ch.type === e.channelType && String(ch.config.appId || '').startsWith(String(e.detail?.appId))))))) : events),
    [events, filterKey, scoped, channels],
  );
  const visibleConnections = connections.filter(c => !scoped || channels.some(ch => ch.type === 'feishu-app' && ch.config.appId === c.appId && ch.config.connectionMode === 'websocket'));
  const rows = useMemo(() => [...visible].slice(-MAX_ROWS).reverse(), [visible]);
  const verdict = useMemo(() => diagnoseChannelFlow(visible), [visible]);
  const healthy = verdict.stage === 'healthy';
  // 健康结论里若拿不到出站回执就退成短句，避免渲染出 "message_id=—、会话 —" 这种读不通的长句
  const verdictHintKey = healthy && verdict.hintKey === 'channels.diag.hint.healthy'
    && verdict.params.messageId === undefined && verdict.params.chatId === undefined
    ? 'channels.diag.hint.healthyShort' : verdict.hintKey;

  const copyPath = useCallback(async () => {
    if (!logPath) return;
    try {
      if (!await copyMarkdown(logPath)) { alert(t('common.copyFailed')); return; }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 剪贴板不可用时静默，路径本来就显示在旁边可手动复制 */ }
  }, [logPath]);

  return (
    <div className="channel-diag">
      <div className="channel-diag-head">
        <span className="channel-diag-title">
          <Activity size={13} /> {t('channels.diag.title')}
        </span>
        {!scoped && <select
          className="channel-diag-filter"
          value={filterKey}
          onChange={(e) => setFilterKey(e.target.value)}
          title={t('channels.diag.filterHint')}
        >
          <option value="">{t('channels.diag.allChannels')}</option>
          {channels.map((ch) => (
            <option key={ch.id} value={channelDiagKey(ch.type, ch.config)}>{ch.name}</option>
          ))}
        </select>}
        <RefreshButton type="button" className="icon-btn-sm" onClick={() => void reload()} title={t('channels.diag.refresh')}/>
        <button
          type="button" className="icon-btn-sm"
          onClick={() => { setEvents([]); if (!scoped) void window.api.clearChannelDiag(); }}
          title={t('channels.diag.clearHint')}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* 结论：整块面板唯一需要读懂的一行 */}
      <div className={`channel-diag-verdict ${healthy ? 'is-ok' : 'is-bad'}`}>
        <span className="channel-diag-badge">{t(`channels.diag.stage.${verdict.stage}`)}</span>
        <span className="channel-diag-hint">{fillParams(t(verdictHintKey, verdict.params), verdict.params)}</span>
      </div>

      {visibleConnections.length > 0 && (
        <div className="channel-diag-ws" title={t('channels.diag.wsHint')}>
          {visibleConnections.map((c) => (
            <span key={c.appId} className={`channel-diag-ws-pill is-${c.state}`}>
              {c.appId} · {t(`channels.diag.ws.${c.state}`)}
              {c.reconnectAttempts > 0 ? ` ×${c.reconnectAttempts}` : ''}
            </span>
          ))}
        </div>
      )}

      {!healthy && <div className="channel-diag-hintline">{t('channels.diag.probeHint')}</div>}

      {rows.length === 0 ? (
        <div className="channel-diag-empty muted small">{t('channels.diag.empty')}</div>
      ) : (
        <ul className="channel-diag-rows">
          {rows.map((e, i) => (
            // 事件没有 id，同一毫秒也可能来两条；用序号即可（列表只追加、不重排）
            <li key={`${e.ts}-${i}`} className={`channel-diag-row ${e.ok ? '' : 'is-bad'}`} title={`${e.stage}/${e.reason}`}>
              <span className="channel-diag-time">{formatDateTime(e.ts, 'HH:mm:ss')}</span>
              <span className="channel-diag-stage">{t(`channels.diag.stage.${e.stage}`)}</span>
              <span className="channel-diag-code">{e.reason}</span>
              <span className="channel-diag-detail">
                {Object.entries(e.detail ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* 日志按「项目 + 渠道」分文件，路径要能一眼看出是哪一份 */}
      {logPath && (
        <div className="channel-diag-path">
          <code className="channel-diag-path-text" title={logPath}>{logPath}</code>
          <button type="button" className="icon-btn-sm" onClick={() => void copyPath()}
            title={copied ? translate('common.copied') : `${t('channels.diag.copyPath')}：${logPath}`}
          >
            {copied ? <Check size={12} /> : <FileText size={12} />}
          </button>
        </div>
      )}
    </div>
  );
}
