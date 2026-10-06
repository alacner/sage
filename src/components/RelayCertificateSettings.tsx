import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, ShieldOff, Search, Loader2 } from 'lucide-react';
import { relayCertificateOrigin, type RelayCertificatePolicy, type RelayCertificateProbe } from '../../shared/relay-certificate';
import { resolveLanguage } from '../../shared/language';
import { useAppStore } from '../stores/appStore';

export function RelayCertificateSettings({ url, certificate, onChange }: {
  url: string;
  certificate?: RelayCertificatePolicy;
  onChange: (value: RelayCertificatePolicy | undefined) => void | Promise<void>;
}) {
  const en = useAppStore(s => resolveLanguage(s.settings?.language, s.settings?._systemLocale) === 'en');
  const copy = (zh: string, english: string) => en ? english : zh;
  const [probe, setProbe] = useState<RelayCertificateProbe>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  let origin = '';
  try { origin = relayCertificateOrigin(url); } catch { /* Only explicit HTTPS/WSS can opt in. */ }
  useEffect(() => { generation.current++; setProbe(undefined); setError(''); setBusy(false); return () => { generation.current++; }; }, [url, certificate]);
  const inspect = async () => {
    const revision = ++generation.current;
    setBusy(true); setProbe(undefined); setError('');
    try {
      const result = await window.api.probeRelayCertificate(url);
      if (revision !== generation.current) return;
      if (result.origin !== origin) throw Error(copy('中继地址已变化，请重新检测。', 'The relay address changed. Inspect it again.'));
      setProbe(result);
    } catch (e) { if (revision === generation.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (revision === generation.current) setBusy(false); }
  };
  const save = async (value?: RelayCertificatePolicy) => {
    const revision = ++generation.current;
    setBusy(true); setError('');
    try { await onChange(value); if (revision === generation.current) setProbe(undefined); }
    catch (e) { if (revision === generation.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (revision === generation.current) setBusy(false); }
  };
  const active = certificate?.origin === origin;
  return <section className="settings-card" aria-label={copy('中继证书信任', 'Relay certificate trust')} style={{ padding: 14, marginTop: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <ShieldCheck size={16} aria-hidden="true" />
      <strong style={{ fontSize: 13 }}>{copy('自签名中继证书', 'Self-signed relay certificate')}</strong>
      <span className="muted small">{active ? copy('已信任当前证书', 'Current certificate trusted') : copy('使用系统证书验证', 'System certificate verification')}</span>
      <button type="button" className="btn btn-sm" disabled={busy || !origin} onClick={() => void inspect()} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {busy ? <Loader2 size={14} aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}{copy('检测证书', 'Inspect certificate')}
      </button>
      {certificate && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save()} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><ShieldOff size={14} aria-hidden="true" />{copy('清除信任', 'Clear trust')}</button>}
    </div>
    <p className="muted small" style={{ margin: '8px 0 0', lineHeight: 1.6 }}>{copy('检测不发送 Token，也不会自动信任。核对管理员提供的 SHA-256 指纹后，才能确认；仅对当前中继地址生效。', 'Inspection sends no Token and never grants trust automatically. Compare the SHA-256 fingerprint with your administrator before confirming. Trust applies only to this relay origin.')}</p>
    {!origin && <p className="muted small">{copy('请填写完整的 HTTPS 或 WSS 中继地址。', 'Enter a complete HTTPS or WSS relay address.')}</p>}
    {certificate && !active && <p role="status" className="muted small">{copy('已保存的信任属于其他中继地址，不会应用到当前连接。请清除后重新检测。', 'Saved trust belongs to another relay origin and cannot apply here. Clear it and inspect again.')}</p>}
    {(probe || active) && <div style={{ marginTop: 10, padding: 10, background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 12, lineHeight: 1.6 }}>
      <div style={{ overflowWrap: 'anywhere' }}>{probe?.origin ?? certificate?.origin}</div>
      <div className="muted" style={{ fontFamily: 'monospace', overflowWrap: 'anywhere', marginTop: 4, userSelect: 'text', WebkitUserSelect: 'text' }}>SHA-256 · {probe?.sha256 ?? certificate?.sha256}</div>
      {probe && <>
        <div className="muted" style={{ marginTop: 5 }}>{copy('有效期至', 'Valid until')} {new Date(probe.validTo).toLocaleString(en ? 'en' : 'zh-CN')}</div>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save({ origin: probe.origin, sha256: probe.sha256, certificatePem: probe.certificatePem })} style={{ marginTop: 8 }}>{copy('已核对指纹，信任此证书', 'Fingerprint verified — trust this certificate')}</button>
      </>}
    </div>}
    {error && <p role="alert" style={{ color: 'var(--err)', fontSize: 12, overflowWrap: 'anywhere', margin: '8px 0 0' }}>{error}</p>}
  </section>;
}
