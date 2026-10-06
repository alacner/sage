import {BoundedCache} from '../../shared/bounded-cache';
import {useEffect,useMemo,useRef,useState,type RefObject,type ReactNode} from 'react';
import {openGitCommit} from '../plugins/git/git-tabs';
import {ArrowDown,Clock} from 'lucide-react';
import type {ChatMessage} from '../../shared/types';
import {conversationFileChanges} from '../../shared/file-changes';

// Keep expired summaries across component remounts and conversation switches in this session.
const expiredChangesByConversation=new BoundedCache<string,string>(128, 1024*1024, value=>value.length*2);

export function ChatActivityFooter({messages,projectPath,convId,busy,scroller,en,queuedCount=0,children}:{messages:ChatMessage[];projectPath:string;convId:string;busy:boolean;scroller:RefObject<HTMLDivElement>;en:boolean;queuedCount?:number;children?:ReactNode}){
 const changes=useMemo(()=>conversationFileChanges(messages,projectPath),[messages,projectPath]);
 const turnId=[...messages].reverse().find(message=>message.role==='user'&&!message.queued)?.id;
 const conversationKey=JSON.stringify([projectPath,convId]);
 const changeKey=JSON.stringify([projectPath,convId,turnId,changes]);
 const [expiredKey,setExpiredKey]=useState<string|null>(null),[hovered,setHovered]=useState(false),[focused,setFocused]=useState(false);
 const expired=expiredKey===changeKey||expiredChangesByConversation.get(conversationKey)===changeKey;
 const [open,setOpen]=useState(false),[away,setAway]=useState(false),[arrived,setArrived]=useState(false);
 useEffect(()=>{setOpen(false);setHovered(false);setFocused(false);},[convId,projectPath,turnId]);
 useEffect(()=>{
  if(!changes.length||busy||open||hovered||focused||expired)return;
  const timeout=setTimeout(()=>{expiredChangesByConversation.set(conversationKey,changeKey);setExpiredKey(changeKey);setOpen(false);},30_000);
  return()=>clearTimeout(timeout);
 },[conversationKey,changeKey,changes.length,busy,open,hovered,focused,expired]);
 const hoverCloseTimer=useRef<ReturnType<typeof setTimeout>>();
 useEffect(()=>()=>clearTimeout(hoverCloseTimer.current),[convId,projectPath,turnId]);
 const menu=useRef<HTMLDivElement>(null),wasAway=useRef(false),timer=useRef<ReturnType<typeof setTimeout>>();
 useEffect(()=>{
  setOpen(false);setAway(false);setArrived(false);wasAway.current=false;
  const el=scroller.current;if(!el)return;
  const check=()=>{
   const next=el.scrollHeight-el.scrollTop-el.clientHeight>80;
   setAway(next);
   if(next){setArrived(false);clearTimeout(timer.current);}
   else if(wasAway.current){setArrived(true);timer.current=setTimeout(()=>setArrived(false),650);}
   wasAway.current=next;
  };
  el.addEventListener('scroll',check,{passive:true});const observer=new ResizeObserver(check);observer.observe(el);if(el.firstElementChild)observer.observe(el.firstElementChild);
  return()=>{el.removeEventListener('scroll',check);observer.disconnect();clearTimeout(timer.current);};
 },[convId,scroller]);
 useEffect(()=>{
  if(!open)return;
  const down=(event:MouseEvent)=>{if(!menu.current?.contains(event.target as Node))setOpen(false);};
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);menu.current?.querySelector<HTMLButtonElement>('.chat-changes-summary')?.focus();}};
  document.addEventListener('mousedown',down);document.addEventListener('keydown',key);return()=>{document.removeEventListener('mousedown',down);document.removeEventListener('keydown',key);};
 },[open]);
 const added=changes.reduce((n,c)=>n+(c.added??0),0),removed=changes.reduce((n,c)=>n+(c.removed??0),0),complete=changes.every(c=>c.added!==undefined&&c.removed!==undefined);
 const viewChanges=(file?:string)=>{openGitCommit(projectPath,':working-tree',en?'Git · Changes':'Git · 变更','changes',file);setOpen(false);};
 const changesPill=changes.length>0&&!expired?<div className="chat-changes chat-changes-inline" ref={menu} onMouseEnter={()=>{clearTimeout(hoverCloseTimer.current);setHovered(true);setOpen(true);}} onMouseLeave={()=>{setHovered(false);if(!focused)hoverCloseTimer.current=setTimeout(()=>setOpen(false),180);}} onFocus={()=>{clearTimeout(hoverCloseTimer.current);setFocused(true);setOpen(true);}} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null)){setFocused(false);setOpen(false);}}}>
  {open&&<div className="chat-changes-popover-anchor"><div className="chat-changes-popover" role="region" aria-label={en?'Changed files':'变更文件'}>{changes.map(file=><button key={file.path} className="chat-change-file" title={file.path} onClick={()=>{viewChanges(file.path);}}><span className="chat-change-name">{file.path.split('/').pop()}<small>{file.path.includes('/')?file.path.slice(0,file.path.lastIndexOf('/')):''}</small></span><span className="chat-change-counts">{file.added!==undefined&&file.removed!==undefined?<><b className="chat-change-add">+{file.added}</b><b className="chat-change-remove">−{file.removed}</b></>:<small>{en?'Changed':'已修改'}</small>}</span></button>)}</div></div>}
  <div className="chat-status-pill chat-changes-pill"><button className="chat-changes-summary" aria-expanded={open} onClick={()=>viewChanges(changes.length===1?changes[0].path:undefined)}><span>{en?`${changes.length} files changed`:`${changes.length} 个文件已变更`}</span>{(complete||added+removed>0)&&<><b className="chat-change-add">+{added}</b><b className="chat-change-remove">−{removed}</b></>}{!complete&&<small title={en?'Some files have no line counts':'部分文件没有行数统计'}>*</small>}</button></div>
 </div>:null;
 const jump=()=>scroller.current?.scrollTo({top:scroller.current.scrollHeight,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
 return <div className="chat-activity-footer">
  {(away||arrived)&&<button className={'chat-jump-latest'+(arrived?' is-arrived':'')} aria-label={en?'Jump to latest message':'回到最新消息'} title={en?'Jump to latest message':'回到最新消息'} onClick={jump}>{away&&busy?<span className="chat-stream-dots" aria-hidden><i/><i/><i/></span>:<ArrowDown size={17}/>}</button>}
  <div className="chat-activity-pills-row">
   {(children||changesPill||queuedCount>0)&&<div className="chat-combined-status-pill">
    {children}{changesPill}
    {queuedCount>0&&<div className="chat-status-pill queue-count-pill" aria-label={en?`Queued messages ${queuedCount}`:`排队消息 ${queuedCount}`}><span><Clock size={13}/>{en?`Queued ${queuedCount}`:`排队消息 ${queuedCount}`}</span></div>}
   </div>}
  </div>
 </div>;
}
