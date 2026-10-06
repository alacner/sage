import { useEffect, useRef, useState } from 'react';
import { Maximize2, PictureInPicture2, X, GripHorizontal, ChevronDown, ChevronUp } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import type {BrowserPreviewCommand} from '../../../../shared/browser-agent';
import { BrowserView } from './BrowserView';
import './browser-preview.css';

type PreviewAgent={conversationId:string;leaseId?:string;status:string;manual?:boolean;viewport:{width:number;height:number}};
const DEFAULT_PREVIEW_VIEWPORT = {width:1280,height:800};

/** Keep the same guest mounted when switching tabs or docking the preview. */
export function BrowserWorkspace() {
  const tabs = useAppStore(s => s.openTabs);
  const active = useAppStore(s => s.activeTabId);
  const project = useAppStore(s => s.currentProject?.path);
  const language = useAppStore(s => s.settings?.language);
  const en = language === 'en';
  const [floating, updateFloating] = useState<string>();
  const floatingRef=useRef<string>();
  const setFloating=(value:string|undefined|((old:string|undefined)=>string|undefined))=>{const next=typeof value==='function'?value(floatingRef.current):value;floatingRef.current=next;updateFloating(next);};
  const previous = useRef<string>();
  const [agents, updateAgents] = useState<Record<string,PreviewAgent>>({});
  const agentsRef=useRef<Record<string,PreviewAgent>>({});
  const setAgents=(change:(old:Record<string,PreviewAgent>)=>Record<string,PreviewAgent>)=>{const next=change(agentsRef.current);agentsRef.current=next;updateAgents(next);};
  const projectRef=useRef(project);
  const retainManually=(id:string)=>{
    const agent=agentsRef.current[id];if(!agent||agent.status==='running'||agent.manual)return;
    setAgents(old=>({...old,[id]:{...old[id],manual:true}}));
    void window.api.browserPreviewControl?.(id,'retain').catch(error=>useAppStore.getState().setBanner(String(error)));
  };
  useEffect(() => window.api.onBrowserPreviewCommand?.(async(command:BrowserPreviewCommand) => {
    const state=useAppStore.getState();
    if(state.currentProject?.path!==command.project){window.api.replyBrowserPreview({requestId:command.requestId,error:'Project changed'});return;}
    try {
      const tab=state.openTabs.find(t=>t.id===command.tabId&&t.kind==='browser');
      const agent=agentsRef.current[command.tabId];
      if(command.action!=='open'&&command.leaseId&&agent?.leaseId!==command.leaseId)throw Error('Expired browser lease');
      if(command.idle){
        const floatingVisible=floatingRef.current===command.tabId&&(!agent||!state.activeTabId?.startsWith('conv:')||state.activeTabId===`conv:${agent.conversationId}`);
        if(command.action!=='dispose'||!command.leaseId||!agent||agent.status!=='ready'||agent.manual||state.activeTabId===command.tabId||floatingVisible)throw Error('Browser page is in use');
        const approved=await window.api.browserPreviewDisposeIdle?.({project:command.project,tabId:command.tabId,leaseId:command.leaseId});
        const latest=useAppStore.getState(),latestAgent=agentsRef.current[command.tabId];
        const latestVisible=latest.activeTabId===command.tabId||(floatingRef.current===command.tabId&&(!latestAgent||!latest.activeTabId?.startsWith('conv:')||latest.activeTabId===`conv:${latestAgent.conversationId}`));
        if(!approved||latest.currentProject?.path!==command.project||latestAgent?.leaseId!==command.leaseId||latestAgent.status!=='ready'||latestAgent.manual||latestVisible)throw Error('Browser page state changed');

      }
      if(command.action==='open') {
        if(!tab&&!command.url)throw Error('Browser tab was closed');
        if(!tab)useAppStore.setState(s=>({openTabs:[...s.openTabs,{kind:'browser',id:command.tabId,data:{url:command.url,title:'浏览器预览'}}]}));
        setAgents(old=>({...old,[command.tabId]:{conversationId:command.conversationId,leaseId:command.leaseId,manual:agentsRef.current[command.tabId]?.manual,status:'running',viewport:{width:command.width??1280,height:command.height??800}}}));
        setFloating(command.tabId);
      } else {
        if(!tab)throw Error('Browser tab was closed');
        if(command.action==='show')setFloating(command.tabId);
        if(command.action==='hide')setFloating(old=>old===command.tabId?undefined:old);
        if(command.action==='resize')setAgents(old=>({...old,[command.tabId]:{...old[command.tabId],viewport:{width:command.width!,height:command.height!}}}));
        if(command.action==='state'||command.action==='release')setAgents(old=>old[command.tabId]?({...old,[command.tabId]:{...old[command.tabId],status:command.status??'ready'}}):old);
        if(command.action==='dispose') {
          useAppStore.setState(s=>({openTabs:s.openTabs.filter(t=>t.id!==command.tabId),activeTabId:s.activeTabId===command.tabId?s.openTabs.find(t=>t.id!==command.tabId)?.id:s.activeTabId}));
          setFloating(old=>old===command.tabId?undefined:old);
          setAgents(old=>{const next={...old};delete next[command.tabId];return next;});
        }
      }
      window.api.replyBrowserPreview({requestId:command.requestId,tabId:command.tabId});
    }catch(error){window.api.replyBrowserPreview({requestId:command.requestId,error:String(error)});}
  }), []);
  useEffect(()=>{
    if(projectRef.current!==project){projectRef.current=project;setFloating(undefined);setAgents(()=>({}));previous.current=undefined;}
    const openTabIds=tabs.filter(tab=>tab.kind==='browser').map(tab=>tab.id);
    const visibleTabIds=openTabIds.filter(id=>active===id||(floatingRef.current===id&&(!agentsRef.current[id]||!active?.startsWith('conv:')||active===`conv:${agentsRef.current[id].conversationId}`)));
    void window.api.browserPreviewWorkspace?.({project,openTabIds,visibleTabIds}).catch(error=>console.warn('[browser] lifecycle sync failed',error));
    const removed=Object.keys(agentsRef.current).some(id=>!openTabIds.includes(id));
    if(removed)setAgents(old=>Object.fromEntries(Object.entries(old).filter(([id])=>openTabIds.includes(id))));
  },[tabs,active,floating,project]);
  useEffect(() => {
    if (active && !active.startsWith('browser:')) previous.current = active;
  }, [active]);
  return <>{tabs.filter(tab => tab.kind === 'browser').map(tab => tab.kind === 'browser' && (
    <BrowserPane key={tab.id} id={tab.id} url={tab.data?.url} incognito={tab.data?.incognito}
      visible={active === tab.id} floating={floating === tab.id && (!agents[tab.id] || !active?.startsWith('conv:') || active === `conv:${agents[tab.id].conversationId}`)} en={en} agent={agents[tab.id]} onManual={()=>retainManually(tab.id)}
      onFloat={() => {
        setFloating(tab.id);
        const back = tabs.find(t => t.id === previous.current && t.kind !== 'browser') || tabs.find(t => t.kind === 'conversation');
        if (back) useAppStore.setState({activeTabId: back.id});
      }}
      onDock={() => { setFloating(undefined); useAppStore.setState({activeTabId: tab.id}); }}
      onHide={() => setFloating(undefined)} />
  ))}</>;
}

