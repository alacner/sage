import {copyMarkdown} from '../lib/clipboard';
import {RefreshButton} from './RefreshButton';
import {channelLabel} from '../lib/channel-labels';
import {formatDateTime,useDateTimeSettings} from '../lib/date-time';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Mail, MessageCircle, Plus, Trash2, Send,
  Loader2, Pencil, TestTube, Power, Copy, Check, Link2, Unlink,
  Eye, EyeOff, CloudLightning,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { translate, useT } from '../i18n';
import { confirmDialog } from '../lib/confirm-dialog';
import { ChannelDiagnostics } from './ChannelDiagnostics';
import type { ChannelConfig } from '../../shared/types';

interface ChannelType {
  type: string;
  label: string;
  fields: Array<{
    key: string;
    label: string;
    type: string;
    required: boolean;
    placeholder?: string;
    help?: string;
    defaultValue?: string;
    options?:Array<{value:string;label:string}>;
  }>;
}

const CHANNEL_ICON: Record<string, any> = {
  email: Mail,
  wechat: MessageCircle,
  dingtalk: MessageCircle,
  feishu: MessageCircle,
  'feishu-webhook': MessageCircle,
  'feishu-app': MessageCircle,
  telegram: Send,
};

/**
 * 通知渠道管理视图。
 * 管理 email / wechat / dingtalk / feishu 等通知渠道配置。
 * 定时任务执行后，自动向绑定的渠道发送结果通知。
 */
