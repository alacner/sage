import { useEffect, useMemo, useState } from 'react';
import { Keyboard, Lock, RotateCcw, Search, Trash2, Pencil } from 'lucide-react';
import {
  SHORTCUT_DEFS,
  SHORTCUT_GROUPS,
  acceleratorFromEvent,
  effectiveAccelerator,
  findShortcutDef,
  formatAccelerator,
  isValidAccelerator,
  isFnAccelerator,
} from '../../shared/shortcuts';
import { useT } from '../i18n';
import type { ComposerShortcut, ShortcutAvailability } from '../../shared/composer-shortcuts';

/**
 * 设置 → 键盘快捷键：汇总应用内全部快捷键，可自定义项支持录制改键 / 未分配 / 恢复默认。
 * 存储为 diff（settings.shortcuts）：字符串=重映射、null=未分配、缺省=默认。
 */
export function ShortcutsSettings({
  shortcuts,
  persist,
}: {
  shortcuts?: Record<string, string | null>;
  persist: (patch: { shortcuts?: Record<string, string | null> }) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState('');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [availability, setAvailability] = useState<Partial<Record<ComposerShortcut, ShortcutAvailability>>>({});
  const [permissionError, setPermissionError] = useState('');
  useEffect(() => {
    let current = true;
    const probe = () => { void window.api.probeComposerShortcuts?.().then(result => { if (current) setAvailability(result); }).catch(() => { if (current) setAvailability({}); }); };
    probe();
    window.addEventListener('focus', probe);
    const timer = window.setInterval(probe, 3000);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener('focus', probe); };
  }, [shortcuts]);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  // 录制：捕获下一次按键组合；Esc 取消；纯修饰键/非法组合继续等待。
  useEffect(() => {
    if (!recordingId) return;
    const save = (accel: string) => {
      if (!isValidAccelerator(accel)) return;
      if (isFnAccelerator(accel) && recordingId !== 'voiceHold' && recordingId !== 'voiceToggle') return;
      const next = { ...(shortcuts ?? {}) };
      if (accel === findShortcutDef(recordingId)?.default) delete next[recordingId];
      else next[recordingId] = accel;
      persist({ shortcuts: next }); setRecordingId(null);
    };
    const fnRecording = recordingId === 'voiceHold' || recordingId === 'voiceToggle';
    window.api.setFnShortcutRecording?.(true, fnRecording);
    const offFn = window.api.onFnShortcutRecorded?.(save);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) { setRecordingId(null); return; }
      const accel = acceleratorFromEvent(e);
      if (!accel || !isValidAccelerator(accel)) return;
      save(accel);
    };
    // capture 阶段拦截，避免触发正在监听的全局快捷键本身
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); offFn?.(); window.api.setFnShortcutRecording?.(false); };
  }, [recordingId, shortcuts, persist]);

  const rows = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    return SHORTCUT_GROUPS.map((group) => ({
      group,
      items: SHORTCUT_DEFS.filter((d) => d.group === group).filter((d) => {
        if (!keyword) return true;
        const hay = [d.id, t(`settings.shortcuts.${d.id}`), t(`settings.shortcuts.${d.id}.desc`), d.default].join(' ').toLowerCase();
        return hay.includes(keyword);
      }),
    })).filter((g) => g.items.length > 0);
  }, [filter, t]);

  // 冲突检测：同一 accelerator 被多个 id 占用时标红提示。
  const usedBy = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const d of SHORTCUT_DEFS) {
      const acc = effectiveAccelerator(d.id, shortcuts);
      if (!acc) continue;
      const key = formatAccelerator(acc,isMac).toLowerCase();
      map.set(key, [...(map.get(key) ?? []), d.id]);
    }
    return map;
  }, [shortcuts]);

  const hasOverrides = shortcuts && Object.keys(shortcuts).length > 0;
  const clearOverride = (id: string) => {
    const next = { ...(shortcuts ?? {}) };
    delete next[id];
    persist({ shortcuts: next });
  };
  const unassign = (id: string) => persist({ shortcuts: { ...(shortcuts ?? {}), [id]: null } });

  return (
    <div className="shortcuts-settings" data-shortcut-recording={recordingId ? 'true' : undefined}>
      <div className="shortcuts-header">
        <h3><Keyboard size={15} /> {t('settings.shortcuts.title')}</h3>
        <button type="button" className="btn-secondary" disabled={!hasOverrides} onClick={() => persist({ shortcuts: {} })}>
          {t('settings.shortcuts.resetAll')}
        </button>
      </div>
      <p className="muted small">{t('settings.shortcuts.note')}</p>
      <p className="muted small">{t('settings.shortcuts.composerNote')}</p>
      {Object.values(availability).includes('permission-required') && <div role="status" className="settings-card">
        <p>{t('settings.shortcuts.priorityPermission')}</p>
        <button type="button" className="btn-secondary" onClick={() => {
          setPermissionError('');
          void window.api.requestComposerShortcutPriority?.().catch(error => setPermissionError(String(error)));
        }}>{t('settings.shortcuts.priorityEnable')}</button>
        {permissionError && <p role="alert">{permissionError}</p>}
      </div>}
      {Object.values(availability).includes('priority-ready') && <p role="status" className="muted small">{t('settings.shortcuts.priorityReady')}</p>}
      {Object.values(availability).includes('priority-limited') && <p role="status" className="warning">{t('settings.shortcuts.priorityLimited')}</p>}
      <label className="shortcuts-search">
        <Search size={14} />
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('settings.shortcuts.search')} aria-label={t('settings.shortcuts.search')} />
      </label>
      {rows.map(({ group, items }) => (
        <div className="settings-card shortcuts-group" key={group}>
          <div className="shortcuts-group-title">{t(`settings.shortcuts.group.${group}`)}</div>
          {items.map((d) => {
            const acc = effectiveAccelerator(d.id, shortcuts);
            const display = formatAccelerator(acc, isMac);
            const overridden = Boolean(shortcuts && Object.prototype.hasOwnProperty.call(shortcuts, d.id));
            const conflicts = acc ? (usedBy.get(formatAccelerator(acc,isMac).toLowerCase())?.filter((id) => id !== d.id) ?? []) : [];
            const recording = recordingId === d.id;
            return (
              <div className={`shortcut-row${conflicts.length ? ' has-conflict' : ''}`} key={d.id}>
                <div className="shortcut-text">
                  <strong>{t(`settings.shortcuts.${d.id}`)}</strong>
                  <p>{t(`settings.shortcuts.${d.id}.desc`)}</p>
                  {availability[d.id as ComposerShortcut] === 'global-ready' && <p role="status" className="muted small">{t('settings.shortcuts.globalReady')}</p>}
                  {availability[d.id as ComposerShortcut] === 'unavailable' && <p role="status" className="warning">{t('settings.shortcuts.unavailable')}</p>}
                  {availability[d.id as ComposerShortcut] === 'native-unavailable' && <p role="status" className="warning">{t('settings.shortcuts.fnUnavailable')}</p>}
                  {availability[d.id as ComposerShortcut] === 'priority-unavailable' && <p role="status" className="warning">{t('settings.shortcuts.priorityUnavailable')}</p>}
                  {availability[d.id as ComposerShortcut] === 'priority-unsupported' && <p role="status" className="warning">{t('settings.shortcuts.priorityUnsupported')}</p>}
                </div>
                <div className="shortcut-actions">
                  {recording ? (
                    <span className="shortcut-chip recording">{t('settings.shortcuts.recording')}</span>
                  ) : (
                    <span className={`shortcut-chip${acc ? '' : ' empty'}`} title={conflicts.length ? t('settings.shortcuts.conflict', { name: conflicts.map((id) => t(`settings.shortcuts.${id}`).trim()).join(', ') }) : undefined}>
                      {acc ? display : t('settings.shortcuts.unassigned')}
                    </span>
                  )}
                  {d.editable ? <>
                    <button type="button" className="icon-btn" title={t('settings.shortcuts.rebind')} aria-label={t('settings.shortcuts.rebind')}
                      onClick={() => setRecordingId(recording ? null : d.id)}>
                      <Pencil size={13} />
                    </button>
                    {overridden && (
                      <button type="button" className="icon-btn" title={t('settings.shortcuts.restoreDefault')} aria-label={t('settings.shortcuts.restoreDefault')} onClick={() => clearOverride(d.id)}>
                        <RotateCcw size={13} />
                      </button>
                    )}
                    {acc && !overridden && (
                      <button type="button" className="icon-btn" title={t('settings.shortcuts.clear')} aria-label={t('settings.shortcuts.clear')} onClick={() => unassign(d.id)}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </> : (
                    <span className="shortcut-locked" title={t('settings.shortcuts.locked')}><Lock size={12} /></span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {!rows.length && <p className="muted small">{t('settings.shortcuts.noMatch')}</p>}
    </div>
  );
}
