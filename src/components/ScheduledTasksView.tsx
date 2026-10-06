import {PluginSlot} from './plugins/PluginWorkbench';
import {ScheduledApprovalNotice} from './ScheduledApprovalNotice';
import {ScheduledErrorNotice} from './ScheduledErrorNotice';
import {securityProfiles,securityProfileText} from '../../shared/security-profiles';
import {scheduledError} from '../lib/scheduled-error';
import {modelLabel} from '../../shared/model-label';
import {useEffect,useState,useRef} from 'react';
import {CalendarClock,Play,Pencil,Trash2,MessageSquare,History,Plus,ChevronLeft,ChevronRight,Clock,Info,Upload,Download} from 'lucide-react';
import {useAppStore} from '../stores/appStore';
import {translate} from '../i18n';
import {resolveLanguage} from '../../shared/language';
import {formatDateTime,useDateTimeSettings} from '../lib/date-time';
import {confirmDialog} from '../lib/confirm-dialog';
import {ScheduledTaskModal} from './ScheduledTaskModal';
import {scheduledTemplates,type ScheduledTemplate} from '../lib/scheduled-templates';
import {openScheduledConversation,openScheduledRunConversation} from '../lib/scheduled-conversation';
import type {ScheduledTask,ScheduledProposal,ScheduledTaskInput,ScheduledRun} from '../../shared/types';
import {scheduledInputError} from '../../shared/scheduled-validation';

