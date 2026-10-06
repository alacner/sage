import {canResumeExperts} from '../../shared/experts-resume';
import {useEffect,useId,useRef,useState,useLayoutEffect} from 'react';
import {LoaderCircle,ListChecks,CircleAlert,ChevronDown,X} from 'lucide-react';
import type {ExpertsPlan,ExpertTask,ExpertRole} from '../../shared/types';
import './floating-execution-plan.css';

export function FloatingExecutionPlan({plan,onNavigate,roleLabel,managerLabel,en=false,busy=false,onResume}:{
  plan:ExpertsPlan;
  onNavigate:(task:ExpertTask)=>void;
  roleLabel:(role:ExpertRole)=>string;
  managerLabel?:string;
  en?:boolean;
  busy?:boolean;
  onResume:()=>Promise<void>;
}){
  const [interacting,setInteracting]=useState(false);
  const [fading,setFading]=useState(false);
  const [hoverTask,setHoverTask]=useState<string | null>(null);
  const [expandedTasks,setExpandedTasks]=useState<Set<string>>(()=>new Set());
  const [open,setOpen]=useState(false);
  const [pinned,setPinned]=useState(false);
  const [dismissed,setDismissed]=useState(false);
  const [error,setError]=useState('');
  const [resuming,setResuming]=useState(false);
  const resumable=!busy&&canResumeExperts(plan);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const panelId=useId();
  const panelRef=useRef<HTMLElement>(null);
  const [panelBounds,setPanelBounds]=useState<{width:number;left:number}>();
  useLayoutEffect(()=>{
    if(!open)return;
    const anchor=root.current, chat=anchor?.closest('.chat-view');
    if(!anchor)return;
    const update=()=>{
      const area=chat?.getBoundingClientRect();
      const left=Math.max(0,area?.left??0),right=Math.min(window.innerWidth,area?.right??window.innerWidth);
      const width=Math.max(0,Math.min(850,right-left-32));
      const center=Math.max(left+16+width/2,Math.min(right-16-width/2,anchor.getBoundingClientRect().left+anchor.offsetWidth/2));
      setPanelBounds({width,left:center-anchor.getBoundingClientRect().left});
    };
    update();window.addEventListener('resize',update);
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(update):null;
    if(chat)observer?.observe(chat);observer?.observe(anchor);
    return()=>{window.removeEventListener('resize',update);observer?.disconnect();};
  },[open]);
  const [panelHeight,setPanelHeight]=useState<number>();
  useLayoutEffect(()=>{
    if(!open){setPanelHeight(undefined);return;}
    const panel=panelRef.current;
    if(panel) setPanelHeight(Math.max(80,Math.min(panel.scrollHeight+120,window.innerHeight*.72,window.innerHeight-220)));
  },[open,plan.id]);
  const terminal=plan.status==='done'||plan.status==='canceled';
  const failures=(tasks:ExpertTask[]):boolean=>tasks.some(t=>t.status==='error'||!!t.subPlan&&failures(t.subPlan.tasks));
  const failed=!!plan.hasFailedTasks||failures(plan.tasks);
  const completed=plan.status==='done'&&!failed&&!canResumeExperts(plan);
  // Historical completed plans start hidden; only a live completion gets a grace period.
  const [completionHidden,setCompletionHidden]=useState(completed);
  useEffect(()=>{
    setFading(false);
    if(!completed){setCompletionHidden(false);return;}
    if(interacting)return;
    const fade=setTimeout(()=>setFading(true),3000);
    const hide=setTimeout(()=>setCompletionHidden(true),3250);
    return()=>{clearTimeout(fade);clearTimeout(hide);};
  },[completed,interacting,plan.id]);
  const done=plan.tasks.filter(t=>t.status==='done').length;
  const status=resuming?(en?'Continuing…':'继续中…'):resumable?(en?'Click to continue':'点击继续执行'):failed?(en?'Some tasks failed':'部分失败'):plan.status==='done'?(en?'Completed':'已完成'):plan.status==='canceled'?(en?'Cancelled':'已取消'):(en?'Running':'执行中');
  useEffect(()=>{if(!terminal)setDismissed(false);},[terminal]);
  useEffect(()=>{
    if(!open){setHoverTask(null);return;}
    // Layout changes also fire enter/leave events. Only actual pointer movement
    // may change the expanded task, otherwise bottom-anchored resizing oscillates.
    let lastX:number|undefined,lastY:number|undefined;
    const move=(e:MouseEvent)=>{
      if(e.clientX===lastX&&e.clientY===lastY)return;
      lastX=e.clientX;lastY=e.clientY;
      const title=e.target instanceof Element?e.target.closest<HTMLElement>('[data-plan-task]'):null;
      setHoverTask(title&&root.current?.contains(title)?title.dataset.planTask??null:null);
    };
    document.addEventListener('mousemove',move);
    const outside=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node)){setOpen(false);setPinned(false);}};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){if(root.current?.contains(document.activeElement))trigger.current?.focus();setOpen(false);setPinned(false);}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('mousemove',move);document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key);};
  },[open]);
  if(dismissed||plan.status==='draft'||!plan.tasks.length||completionHidden)return null;
  function tasks(items:ExpertTask[],prefix=''):React.ReactNode{
    return <ol className="floating-plan-tasks">{items.map((task,i)=><li key={task.id} className={task.status} data-plan-task={prefix+task.id}>
      <button type="button" className="floating-plan-task" disabled={!task.msgId} onClick={()=>{onNavigate(task);setOpen(false);setPinned(false);}}>
        <span aria-hidden="true">{task.status==='done'?'✓':task.status==='error'?'✗':task.status==='running'?(busy?<span className="experts-task-spinner"/>:<CircleAlert size={13}/>):'○'}</span>
        <span><strong data-plan-task-title={prefix+task.id}>{prefix}{i+1}. {task.title}</strong><small>{roleLabel(task.expert)} {task.expertName} · {{pending:en?'Pending':'待执行',running:busy?(en?'Running':'执行中'):(en?'Interrupted · Can resume':'已中断 · 可继续'),done:en?'Completed':'已完成',error:en?'Failed':'失败'}[task.status]}</small></span>
      </button>
      <button type="button" className="floating-plan-detail-toggle" aria-label={(en?'Task details: ':'任务详情：')+task.title} aria-expanded={expandedTasks.has(prefix+task.id)} onClick={()=>setExpandedTasks(current=>{const next=new Set(current);const key=prefix+task.id;if(next.has(key))next.delete(key);else next.add(key);return next;})}><ChevronDown size={14}/></button>
      {(hoverTask===prefix+task.id||expandedTasks.has(prefix+task.id))&&<div className="floating-plan-details">
      <p>{task.description}</p>
      {!!task.dependsOn?.length&&<small>{en?'Depends on: ':'依赖：'}{task.dependsOn.map(id=>items.find(t=>t.id===id)?.title??id).join('、')}</small>}</div>}
      {task.subPlan&&tasks(task.subPlan.tasks,prefix+(i+1)+'.')}
    </li>)}</ol>;
  }
  async function activatePlan(){
    if(!resumable){setPinned(!pinned);setOpen(!pinned);return;}
    setPinned(true);setOpen(true);setResuming(true);setError('');
    try{await onResume();}catch(e){setError(String((e as Error).message));}
    finally{setResuming(false);}
  }
  return <div className={`floating-plan-dock${fading?' fading':''}`} onMouseEnter={()=>setInteracting(true)} onMouseLeave={()=>setInteracting(false)} onFocusCapture={()=>setInteracting(true)} onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setInteracting(false);}}>
    <div className="floating-plan-anchor" ref={root} onMouseEnter={()=>setOpen(true)} onMouseLeave={()=>{if(!pinned&&!root.current?.contains(document.activeElement))setOpen(false);}} onBlur={e=>{if(!pinned&&!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false);}}>
      <div className="chat-status-pill floating-plan-pill">
      <button ref={trigger} type="button" className="floating-plan-trigger" disabled={resuming} aria-expanded={open} aria-controls={panelId} onFocus={()=>setOpen(true)} onClick={activatePlan} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setOpen(true);setPinned(true);}}}>
        {resuming || (busy && !terminal) ? <LoaderCircle size={15} className="tool-spin floating-plan-running-icon" aria-hidden="true"/> : <ListChecks size={15}/>} <span className="floating-plan-trigger-label">{en?'Execution plan':'执行计划'} · {managerLabel} · {done}/{plan.tasks.length} · {status}</span>
      </button><button type="button" className="chat-changes-expand floating-plan-expand" aria-label={en?'Toggle execution plan':'展开或收起执行计划'} aria-expanded={open} onClick={()=>{setPinned(!pinned);setOpen(!open);}}><ChevronDown size={14}/></button>
      {terminal&&!resumable&&<button type="button" className="floating-plan-dismiss" aria-label={en?'Dismiss plan':'关闭计划浮窗'} onClick={()=>setDismissed(true)}><X size={13}/></button>}
      </div>
      {open&&<section ref={panelRef} style={{height:panelHeight,...panelBounds}} className="floating-plan-panel" id={panelId} aria-label={en?'Execution plan details':'执行计划详情'}>
        <header><strong>{en?'Execution plan':'执行计划'}</strong><span>{status}</span><button type="button" className="floating-plan-dismiss" aria-label={en?'Close details':'收起计划详情'} onClick={()=>{setOpen(false);setPinned(false);}}><X size={13}/></button></header>
        {error&&<p role="alert">{error}</p>}
        {resumable&&<p>{en?'Completed tasks are kept. Interrupted work is checked before continuing.':'保留已完成任务，核对中断前的执行结果后继续剩余工作。'}</p>}
        <p className="floating-plan-goal">{plan.goal}</p>{tasks(plan.tasks)}
      </section>}
    </div>
  </div>;
}
