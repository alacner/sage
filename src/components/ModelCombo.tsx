import {EffortIcon} from './EffortIcon';
export {EffortIcon} from './EffortIcon';
import { useAppStore } from '../stores/appStore';
import { effectiveModelSelection } from '../../shared/model-selection';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Link } from 'lucide-react';
import type { ModelProvider, SelectedModel, ThinkingEffort } from '../../shared/types';
import { modelLabel } from '../../shared/model-label';
import { useModelTypes } from '../lib/useModelTypes';
import { useT } from '../i18n';
import { FlatModelList } from './FlatModelList';
import { AnchoredPopover } from './AnchoredPopover';
import './ModelCombo.css';

export interface ModelComboProps {
  providers: ModelProvider[]; value: SelectedModel | null; inheritedValue?: SelectedModel | null;
  onChange: (value: SelectedModel | null) => void; effort?: ThinkingEffort;
  onEffortChange?: (effort: ThinkingEffort | undefined) => void;
  allowEmpty?: boolean; emptyLabel?: string; inheritedHint?: string; followLabel?: string;
  visionOnly?: boolean; disabled?: boolean; showTooltip?: boolean;
}
export function ModelCombo({providers,value,inheritedValue,onChange,effort,onEffortChange,allowEmpty=true,emptyLabel,inheritedHint,followLabel,visionOnly=false,disabled=false,showTooltip=true}:ModelComboProps) {
  const t=useT();
  const globalEffort=useAppStore(s=>s.settings?.selectedModel?.thinkingEffort);
  const [open,setOpen]=useState<'model'|'effort'|null>(null);
  const root=useRef<HTMLDivElement>(null);
  const popup=useRef<HTMLDivElement>(null);
  const capsOf=useModelTypes(providers);
  const effective=effectiveModelSelection(value,inheritedValue);
  const provider=providers.find(p=>p.id===effective?.providerId);
  const caps=provider&&effective?capsOf(provider,effective.modelId):{};
  const supports=['low','medium','xhigh'].some(level=>caps[`thinking:${level}` as keyof typeof caps]===true);
  const selectedEffort=effort??effective?.thinkingEffort??'low';
  const inherited=!value||value.followDefault;
  const followsEffort=!!inherited&&!!inheritedValue&&effort===undefined&&value?.thinkingEffort===undefined;
  const effortFollowLabel=(followLabel??t('fml.followGlobal')).replace(/\s*[（(]%s[）)]?/g,'').trim();
  const changeEffort=(level:ThinkingEffort|undefined)=>{
    if(onEffortChange)onEffortChange(level);
    else if(inherited)onChange(level?{providerId:'',modelId:'',followDefault:true,thinkingEffort:level}:null);
    else onChange({...value,thinkingEffort:level});
    setOpen(null);
  };
  useEffect(()=>{
    if(!open)return;
    const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node)&&!popup.current?.parentElement?.contains(e.target as Node))setOpen(null);};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(null);root.current?.querySelector('button')?.focus();}};
    document.addEventListener('pointerdown',close,true);document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('pointerdown',close,true);document.removeEventListener('keydown',key);};
  },[open]);
  useEffect(()=>{setOpen(null);},[effective?.providerId,effective?.modelId,disabled]);
  const toggle=(next:'model'|'effort')=>setOpen(current=>current===next?null:next);
  const label=effective?modelLabel(provider,effective.modelId):(emptyLabel??t('fml.unselected'));
  return <div className="model-combo">
    <div className="model-combo-control" ref={root}>
      <button type="button" className="model-combo-model" disabled={disabled} aria-expanded={open==='model'} title={showTooltip?(provider?`${provider.name} | ${label}`:label):undefined} onClick={()=>toggle('model')}>
        <>{inherited&&inheritedValue&&<Link className="model-combo-icon" size={16}/>}</><span className="model-combo-provider">{provider?.name}{provider?' | ':''}</span><span className="model-combo-label">{label}</span>
      </button>
      <button type="button" className="model-combo-toggle" disabled={disabled} aria-label={t('chat.model.title')} aria-expanded={!!open} onClick={()=>open?setOpen(null):setOpen('model')}>{open?<ChevronUp size={16}/>:<ChevronDown size={16}/>}</button>
      {supports&&<button type="button" className="model-combo-effort" disabled={disabled} aria-label={t('chat.thinkingEffort.label')} aria-expanded={open==='effort'} onClick={()=>toggle('effort')}><EffortIcon effort={selectedEffort}/><span className="model-combo-effort-text">{selectedEffort==='off'?t('modelCombo.off'):selectedEffort}</span></button>}
      {open&&<AnchoredPopover align={open==='effort'?'end':'start'} className={open==='model'?'model-combo-popup':'model-combo-popup model-combo-effort-popup'}><div ref={popup}>
        {open==='model'?<FlatModelList providers={providers} selected={effective} inheritedValue={inheritedValue} inheritedHint={inheritedHint} isInherited={!!inherited&&!!inheritedValue} followLabel={followLabel??(inheritedValue?t('fml.followGlobal'):undefined)} allowEmpty={allowEmpty} emptyLabel={emptyLabel} visionOnly={visionOnly} onClose={()=>setOpen(null)} onSelect={(providerId,modelId)=>{onChange(providerId&&modelId?{providerId,modelId,thinkingEffort:globalEffort??'low'}:null);setOpen(null);}}/>:<>
          <strong>{t('chat.thinkingEffort.label')}</strong>
          {inherited&&inheritedValue&&<button type="button" className="model-combo-reset" role="menuitemradio" aria-checked={followsEffort} onClick={()=>changeEffort(undefined)}><span className="model-combo-check">{followsEffort&&<Check size={16}/>}</span><Link className="model-combo-icon" size={16}/><span>{effortFollowLabel}</span></button>}
          {(['off','low','medium','xhigh'] as const).map(level=><button type="button" role="menuitemradio" aria-checked={!followsEffort&&selectedEffort===level} key={level} onClick={()=>{changeEffort(level);}}><span className="model-combo-check">{!followsEffort&&selectedEffort===level&&<Check size={16}/>}</span><EffortIcon effort={level}/><span>{level==='off'?t('modelCombo.off'):level}</span></button>)}
        </>}
      </div></AnchoredPopover>}
    </div>
  </div>;
}
