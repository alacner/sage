import {RefreshButton} from './RefreshButton';
import {EffortIcon} from './EffortIcon';
import { ModelPriceChart } from './ModelPriceChart';
import { modelPriceKey } from '../../shared/model-price-key';
import { useT } from '../i18n';
import { resolveLanguage } from '../../shared/language';
import { useAppStore } from '../stores/appStore';
import { useOnboardingContext } from '../lib/onboarding-context';
import { useCursorMenuStyle } from '../lib/cursor-menu';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { confirmDialog } from '../lib/confirm-dialog';
import { modelTypeIcons } from './ModelTypeIcons';
import { X, RefreshCw, ChartNoAxesCombined } from 'lucide-react';
import type { ProbeFeature, ProbeReport, ProbeRetry, ProbeRow } from '../../shared/model-probe-report';
import './ModelProbeReport.css';

export function ModelProbeReport() {
  const t = useT();
  const autoEnabled=useAppStore(s=>s.settings?.modelAutoVerifyEnabled!==false);
  const [savingAuto,setSavingAuto]=useState(false);
  const changeAuto=async(value:boolean)=>{setSavingAuto(true);try{await useAppStore.getState().saveSettings({modelAutoVerifyEnabled:value});}catch(e){setError(String(e));}finally{setSavingAuto(false);}};
  const language = useAppStore(s => resolveLanguage(s.settings?.language,s.settings?._systemLocale));
  const names: Record<ProbeFeature,string> = {chat:'',vision:t('modelType.vision'),webSearch:t('modelType.webSearch'),reasoning:t('modelType.reasoning'),tool:t('modelType.tool'),reranker:t('modelType.reranker'),embedding:t('modelType.embedding'),'thinking:low':t('probeReport.thinkingLow'),'thinking:medium':t('probeReport.thinkingMedium'),'thinking:xhigh':t('probeReport.thinkingXhigh')};
  const statusName = (value:boolean|undefined) => t(value === true ? 'probeReport.supported' : value === false ? 'probeReport.unsupported' : 'probeReport.unknown');
  const [report, setReport] = useState<ProbeReport>();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [setupAttempts, setSetupAttempts] = useState(0);
  useEffect(() => {
    useOnboardingContext.setState({probe: {
      loaded: !!report, running: submitting || !!report?.running, attempts: setupAttempts,
      pending: report?.rows.filter(r => r.feature !== 'chat' && r.supported === undefined && r.available).length ?? 0,
      error: error || report?.error,
    }});
  }, [report, submitting, setupAttempts, error]);
  useEffect(() => () => { useOnboardingContext.setState({probe: null}); }, []);
  const [query, setQuery] = useState('');
  const [unknownOnly, setUnknownOnly] = useState(false);
  const [logTarget, setLogTarget] = useState<{key:string;feature:ProbeFeature}>();
  const [prices, setPrices] = useState<any>({ prices: [] });
  const [probeAudits, setProbeAudits] = useState<any[]>([]);
  const [priceHover, setPriceHover] = useState<{model:string;price:any;x:number;y:number}>();
  const [priceRefreshing, setPriceRefreshing] = useState(false);
  const [priceError, setPriceError] = useState(false);
  const priceCloseTimer = useRef<ReturnType<typeof setTimeout>>();
  const keepPriceOpen = () => clearTimeout(priceCloseTimer.current);
  const dismissPriceSoon = () => { keepPriceOpen(); priceCloseTimer.current = setTimeout(() => setPriceHover(undefined), 220); };
  const { ref: priceRef, style: priceStyle } = useCursorMenuStyle(Math.max(8,(priceHover?.x ?? 0)-368), priceHover?.y ?? 0, !!priceHover);
  const refreshPrice = async () => {
    if (!priceHover || priceRefreshing) return;
    keepPriceOpen(); setPriceRefreshing(true); setPriceError(false);
    try {
      const data = await window.api.modelPricesCache([priceHover.model], { force: true });
      setPrices(data); setPriceError(!!data?.refreshFailed);
      const price = data?.prices?.find((p:any) => modelPriceKey(p.key) === modelPriceKey(priceHover.model));
      setPriceHover(current => current ? {...current,price} : current);
    } catch { setPriceError(true); }
    finally { setPriceRefreshing(false); }
  };
  const [hover, setHover] = useState<{ key: string; feature: ProbeFeature; x: number; y: number }>();
  const { ref: popoverRef, style: popoverStyle } = useCursorMenuStyle(hover?.x ?? 0, hover?.y ?? 0, !!hover);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const acting = useRef(false);
  const keepOpen = () => clearTimeout(closeTimer.current);
  const dismissSoon = () => { keepOpen(); closeTimer.current = setTimeout(() => setHover(undefined), 180); };
  useEffect(() => {
    const dismiss = () => { setHover(undefined); setPriceHover(undefined); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { dismiss(); setLogTarget(undefined); } };
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('keydown', escape);
    return () => { keepOpen(); keepPriceOpen(); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); window.removeEventListener('keydown', escape); };
  }, []);
  useEffect(() => {
    let live = true;
    const refreshAudit = async () => {
      try {
        const result = await window.api.getAuditLog({ limit: 100 });
        if (live) setProbeAudits((result?.entries ?? []).filter((entry: any) => entry.tool === 'ModelCapabilityProbe').slice(0, 8));
      } catch { if (live) setProbeAudits([]); }
    };
    void refreshAudit(); const timer = setInterval(refreshAudit, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    const models = [...new Set(report?.rows.map(r => r.model) ?? [])];
    if (models.length) void window.api.modelPricesCache?.(models).then((data: any) => setPrices(data ?? { prices: [] })).catch(() => {});
  }, [report?.rows.length]);
  useEffect(() => {
    let live = true, pending = false;
    const refresh = async () => {
      if (pending) return; pending = true;
      try { const data = await window.api.modelCapsReport(); if (live) { setReport(data); setError(''); } }
      catch (e) { if (live) setError(String(e)); } finally { pending = false; }
    };
    void refresh(); const timer = setInterval(refresh, 1500);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const retry = async (request: ProbeRetry) => {
    setSubmitting(true); setError('');
    try { setReport(await window.api.modelCapsRetry({...request, excludeChat:true})); if (!request.key && !request.feature) setSetupAttempts(n => n + 1); } catch (e) { setError(String(e)); }
    finally { setSubmitting(false); }
  };
  const busy = submitting || report?.running;
  const verify = async (row: ProbeRow) => {
    if (acting.current || busy || !row.available) return;
    acting.current = true;
    keepOpen(); setHover(undefined);
    try {
      if (row.supported !== undefined && !(await confirmDialog({ title:t('probeReport.confirmTitle'), message:t('probeReport.confirm',{model:row.model,type:names[row.feature],status:statusName(row.supported)}), okLabel:t('probeReport.again') }))) return;
      await retry({ key: row.key, feature: row.feature });
    } finally { acting.current = false; }
  };
  const show = (row: ProbeRow, button: HTMLButtonElement) => {
    if (acting.current) return;
    keepOpen();
    const rect = button.getBoundingClientRect();
    setHover({ key: row.key, feature: row.feature, x: rect.left, y: rect.bottom + 6 });
  };
  const rows = report?.rows.filter(r => r.feature !== 'chat' && (!unknownOnly || r.supported === undefined) && `${r.model} ${names[r.feature]} ${r.record?.providerName ?? ''}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const groups = new Map<string, ProbeRow[]>();
  for (const row of rows) { const group = groups.get(row.key) ?? []; group.push(row); groups.set(row.key, group); }
  const hovered = report?.rows.find(r => r.key === hover?.key && r.feature === hover?.feature);
  const logRow = report?.rows.find(r => r.key === logTarget?.key && r.feature === logTarget?.feature);
  const pending = report?.rows.filter(r => r.feature !== 'chat' && r.supported === undefined && r.available).length ?? 0;
  const current = report?.rows.find(row => row.running);
  return <section className="model-probe-report" aria-label={t('probeReport.title')}>
    <header><strong>{t('probeReport.title')}</strong><button type="button" data-setup="probe-retry" className="btn-ghost btn-sm" disabled={!!busy || !pending} onClick={() => void retry({})}><RefreshCw size={14} className={busy ? 'spin' : undefined}/>{t('probeReport.retryAll',{count:pending})}</button></header>
    <p className="muted">{t('probeReport.description')}</p><label className="model-probe-auto"><input type="checkbox" checked={autoEnabled} disabled={savingAuto} onChange={e=>void changeAuto(e.target.checked)}/>{t('probeReport.auto')}</label><p className="muted">{t('probeReport.autoHint')}</p>
    <div className="model-probe-controls"><input aria-label={t('probeReport.search')} placeholder={t('probeReport.search')} value={query} onChange={e => setQuery(e.target.value)}/><label><input type="checkbox" checked={unknownOnly} onChange={e => setUnknownOnly(e.target.checked)}/>{t('probeReport.unknownOnly')}</label><span role="status">{report?.running ? <>{t('probeReport.progress',{done:report.completed,total:report.total})}{current ? <small className="model-probe-current"> · {t('probeReport.current',{model:current.model,type:names[current.feature]})}</small> : null}</> : report?.total ? t('probeReport.last',{done:report.completed,total:report.total}) : t('probeReport.count',{count:rows.length})}</span></div>
    <details className="model-probe-audit"><summary>{t('probeReport.audit')}{probeAudits.length ? ` (${probeAudits.length})` : ''}</summary>{probeAudits.length ? <ul>{probeAudits.map((entry, index) => <li key={`${entry.ts}-${index}`}>{new Date(entry.ts).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')} · {entry.detail?.reason}</li>)}</ul> : <p className="muted">{t('probeReport.auditEmpty')}</p>}</details>
    {(error || report?.error) && <p role="alert">{error || report?.error}</p>}
    <div className="model-probe-table"><table><thead><tr><th>{t('probeReport.model')}</th><th>{t('probeReport.type')}</th><th>{t('probeReport.thinking')}</th><th aria-label="Price" /></tr></thead><tbody>
      {[...groups].map(([key, types]) => { const typeRows = types.filter(row => !row.feature.startsWith('thinking:')); const thinkingRows = types.filter(row => row.feature.startsWith('thinking:')); const price = prices.prices?.find((p:any) => modelPriceKey(p.key) === modelPriceKey(types[0].model)); return <tr key={key}><td>{types[0].model}</td><td><div className="model-probe-icons">{typeRows.map(row => {
        const Icon = modelTypeIcons[row.feature as Exclude<ProbeFeature,'chat' | `thinking:${string}`>];
        const status = statusName(row.supported);
        return <button key={row.feature} type="button" className={`model-probe-icon model-type-icon ${row.running ? 'probe-running' : row.supported === true ? row.feature : row.supported === false ? 'probe-neutral' : 'probe-unknown'}`} aria-label={`${row.model} · ${names[row.feature]} · ${status}`} aria-haspopup="dialog" aria-expanded={hovered === row} aria-disabled={!!busy || !row.available}
          onMouseEnter={e => show(row, e.currentTarget)} onMouseLeave={dismissSoon} onFocus={e => show(row, e.currentTarget)} onBlur={dismissSoon}
          onClick={e => show(row, e.currentTarget)} onDoubleClick={() => void verify(row)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void verify(row); } }}><Icon size={15} aria-hidden="true"/></button>;
      })}</div></td><td><div className="model-probe-thinking">{thinkingRows.map(row => {
        const status = statusName(row.supported); const level = names[row.feature];
        return <button key={row.feature} type="button" className={`model-probe-effort ${row.running ? 'probe-running' : row.supported === true ? 'supported' : row.supported === false ? 'probe-neutral' : 'probe-unknown'}`} title={`${level} · ${status}`} aria-label={`${row.model} · ${level} · ${status}`} aria-haspopup="dialog" aria-expanded={hovered === row} aria-disabled={!!busy || !row.available}
          onMouseEnter={e => show(row, e.currentTarget)} onMouseLeave={dismissSoon} onFocus={e => show(row, e.currentTarget)} onBlur={dismissSoon}
          onClick={e => show(row, e.currentTarget)} onDoubleClick={() => void verify(row)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void verify(row); } }}><EffortIcon effort={row.feature==='thinking:low'?'low':row.feature==='thinking:medium'?'medium':'xhigh'}/></button>;
      })}</div></td><td className="model-probe-price">{price ? <button type="button" className="model-probe-price-icon" aria-label={t('probeReport.priceChart')} onMouseEnter={e => { keepPriceOpen(); setPriceError(false); const r=e.currentTarget.getBoundingClientRect(); setPriceHover({model:types[0].model,price,x:r.left,y:r.bottom+6}); }} onMouseLeave={dismissPriceSoon} onFocus={e => { keepPriceOpen(); setPriceError(false); const r=e.currentTarget.getBoundingClientRect(); setPriceHover({model:types[0].model,price,x:r.left,y:r.bottom+6}); }} onBlur={dismissPriceSoon}><ChartNoAxesCombined size={16}/></button> : null}</td></tr>; })}
      {!groups.size && <tr><td colSpan={4}>{t(report ? 'probeReport.empty' : 'probeReport.loading')}</td></tr>}
    </tbody></table></div>
    {priceHover && createPortal(<div className="model-probe-price-popover" role="dialog" aria-label={t('probeReport.priceChart')} ref={priceRef} style={{...priceStyle,width:Math.min(360,Math.max(80,(priceHover?.x??0)-16))}} onMouseEnter={keepPriceOpen} onMouseLeave={dismissPriceSoon} onFocus={keepPriceOpen} onBlur={dismissPriceSoon}>
      <header><strong>{priceHover.model}</strong><RefreshButton type="button" className="model-price-refresh" aria-label={t('probeReport.priceRefresh')} title={t('probeReport.priceRefresh')} disabled={priceRefreshing} onClick={() => void refreshPrice()} loading={priceRefreshing}/><button type="button" className="model-price-refresh" aria-label={t('common.close')} onClick={()=>setPriceHover(undefined)}><X size={16}/></button></header>
      <ModelPriceChart compact price={priceHover.price} date={prices.date}/>
      {priceError && <small role="status">{t('probeReport.priceRefreshFailed')}</small>}
    </div>, document.body)}
    {hover && hovered && createPortal(<div className="model-probe-popover" role="dialog" aria-label={t('probeReport.details',{model:hovered.model,type:names[hovered.feature]})} ref={popoverRef} style={popoverStyle} onMouseEnter={keepOpen} onMouseLeave={dismissSoon} onFocus={keepOpen} onBlur={dismissSoon}>
      <div>{t('probeReport.type')}: {names[hovered.feature]}</div>
      <div>{t('probeReport.support')}: {statusName(hovered.supported)}</div>
      <div>{t('probeReport.provider')}: {hovered.record?.source === 'relay' || hovered.record?.providerId === 'relay-cache' ? t('probeReport.relay') : hovered.record?.providerName ?? t('probeReport.missing')}</div>
      <div>{t('probeReport.time')}: {hovered.record ? new Date(hovered.record.checkedAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : t('probeReport.missing')}</div>
      <button type="button" className="btn-ghost btn-sm" disabled={!!busy || !hovered.available} onClick={() => void verify(hovered)}>{t(hovered.supported === undefined ? 'probeReport.now' : 'probeReport.again')}</button>
      <button type="button" className="btn-ghost btn-sm" onClick={() => { setLogTarget({key:hovered.key,feature:hovered.feature}); setHover(undefined); }}>{t('probeReport.logs')}</button>
      {!hovered.available && <small>{t('probeReport.noProvider')}</small>}
    </div>, document.body)}
    {logRow && createPortal(<div className="probe-log-backdrop" onClick={() => setLogTarget(undefined)}>
      <div className="probe-log-dialog" role="dialog" aria-modal="true" aria-label={t('probeReport.logs')} onClick={e => e.stopPropagation()}>
        <header><strong>{logRow.model} · {names[logRow.feature]} · {t('probeReport.logs')}</strong><button type="button" className="btn-ghost" autoFocus onClick={() => setLogTarget(undefined)}>{t('common.close')}</button></header>
        <div className="probe-log-body">
          <p className="muted">{t('probeReport.logHint')}</p>
          {!logRow.logs?.length && <p>{t('probeReport.noLogs')}</p>}
          {[...(logRow.logs ?? [])].reverse().map((log,i) => <article key={`${log.checkedAt}-${i}`}>
            <strong>{log.providerName} · {new Date(log.checkedAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}</strong>
            <p>{statusName(log.result)} · {t(`probeReport.reason.${log.reason}`)}</p>
            <p>{log.protocol} · HTTP {log.httpStatus ?? '—'} · {log.durationMs} ms</p>
            {log.endpoint && <code>{log.endpoint}</code>}
            {log.request && <details><summary>{t('probeReport.request')}</summary><pre>{log.request}</pre></details>}
            {log.response && <details open><summary>{t('probeReport.response')}</summary><pre>{log.response}</pre></details>}
          </article>)}
        </div>
      </div>
    </div>,document.body)}
  </section>;
}
