import {useEffect,useRef,useState} from 'react';
import {Search,RefreshCw,Blocks,X} from 'lucide-react';
import {WindowOverlay} from './WindowOverlay';
import {useAppStore} from '../stores/appStore';
import {resolveLanguage} from '../../shared/language';
import type {ChatCapabilities as Catalog} from '../../shared/chat-capabilities';
import './chat-capabilities.css';
export function ChatCapabilities({project,disabled,onSelect}:{project:string;disabled?:boolean;onSelect:(request:string)=>void}) {
  const en=useAppStore(s=>resolveLanguage(s.settings?.language,s.settings?._systemLocale)==='en');
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[kind,setKind]=useState('all');
  const [catalog,setCatalog]=useState<Catalog>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=useRef(0);
  const load=async(force=false)=>{
    const id=++request.current;setBusy(true);setError('');
    try {const result=await window.api.chatCapabilities(project,force);if(id===request.current)setCatalog(result);}
    catch(error){if(id===request.current)setError(String((error as Error).message??error));}
    finally {if(id===request.current)setBusy(false);}
  };
  useEffect(()=>{setCatalog(undefined);setQuery('');if(open)void load();return()=>{++request.current;};},[project,open]);
  useEffect(()=>window.api.onPluginsChanged(()=>{if(open)void load();}),[project,open]);
  const label=en?'Skills, plugins & MCP':'技能、插件与 MCP';
  const kinds=[['all',en?'All':'全部'],['skill',en?'Skills':'技能'],['plugin',en?'Plugins':'插件'],['mcp','MCP']];
  const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items=(catalog?.items??[]).filter(item=>(kind==='all'||item.kind===kind)&&words.every(word=>`${item.name} ${item.source} ${item.description}`.toLowerCase().includes(word)));
  return <><button type="button" className="btn-ghost chat-capabilities-trigger" title={label} aria-label={label} disabled={disabled} onClick={()=>setOpen(true)}><Blocks size={15}/></button>
    {open&&<WindowOverlay className="modal-backdrop" onEscape={()=>setOpen(false)} onClick={()=>setOpen(false)}>
      <div className="modal chat-capabilities" role="dialog" aria-modal="true" aria-label={label} onClick={e=>e.stopPropagation()}>
        <header><h3>{label}</h3><button type="button" className="btn-ghost" aria-label={en?'Close':'关闭'} onClick={()=>setOpen(false)}><X size={17}/></button></header>
        <p className="muted">{en?'Choose a capability to add to your draft. Sending the message uses the usual approval policy.':'选择能力加入草稿；发送后按当前对话的审批方案执行。'}</p>
        <div className="capability-search"><Search size={16}/><input data-autofocus type="search" aria-label={en?'Search capabilities':'搜索能力'} placeholder={en?'Search names, descriptions or sources':'搜索名称、描述或来源'} value={query} onChange={e=>setQuery(e.target.value)}/><button type="button" disabled={busy} aria-label={en?'Refresh capabilities':'刷新能力'} onClick={()=>void load(true)}><RefreshCw size={15}/></button></div>
        <nav aria-label={en?'Capability type':'能力类型'}>{kinds.map(([id,title])=><button type="button" key={id} aria-pressed={kind===id} onClick={()=>setKind(id)}>{title}</button>)}</nav>
        {busy&&<p role="status">{en?'Loading capabilities…':'正在读取可用能力…'}</p>}{error&&<p role="alert">{error}</p>}
        {!!catalog?.unavailable.length&&<p role="status" className="muted">{en?'Unavailable; check settings and refresh: ':'暂不可用，请检查设置后刷新：'}{catalog.unavailable.join('、')}</p>}
        <div className="capability-list">{items.map(item=><button type="button" key={item.id} onClick={()=>{onSelect(`${en?'Use this capability: ':'使用以下能力：'}${item.request}\n`);setOpen(false);}}><strong>{item.name}</strong><small>{kinds.find(([id])=>id===item.kind)?.[1]} · {item.source}</small><span>{item.description}</span></button>)}</div>
        {!busy&&!items.length&&<p>{en?'No matching capabilities. Add skills or enable plugins and MCP servers in Settings.':'没有匹配的能力。可在设置中添加技能，或启用插件与 MCP 服务器。'}</p>}
      </div>
    </WindowOverlay>}
  </>;
}
