import { useEffect, useState } from 'react';
import { Plus, Trash2, Code2, ListFilter } from 'lucide-react';
import type { ModelMapping, ModelProvider } from '../../shared/types';
import { validModelTimeRanges } from '../../shared/model-availability';
import { modelLabel } from '../../shared/model-label';
import { useT } from '../i18n';

export function CompositeMappingEditor({ mapping, publicModels, member, providers, onChange, onRemove }: {
  mapping: ModelMapping; publicModels: string[]; member?: ModelProvider; providers: ModelProvider[];
  onChange: (mapping: ModelMapping) => void; onRemove: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(mapping);
  const [scheduled, setScheduled] = useState(!!mapping.activeTimeRanges);
  const [ranges, setRanges] = useState(() => parseRanges(mapping.activeTimeRanges));
  const [dates, setDates] = useState(() => parseRanges(mapping.activeTimeRanges, true));
  const [expressionMode, setExpressionMode] = useState(false);
  const [expression, setExpression] = useState(mapping.activeTimeRanges ?? '');
  useEffect(() => { setDraft(mapping); setScheduled(!!mapping.activeTimeRanges); setRanges(parseRanges(mapping.activeTimeRanges));setDates(parseRanges(mapping.activeTimeRanges,true));setExpression(mapping.activeTimeRanges ?? ''); }, [mapping]);
  const fallbackModels = [...new Set(providers.filter(p => p.enabled && p.kind !== 'composite').flatMap(p => p.models))];
  const formValue = [...ranges.map(r => `${r.start}-${r.end}`), ...dates.map(r => `${r.start.replaceAll('-', '/')}-${r.end.replaceAll('-', '/')}`)].join(',');
  const timeValue = expressionMode ? expression.trim() : formValue;
  const validExpression = !!timeValue && validModelTimeRanges(timeValue) && parseRanges(timeValue).every(r => r.start !== r.end);
  const switchMode = () => {
    if (expressionMode) {
      if (scheduled && !validExpression) return;
      setRanges(parseRanges(expression)); setDates(parseRanges(expression, true));
    } else setExpression(formValue);
    setExpressionMode(!expressionMode);
  };
  const validTimes = !scheduled || validExpression;
  const validModels = publicModels.includes(draft.compositeModel) && !!member?.models.includes(draft.memberModel) && (!scheduled || !draft.fallbackModel || fallbackModels.includes(draft.fallbackModel));
  const result = { ...draft, activeTimeRanges: scheduled ? timeValue : undefined, fallbackModel: scheduled ? draft.fallbackModel : undefined };
  const dirty = JSON.stringify(result) !== JSON.stringify(mapping);
  const selectOptions = (models: string[], value: string, provider?: ModelProvider) => <>
    {!models.includes(value) && <option value={value}>{value ? `${modelLabel(provider,value)} (${t('providers.mappingUnavailable')})` : t('providers.mappingSelect')}</option>}
    {models.map(model => <option key={model} value={model}>{modelLabel(provider,model)}</option>)}
  </>;
  return <div className="mapping-editor">
    <div className="mapping-editor-toolbar"><button type="button" className="icon-btn" title={t(expressionMode ? 'providers.mappingSwitchForm' : 'providers.mappingSwitchExpression')} aria-label={t(expressionMode ? 'providers.mappingSwitchForm' : 'providers.mappingSwitchExpression')} aria-pressed={expressionMode} onClick={switchMode} disabled={expressionMode && scheduled && !validExpression}>{expressionMode ? <ListFilter size={14} aria-hidden="true"/> : <Code2 size={14} aria-hidden="true"/>}</button></div>
    <div className="mapping-editor-models">
      <label><span>{t('providers.mappingPublic')}</span><select aria-label={t('providers.mappingPublic')} value={draft.compositeModel} onChange={e => setDraft({...draft, compositeModel:e.target.value})}>{selectOptions(publicModels,draft.compositeModel)}</select></label>
      <label><span>{t('providers.mappingUpstream')}</span><select aria-label={t('providers.mappingUpstream')} value={draft.memberModel} onChange={e => setDraft({...draft, memberModel:e.target.value})}>{selectOptions(member?.models ?? [],draft.memberModel,member)}</select></label>
      <button type="button" className="icon-btn danger" title={t('providers.deleteMapping')} aria-label={t('providers.deleteMapping')} onClick={onRemove}><Trash2 size={13}/></button>
    </div>
    <div className="mapping-editor-schedule">
      <label><span>{t('providers.mappingSchedule')}</span><select aria-label={t('providers.mappingSchedule')} value={scheduled?'scheduled':'always'} onChange={e => {setScheduled(e.target.value==='scheduled');if(!ranges.length && !dates.length){setRanges([{start:'09:00',end:'18:00'}]);if(!expression.trim())setExpression('09:00-18:00');}}}>
        <option value="always">{t('providers.mappingAlways')}</option><option value="scheduled">{t('providers.mappingScheduled')}</option>
      </select></label>
      {scheduled && !expressionMode && <div className="mapping-editor-ranges">
        <span className="mapping-editor-section-title">{t('providers.mappingDaily')}</span>
        {ranges.map((range,index) => <div className="mapping-editor-time" key={index}>
          <input type="time" aria-label={`${t('providers.mappingStart')} ${index+1}`} value={range.start} onChange={e => setRanges(ranges.map((r,i)=>i===index?{...r,start:e.target.value}:r))}/>
          <span>—</span>
          <input type="time" aria-label={`${t('providers.mappingEnd')} ${index+1}`} value={range.end} onChange={e => setRanges(ranges.map((r,i)=>i===index?{...r,end:e.target.value}:r))}/>
          {range.start && range.end && range.start > range.end && <small className="muted mapping-editor-overnight">{t('providers.mappingNextDay')}</small>}
          <button type="button" className="icon-btn" aria-label={`${t('providers.mappingRemoveRange')} ${index+1}`} onClick={()=>setRanges(ranges.filter((_,i)=>i!==index))}><Trash2 size={12}/></button>
        </div>)}
        <button type="button" className="btn-ghost btn-sm" onClick={()=>setRanges([...ranges,{start:'09:00',end:'18:00'}])}><Plus size={12}/>{t('providers.mappingAddRange')}</button>
        <small className="muted">{t('providers.mappingClockHint')}</small>
      </div>}
    </div>
    {scheduled && !expressionMode && <div className="mapping-editor-dates">
      <span>{t('providers.mappingDates')}</span>
      {dates.map((range,index) => <div className="mapping-editor-time mapping-editor-date-row" key={index}>
        <input type="date" aria-label={`${t('providers.mappingDateStart')} ${index+1}`} value={range.start} onChange={e=>setDates(dates.map((r,i)=>i===index?{...r,start:e.target.value}:r))}/>
        <span>—</span>
        <input type="date" aria-label={`${t('providers.mappingDateEnd')} ${index+1}`} value={range.end} onChange={e=>setDates(dates.map((r,i)=>i===index?{...r,end:e.target.value}:r))}/>
        <button type="button" className="icon-btn" aria-label={`${t('providers.mappingRemoveDate')} ${index+1}`} onClick={()=>setDates(dates.filter((_,i)=>i!==index))}><Trash2 size={12}/></button>
      </div>)}
      <button type="button" className="btn-ghost btn-sm" onClick={()=>setDates([...dates,{start:'',end:''}])}><Plus size={12}/>{t('providers.mappingAddDate')}</button>
      <small className="muted">{t('providers.mappingDateHint')}</small>
    </div>}
    {scheduled && expressionMode && <label className="mapping-editor-expression"><span>{t('providers.mappingExpression')}</span><textarea aria-label={t('providers.mappingExpression')} rows={3} spellCheck={false} value={expression} placeholder="HH:mm-HH:mm,HH:mm-HH:mm,YYYY/MM/DD-YYYY/MM/DD,YYYY/MM/DD-YYYY/MM/DD" onChange={e=>setExpression(e.target.value)}/><small className="muted">{t('providers.mappingExpressionHint')}</small></label>}
    {scheduled && <label className="mapping-editor-fallback"><span>{t('providers.mappingFallback')}</span><select aria-label={t('providers.mappingFallback')} value={draft.fallbackModel ?? ''} onChange={e => setDraft({...draft,fallbackModel:e.target.value || undefined})}>
      <option value="">{t('providers.mappingNoFallback')}</option>
      {draft.fallbackModel && !fallbackModels.includes(draft.fallbackModel) && <option value={draft.fallbackModel}>{modelLabel(providers.find(p=>p.models.includes(draft.fallbackModel!)),draft.fallbackModel)} ({t('providers.mappingUnavailable')})</option>}
      {fallbackModels.map(model => <option key={model} value={model}>{modelLabel(providers.find(p=>p.enabled && p.kind!=='composite' && p.models.includes(model)),model)} · {providers.filter(p=>p.enabled && p.kind!=='composite' && p.models.includes(model)).map(p=>p.name).join(' / ')}</option>)}
    </select><small className="muted">{t('providers.mappingFallbackHint')}</small></label>}
    {(!validTimes || !validModels) && <p className="mapping-editor-error" role="alert">{t(!validTimes?'providers.mappingInvalidTime':'providers.mappingInvalidModel')}</p>}
    {dirty && <div className="mapping-editor-actions"><button type="button" disabled={!validTimes || !validModels} onClick={()=>onChange(result)}>{t('providers.mappingApply')}</button><button type="button" className="btn-ghost" onClick={()=>{setDraft(mapping);setScheduled(!!mapping.activeTimeRanges);setRanges(parseRanges(mapping.activeTimeRanges));setDates(parseRanges(mapping.activeTimeRanges,true));setExpression(mapping.activeTimeRanges ?? '');}}>{t('common.cancel')}</button></div>}
  </div>;
}
function parseRanges(value?: string, dates = false) {
  return (value ?? '').split(',').filter(part => part.trim() && part.includes('/') === dates).map(part => {
    const [start='', end=''] = part.trim().split('-').map(s => s.trim());
    return {start: dates ? start.replaceAll('/', '-') : start, end: dates ? end.replaceAll('/', '-') : end};
  });
}
