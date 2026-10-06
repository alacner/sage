import {useEffect,useRef,useState} from 'react';
import {Check,Link2,SlidersHorizontal} from 'lucide-react';
import {useAppStore} from '../stores/appStore';
import {resolveLanguage} from '../../shared/language';
import {defaultSecurityProfile,enabledSecurityProfiles,FULL_ACCESS_ID,securityProfileText} from '../../shared/security-profiles';
import {SecurityProfileIcon} from './SecurityProfileIcon';
import {FullAccessDialog} from './FullAccessDialog';
import './security-settings.css';

export function ScheduledSecuritySelector({value,onChange,sourceConvId,mode,onModeChange}:{value?:string|null;onChange:(id:string|null)=>void;sourceConvId?:string;mode?:'source'|'policy';onModeChange?:(mode:'source'|'policy')=>void}){
 const settings=useAppStore(s=>s.settings),lang=resolveLanguage(settings?.language,settings?._systemLocale),en=lang==='en';
 const [open,setOpen]=useState(false),[confirmFull,setConfirmFull]=useState(false);
 const root=useRef<HTMLDivElement>(null);
 const profiles=enabledSecurityProfiles(settings),fallback=defaultSecurityProfile(settings);
 const active=value?profiles.find(p=>p.id===value):fallback;
 const label=active?securityProfileText(active,'name',lang):(en?'Selected policy unavailable':'所选方案已失效');
 useEffect(()=>{if(!open)return;const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();setOpen(false);}};document.addEventListener('pointerdown',outside);root.current?.addEventListener('keydown',key);const el=root.current;return()=>{document.removeEventListener('pointerdown',outside);el?.removeEventListener('keydown',key);};},[open]);
 const select=(id:string|null)=>{onChange(id);setOpen(false);};
 return <div className="scheduled-security-selector" ref={root}>
  {sourceConvId&&<label><input type="checkbox" checked={mode==='source'} onChange={e=>onModeChange?.(e.target.checked?'source':'policy')}/>{en?'Inherit source conversation authorization':'继承来源对话授权'}</label>}
  {mode==='source'?<p className="muted small">{en?'Saving captures the source policy and exact reusable approvals. One-time approvals and unrestricted conversation-wide grants are not delegated. New actions still need review; a changed source policy requires saving the task again.':'保存时继承来源安全方案与已批准的精确调用。不转移一次性批准，也不把「本对话都通过」变为后台无限授权；新的操作仍需审批，来源方案变化后需重新保存任务。'}</p>:<>

  <p><strong>{en?'Authorization policy':'授权方案'}</strong></p>
  <button type="button" className="security-trigger" style={{color:active?.color}} aria-expanded={open} aria-label={en?'Choose task authorization policy':'选择任务授权方案'} onClick={()=>setOpen(!open)}>
   {active&&<SecurityProfileIcon profile={active} size={16}/>}<span>{!value?(en?'Follow default · ':'跟随默认 · '):''}{label}</span><SlidersHorizontal size={14}/>
  </button>
  {open&&<div className="security-profile-menu">
   <div className="security-menu-heading"><strong>{en?'Task authorization':'任务授权'}</strong><button type="button" onClick={()=>{setOpen(false);useAppStore.getState().openSettingsTab({initialTab:'security'});}}>{en?'Manage policies':'管理方案'}</button></div>
   <button type="button" className="security-policy-option" aria-pressed={!value} onClick={()=>select(null)}><Link2/><span><strong>{en?'Follow default policy':'跟随默认方案'}</strong><small>{securityProfileText(fallback,'name',lang)}</small></span>{!value&&<Check size={18}/>}</button>
   {[...profiles.filter(p=>p.id!==FULL_ACCESS_ID),...profiles.filter(p=>p.id===FULL_ACCESS_ID)].map(p=><button type="button" key={p.id} data-profile-id={p.id} className={'security-policy-option'+(p.id===FULL_ACCESS_ID?' security-full-access':'')} style={{color:p.color}} aria-pressed={value===p.id} onClick={()=>{if(p.id===FULL_ACCESS_ID){setOpen(false);setConfirmFull(true);}else select(p.id);}}><SecurityProfileIcon profile={p}/><span><strong>{securityProfileText(p,'name',lang)}</strong><small>{securityProfileText(p,'description',lang)}</small></span>{value===p.id&&<Check size={18}/>}</button>)}
  </div>}
  {confirmFull&&<FullAccessDialog onCancel={()=>setConfirmFull(false)} onConfirm={async()=>{select(FULL_ACCESS_ID);setConfirmFull(false);}}/>}
  <p className="muted small">{en?'Applies to future runs of this task after saving. Operations needing approval wait on the task card until approved or timed out. Configure required commands and network access in the selected policy. Website allow rules apply to WebFetch; curl still requires command network approval.':'保存后用于此任务后续运行。需审批的操作会在任务卡片等待同意，超时后结束。完全无人值守请在所选方案中配置所需权限。网站允许规则用于 WebFetch；curl 仍需命令联网审批。'}</p>
  {!active&&<p role="alert" className="file-error">{en?'This policy was deleted or disabled. Select an available policy before running.':'此方案已删除或禁用，请重新选择后运行。'}</p>}
 </>}
 </div>;
}
