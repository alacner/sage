import {WindowOverlay} from './WindowOverlay';
import { resolveLanguage } from '../../shared/language';
import { useEffect, useState } from 'react';
import { Download, CheckCircle2, Loader2, AlertTriangle, X, RotateCcw, RefreshCw } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useT } from '../i18n';

function prettyBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

/**
 * 自动更新弹窗：展示新版本信息 / 下载进度 / 错误。
 * 由 appStore.updateDialogOpen 控制显隐。
 */
export function UpdateDialog() {
  const status = useAppStore((s) => s.updateStatus);
  const open = useAppStore((s) => s.updateDialogOpen);
  const setOpen = useAppStore((s) => s.setUpdateDialogOpen);
  const installUpdate = useAppStore((s) => s.installUpdate);
  const checkUpdate = useAppStore((s) => s.checkUpdate);
  const cancelUpdate = useAppStore((s) => s.cancelUpdate);
  const [cancelling, setCancelling] = useState(false);
  const switchUpdate = useAppStore((s) => s.switchUpdate);
  const dismissSuperseded = useAppStore((s) => s.dismissSuperseded);
  const [installing, setInstalling] = useState(false);
  const [switching, setSwitching] = useState(false);
  const t = useT();
  const language = useAppStore(s => s.settings?.language);
  const en = resolveLanguage(language,useAppStore.getState().settings?._systemLocale) === 'en';

  // 弹窗打开期间订阅状态变化，下载完成自动进入安装
  useEffect(() => {
    if (!open) return;
    // 初始拉一次当前状态
    void window.api.updateStatusGet?.().then((s: any) => {
      if (s) useAppStore.setState({ updateStatus: s });
    }).catch(() => {});
  }, [open]);

  if (!open || !status) return null;

  const phase = status.phase;
  const canInstall = phase === 'available' || phase === 'downloading' || phase === 'ready';
  // 兼容未携带 errorPhase 的旧状态，下载失败仍应提供续传入口。
  const downloadError = status.errorPhase === 'download' || (!status.errorPhase
    && !!status.latestVersion && /^更新失败[:：]/.test(status.error ?? ''));

  const handleInstall = async (restart = false) => {
    if (installing) return;
    setInstalling(true);
    try {
      await installUpdate(restart);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <WindowOverlay className="modal-backdrop" aria-label={t('update.title')} onEscape={() => setOpen(false)} onClick={() => setOpen(false)}>
      <div className="modal update-modal" onClick={(e) => e.stopPropagation()}>
        <div className="update-modal-header">
          <h2>{t('update.title')}</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} title={t('common.close')}>
            <X size={16} />
          </button>
        </div>

        {/* 错误 */}
        {phase === 'error' ? (
          <div className="update-modal-body">
            <div className="update-error">
              <AlertTriangle size={16} />
              <span>{status.error ?? t('update.errorFallback')}</span>
            </div>
            <div className="update-modal-actions">
              <button className="btn-ghost" onClick={() => setOpen(false)}>{t('common.close')}</button>
              {downloadError ? <>
                <button className="btn-ghost" disabled={installing} onClick={() => void handleInstall(true)}><RotateCcw size={14} />{t('update.restartDownload')}</button>
                <button className="btn-primary" disabled={installing} onClick={() => void handleInstall()}><RefreshCw size={14} />{t('update.retryDownload')}</button>
              </> : <button className="btn-primary" onClick={() => void checkUpdate()}>{t('update.retryCheck')}</button>}
            </div>
          </div>
        ) : (<div className="update-modal-body">
            {/* 版本信息 */}
            <div className="update-versions">
              <div className="update-version-current">
                <span className="muted small">{t('update.clientVersion')}</span>
                <strong>v{status.currentVersion}</strong>
              </div>
              {status.latestVersion && (
                <>
                  <span className="update-version-arrow">→</span>
                  <div className="update-version-latest">
                    <span className="muted small">{t('update.serverVersion')}</span>
                    <strong>v{status.latestVersion}</strong>
                  </div>
                </>
              )}
            </div>

            {/* 更新说明 */}
            {status.notes ? (
              <div className="update-notes">
                <div className="muted small" style={{ marginBottom: 4 }}>{t('update.notes')}</div>
                <pre className="update-notes-content">{status.notes}</pre>
              </div>
            ) : null}

            {/* 下载进度 */}
            {phase === 'downloading' && (
              <div className="update-progress">
                <div className="update-progress-bar">
                  <div
                    className="update-progress-fill"
                    style={{ width: `${status.progress ?? 0}%` }}
                  />
                </div>
                <span className="muted small">
                  {typeof status.progress === 'number'
                    ? `${status.progress}%`
                    : t('update.downloading')}
                  {status.received !== undefined && status.total
                    ? ` · ${prettyBytes(status.received)} / ${prettyBytes(status.total)}`
                    : ''}
                </span>
              </div>
            )}

            {/* 下载中发现了更新的版本：切换 or 继续 */}
            {(phase === 'downloading' || phase === 'ready') && status.supersededBy && (
              <div className="update-superseded">
                <div className="update-superseded-text">
                  <AlertTriangle size={14} />
                  <span>
                    {t('update.superseded', {
                      version: status.supersededBy,
                      current: status.latestVersion ?? '',
                    })}
                  </span>
                </div>
                <div className="update-modal-actions">
                  <button
                    className="btn-ghost"
                    disabled={switching}
                    onClick={() => phase === 'ready' ? void handleInstall() : void dismissSuperseded()}
                  >
                    {phase === 'ready' ? (en ? 'Install downloaded version' : '安装已下载版本') : t('update.keepCurrent')}
                  </button>
                  <button
                    className="btn-primary"
                    disabled={switching}
                    onClick={async () => {
                      setSwitching(true);
                      try { await switchUpdate(); } finally { setSwitching(false); }
                    }}
                  >
                    <Loader2 size={13} className={switching ? 'spin' : undefined} style={switching ? undefined : { display: 'none' }} />
                    {t('update.switchToNew')}
                  </button>
                </div>
              </div>
            )}

            {phase === 'ready' && <p role="status">{en ? 'Download complete. You can keep working and install when ready.' : '下载已完成，你可以继续工作，准备好后再安装。'}</p>}
            {/* 安装中 */}
            {phase === 'installing' && (
              <div className="update-installing">
                <Loader2 size={14} className="spin" />
                <span className="muted small">{t('update.installing')}</span>
              </div>
            )}

            {/* 检查中 */}
            {phase === 'checking' && (
              <div className="update-installing">
                <Loader2 size={14} className="spin" />
                <span className="muted small">{t('update.checking')}</span>
              </div>
            )}

            {/* 已是最新 */}
            {phase === 'not-available' && (
              <div className="update-latest-ok">
                <CheckCircle2 size={16} />
                <span>
                  {status.latestVersion && status.latestVersion !== status.currentVersion
                    ? t('update.latestWithServer', { server: status.latestVersion, client: status.currentVersion })
                    : t('update.latest')}
                </span>
              </div>
            )}

            {/* 未配置 */}
            {!status.configured && phase === 'idle' && (
              <div className="update-unconfigured muted small">
                {t('update.notConfigured')}
              </div>
            )}

            <div className="update-modal-actions">
              <button className="btn-ghost" onClick={() => setOpen(false)}>
                {t('update.later')}
              </button>
              {phase === 'idle' && status.configured && (
                <button className="btn-primary" onClick={() => void checkUpdate()}>
                  {t('update.check')}
                </button>
              )}
              {(phase === 'downloading' || phase === 'ready') && <button className="btn-ghost" onClick={() => void checkUpdate()}>{en ? 'Check for a newer version' : '检查新版本'}</button>}
              {phase === 'downloading' && <button className="btn-ghost" disabled={cancelling} onClick={async()=>{setCancelling(true);try {await cancelUpdate();} finally {setCancelling(false);}}}>{en ? 'Cancel download' : '取消下载'}</button>}
              {canInstall && (
                <button
                  className="btn-primary"
                  onClick={() => void handleInstall()}
                  disabled={installing || phase === 'downloading'}
                >
                  {phase === 'downloading' ? (
                    <><Loader2 size={13} className="spin" /> {t('update.downloading')}</>
                  ) : (
                    <><Download size={13} /> {phase === 'ready' ? (en ? 'Install downloaded update' : '安装已下载版本') : t('update.downloadInstall')}</>
                  )}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </WindowOverlay>
  );
}