/** Tasks, editable examples and execution history share the project scope. */
export function ScheduledTasksView({onViewConversation}:{onClose?:()=>void;onViewConversation:(id:string)=>void|Promise<void>}){
 useDateTimeSettings();
 const project=useAppStore(s=>s.currentProject),settings=useAppStore(s=>s.settings),tasks=useAppStore(s=>s.scheduledTasks),runs=useAppStore(s=>s.scheduledRuns);
 const en=resolveLanguage(settings?.language,settings?._systemLocale)==='en';
 const createdDestination=useRef<string>();
 const importedDraft=useRef(false);
 const importInput=useRef<HTMLInputElement>(null);
 const [examplesOpen,setExamplesOpen]=useState(()=>localStorage.getItem('scheduledExamplesSeen')!=='1');
 useEffect(()=>{localStorage.setItem('scheduledExamplesSeen','1');},[]);
 const [taskErrors,setTaskErrors]=useState<Record<string,string>>({});
 const [proposal,setProposal]=useState<ScheduledProposal|null>(null),[error,setError]=useState(''),[pending,setPending]=useState<string|null>(null);
 const [tab,setTab]=useState<'tasks'|'runs'>('tasks'),[category,setCategory]=useState('all'),[page,setPage]=useState(0),[taskFilter,setTaskFilter]=useState('all'),[status,setStatus]=useState('all'),[sort,setSort]=useState('created');
 const refresh=async()=>{await Promise.all([useAppStore.getState().refreshScheduledTasks(),useAppStore.getState().refreshScheduledRuns()]);};
 useEffect(()=>{setProposal(null);setTaskFilter('all');setError('');setTaskErrors({});void refresh().catch(e=>setError(scheduledError(e,en)));},[project?.path]);
 const act=async(id:string,fn:()=>Promise<unknown>)=>{setPending(id);setError('');setTaskErrors(errors=>{const next={...errors};delete next[id];return next;});try{await fn();await refresh();}catch(e:any){if(id==='awake')setError(scheduledError(e,en));else setTaskErrors(errors=>({...errors,[id]:scheduledError(e,en)}));}finally{setPending(null);}};
 const discuss=async(task?:ScheduledTask)=>{
  if(task){await act(task.id,()=>openScheduledConversation(task,en));return;}
  const store=useAppStore.getState(),id=(await store.createConversation())?.id;
  if(id){store.setConvDraft(id,{text:en?'Create a scheduled task: ':'创建一个定时任务：'});onViewConversation(id);}
 };
 const viewRun=async(run:ScheduledRun)=>{setError('');try{await openScheduledRunConversation(run,en,onViewConversation);}catch(e){setError(scheduledError(e,en));}};
 const createRequested=useAppStore(s=>s.scheduledCreateRequested);
 useEffect(()=>{if(createRequested){useAppStore.setState({scheduledCreateRequested:false});void discuss();}},[createRequested]);
 const startCreate=(example?:ScheduledTemplate)=>{
  createdDestination.current=undefined;
  importedDraft.current=false;
  const current=useAppStore.getState().currentConversation;
  const source=current?.projectPath===project?.path&&!current?.archived?current:undefined;
  const task:ScheduledTaskInput={name:example?.name??'',prompt:example?.prompt??'',schedule:structuredClone(example?.schedule??{type:'daily',at:'09:00'}),enabled:true,output:'conversation',sourceConvId:source?.id,targetConvId:source?.id??'__new_associated_conversation__',timeoutMinutes:30,selectedModel:undefined};
  setProposal({action:'create',task});
 };
 const save=async(draft:ScheduledTaskInput)=>{
  if(!project||!proposal)throw Error(en?'Select a project first':'请先选择项目');
  const workflowUsesConversation=draft.outputWorkflow&&[...draft.outputWorkflow.mainTargets,...draft.outputWorkflow.steps.flatMap(step=>step.targets)].some(target=>target.type==='conversation');
  const needsConversation=draft.outputWorkflow?!!workflowUsesConversation:draft.output==='conversation';
  if(proposal.action==='create'&&draft.outputWorkflow&&!needsConversation)draft={...draft,targetConvId:undefined};
  if(proposal.action==='create'&&needsConversation&&draft.targetConvId==='__new_associated_conversation__'){
   if(!createdDestination.current){const conv=await window.api.createConv(project.path,draft.name,settings?.permissionMode??'plan');if(!conv?.id)throw Error(en?'Unable to create associated conversation':'无法创建关联对话');createdDestination.current=conv.id;}
   draft={...draft,sourceConvId:createdDestination.current,targetConvId:createdDestination.current};
  }
  if(proposal.action==='create'&&needsConversation&&!draft.sourceConvId&&!importedDraft.current)draft={...draft,sourceConvId:draft.targetConvId};
  if(proposal.action==='create')await window.api.createScheduled(project.path,draft.name,draft.prompt,draft.schedule,draft);
  else {const saved=await window.api.updateScheduled(proposal.taskId!,draft,proposal.expectedUpdatedAt);if(!saved)throw Error(en?'Task no longer exists':'任务已不存在');}
  setProposal(null);importedDraft.current=false;void useAppStore.getState().refreshConversations();await refresh().catch(e=>setError(scheduledError(e,en)));
 };
 const exportTask=(task:ScheduledTask)=>{
  const config:ScheduledTaskInput={name:task.name,prompt:task.prompt,schedule:structuredClone(task.schedule),enabled:task.enabled,output:task.output,targetConvId:task.targetConvId,selectedModel:task.selectedModel?structuredClone(task.selectedModel):undefined,securityProfileId:task.securityProfileId,channelIds:task.channelIds?[...task.channelIds]:undefined,outputWorkflow:task.outputWorkflow?structuredClone(task.outputWorkflow):undefined,timeoutMinutes:task.timeoutMinutes};
  const payload={format:'sage-scheduled-task',version:1,task:config};
  const blob=new Blob([JSON.stringify(payload,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=`${task.name.trim().replace(/[^a-zA-Z0-9一-龥._-]+/g,'-').slice(0,60)||'scheduled-task'}.sage-task.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
 const importTask=async(file?:File)=>{
  if(!file)return;
  try{
   if(file.size>2*1024*1024)throw Error(en?'File is too large (2 MB maximum).':'文件过大（最大 2 MB）。');
   const payload=JSON.parse(await file.text());
   if(payload?.format!=='sage-scheduled-task'||payload?.version!==1||!payload.task||typeof payload.task!=='object')throw Error(en?'Unsupported scheduled task file.':'不支持的定时任务文件。');
   const raw=payload.task as ScheduledTaskInput;
   if(typeof raw.name!=='string'||typeof raw.prompt!=='string'||!raw.schedule||typeof raw.schedule!=='object'||typeof raw.schedule.type!=='string')throw Error(en?'Task configuration is incomplete.':'任务配置不完整。');
   const task:ScheduledTaskInput={...raw,authorizationMode:'policy',enabled:false,sourceConvId:undefined,sourceMessageId:undefined};
   delete (task as Partial<ScheduledTask>).authorization;
   const target=task.targetConvId;
   if(target&&!useAppStore.getState().conversations.some(c=>c.id===target&&!c.archived))task.targetConvId=undefined;
   const invalid=scheduledInputError(task);
   if(invalid&&!['conversation','channels'].includes(invalid))throw Error(en?'Invalid task configuration: ':'任务配置无效：'+invalid);
   importedDraft.current=true;createdDestination.current=undefined;setTab('tasks');setProposal({action:'create',task});
  }catch(e:any){setError(e?.message??String(e));}
  finally{if(importInput.current)importInput.current.value='';}
 };
 const stateLabel=(value:string)=>en?({approval:'Waiting for authorization',running:'Running',success:'Succeeded',failed:'Failed',missed:'Missed',pending:'Pending',delivery:'Delivery failed',quiet:'Completed quietly'}[value]??value):({approval:'等待授权',running:'执行中',success:'成功',failed:'失败',missed:'错过',pending:'等待',delivery:'投递失败',quiet:'完成 · 未触发提醒'}[value]??value);
 const runState=(r:ScheduledRun)=>r.status==='running'&&r.pendingApprovals?.length?'approval':r.deliveryError?'delivery':r.status==='success'&&r.outputDisposition==='silent'?'quiet':r.status;
 const running=(id:string)=>runs.some(r=>r.taskId===id&&r.status==='running');
 const categories=en?{all:'All examples',work:'Daily work',ops:'Operations',development:'Development',research:'Research'}:{all:'全部案例',work:'日常工作',ops:'运维巡检',development:'研发质量',research:'信息研究'};
 const examples=scheduledTemplates(en).filter(t=>category==='all'||t.category===category),pages=Math.ceil(examples.length/3);
 const sorted=[...tasks].sort((a,b)=>sort==='next'?(a.nextRunAt??Infinity)-(b.nextRunAt??Infinity):Date.parse(b.createdAt)-Date.parse(a.createdAt));
 const records=runs.filter(r=>(taskFilter==='all'||r.taskId===taskFilter)&&(status==='all'||runState(r)===status)).sort((a,b)=>b.startedAt-a.startedAt);
 return <div className="scheduled-workspace">
  <header><h2><CalendarClock size={21}/> {en?'Scheduled tasks':'定时任务'}</h2><p className="muted">{en?'Run tasks on a schedule or manually. Describe a task in any conversation, or configure one here.':'按计划自动执行，也可随时手动触发。在对话中描述需求，或在这里直接配置任务。'}</p><div className="scheduled-header-actions"><PluginSlot slot="scheduled.toolbar"/><input ref={importInput} type="file" accept=".json,.sage-task.json,application/json" hidden onChange={e=>void importTask(e.target.files?.[0])}/><button disabled={!project} onClick={()=>importInput.current?.click()}><Upload size={14}/> {en?'Import task':'导入定时任务'}</button><button onClick={()=>void discuss()}><MessageSquare size={14}/> {en?'Create in conversation':'在对话中创建'}</button><button className="btn-primary" disabled={!project} onClick={()=>startCreate()}><Plus size={15}/> {en?'New scheduled task':'新建定时任务'}</button><button className="scheduled-examples-toggle" aria-expanded={examplesOpen} aria-controls="scheduled-examples" onClick={()=>setExamplesOpen(open=>!open)}>{en?'Recommended examples':'推荐案例'}{examplesOpen?<ChevronLeft size={14}/>:<ChevronRight size={14}/>}</button></div></header>
  {error&&<p role="alert" className="file-error">{error}</p>}
  <div className="scheduled-runtime-note"><span><Info size={16}/>{en?'Sage must be running and the computer awake.':'定时任务需要 Sage 运行且电脑保持唤醒。'}</span><label><input type="checkbox" checked={!!settings?.preventSleep} disabled={!settings||pending==='awake'} onChange={e=>{const preventSleep=e.target.checked;void act('awake',()=>useAppStore.getState().saveSettings({preventSleep}));}}/>{en?'Keep system awake':'保持系统唤醒'}</label></div>
  <section id="scheduled-examples" className="scheduled-examples" hidden={!examplesOpen}><div className="scheduled-section-heading"><h3>{en?'Recommended examples':'推荐案例'}</h3><div><button className="icon-btn" aria-label={en?'Previous examples':'上一组案例'} disabled={page===0} onClick={()=>setPage(p=>p-1)}><ChevronLeft size={16}/></button><span className="muted small">{page+1} / {pages}</span><button className="icon-btn" aria-label={en?'Next examples':'下一组案例'} disabled={page>=pages-1} onClick={()=>setPage(p=>p+1)}><ChevronRight size={16}/></button></div></div>
   <div className="scheduled-category-filter">{Object.entries(categories).map(([id,label])=><button key={id} aria-pressed={category===id} onClick={()=>{setCategory(id);setPage(0);}}>{label}</button>)}</div>
   <div className="scheduled-example-grid">{examples.slice(page*3,page*3+3).map(example=><button key={example.id} className="scheduled-example-card" onClick={()=>startCreate(example)}><strong>{example.name}</strong><p>{example.description}</p><span><Clock size={13}/>{formatSchedule({schedule:example.schedule})}</span><small>{en?'Use example →':'使用案例 →'}</small></button>)}</div>
  </section>
  <div className="scheduled-list-toolbar"><div role="tablist" aria-label={en?'Tasks and runs':'任务与记录'}><button role="tab" aria-selected={tab==='tasks'} onClick={()=>setTab('tasks')}>{en?'My scheduled tasks':'我的定时任务'} <span className="muted">{tasks.length}</span></button><button role="tab" aria-selected={tab==='runs'} onClick={()=>setTab('runs')}>{en?'Execution history':'执行记录'}</button></div>
   {tab==='tasks'?<select aria-label={en?'Task order':'任务排序'} value={sort} onChange={e=>setSort(e.target.value)}><option value="created">{en?'Newest first':'按创建时间倒序'}</option><option value="next">{en?'Next run first':'按下次执行时间'}</option></select>:<div className="scheduled-history-filters"><select aria-label={en?'Filter by task':'按任务筛选'} value={taskFilter} onChange={e=>setTaskFilter(e.target.value)}><option value="all">{en?'All tasks':'全部任务'}</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><select aria-label={en?'Filter by status':'按状态筛选'} value={status} onChange={e=>setStatus(e.target.value)}><option value="all">{en?'All statuses':'全部状态'}</option>{['approval','running','success','quiet','failed','delivery','missed'].map(s=><option key={s} value={s}>{stateLabel(s)}</option>)}</select></div>}
  </div>
  {tab==='tasks'?<div className="scheduled-task-list">{!tasks.length&&<p className="scheduled-empty muted">{en?'No tasks yet. Start with an example or create your own.':'暂无任务，可以选择推荐案例或新建自己的定时任务。'}</p>}{sorted.map(task=>{
   const latest=runs.find(r=>r.taskId===task.id&&r.status==='running')??runs.filter(r=>r.taskId===task.id).sort((a,b)=>b.startedAt-a.startedAt)[0],provider=settings?.modelProviders?.find(p=>p.id===task.selectedModel?.providerId),busy=running(task.id)||pending===task.id;
   const destination=task.outputWorkflow?(en?`Main outputs: ${task.outputWorkflow.mainTargets.length}`:`主任务输出：${task.outputWorkflow.mainTargets.length} 个目标`):task.output==='silent'?(en?'Silent':'静默执行'):task.output==='channels'?(en?'Channels':'通知渠道'):task.output==='conversation'?(en?'Conversation':'指定对话'):(en?'New conversation':'新对话');
   return <article className="scheduled-task-row" key={task.id}>
    <div className="scheduled-task-details"><div className="scheduled-task-title"><h3>{task.name}</h3><label className="scheduled-task-toggle"><input type="checkbox" aria-label={`${task.enabled?(en?'Pause':'暂停'):(en?'Enable':'启用')} ${task.name}`} checked={task.enabled} disabled={pending===task.id} onChange={()=>void act(task.id,()=>window.api.toggleScheduled(task.id,!task.enabled))}/><span>{task.enabled?(en?'Enabled':'启用'):(en?'Paused / completed':'暂停 / 已完成')}</span></label></div><p className="scheduled-task-prompt muted">{task.prompt}</p><p className="small"><Clock size={13}/> {formatSchedule(task)}</p><p className="muted small">{en?'Next run: ':'下次执行：'}{task.enabled&&task.nextRunAt?formatDateTime(task.nextRunAt):'—'}</p><p className="muted small">{destination}{task.outputWorkflow?.steps.length?(en?` · ${task.outputWorkflow.steps.length} decision step(s)`:` · ${task.outputWorkflow.steps.length} 个判断步骤`):''} · {task.selectedModel&&!task.selectedModel.followDefault?`${provider?.name??(en?'Model provider':'模型提供商')} / ${modelLabel(provider,task.selectedModel.modelId)}`:(en?'Default model':'默认模型')}{task.selectedModel?.thinkingEffort?` · ${task.selectedModel.thinkingEffort}`:''}</p><p className="muted small">{en?'Authorization: ':'授权：'}{task.authorizationMode==='source'?(en?'Inherited conversation authorization':'继承来源对话授权'):task.securityProfileId?(()=>{const p=securityProfiles(settings).find(p=>p.id===task.securityProfileId&&p.enabled!==false);return p?securityProfileText(p,'name',en?'en':'zh'):(en?'Policy unavailable':'方案已失效');})():(en?'Follow default policy':'跟随默认方案')}</p>{task.pausedReason&&<p className="muted small">{task.pausedReason==='conversation_archived'?(en?'Paused because the associated conversation was archived':'关联对话已归档，任务已暂停'):(en?'Output conversation unavailable; task paused':'输出对话已不存在，任务已暂停')}</p>}{latest&&<p className="small">{en?'Last check: ':'最近检查：'}{formatDateTime(latest.finishedAt??latest.startedAt)} · {stateLabel(runState(latest))}{latest.completedOutputSteps?.length?(en?` · ${latest.completedOutputSteps.length} steps matched`:` · 命中 ${latest.completedOutputSteps.length} 个步骤`):''}</p>}{latest&&<ScheduledApprovalNotice run={latest} en={en}/>} {!busy&&(taskErrors[task.id]||latest?.error||latest?.deliveryError)&&<ScheduledErrorNotice key={taskErrors[task.id]??latest?.id} message={taskErrors[task.id]||latest?.error||latest?.deliveryError||''} en={en} onConfigure={()=>setProposal({action:'update',taskId:task.id,expectedUpdatedAt:task.updatedAt,task})}/>}</div>
    <div className="scheduled-row-actions"><PluginSlot slot="scheduled.task" context={{taskId:task.id}}/><button disabled={busy} title={en?'Run now':'立即运行'} onClick={()=>void act(task.id,async()=>{const r=await window.api.runScheduledNow(task.id);if(!r.ok&&!r.run)throw new Error(r.error);})}><Play size={15}/></button><button title={en?'Edit settings':'编辑配置'} onClick={()=>setProposal({action:'update',taskId:task.id,expectedUpdatedAt:task.updatedAt,task})}><Pencil size={15}/></button><button disabled={pending===task.id} title={en?'Go to task message':'定位任务消息'} onClick={()=>void discuss(task)}><MessageSquare size={15}/></button><button title={en?'Run history':'运行记录'} onClick={()=>{setTaskFilter(task.id);setStatus('all');setTab('runs');}}><History size={15}/></button><button title={en?'Export task':'导出定时任务'} onClick={()=>exportTask(task)}><Download size={15}/></button><button disabled={busy} title={en?'Delete':'删除'} onClick={()=>void act(task.id,async()=>{if(await confirmDialog({title:en?'Delete task':'删除任务',message:task.name,okLabel:en?'Delete':'删除',danger:true}))await window.api.deleteScheduled(task.id);})}><Trash2 size={15}/></button></div>
   </article>;
  })}</div>:<div className="scheduled-history-table"><table><thead><tr><th>{en?'Task / status':'任务 / 状态'}</th><th>{en?'Executed at':'执行时间'}</th><th>{en?'Duration':'耗时'}</th><th>{en?'Result':'结果'}</th></tr></thead><tbody>{records.map(run=><tr key={run.id}><td><strong>{tasks.find(t=>t.id===run.taskId)?.name??(en?'Deleted task':'已删除任务')}</strong><p className={run.status==='failed'||run.deliveryError?'file-error':'muted'}>{stateLabel(runState(run))}{run.deliverySkipped?(en?' · Conversation archived; result saved in execution details':' · 对话已归档，结果保留在执行详情'):''}</p><ScheduledApprovalNotice run={run} en={en}/>{(run.error||run.deliveryError)&&<ScheduledErrorNotice message={run.error||run.deliveryError||''} en={en}/>}</td><td>{formatDateTime(run.startedAt)}</td><td>{run.finishedAt?`${Math.max(0,Math.round((run.finishedAt-run.startedAt)/1000))} ${en?'s':'秒'}`:'—'}</td><td>{(run.outputConvId||run.convId)?<button onClick={()=>void viewRun(run)}>{en?'View':'查看'}</button>:'—'}</td></tr>)}</tbody></table>{!records.length&&<p className="scheduled-empty muted">{en?'No matching runs.':'暂无符合条件的执行记录。'}</p>}</div>}
  {proposal&&<ScheduledTaskModal key={`${project?.path}:${proposal.taskId??'new'}`} proposal={proposal} onCancel={()=>setProposal(null)} onConfirm={save}/>}
 </div>;
}
function formatSchedule(task: Pick<ScheduledTask,'schedule'>): string {
  const { schedule } = task;
  switch (schedule.type) {
    case 'once':
      return schedule.at ? translate('scheduled.fmt.onceAt', { time: formatDateTime(schedule.at) }) : translate('scheduled.fmt.once');
    case 'interval':
      return translate('scheduled.fmt.interval', { n: schedule.intervalMinutes ?? 0 });
    case 'hourly':
      return translate('scheduled.fmt.hourly', { m: schedule.minute ?? 0 });
    case 'daily':
      return translate('scheduled.fmt.daily', { at: schedule.at ?? '09:00' });
    case 'weekly': {
      return translate('scheduled.fmt.weekly', { wd: translate(`scheduled.wd.${schedule.weekday ?? 1}`), at: schedule.at ?? '09:00' });
    }
    case 'monthly':
      return translate('scheduled.fmt.monthly', { d: schedule.monthDay ?? 0, at: schedule.at ?? '09:00' });
    default:
      return translate('scheduled.fmt.none');
  }
}
