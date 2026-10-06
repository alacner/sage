import {resolveLanguage} from '../../shared/language';
import {securityProfileText} from '../../shared/security-profiles';
import { SecurityColorPicker } from './SecurityColorPicker';
import { FullAccessDialog, SecurityConfirmationDialog } from './FullAccessDialog';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, GripVertical, Star, History, Copy, Pencil, Trash2, Power, Plus } from 'lucide-react';
import type { SecurityProfile, SandboxOverrides } from '../../shared/types';
import { defaultSecurityProfile, FULL_ACCESS_ID, securityProfiles, securitySnapshot } from '../../shared/security-profiles';
import { useAppStore } from '../stores/appStore';
import { useT } from '../i18n';
import { SecuritySettingsPanel } from './SecuritySettings';
import { SECURITY_ICON_OPTIONS, SecurityProfileIcon, useSecurityCopy } from './SecurityProfileIcon';
import { BuiltInBadge } from './BuiltInBadge';
import { SystemPermissionsSettings } from './SystemPermissionsSettings';

export function SecurityProfilesSettings() {
  const settings = useAppStore(s => s.settings);
  const t = useT(); const copy=useSecurityCopy();
  const [items, setItems] = useState(() => structuredClone(securityProfiles(settings)));
  const latest = useRef(items);
  const queue = useRef(Promise.resolve());
  const retry = useRef<() => Promise<unknown>>();
  const [selected, setSelected] = useState('');
  const [confirmFullAccess,setConfirmFullAccess]=useState(false);
  const iconPickerRef=useRef<HTMLDetailsElement>(null);
  const colorPickerRef=useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const pickers = () => [iconPickerRef.current, colorPickerRef.current];
    const outside = (event: PointerEvent) => {
      for (const picker of pickers()) {
        if (picker?.open && event.target instanceof Node && !picker.contains(event.target)) picker.open = false;
      }
    };
    const escape = (event: KeyboardEvent) => {
      const open = pickers().find(picker => picker?.open);
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault(); event.stopPropagation();
      open.open = false;
      open.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, []);
  const [deleteProfile,setDeleteProfile]=useState<SecurityProfile>();
  const [dragging,setDragging]=useState<string>();
  const [error, setError] = useState('');
  const profile = items.find(p=>p.id === selected);
  const defaultId=defaultSecurityProfile(settings).id;
  const persist = (next: SecurityProfile[]) => {
    retry.current = () => persist(latest.current);
    latest.current = next; setItems(next); setError('');
    const task = queue.current.catch(() => {}).then(async () => {
      await useAppStore.getState().saveSettings({securityProfiles: next});
    });
    queue.current = task;
    void task.catch(e => setError(e.message));
    return task;
  };
  const update = (id: string, patch: Partial<SecurityProfile>) => persist(latest.current.map(p=>p.id===id ? {...p,...patch} : p));
  const setDefault = (id:string):Promise<void> => {
    retry.current=()=>setDefault(id);setError('');
    const task=queue.current.catch(()=>{}).then(async()=>{await useAppStore.getState().saveSettings({defaultSecurityProfileId:id});});
    queue.current=task;void task.catch(e=>setError(e.message));return task;
  };
  const add = (source?:SecurityProfile) => {
    const item:SecurityProfile = source?{...securitySnapshot(source),id:crypto.randomUUID(),name:source.name+copy(' 副本',' copy')}:{id:crypto.randomUUID(),name:t('security.profiles.new'),description:'',icon:'shield',color:'#6b57d9',policy:{review:{enabled:false,projectFiles:false}}};
    setSelected(item.id); void persist([...latest.current,item]).catch(()=>{});
  };
  const move=(id:string,target:string)=>{
    if(id===FULL_ACCESS_ID||target===FULL_ACCESS_ID||id===target)return;
    const next=[...latest.current];const from=next.findIndex(p=>p.id===id),to=next.findIndex(p=>p.id===target);
    if(from<0||to<0)return;next.splice(to,0,next.splice(from,1)[0]);void persist(next).catch(()=>{});
  };
  const confirmDelete = async () => {
    if (!deleteProfile) return;
    if (defaultSecurityProfile(useAppStore.getState().settings).id===deleteProfile.id) throw Error(copy('请先选择其它默认方案。','Choose another default policy first.'));
    const previous=latest.current;
    try {await persist(previous.filter(p=>p.id!==deleteProfile.id));setDeleteProfile(undefined);}
    catch(error){latest.current=previous;setItems(previous);throw error;}
  };
  return <div className="security-profiles">
    {deleteProfile && <SecurityConfirmationDialog onCancel={()=>setDeleteProfile(undefined)} onConfirm={confirmDelete} title={copy('删除审批方案？','Delete approval policy?')} confirmLabel={copy('确认删除','Delete')}><p>{copy('确定删除“'+deleteProfile.name+'”？删除后，该方案将不再出现在可选列表中。','Delete “'+deleteProfile.name+'”? It will no longer appear in the policy selection list.')}</p></SecurityConfirmationDialog>}
    {confirmFullAccess && <FullAccessDialog asDefault onCancel={()=>setConfirmFullAccess(false)} onConfirm={async()=>{await setDefault(FULL_ACCESS_ID);setConfirmFullAccess(false);}}/>}
    <p className="security-muted">{copy('更改将在下一次开始或恢复执行时生效，不影响正在运行的操作。','Changes apply the next time execution starts or resumes, without affecting operations in progress.')}</p>
    {error && <p role="alert" className="security-error">{error} <button onClick={()=>void retry.current?.().catch(()=>{})}>{t('security.retrySave')}</button></p>}
    {!profile ? <>
      <div className="security-profile-toolbar"><h3>{copy('审批策略','Approval policies')}</h3><button className="btn-secondary" onClick={()=>useAppStore.getState().openSettingsTab({initialTab:'security-audit',auditProfileId:undefined,auditConvId:undefined})}>{copy('决策记录','Decision history')}</button><button className="btn-secondary" onClick={()=>add()}><Plus size={14}/> {t('security.profiles.add')}</button></div>
      {items.filter(p=>p.id!==FULL_ACCESS_ID).every(p=>p.enabled===false)&&<p className="security-muted">{copy('其它方案已禁用，当前仅可选择完全访问权限。','Other policies are disabled. Only Full access is available.')}</p>}<div className="security-policy-list settings-card">
        {items.map((p,index)=><div key={p.id} className={`security-policy-row ${p.id===FULL_ACCESS_ID?'security-full-access':''} ${defaultId===p.id?'is-default':''} ${dragging===p.id?'dragging':''} ${p.enabled===false?'security-policy-disabled':''}`} style={{color:p.color}} onDragOver={e=>{if(p.id!==FULL_ACCESS_ID)e.preventDefault();}} onDrop={e=>{e.preventDefault();if(dragging)move(dragging,p.id);setDragging(undefined);}}>
          {p.id!==FULL_ACCESS_ID?<button className="security-drag" draggable aria-label={copy('拖拽排序；方向键调整顺序','Drag to reorder; use arrow keys to move')} onDragStart={e=>{setDragging(p.id);e.dataTransfer.setData('text/plain',p.id);}} onDragEnd={()=>setDragging(undefined)} onKeyDown={e=>{const target=items[index+(e.key==='ArrowUp'?-1:e.key==='ArrowDown'?1:0)];if(target&&target.id!==p.id){e.preventDefault();move(p.id,target.id);}}}><GripVertical size={16}/></button>:<span className="security-drag"/>}
          <SecurityProfileIcon profile={p} size={18}/><div className="security-policy-text"><strong>{p.id===FULL_ACCESS_ID?copy('完全访问权限','Full access'):securityProfileText(p,'name',resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale))}</strong>{['manual','assisted',FULL_ACCESS_ID].includes(p.id)&&<BuiltInBadge/>}{defaultId===p.id?<span className="security-policy-badge">{t('security.profiles.default')}</span>:p.enabled===false?<span className="security-policy-badge disabled">{copy('已禁用','Disabled')}</span>:null}<p>{p.id===FULL_ACCESS_ID?copy('可不受限制地访问互联网和你电脑上的任何文件','Unrestricted access to the internet and any files on your computer'):securityProfileText(p,'description',resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale))}</p></div>
          <div className="security-policy-actions"><button className="btn-ghost" title={copy('决策记录','Decision history')} aria-label={copy('决策记录','Decision history')} onClick={()=>useAppStore.getState().openSettingsTab({initialTab:'security-audit',auditProfileId:p.id,auditConvId:undefined})}><History size={16}/></button><button className="btn-ghost" disabled={p.enabled===false} aria-pressed={defaultId===p.id} title={defaultId===p.id?t('security.profiles.default'):t('security.profiles.setDefault')} aria-label={t('security.profiles.setDefault')} onClick={()=>{if(p.id===FULL_ACCESS_ID)setConfirmFullAccess(true);else void setDefault(p.id).catch(()=>{});}}><Star size={15} fill={defaultId===p.id?'currentColor':'none'}/></button>
          {p.id!==FULL_ACCESS_ID&&<><button className="btn-ghost" disabled={defaultId===p.id && p.enabled!==false} title={defaultId===p.id?copy('请先将默认项移到其它方案','Choose another default policy first'):(p.enabled===false?copy('启用','Enable'):copy('禁用','Disable'))} aria-label={p.enabled===false?copy('启用','Enable'):copy('禁用','Disable')} aria-pressed={p.enabled!==false} onClick={()=>{if(defaultId!==p.id || p.enabled===false)void update(p.id,{enabled:p.enabled===false}).catch(()=>{});}}><Power size={16}/></button><button className="btn-ghost" title={t('security.profiles.copy')} aria-label={t('security.profiles.copy')} onClick={()=>add(p)}><Copy size={16}/></button><button className="btn-ghost" title={copy('修改','Edit')} aria-label={copy('修改','Edit')} onClick={()=>setSelected(p.id)}><Pencil size={16}/></button><button className="btn-ghost security-delete-action" title={t('security.profiles.delete')} aria-label={t('security.profiles.delete')} disabled={defaultId===p.id} onClick={()=>setDeleteProfile(p)}><Trash2 size={16}/></button></>}</div>
        </div>)}
      </div>
      <SystemPermissionsSettings />
    </>:<>
      <div className="security-profile-toolbar"><button className="btn-secondary" onClick={()=>setSelected('')}><ArrowLeft size={15}/>{copy('返回策略列表','Back to policies')}</button><h3>{copy('编辑方案','Edit policy')}</h3></div>
      <div className="security-profile-fields">
        <label className="security-profile-name">{t('security.profiles.name')}<input key={profile.id+'name'+useAppStore.getState().settings?.language} defaultValue={securityProfileText(profile,'name',resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale))} maxLength={100} onBlur={e=>{if(e.target.value===securityProfileText(profile,'name',resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale)))return;if(e.target.value.trim())void update(profile.id,{name:e.target.value.trim()}).catch(()=>{});else e.target.value=profile.name;}}/></label>
        <div className="security-profile-appearance">
          <span className="security-profile-appearance-label">{copy('图标','Icon')}</span>
          <div className="security-profile-appearance-controls">
          <details ref={iconPickerRef} onToggle={e=>{if(e.currentTarget.open && colorPickerRef.current)colorPickerRef.current.open=false;}} className="security-appearance-picker">
            <summary aria-label={copy('选择图标','Choose icon')} title={copy('选择图标','Choose icon')}><span className="security-appearance-sr-only">{copy('选择图标','Choose icon')}</span><span className="security-appearance-preview"><SecurityProfileIcon profile={profile} size={18}/></span></summary>
            <div className="security-icon-grid" role="group" aria-label={copy('图标','Icon')}>{Object.entries(SECURITY_ICON_OPTIONS).map(([id,Icon])=><button key={id} type="button" aria-label={id} aria-pressed={(profile.icon??'shield')===id} onClick={()=>{void update(profile.id,{icon:id as SecurityProfile['icon']}).catch(()=>{});if(iconPickerRef.current)iconPickerRef.current.open=false;}}><Icon size={20}/></button>)}</div>
          </details>
          <details ref={colorPickerRef} onToggle={e=>{if(e.currentTarget.open && iconPickerRef.current)iconPickerRef.current.open=false;}} className="security-appearance-picker">
            <summary aria-label={copy('名称和备注颜色','Name and description color')} title={copy('名称和备注颜色','Name and description color')}><span className="security-appearance-sr-only">{copy('名称和备注颜色','Name and description color')}</span><span className="security-appearance-color-preview" style={{background:profile.color??'#6b57d9'}}/></summary>
            <SecurityColorPicker value={profile.color??'#6b57d9'} onChange={color=>void update(profile.id,{color}).catch(()=>{})} onSelect={()=>{if(colorPickerRef.current)colorPickerRef.current.open=false;}}/>
          </details>
          </div>
        </div>
        <label className="security-profile-description">{t('security.profiles.description')}<input key={profile.id+'desc'+useAppStore.getState().settings?.language} defaultValue={securityProfileText(profile,'description',resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale))} maxLength={2000} onBlur={e=>{if(e.target.value!==securityProfileText(profile,'description',resolveLanguage(useAppStore.getState().settings?.language,useAppStore.getState().settings?._systemLocale)))void update(profile.id,{description:e.target.value}).catch(()=>{});}}/></label>
      </div>
      <SecuritySettingsPanel key={profile.id} policy={profile.policy} onSave={policy=>update(profile.id,{policy})}/>
    </>}
  </div>;
}
