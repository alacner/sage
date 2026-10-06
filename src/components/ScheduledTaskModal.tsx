import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {X} from 'lucide-react';
import {ScheduledTaskEditor} from './ScheduledTaskEditor';
import type {ScheduledProposal,ScheduledTaskInput} from '../../shared/types';
import {useT} from '../i18n';

export function ScheduledTaskModal({proposal,onConfirm,onCancel}:{proposal:ScheduledProposal;onConfirm:(draft:ScheduledTaskInput)=>Promise<void>;onCancel:()=>void}){
 const t=useT(),root=useRef<HTMLDivElement>(null),busy=useRef(false),cancel=useRef(onCancel);
 const [saving,setSaving]=useState(false);cancel.current=onCancel;
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;
  document.body.style.overflow='hidden';root.current?.querySelector<HTMLInputElement>('input')?.focus();
  const keydown=(e:KeyboardEvent)=>{
   if(document.querySelector('.full-access-backdrop'))return;
   if(e.key==='Escape'&&!document.querySelector('.model-combo-popup')){e.preventDefault();if(!busy.current)cancel.current();}
   if(e.key==='Tab'&&!document.querySelector('.model-combo-popup')){
    const nodes=[...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')??[])].filter(e=>e.getClientRects().length>0);
    const first=nodes[0],last=nodes.at(-1);if(!first)return;
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
   }
  };
  document.addEventListener('keydown',keydown);return()=>{document.removeEventListener('keydown',keydown);document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus();};
 },[]);
 return createPortal(<div className="scheduled-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy.current)onCancel();}}><div ref={root} role="dialog" aria-modal="true" aria-label={proposal.task.name||t('scheduled.title')} className="scheduled-modal"><button className="icon-btn scheduled-modal-close" disabled={saving} aria-label={t('common.close')} onClick={onCancel}><X size={18}/></button><ScheduledTaskEditor proposal={proposal} dialog onBusyChange={value=>{busy.current=value;setSaving(value);}} onCancel={onCancel} onConfirm={onConfirm}/></div></div>,document.body);
}