function BrowserPane({id, url, incognito, visible, floating, en, agent, onFloat, onDock, onHide, onManual}: {
  id: string; url?: string; incognito?: boolean; visible: boolean; floating: boolean; en: boolean;
  agent?: PreviewAgent;
  onManual:()=>void;
  onFloat: () => void; onDock: () => void; onHide: () => void;
}) {
  const locked=agent?.status==='running';
  const [reload, setReload] = useState(0);
  const [toolbarHidden, setToolbarHidden] = useState(true);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({x: Math.max(8, window.innerWidth - 400), y: 72});
  const pane = useRef<HTMLDivElement>(null);
  const [previewWidth, setPreviewWidth] = useState(400);
  const viewport = agent?.viewport ?? (floating ? DEFAULT_PREVIEW_VIEWPORT : undefined);
  const drag = useRef<{x: number; y: number; left: number; top: number}>();
  useEffect(() => {
    const handler = (event: Event) => { if ((event as CustomEvent).detail === id) setReload(n => n + 1); };
    window.addEventListener('sage:browser-reload', handler);
    return () => window.removeEventListener('sage:browser-reload', handler);
  }, [id]);
  useEffect(() => {
    const clamp = () => setPosition(p => ({x: Math.max(8, Math.min(p.x, window.innerWidth - (pane.current?.offsetWidth || 400) - 8)), y: Math.max(8, Math.min(p.y, window.innerHeight - (pane.current?.offsetHeight || 300) - 8))}));
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);
  useEffect(() => {
    if (!floating || !viewport) return;
    const element = pane.current;
    const content = element?.querySelector('.browser-content');
    if (!element || !content) return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = content.clientHeight;
        if (!height) return;
        const width = Math.min(window.innerWidth - 16, Math.max(220, Math.ceil(height * viewport.width / viewport.height) + 2));
        setPreviewWidth(previous => previous === width ? previous : width);
        setPosition(previous => {
          const x = Math.max(8, Math.min(previous.x, window.innerWidth - width - 8));
          const y = Math.max(8, Math.min(previous.y, window.innerHeight - element.offsetHeight - 8));
          return x === previous.x && y === previous.y ? previous : {x,y};
        });
      });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    window.addEventListener('resize', fit);
    fit();
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); cancelAnimationFrame(frame); };
  }, [floating, viewport?.width, viewport?.height]);
  return <div ref={pane} className={`browser-pane${floating ? ' browser-preview-float' : ''}${floating && toolbarHidden ? ' browser-preview-toolbar-hidden' : ''}`}
    onPointerDownCapture={event=>{if(event.isTrusted&&!locked&&(event.target as HTMLElement).closest('.browser-preview-content,.browser-preview-toolbar-host'))onManual();}}
    onFocusCapture={event=>{if(event.isTrusted&&!locked&&(event.target as HTMLElement).closest('.browser-preview-content,.browser-preview-toolbar-host'))onManual();}}
    style={floating ? {left: position.x, top: position.y, width:previewWidth} : {display: visible ? 'flex' : 'none'}}>
    <div className={`browser-preview-heading${floating && !toolbarHidden ? ' browser-preview-heading-with-toolbar' : ''}`}
      onPointerDown={event => {
        if (!floating || (event.target as HTMLElement).closest('button')) return;
        drag.current = {x: event.clientX, y: event.clientY, left: position.x, top: position.y};
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start) return;
        setPosition({x: Math.max(8, Math.min(start.left + event.clientX - start.x, window.innerWidth - (pane.current?.offsetWidth || 400) - 8)), y: Math.max(8, Math.min(start.top + event.clientY - start.y, window.innerHeight - (pane.current?.offsetHeight || 300) - 8))});
      }}
      onPointerUp={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}>
      {floating && <GripHorizontal size={14} />}
      <span className="browser-preview-title">{en ? 'Browser preview' : '浏览器预览'}{agent ? ` · ${agent.status==='running'?(en?'Agent controlling':'Agent 控制中'):agent.status==='paused'?(en?'Paused':'已暂停'):(en?'Ready':'可操作')}` : ''}</span>
      <div ref={setToolbarTarget} className={`browser-preview-toolbar-host${floating && toolbarHidden ? ' browser-preview-toolbar-hidden' : ''}`} />
      {agent && agent.status!=='ready' && <button className="icon-btn" title={agent.status==='paused'?'继续 Agent':'暂停 Agent'} onClick={() => void window.api.browserPreviewControl(id,agent.status==='paused'?'resume':'pause').catch(error=>useAppStore.getState().setBanner(String(error)))}>{agent.status==='paused'?'▶':'Ⅱ'}</button>}
      <button className="icon-btn" onClick={event=>{if(event.isTrusted&&!locked)onManual();if(floating)onDock();else onFloat();}} title={floating ? (en ? 'Restore to tab' : '还原到标签页') : (en ? 'Float over conversation' : '悬浮在对话上方')} aria-label={floating ? '还原到标签页' : '悬浮预览'}>
        {floating ? <Maximize2 size={15}/> : <PictureInPicture2 size={15}/>}
      </button>
      {floating && <button className="icon-btn" title={toolbarHidden ? (en?'Show navigation':'显示导航栏') : (en?'Hide navigation':'隐藏导航栏')} onClick={e=>{e.stopPropagation();setToolbarHidden(v=>!v)}} aria-label={toolbarHidden ? '显示导航栏' : '隐藏导航栏'}>{toolbarHidden ? <ChevronDown size={15}/> : <ChevronUp size={15}/>}</button>}
      {floating && <button className="icon-btn" onClick={onHide} title={en ? 'Hide preview' : '收起预览（保留页面）'} aria-label="收起预览"><X size={15}/></button>}
    </div>
    <div className={`browser-preview-content${locked?' is-agent-controlled':''}`} aria-busy={locked}>
      <div className="browser-preview-surface" {...(locked?{inert:''} as any:{})}>
        <BrowserView initialUrl={url} tabId={id} incognito={incognito} reloadNonce={reload} compact={floating} viewport={viewport} interactionLocked={locked} toolbarTarget={floating ? toolbarTarget ?? undefined : undefined}/>
      </div>
      {locked&&<div className="browser-agent-input-shield" data-agent-input-shield="true" tabIndex={-1} aria-hidden="true"
        title={en?'Agent is controlling this page. Pause to interact.':'Agent 控制中，暂停后可手动操作。'}
        onPointerDown={e=>{e.preventDefault();e.stopPropagation();}} onClick={e=>{e.preventDefault();e.stopPropagation();}}
        onDoubleClick={e=>{e.preventDefault();e.stopPropagation();}} onContextMenu={e=>{e.preventDefault();e.stopPropagation();}}
        onDragOver={e=>{e.preventDefault();e.stopPropagation();}} onDrop={e=>{e.preventDefault();e.stopPropagation();}}/>}
    </div>
  </div>;
}
