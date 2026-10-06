import { useEffect, useRef, useState } from 'react';
import { resolveLanguage } from '../../shared/language';
import type { AppSettings } from '../../shared/types';
import { useAppStore } from '../stores/appStore';

export function RelayClientIdentity({ name, connected, language }: {
  name?: string;
  connected: boolean;
  language?: AppSettings['language'];
}) {
  const text = (zh: string, en: string) => resolveLanguage(language, useAppStore.getState().settings?._systemLocale) === 'en' ? en : zh;
  const label = text('客户端名称', 'Client name');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);

  useEffect(() => { if (!editing) setDraft(name ?? ''); }, [name, editing]);
  useEffect(() => {
    if (!connected) {
      revision.current++;
      setBusy(false);
      setEditing(false);
      setError('');
    }
  }, [connected]);
  useEffect(() => () => { revision.current++; }, []);

  const save = async () => {
    if (busy || !connected) return;
    if (!draft.trim() || draft.trim().length > 120 || /[\x00-\x1f\x7f]/.test(draft)) {
      setError(text('客户端名称须为 1–120 个字符，不能包含控制字符。', 'Use 1–120 characters without control characters.'));
      return;
    }
    const generation = ++revision.current;
    setBusy(true);
    setError('');
    try {
      const result = await window.api.setRelayClientName(draft.trim());
      if (generation !== revision.current) return;
      if (!result.ok) throw Error(result.error || text('保存失败', 'Save failed'));
      setDraft(result.clientName ?? draft.trim());
      setEditing(false);
    } catch (cause) {
      if (generation === revision.current) setError(cause instanceof Error ? cause.message : text('保存失败', 'Save failed'));
    } finally { if (generation === revision.current) setBusy(false); }
  };

  return <div style={{ padding: '16px 20px' }}>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
      <strong>{label}</strong>
      {editing
        ? <input aria-label={label} value={draft} maxLength={120} disabled={busy} onChange={event => setDraft(event.target.value)} />
        : <span>{name || text('连接后读取 Token 备注', 'Uses the name set when issuing the Token')}</span>}
      {connected && !editing && <button className="btn-ghost btn-sm" onClick={() => { setError(''); setEditing(true); }}>{text('修改名称', 'Edit name')}</button>}
      {editing && <>
        <button className="btn-ghost btn-sm" disabled={busy || !connected || !draft.trim()} onClick={() => void save()}>{text('保存名称', 'Save name')}</button>
        <button className="btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(false)}>{text('取消', 'Cancel')}</button>
      </>}
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
