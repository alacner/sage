import {PluginSlot} from './plugins/PluginWorkbench';
import {WindowOverlay} from './WindowOverlay';
import {resolveLanguage} from '../../shared/language';
import {useState,useMemo,useEffect,useRef} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {useAppStore} from '../stores/appStore';
import {Search,BookOpen,X} from 'lucide-react';
import {mermaidMarkdownComponents} from '../lib/markdownComponents';
import {helpTopics,helpPassages,searchHelp,type HelpLanguage} from '../help/search';

export function AboutModal({onClose,pane}:{onClose:()=>void;pane?:boolean}){
 const appLanguage=useAppStore(s=>s.settings?.language);
 const language:HelpLanguage=resolveLanguage(appLanguage,useAppStore.getState().settings?._systemLocale);
 const copy=(zh:string,en:string)=>language==='zh'?zh:en;
 const topics=useMemo(()=>helpTopics(language),[language]);
 const [selectedId,setSelectedId]=useState('overview'),[query,setQuery]=useState(''),[section,setSection]=useState(0);
 const searchRef=useRef<HTMLInputElement>(null);
 const [version,setVersion]=useState('');const bodyRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{void window.api.appVersion?.().then(v=>setVersion(v||'')).catch(()=>{});},[]);
 const selected=topics.find(t=>t.id===selectedId)??topics[0];
 const groups=useMemo(()=>Array.from(new Set(topics.map(t=>t.group))).map(name=>({name,topics:topics.filter(t=>t.group===name)})),[topics]);
 const matches=useMemo(()=>searchHelp(topics,query),[topics,query]);
 const passages=useMemo(()=>helpPassages([selected]),[selected]);
 useEffect(()=>{const node=bodyRef.current?.querySelector(`[data-help-section="${section}"]`);if(section)node?.scrollIntoView({block:'start'});else if(bodyRef.current)bodyRef.current.scrollTop=0;},[selectedId,section,language]);
 const select=(id:string,index=0)=>{setSelectedId(id);setSection(index);};
 useEffect(()=>{const key=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='f'){event.preventDefault();searchRef.current?.focus();searchRef.current?.select();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
 const content=<div className="modal help-modal" onClick={e=>{if(!pane)e.stopPropagation();}} style={pane?{display:'flex',flexDirection:'column',overflow:'hidden'}:{width:1000,maxWidth:'95vw',height:'85vh',display:'flex',flexDirection:'column',overflow:'hidden'}}>
  <div className="help-header"><div className="help-header-left"><BookOpen size={18}/><h2>{copy('Sage 帮助','Sage Help')}</h2></div><div className="help-header-actions"><PluginSlot slot="help.toolbar" context={{topicId:selectedId}}/><span className="muted small">v{version||'—'}</span>{!pane?<button className="btn-ghost" aria-label={copy('关闭帮助','Close help')} onClick={onClose}><X size={16}/></button>:null}</div></div>
  <div className="help-body"><nav className="help-nav" aria-label={copy('帮助主题','Help topics')}><div className="help-search"><Search size={14} className="help-search-icon"/><input data-setup="help-search" ref={searchRef} type="search" aria-label={copy('搜索帮助','Search help')} placeholder={copy('搜索关键词或描述问题…','Search keywords or ask a question…')} value={query} onChange={e=>setQuery(e.target.value)}/></div>
  <div className="help-nav-list">{query.trim()?<><p className="help-search-hint muted small">{copy('文本匹配 + 本地知识检索','Text matching + local knowledge retrieval')}</p>{matches.map((m)=><button key={m.topic.id+'-'+m.index} className={`help-nav-item help-result ${selectedId===m.topic.id&&section===m.index?'active':''}`} onClick={()=>select(m.topic.id,m.index)}><strong>{m.topic.title}</strong><span>{m.heading}</span><small>{m.text.replace(/^#+ .*\n?/,'').replace(/[#*`]/g,'').trim().slice(0,180)}…</small><em>{m.direct?copy('直接匹配','Direct match'):copy('相关段落','Related passage')}</em></button>)}{!matches.length?<p className="help-search-hint muted small">{copy('未找到相关帮助。试试功能名称或更具体的问题。','No relevant help found. Try a feature name or a more specific question.')}</p>:null}</>:groups.map(group=><div key={group.name} className="help-nav-group"><div className="help-nav-group-title">{group.name}</div>{group.topics.map(topic=><button key={topic.id} type="button" className={`help-nav-item ${selectedId===topic.id?'active':''}`} onClick={()=>select(topic.id)} title={topic.summary}><span className="help-nav-item-title">{topic.title}</span></button>)}</div>)}</div></nav>
  <div className="help-content"><div className="help-content-header"><span className="muted small">{selected.summary}</span></div><nav className="help-toc" aria-label={copy('本页目录','On this page')}>{passages.filter(p=>p.index>0).map(p=><button type="button" key={p.index} onClick={()=>setSection(p.index)}>{p.heading}</button>)}</nav><div className="help-content-body" ref={bodyRef}>{passages.map(p=><section key={p.index} data-help-section={p.index} className={query.trim()&&section===p.index?'help-section-hit':''}><div data-markdown-document><ReactMarkdown remarkPlugins={[remarkGfm]} components={mermaidMarkdownComponents}>{p.text}</ReactMarkdown></div></section>)}</div></div></div>
 </div>;
 return pane?<div className="pane-host">{content}</div>:<WindowOverlay className="modal-backdrop" onEscape={onClose} onClick={onClose}>{content}</WindowOverlay>;
}