export function ChannelsView({ onClose }: { onClose?: () => void }) {
  useDateTimeSettings();
  const t = useT();
  const project = useAppStore((s) => s.currentProject);
  const settings = useAppStore((s) => s.settings);
  /** 是否已配置 relay（显示重置 Webhook Token 按钮）。 */
  const hasRelay = !!(settings?.relayUrl && settings?.relayToken);

  const [channelTypes, setChannelTypes] = useState<ChannelType[]>([]);
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [editing, setEditing] = useState<ChannelConfig | 'new' | null>(null);
  const [selectedType, setSelectedType] = useState<string>('email');
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);
  /** 每个渠道的完整入站 URL（relay 配置后自动变为 relay 公网地址）。 */
  const [inboundUrls, setInboundUrls] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scope = useRef(project?.path);
  scope.current = project?.path;
  const channelRequest = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++channelRequest.current; }; }, []);

  const loadChannels = useCallback(async () => {
    const projectPath = project?.path;
    if (!projectPath) return;
    const request = ++channelRequest.current;
    const list = await window.api.listChannels(projectPath);
    if (mounted.current && scope.current === projectPath && request === channelRequest.current) setChannels(list);
  }, [project?.path]);

  useEffect(() => {
    void (async () => {
      const types = await window.api.listChannelTypes();
      setChannelTypes(types);
    })();
  }, []);

  useEffect(() => {
    setChannels([]);
    setInboundUrls({});
    setEditing(null);
    void loadChannels().catch(() => {});
    return () => { ++channelRequest.current; };
  }, [loadChannels]);

  useEffect(() => window.api.onMobileManagementChanged?.((event) => {
    if (event.section === 'channels' && event.projectPath === project?.path) {
      // Only refresh the list: ChannelForm owns the current unsaved draft.
      void loadChannels().catch(() => {});
    }
  }), [project?.path, loadChannels]);

  // 拉取每个渠道的完整入站 URL（IPC 会感知 relay 配置，返回 relay 公网地址或本地地址）
  // 单向渠道（email, feishu-webhook）不支持入站，跳过
  useEffect(() => {
    let live = true;
    for (const ch of channels) {
      if (!ch.inboundWebhookPath || ['email', 'feishu-webhook'].includes(ch.type)) continue;
      void window.api.getInboundUrl(ch).then((r: any) => {
        if (live && r?.url) {
          setInboundUrls((prev) => (prev[ch.id] === r.url ? prev : { ...prev, [ch.id]: r.url }));
        }
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [channels]);

  /**
   * 抽离所有渠道共享的 relay 前缀（= 完整 URL 去掉渠道自身的 webhookPath）。
   * 同一中继下所有渠道前缀相同，只在顶部显示一次 + 重置按钮，
   * 避免每个渠道都重复展示长长的完整 URL。
   */
  const relayPrefix = useMemo(() => {
    for (const ch of channels) {
      const full = inboundUrls[ch.id];
      if (full && ch.inboundWebhookPath && full.endsWith('/' + ch.inboundWebhookPath)) {
        // 去掉末尾 '/'，使「前缀 + /渠道路径」拼接时不产生双斜杠
        return full.slice(0, full.length - ch.inboundWebhookPath.length - 1);
      }
    }
    return null;
  }, [channels, inboundUrls]);

  const copyUrl = useCallback(async (id: string) => {
    // 复制完整 URL（前缀 + 渠道路径），外部平台需要完整地址
    const url = inboundUrls[id];
    if (!url) return;
    try {
      if (!await copyMarkdown(url)) { alert(t('common.copyFailed')); return; }
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch { /* ignore */ }
  }, [inboundUrls]);

  const copyPrefix = useCallback(async () => {
    if (!relayPrefix) return;
    try {
      if (!await copyMarkdown(relayPrefix)) { alert(t('common.copyFailed')); return; }
      setCopiedId('__prefix__');
      setTimeout(() => setCopiedId((c) => (c === '__prefix__' ? null : c)), 1500);
    } catch { /* ignore */ }
  }, [relayPrefix]);

  // 重置 Webhook Token（客户端自助，经 relay admin API）
  const rotateWebhook = useCallback(async () => {
    if (!hasRelay || rotating) return;
    if (!(await confirmDialog({ message: t('channels.rotateWebhookConfirm') }))) return;
    setRotating(true);
    try {
      const r = await window.api.rotateWebhookToken();
      if (r?.ok) {
        alert(t('channels.rotateWebhookDone'));
        // 清空旧 URL 缓存，强制重新拉取（新的 webhookToken 已写入 settings）
        setInboundUrls({});
        await loadChannels();
      } else {
        alert(t('channels.rotateWebhookFail') + (r?.error ? `：${r.error}` : ''));
      }
    } catch (err: any) {
      alert(t('channels.rotateWebhookFail') + `：${err?.message ?? String(err)}`);
    } finally {
      setRotating(false);
    }
  }, [hasRelay, rotating, t, loadChannels]);

  const handleSave = useCallback(async (channel: ChannelConfig) => {
    if (!project) return;
    await window.api.saveChannel(project.path, channel);
    await loadChannels();
    setEditing(null);
  }, [project, loadChannels]);

  const handleDelete = useCallback(async (id: string) => {
    if (!project) return;
    if (!(await confirmDialog({ message: t('channels.deleteConfirm'), danger: true }))) return;
    await window.api.deleteChannel(project.path, id);
    await loadChannels();
  }, [project, loadChannels]);

  const handleTest = useCallback(async (type: string, config: Record<string, string>) => {
    if (!project) return;
    setBusy(true);
    try {
      const result = await window.api.testChannel(type, config, project.path);
      if (result.ok) {
        // 回显 message_id / chat_id：ok=true 只能证明飞书收了包，证明不了“发进了你在看的那个群”。
        // 没回执时退回原文案，不要把“成功”说成比实际知道的更多。
        const receipt = result.receipt;
        alert(receipt?.messageId
          ? translate('channels.testOkReceipt', { messageId: receipt.messageId, chatId: receipt.chatId ?? '—' })
          : translate('channels.testOk'));
      } else {
        alert(translate('channels.testFail', { error: result.error ?? translate('status.relayUnknown') }));
      }
    } finally {
      setBusy(false);
    }
  }, [project]);

  // Telegram 专属：设置 webhook
  const handleSetWebhook = useCallback(async (channel: ChannelConfig) => {
    const url = inboundUrls[channel.id];
    if (!url) {
      alert(translate('channels.urlNotReady'));
      return;
    }
    setBusy(true);
    try {
      const result = await window.api.setTelegramWebhook(channel.config, url);
      if (result.ok) {
        alert(translate('channels.webhookSetOk', { url }));
      } else {
        alert(translate('channels.webhookSetFail', { error: result.error ?? translate('status.relayUnknown') }));
      }
    } finally {
      setBusy(false);
    }
  }, [inboundUrls]);

  // Telegram 专属：删除 webhook
  const handleDeleteWebhook = useCallback(async (channel: ChannelConfig) => {
    if (!(await confirmDialog({ message: t('channels.removeTelegramWebhookConfirm'), danger: true }))) return;
    setBusy(true);
    try {
      const result = await window.api.deleteTelegramWebhook(channel.config);
      if (result.ok) {
        alert(translate('channels.webhookRemoved'));
      } else {
        alert(translate('channels.webhookRemoveFail', { error: result.error ?? translate('status.relayUnknown') }));
      }
    } finally {
      setBusy(false);
    }
  }, []);

  if (!project) return null;

  return (
    <div className="channels-view">
      {/* Header */}
      <div className="sched-header">
        <h2>{t('channels.title')}</h2>
        <p className="muted small">{t('channels.subtitle')}</p>
      </div>

      <div className="channels-body">
        {/* Channel list */}
        <div className="channels-list-col">
          <div className="channels-col-actions">
            <button
              className="btn-primary channels-new-btn"
              onClick={() => { setEditing('new'); setSelectedType('email'); }}
            >
              <Plus size={14} /> {t('channels.new')}
            </button>
            {/* 公共 relay 前缀：所有渠道共享，只展示一次；重置按钮紧随其后 */}
            {hasRelay && relayPrefix ? (
              <div className="channels-prefix-row" title={`${t('channels.prefixHint')}\n${relayPrefix}`}>
                <Link2 size={12} className="channels-prefix-icon" />
                <code className="channels-prefix-url">{relayPrefix}</code>
                <button
                  className="icon-btn-sm"
                  onClick={() => void copyPrefix()}
                  title={copiedId === '__prefix__' ? t('common.copied') : t('channels.prefixCopy')}
                >
                  {copiedId === '__prefix__' ? <Check size={11} /> : <Copy size={11} />}
                </button>
                <RefreshButton
                  className="icon-btn-sm"
                  disabled={rotating}
                  onClick={() => void rotateWebhook()}
                  title={t('channels.rotateWebhookHint')}
                 loading={rotating}/>
              </div>
            ) : null}
          </div>

          {channels.length === 0 ? (
            <div className="channels-empty-state">
              <CloudLightning size={28} className="muted" />
              <p className="muted small">{t('channels.empty')}</p>
            </div>
          ) : (
            <ul className="channels-list">
              {channels.map((ch) => {
                const typeInfo = channelTypes.find((ct) => ct.type === ch.type);
                const Icon = typeInfo ? (CHANNEL_ICON[ch.type] ?? CloudLightning) : CloudLightning;
                return (
                  <li key={ch.id} className={`channel-card ${ch.enabled ? '' : 'is-disabled'}`}>
                    {/* 左侧：图标 */}
                    <div className="channel-card-icon">
                      <Icon size={16} />
                    </div>
                    {/* 中间：内容 */}
                    <div className="channel-card-body">
                      <div className="channel-card-head">
                        <span className="channel-card-name">{ch.name}</span>
                        <span className="channel-card-type">
                          {channelLabel(typeInfo?.label) ?? ch.type}
                        </span>
                        {!ch.enabled && <span className="channel-card-paused">{t('scheduled.disabled')}</span>}
                      </div>
                      {ch.lastSendAt && (
                        <div className="channel-card-meta muted small">
                          {t('channels.lastSend')}: {formatDateTime(ch.lastSendAt)}
                          {ch.lastSendStatus === 'success' ? ' ✅' : ' ❌'}
                        </div>
                      )}
                      {/* 只展示渠道自身路径段；完整 URL = 上方公共前缀 + 此路径，复制时自动拼接完整地址 */}
                      {/* 单向渠道（email, feishu-webhook）不支持入站，不显示 URL */}
                      {ch.inboundWebhookPath && !['email', 'feishu-webhook'].includes(ch.type) ? (
                        <div className="channel-card-url" title={inboundUrls[ch.id] ?? ''}>
                          <code className="channel-card-url-text">/{ch.inboundWebhookPath}</code>
                          <button
                            className="icon-btn-sm channel-card-copy"
                            onClick={(e) => { e.stopPropagation(); void copyUrl(ch.id); }}
                            title={copiedId === ch.id ? t('common.copied') : t('channels.copyFullUrl')}
                          >
                            {copiedId === ch.id ? <Check size={11} /> : <Copy size={11} />}
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {/* 右侧：操作 */}
                    <div className="channel-card-actions">
                      <button
                        className="icon-btn-sm"
                        title={ch.enabled ? t('scheduled.stop') : t('scheduled.enable')}
                        onClick={async () => {
                          if (!project) return;
                          await window.api.saveChannel(project.path, { ...ch, enabled: !ch.enabled });
                          await loadChannels();
                        }}
                      >
                        <Power size={13} />
                      </button>
                      <button
                        className="icon-btn-sm"
                        title={t('common.edit')}
                        onClick={() => { setEditing(ch); setSelectedType(ch.type); }}
                      >
                        <Pencil size={13} />
                      </button>
                      {/* Telegram 专属：设置/删除 Webhook */}
                      {ch.type === 'telegram' && ch.inboundWebhookPath ? (
                        <>
                          <button
                            className="icon-btn-sm"
                            disabled={busy || !inboundUrls[ch.id]}
                            title={t('channels.setWebhookTitle')}
                            onClick={() => void handleSetWebhook(ch)}
                          >
                            {busy ? <Loader2 size={13} className="spin" /> : <Link2 size={13} />}
                          </button>
                          <button
                            className="icon-btn-sm"
                            disabled={busy}
                            title={t('channels.removeWebhookTitle')}
                            onClick={() => void handleDeleteWebhook(ch)}
                          >
                            <Unlink size={13} />
                          </button>
                        </>
                      ) : null}
                      <button
                        className="icon-btn-sm delete-btn"
                        title={t('common.delete')}
                        onClick={() => void handleDelete(ch.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

        </div>

        {/* Edit form */}
        <div className="channels-detail-col">
          {editing ? (
            <>
            <ChannelForm
              key={editing === 'new' ? 'new' : editing.id}
              channel={editing === 'new' ? undefined : editing}
              channelTypes={channelTypes}
              selectedType={selectedType}
              onTypeChange={setSelectedType}
              onCancel={() => setEditing(null)}
              onSave={handleSave}
              onTest={handleTest}
              busy={busy}
            />
            </>
          ) : (
            <div className="channels-detail-empty">
              <CloudLightning size={32} className="muted" />
              <p className="muted small">{t('channels.hint')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Channel Form ────────────────────────────────────────────────────────────

function ChannelForm({
  channel,
  channelTypes,
  selectedType,
  onTypeChange,
  onCancel,
  onSave,
  onTest,
  busy,
}: {
  channel?: ChannelConfig;
  channelTypes: ChannelType[];
  selectedType: string;
  onTypeChange: (type: string) => void;
  onCancel: () => void;
  onSave: (channel: ChannelConfig) => void;
  onTest: (type: string, config: Record<string, string>) => void;
  busy: boolean;
}) {
  const t = useT();
  const typeInfo = channelTypes.find((ct) => ct.type === selectedType);

  const [name, setName] = useState(channel?.name ?? '');
  const [config, setConfig] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (channel) {
      Object.assign(init, channel.config);
    } else if (typeInfo) {
      for (const f of typeInfo.fields) {
        if (f.defaultValue !== undefined) init[f.key] = f.defaultValue;
      }
    }
    return init;
  });
  const [submitting, setSubmitting] = useState(false);
  // Track which password fields are visible (show plaintext instead of dots)
  const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(new Set());
  // Broadcast template (per-channel)
  const [broadcastTitle, setBroadcastTitle] = useState(channel?.broadcastTemplate?.title ?? '{{conversation}}');
  const [broadcastContent, setBroadcastContent] = useState(channel?.broadcastTemplate?.content ?? '{{content}}');
  const togglePasswordVisible = (key: string) => {
    setVisiblePasswords((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // When switching channel type, reset config to defaults
  useEffect(() => {
    if (channel) return; // editing existing
    const ti = channelTypes.find((ct) => ct.type === selectedType);
    if (!ti) return;
    const init: Record<string, string> = {};
    for (const f of ti.fields) {
      if (f.defaultValue !== undefined) init[f.key] = f.defaultValue;
    }
    setConfig(init);
  }, [selectedType, channelTypes, channel]);

  const handleConfigChange = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const now = new Date().toISOString();
      // 为支持入站的渠道自动生成 webhook 路径（如果还没有）
      // 不支持入站的类型：email（SMTP 单向）、feishu-webhook（Webhook 机器人单向）
      const outboundOnlyTypes = ['email', 'feishu-webhook'];
      let inboundPath = channel?.inboundWebhookPath;
      if (!inboundPath && !outboundOnlyTypes.includes(selectedType)) {
        const prefix = selectedType.slice(0, 4).toLowerCase();
        const suffix = Math.random().toString(36).slice(2, 10);
        inboundPath = `${prefix}_${suffix}`;
      }
      const result: ChannelConfig = {
        id: channel?.id ?? Math.random().toString(36).slice(2, 12),
        type: selectedType,
        name: name.trim(),
        enabled: channel?.enabled ?? true,
        config,
        createdAt: channel?.createdAt ?? now,
        updatedAt: now,
        lastSendStatus: channel?.lastSendStatus,
        lastSendError: channel?.lastSendError,
        lastSendAt: channel?.lastSendAt,
        inboundWebhookPath: inboundPath,
        broadcastTemplate: {
          title: broadcastTitle.trim() || '{{conversation}}',
          content: broadcastContent.trim() || '{{content}}',
        },
      };
      await onSave(result);
    } finally {
      setSubmitting(false);
    }
  };

  if (!typeInfo) return null;

  return (
    <form className="channel-form" onSubmit={submit}>
      <div className="channel-form-body">
      <h3>{channel ? t('channels.edit') : t('channels.new')}</h3>

      <label>
        {t('channels.name')}
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('channels.name.placeholder')}
          disabled={submitting}
        />
      </label>

      {!channel && (
        <label>
          {t('channels.type')}
          <select
            value={selectedType}
            onChange={(e) => onTypeChange(e.target.value)}
            disabled={submitting}
          >
            {channelTypes.map((ct) => (
              <option key={ct.type} value={ct.type}>{channelLabel(ct.label)}</option>
            ))}
          </select>
        </label>
      )}

      {typeInfo.fields.map((field) => {
        const isPassword = field.type === 'password';
        const isVisible = visiblePasswords.has(field.key);
        return (
          <label key={field.key}>
            {channelLabel(field.label)}
            {field.required && <span className="required-mark">*</span>}
            <div className={isPassword ? 'password-field-wrapper' : undefined}>
              {field.type==='select'?<select value={config[field.key]??field.defaultValue??''} disabled={submitting} onChange={e=>handleConfigChange(field.key,e.target.value)}>{field.options?.map(option=><option key={option.value} value={option.value}>{channelLabel(option.label)}</option>)}</select>:<input
                type={isPassword ? (isVisible ? 'text' : 'password')
                  : field.type === 'number' ? 'number'
                  : field.type === 'url' ? 'url'
                  : field.type === 'email' ? 'email'
                  : 'text'}
                value={config[field.key] ?? ''}
                onChange={(e) => handleConfigChange(field.key, e.target.value)}
                placeholder={channelLabel(field.placeholder)}
                disabled={submitting}
              />}
              {isPassword && (
                <button
                  type="button"
                  className="password-toggle-btn"
                  onClick={() => togglePasswordVisible(field.key)}
                  title={isVisible ? t('channels.hide') : t('channels.view')}
                  tabIndex={-1}
                >
                  {isVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              )}
            </div>
            {field.help && <span className="muted small field-help">{channelLabel(field.help)}</span>}
          </label>
        );
      })}

      {/* ─── 该渠道的广播消息模板 ─── */}
      <div className="channel-form-section-divider">
        {t('channel.broadcastTemplate.title')}
      </div>
      <label>
        {t('channel.broadcastTemplate.titleField')}
        <input
          type="text"
          value={broadcastTitle}
          onChange={(e) => setBroadcastTitle(e.target.value)}
          placeholder="{{conversation}}"
          disabled={submitting}
        />
        <span className="muted small">{t('channel.broadcastTemplate.titleHelp')}</span>
      </label>
      <label>
        {t('channel.broadcastTemplate.contentField')}
        <textarea
          value={broadcastContent}
          onChange={(e) => setBroadcastContent(e.target.value)}
          placeholder="{{content}}"
          rows={4}
          style={{ fontFamily: 'monospace', fontSize: '12px' }}
          disabled={submitting}
        />
        <span className="muted small">{t('channel.broadcastTemplate.contentHelp')}</span>
      </label>
      <p className="muted small">
        {t('channel.broadcastTemplate.help')}
      </p>

      {channel && <ChannelDiagnostics key={channel.id} channels={[{...channel,type:selectedType,config}]} scoped />}
      </div>
      <div className="modal-actions">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => void onTest(selectedType, config)}
          disabled={busy || submitting}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <TestTube size={14} />}
          {t('channels.test')}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={submitting}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn-primary" disabled={submitting || !name.trim()}>
          {submitting ? <Loader2 size={14} className="spin" /> : null}
          {t('common.save')}
        </button>
      </div>
    </form>
  );
}
