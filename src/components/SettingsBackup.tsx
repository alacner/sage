import {formatDateTime,useDateTimeSettings} from '../lib/date-time';
import { BACKUP_GROUPS, type BackupGroup, type SettingsImportPreview } from '../../shared/settings-backup';
import { useState } from 'react';
import { Eye, EyeOff, Copy, RefreshCw, Download, Upload, History, FileSearch, RotateCcw, ShieldCheck } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useT } from '../i18n';
import type { SettingsVersionPreview } from '../../shared/types';
import { copyMarkdown } from '../lib/clipboard';

/** Passwords are transient component state only, never settings/localStorage. */
export function SettingsBackup({ disabled = false }: { disabled?: boolean }) {
  useDateTimeSettings();
  const t = useT();
  const settings = useAppStore(s => s.settings);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [apiKey, setApiKey] = useState(true);
  const [apiHost, setApiHost] = useState(false);
  const [exportGroups,setExportGroups] = useState<BackupGroup[]>([...BACKUP_GROUPS]);
  const [importPreview,setImportPreview] = useState<SettingsImportPreview|null>(null);
  const [importGroups,setImportGroups] = useState<BackupGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [versions, setVersions] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [preview, setPreview] = useState<SettingsVersionPreview | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await fn(); } catch (e: any) { setMessage(e?.message ?? String(e)); }
    finally { setBusy(false); }
  };
  const clearPassword = () => { setPassword(''); setShowPassword(false); };
  const blocked = busy || disabled;
  const iconSize = 15;
  return <section className="settings-card settings-backup" aria-label={t('backup.title')}>
    <div className="backup-heading"><ShieldCheck size={20} /><div><h3>{t('backup.title')}</h3><p className="muted small">{t('backup.help')}</p></div></div>
    <div className="backup-section">
      <label className="backup-label" htmlFor="backup-passphrase">{t('backup.passLabel')}</label>
      <div className="backup-password-row">
        <div className="password-input-wrap">
          <input id="backup-passphrase" type={showPassword ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={password} disabled={blocked} onChange={e => setPassword(e.target.value)} />
          <button type="button" className="password-toggle" disabled={blocked} title={t(showPassword ? 'settings.apiKey.hide' : 'settings.apiKey.show')} aria-label={t(showPassword ? 'settings.apiKey.hide' : 'settings.apiKey.show')} onClick={() => setShowPassword(v => !v)}>{showPassword ? <EyeOff size={iconSize} /> : <Eye size={iconSize} />}</button>
        </div>
        <button type="button" className="btn-ghost" disabled={blocked} onClick={() => {
          // 32 uniformly distributed characters from a 64-symbol alphabet (192 bits).
          const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
          setPassword(Array.from(crypto.getRandomValues(new Uint8Array(32)), b => alphabet[b & 63]).join(''));
          setMessage(t('backup.generated'));
        }}><RefreshCw size={iconSize} />{t('backup.generate')}</button>
        <button type="button" className="btn-ghost" disabled={blocked || !password} onClick={() => void run(async () => { if (!await copyMarkdown(password)) throw new Error(t('common.copyFailed')); setMessage(t('backup.copied')); })}><Copy size={iconSize} />{t('backup.copy')}</button>
      </div>
      <p className="muted small">{t('backup.passHelp')}</p>
    </div>
    <div className="backup-section">
      <div className="backup-history-heading"><h4>{t('backup.sections')}</h4><button type="button" className="btn-ghost" disabled={blocked} onClick={()=>setExportGroups(exportGroups.length===BACKUP_GROUPS.length?[]:[...BACKUP_GROUPS])}>{t(exportGroups.length===BACKUP_GROUPS.length?'backup.selectNone':'backup.selectAll')}</button></div>
      <div className="backup-section-options">{BACKUP_GROUPS.map(id=><label key={id}><input type="checkbox" disabled={blocked} checked={exportGroups.includes(id)} onChange={e=>setExportGroups(e.target.checked?[...exportGroups,id]:exportGroups.filter(g=>g!==id))}/><span>{t(`backup.group.${id}`)}</span></label>)}</div>
      <p className="muted small">{t('backup.sectionsHelp')}</p>
    </div>
    <div className="backup-section">
      <h4>{t('backup.redactTitle')}</h4>
      <div className="backup-protection-grid">
        <label className="backup-protection"><input type="checkbox" checked={apiKey || !!settings?._secretPolicy?.apiKey} disabled={blocked || settings?._secretPolicy?.apiKey} onChange={e => setApiKey(e.target.checked)} /><span><strong>{t('backup.redApiKey')}</strong><small>{t('backup.keyHelp')}</small></span></label>
        <label className="backup-protection"><input type="checkbox" checked={apiHost || !!settings?._secretPolicy?.apiHost} disabled={blocked || settings?._secretPolicy?.apiHost} onChange={e => setApiHost(e.target.checked)} /><span><strong>{t('backup.redApiHost')}</strong><small>{t('backup.hostHelp')}</small></span></label>
      </div>
      <p className="muted small">{t('backup.redactHelp')}</p>
      <button type="button" className="btn-primary" disabled={blocked || password.length < 12 || !exportGroups.length} onClick={() => void run(async () => {
        const r = await window.api.exportSettings({ password, policy: { apiKey, apiHost }, groups: exportGroups });
        setMessage(r.canceled ? t('backup.exportCancel') : t('backup.exportOk'));
        if (!r.canceled) clearPassword();
      })}><Download size={iconSize} />{t('backup.exportBtn')}</button>
    </div>
    <div className="backup-section">
      <div className="backup-history-heading"><h4>{t('backup.importTitle')}</h4><button type="button" className="btn-ghost" disabled={blocked || !password} onClick={() => void run(async () => {
        const r=await window.api.previewSettingsImport(password);
        if(!r.canceled && r.preview){setImportPreview(r.preview);setImportGroups(r.preview.groups.map(g=>g.id));clearPassword();}
      })}><Upload size={iconSize}/>{t('backup.pickPreview')}</button></div>
      <p className="muted small">{t('backup.importSectionsHelp')}</p>
      {importPreview && <div className="backup-import-preview">
        {!importPreview.currentReadable && <p role="alert">{t('backup.unreadable')}</p>}
        {importPreview.groups.map(g=><div className="backup-import-section" key={g.id}><div><strong>{t(`backup.group.${g.id}`)}</strong><p className="muted small">{g.fields.length} {t('backup.fields')}{g.providerCount!==undefined?` · ${g.providerCount} ${t('backup.providersCount')}`:''}</p><details><summary>{t('backup.fieldList')}</summary><p className="muted small">{g.fields.join(' · ')||t('backup.defaults')}</p></details></div><select aria-label={t(`backup.group.${g.id}`)} disabled={blocked} value={importGroups.includes(g.id)?'overwrite':'ignore'} onChange={e=>setImportGroups(e.target.value==='overwrite'?[...importGroups,g.id]:importGroups.filter(id=>id!==g.id))}><option value="overwrite">{t('backup.overwrite')}</option><option value="ignore">{t('backup.ignore')}</option></select></div>)}
        <div className="backup-password-row"><button type="button" className="btn-primary" disabled={blocked||!importGroups.length} onClick={()=>void run(async()=>{
          await window.api.applySettingsImport(importPreview.ticket,importGroups);
          await useAppStore.getState().refreshSettings();setImportPreview(null);setPreview(null);setMessage(t('backup.imported'));
        })}>{t('backup.applySections')}</button><button type="button" className="btn-ghost" disabled={blocked} onClick={()=>setImportPreview(null)}>{t('backup.cancelImport')}</button></div>
      </div>}
    </div>
    <div className="backup-section">
      <div className="backup-history-heading"><h4><History size={16} />{t('backup.historyTitle')}</h4><button type="button" className="btn-ghost" disabled={blocked} onClick={() => void run(async () => { setVersions(await window.api.settingsVersions()); setHistoryOpen(true); })}><RefreshCw size={iconSize} />{t(historyOpen ? 'backup.refreshHistory' : 'backup.historyBtn')}</button></div>
      {historyOpen && <div className="backup-history-layout">
        <div className="backup-history-list" aria-label={t('backup.historyTitle')}>
          {!versions.length && <p className="muted small">{t('backup.noHistory')}</p>}
          {versions.map(name => <button key={name} type="button" className={`backup-version ${preview?.name === name ? 'active' : ''}`} disabled={blocked} onClick={() => void run(async () => { setPreview(await window.api.previewSettingsVersion(name)); })}>
            <FileSearch size={16} /><span><strong>{formatDateTime(Number(name.split('-')[0]))}</strong><small>{name.slice(-13, -5)}</small></span><span className="backup-preview-label">{t('backup.preview')}</span>
          </button>)}
        </div>
        <div className="backup-preview">
          {!preview ? <p className="muted">{t('backup.previewHelp')}</p> : <>
            <div className="backup-history-heading"><div><h4>{t('backup.previewTitle')}</h4><p className="muted small">{formatDateTime(preview.createdAt)}</p></div><button type="button" className="btn-primary" disabled={blocked} onClick={() => void run(async () => {
              const r = await window.api.restoreSettings(preview.name, preview.revision);
              if (!r.canceled) { await useAppStore.getState().refreshSettings(); setMessage(t('backup.restored')); setPreview(null); setVersions(await window.api.settingsVersions()); }
            })}><RotateCcw size={iconSize} />{t('backup.restoreBtn')}</button></div>
            <p className="muted small">{t('backup.previewScope')}</p>
            {preview.providers.map(p => <div className="backup-preview-provider" key={p.id}><div className="backup-history-heading"><strong>{p.name}</strong><span className={`backup-change ${p.change}`}>{t(`backup.change.${p.change}`)}</span></div><p className="muted small">{p.kind} · {t(p.enabled ? 'backup.enabled' : 'backup.disabled')} · API Key: {t(p.keyConfigured ? 'backup.configured' : 'backup.empty')}</p><p className="backup-host">API Host: {p.apiHost || '—'}</p><div className="backup-model-tags">{p.models.map((m, i) => <span key={i}>{m}</span>)}</div></div>)}
            {preview.removedProviders.length > 0 && <p className="backup-removed">{t('backup.removed')}: {preview.removedProviders.join('、')}</p>}
            <div className="backup-diff"><table><thead><tr><th>{t('backup.setting')}</th><th>{t('backup.current')}</th><th>{t('backup.version')}</th></tr></thead><tbody>{preview.preferences.map(p => <tr key={p.key} className={p.before !== p.after ? 'changed' : ''}><td>{t(`backup.pref.${p.key}`)}</td><td>{p.before}</td><td>{p.after}</td></tr>)}</tbody></table></div>
          </>}
        </div>
      </div>}
    </div>
    {message && <p className="backup-message" role="status">{message}</p>}
  </section>;
}
