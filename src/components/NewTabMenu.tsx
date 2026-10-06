import {useEffect,useRef,useState} from 'react';
import {MessageSquarePlus,FilePlus,Globe} from 'lucide-react';
import {AnchoredPopover} from './AnchoredPopover';
import {useAppStore} from '../stores/appStore';
import {useT} from '../i18n';

export function NewTabMenu(){
 const t=useT(),project=useAppStore(s=>s.currentProject);
 const [open,setOpen]=useState(false),[file,setFile]=useState(false),[name,setName]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null),creatingConversation=useRef(false);
 const close=()=>{setOpen(false);setFile(false);setError('');trigger.current?.focus();};
 useEffect(()=>{if(!open)return;const outside=(e:MouseEvent)=>{if(!panel.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))close();};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();close();}};document.addEventListener('mousedown',outside);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('mousedown',outside);document.removeEventListener('keydown',escape);};},[open]);
 useEffect(()=>{if(open){if(file)input.current?.focus();else panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();}},[open,file]);
 useEffect(()=>{setOpen(false);setFile(false);setError('');},[project?.path]);
 const action=(fn:()=>void)=>{close();fn();};
 const create=async()=>{if(!name.trim()||busy)return;setBusy(true);setError('');const store=useAppStore.getState(),path=project?.path;try{const result=await store.createFile(name.trim());if(!result.ok){setError(t('ft.mkfileFail',{error:result.error??''}));return;}if(useAppStore.getState().currentProject?.path===path){await store.openFile(name.trim());close();}}catch(e){setError(String(e));}finally{setBusy(false);}};
 const newConversation=async()=>{
  close();
  if(!useAppStore.getState().currentProject||creatingConversation.current)return;
  creatingConversation.current=true;
  try{await useAppStore.getState().createConversation();}
  catch(error){useAppStore.getState().setBanner(String(error));}
  finally{creatingConversation.current=false;}
 };
 return <span className="tab-add-control"><button ref={trigger} type="button" className="tab-add-btn" title={t('tabs.newMenuHint')} aria-label={t('tabs.newMenu')} aria-haspopup="dialog" aria-expanded={open} onClick={e=>{if(e.detail>1)return;setFile(false);setName('');setError('');setOpen(!open);}} onDoubleClick={e=>{e.preventDefault();void newConversation();}}>+</button>
 {open&&<AnchoredPopover className="file-tab-context-menu tab-new-popover"><div ref={panel} role="dialog" aria-label={t('tabs.newMenu')} onKeyDown={e=>{if(file||!['ArrowDown','ArrowUp'].includes(e.key))return;e.preventDefault();const items=[...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],i=items.indexOf(document.activeElement as HTMLButtonElement);items[(i+(e.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}}>
 {file?<form onSubmit={e=>{e.preventDefault();void create();}}><label>{t('ft.promptFile')}<input ref={input} value={name} onChange={e=>setName(e.target.value)} disabled={busy}/></label>{error&&<p role="alert">{error}</p>}<button type="submit" disabled={busy||!name.trim()}><FilePlus size={16}/>{t('ft.newFile')}</button></form>:<>
 <button type="button" disabled={!project} onClick={()=>action(()=>void useAppStore.getState().createConversation())}><MessageSquarePlus size={16}/>{t('tabs.newConv')}</button>
 <button type="button" disabled={!project} onClick={()=>setFile(true)}><FilePlus size={16}/>{t('ft.newFile')}</button>
 <button type="button" onClick={()=>action(()=>useAppStore.getState().openBrowserTab(undefined,{forceNew:true}))}><Globe size={16}/>{t('tabs.newBrowser')}</button>
 </>}
 </div></AnchoredPopover>}
 </span>;
}
