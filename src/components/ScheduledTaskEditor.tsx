import {ScheduledSecuritySelector} from './ScheduledSecuritySelector';
import {scheduledError} from '../lib/scheduled-error';
import { useEffect, useRef, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { resolveLanguage } from '../../shared/language';
import { scheduledInputError } from '../../shared/scheduled-validation';
import type { ScheduledTaskInput, ScheduledProposal, ScheduleType, ScheduledOutputTarget, ScheduledOutputWorkflow, ScheduledOutputStep } from '../../shared/types';
import { ModelSelector } from './ModelSelector';

export function ScheduledTaskEditor({proposal,onConfirm,onCancel,dialog=false,onBusyChange}:{dialog?:boolean;onBusyChange?:(busy:boolean)=>void;proposal:ScheduledProposal;onConfirm:(task:ScheduledTaskInput)=>Promise<void>;onCancel:()=>void}){
 const settings=useAppStore(s=>s.settings),project=useAppStore(s=>s.currentProject),conversations=useAppStore(s=>s.conversations);
 const en=resolveLanguage(settings?.language,settings?._systemLocale)==='en';
 const [task,setTask]=useState<ScheduledTaskInput>(()=>structuredClone(proposal.task));
 const [channels,setChannels]=useState<Array<{id:string;name:string;enabled:boolean}>>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const saving=useRef(false);
 const patch=(value:Partial<ScheduledTaskInput>)=>setTask(t=>({...t,...value}));
 const workflow:ScheduledOutputWorkflow=task.outputWorkflow??{mainTargets:task.output==='conversation'?[{type:'conversation'}]:task.output==='channels'?(task.channelIds??[]).map(channelId=>({type:'channel' as const,channelId})):[],steps:[]};
 const patchWorkflow=(change:(current:ScheduledOutputWorkflow)=>ScheduledOutputWorkflow)=>setTask(t=>({...t,outputWorkflow:change(t.outputWorkflow??{mainTargets:t.output==='conversation'?[{type:'conversation'}]:t.output==='channels'?(t.channelIds??[]).map(channelId=>({type:'channel' as const,channelId})):[],steps:[]})}));
 const toggleTarget=(targets:ScheduledOutputTarget[],target:ScheduledOutputTarget)=>targets.some(item=>item.type===target.type&&(item.type==='conversation'||(target.type==='channel'&&target.channelId===item.channelId)))?targets.filter(item=>!(item.type===target.type&&(item.type==='conversation'||(target.type==='channel'&&target.channelId===item.channelId)))):[...targets,target];
 const stepPatch=(id:string,change:(step:ScheduledOutputStep)=>ScheduledOutputStep)=>patchWorkflow(current=>({...current,steps:current.steps.map(step=>step.id===id?change(step):step)}));
 const locked=['delete','run'].includes(proposal.action);
 useEffect(()=>{
  let live=true,requestId=0;
  const projectPath=project?.path;
  // Refresh only the destination catalogue. The task and workflow remain the user's draft.
  const refreshChannels=async()=>{
   if(!live||!projectPath)return;
   const request=++requestId;
   try{const items=await window.api.listChannels(projectPath);if(live&&request===requestId)setChannels(items);}
   catch(err){if(live&&request===requestId)setError(String(err));}
  };
  setChannels([]);
  const unsubscribe=window.api.onMobileManagementChanged?.(event=>{if(event.section==='channels'&&event.projectPath===projectPath)void refreshChannels();});
  void refreshChannels();
  return()=>{live=false;requestId++;unsubscribe?.();};
 },[project?.path]);
 const labels:Record<ScheduleType,string>=en?{once:'Once',interval:'Every N minutes',hourly:'Hourly',daily:'Daily',weekly:'Weekly',monthly:'Monthly'}:{once:'一次性',interval:'每隔 N 分钟',hourly:'每小时',daily:'每天',weekly:'每周',monthly:'每月'};
 const errors:Record<string,string>=en?{model:'Choose a supported model and thinking effort.',namePrompt:'Enter a name and instructions.',future:'Choose a future date and time.',interval:'Interval must be at least 1 minute.',minute:'Minute must be 0–59.',time:'Choose a valid time.',weekday:'Choose a weekday.',monthDay:'Day must be 1–31.',output:'Choose an output destination.',conversation:'Choose an output conversation.',channels:'Select at least one enabled channel.',outputWorkflow:'Choose a main output or add a complete conditional step with a destination.',timeout:'Timeout must be 1–120 minutes.',schedule:'Choose a schedule.'}:{model:'请选择有效的模型与思考强度。',namePrompt:'请填写任务名称和执行内容。',future:'请选择未来的日期和时间。',interval:'间隔至少为 1 分钟。',minute:'分钟应为 0–59。',time:'请选择有效时间。',weekday:'请选择星期。',monthDay:'日期应为 1–31。',output:'请选择输出方式。',conversation:'请选择输出对话。',channels:'请至少选择一个已启用渠道。',outputWorkflow:'请选择主任务输出目标，或添加一个配置完整且带输出目标的条件步骤。',timeout:'超时应为 1–120 分钟。',schedule:'请选择调度方式。'};
 const save=async()=>{if(saving.current)return;const normalizedTask=task.outputWorkflow?{...task,outputWorkflow:{...task.outputWorkflow,steps:task.outputWorkflow.steps.map(step=>({...step,targets:step.targets.filter(target=>target.type==='channel')}))}}:task;const invalid=locked?undefined:scheduledInputError(normalizedTask);if(invalid){setError(errors[invalid]??invalid);return;}saving.current=true;setBusy(true);onBusyChange?.(true);setError('');try{await onConfirm(normalizedTask);}catch(err:any){setError(scheduledError(err,en));}finally{saving.current=false;setBusy(false);onBusyChange?.(false);}};
 const localDate=(iso?:string)=>{if(!iso||!Number.isFinite(Date.parse(iso)))return '';const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
 return <section className="scheduled-task-editor clarify-step-card">
  <h3><CalendarClock size={18}/> {en?({create:dialog?'New scheduled task':'Confirm scheduled task',update:'Update scheduled task',delete:'Delete scheduled task',run:'Run scheduled task now'}[proposal.action]):({create:dialog?'新建定时任务':'确认创建定时任务',update:'调整定时任务',delete:'删除定时任务',run:'立即运行定时任务'}[proposal.action])}</h3>
  <p className="muted small">{en?'Review the instructions, schedule, model and destination before confirming.':'请确认执行内容、时间、模型和输出位置后提交。'}</p>
  <fieldset disabled={busy||locked}>
   <label>{en?'Task name':'任务名称'}<input value={task.name} onChange={e=>patch({name:e.target.value})}/></label>
   <label>{en?'Instructions for each run':'每次执行的内容'}<textarea rows={4} value={task.prompt} onChange={e=>patch({prompt:e.target.value})}/></label>
   <div className="scheduled-fields">
    <label>{en?'Schedule':'执行频率'}<select value={task.schedule.type} onChange={e=>patch({schedule:{type:e.target.value as ScheduleType,at:'',minute:0,weekday:1,monthDay:1,intervalMinutes:60}})}>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
    {task.schedule.type==='once'?<label>{en?'Date and time':'日期时间'}<input type="datetime-local" value={localDate(task.schedule.at)} onChange={e=>patch({schedule:{...task.schedule,at:e.target.value?new Date(e.target.value).toISOString():''}})}/></label>:['daily','weekly','monthly'].includes(task.schedule.type)?<label>{en?'Time':'时间'}<input type="time" value={task.schedule.at??''} onChange={e=>patch({schedule:{...task.schedule,at:e.target.value}})}/></label>:<label>{en?'Minutes':'分钟'}<input type="number" min={task.schedule.type==='interval'?1:0} max={task.schedule.type==='hourly'?59:undefined} value={(task.schedule.type==='hourly'?task.schedule.minute:task.schedule.intervalMinutes)??0} onChange={e=>patch({schedule:{...task.schedule,[task.schedule.type==='hourly'?'minute':'intervalMinutes']:Number(e.target.value)}})}/></label>}
    {task.schedule.type==='weekly'&&<label>{en?'Weekday':'星期'}<select value={task.schedule.weekday??1} onChange={e=>patch({schedule:{...task.schedule,weekday:Number(e.target.value) as any}})}>{(en?['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']:['周日','周一','周二','周三','周四','周五','周六']).map((name,i)=><option key={i} value={i}>{name}</option>)}</select></label>}
    {task.schedule.type==='monthly'&&<label>{en?'Day of month':'每月日期'}<input type="number" min={1} max={31} value={task.schedule.monthDay??1} onChange={e=>patch({schedule:{...task.schedule,monthDay:Number(e.target.value)}})}/></label>}
   </div>
   <p className="muted small">{en?'Local timezone':'本机时区'}: {Intl.DateTimeFormat().resolvedOptions().timeZone} · {en?'Sage must be running. After sleep, missed recurrences are combined into one run.':'需要 Sage 保持运行；休眠后错过的周期合并补跑一次。'}</p>
   <ModelSelector label={en?'Model and thinking effort':'模型与思考强度'} providers={settings?.modelProviders??[]} value={task.selectedModel??null} inheritedValue={project?.selectedModel??settings?.selectedModel} emptyLabel={en?'Follow project / global default':'跟随项目 / 全局默认'} onChange={value=>patch({selectedModel:value??undefined})}/>
   <ScheduledSecuritySelector sourceConvId={task.sourceConvId} mode={task.authorizationMode} onModeChange={authorizationMode=>patch({authorizationMode})} value={task.securityProfileId} onChange={securityProfileId=>patch({securityProfileId})}/>
   <section className="scheduled-output-rules">
    <div className="scheduled-section-heading"><strong>{en?'Main task outputs':'主任务输出目标'}</strong></div>
    <p className="muted small">{en?'Selected destinations receive the final result when the task notification conditions are met. Progress and quiet checks stay in execution history.':'达到任务提醒条件时，最终结果会投递到勾选的目标。执行过程、未触发提醒的检查记录保留在运行记录中。'}</p>
    <div className="scheduled-main-targets"><label className="scheduled-conversation-target"><input type="checkbox" checked={workflow.mainTargets.some(target=>target.type==='conversation')} onChange={()=>patchWorkflow(current=>({...current,mainTargets:toggleTarget(current.mainTargets,{type:'conversation'})}))}/>{en?'Task conversation':'关联对话'}{workflow.mainTargets.some(target=>target.type==='conversation')&&<select aria-label={en?'Task conversation':'关联对话'} value={task.targetConvId??''} onChange={e=>patch({targetConvId:e.target.value})}><option value="">{en?'Select conversation':'选择对话'}</option>{dialog&&proposal.action==='create'&&<option value="__new_associated_conversation__">{en?'Create one associated conversation on save':'保存时创建一个关联对话'}</option>}{conversations.filter(c=>!c.archived).map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select>}</label><div className="scheduled-channel-options">{channels.filter(channel=>channel.enabled).map(channel=><label key={channel.id}><input type="checkbox" checked={workflow.mainTargets.some(target=>target.type==='channel'&&target.channelId===channel.id)} onChange={()=>patchWorkflow(current=>({...current,mainTargets:toggleTarget(current.mainTargets,{type:'channel',channelId:channel.id})}))}/>{channel.name}</label>)}{!channels.some(channel=>channel.enabled)&&<span className="muted small">{en?'Configure channels to enable external delivery.':'配置并启用渠道后，即可选择外部投递。'}</span>}</div></div>
    <div className="scheduled-section-heading scheduled-conditions-heading"><strong>{en?'Conditional processing steps':'条件判断与后续处理'}</strong></div>
    <p className="muted small">{en?'Each step judges its selected results. Every selected result must be available; matching steps can prepare content and send it to multiple channels.':'每个步骤按所选结果进行判断；所选结果都命中后才会继续，可整理内容并投递到多个渠道。'}</p>
    {workflow.steps.map((step,index)=><div className="scheduled-output-rule" key={step.id}>
      <div className="scheduled-section-heading"><strong>{index+1}. {step.name|| (en?'Untitled step':'未命名步骤')}</strong><button type="button" onClick={()=>patchWorkflow(current=>({...current,steps:current.steps.filter(item=>item.id!==step.id).map(item=>{const sources=(item.sourceIds??[item.parentId??'$main']).filter(id=>id!==step.id);return{...item,sourceIds:sources.length?sources:['$main'],parentId:item.parentId===step.id?undefined:item.parentId};})}))}>{en?'Remove':'移除'}</button></div>
      <div className="scheduled-fields"><label>{en?'Step name':'步骤名称'}<input value={step.name} onChange={e=>stepPatch(step.id,item=>({...item,name:e.target.value}))}/></label><div className="scheduled-source-picker"><span>{en?'Results to use (all selected)':'使用哪些结果（所选结果都会参与）'}</span><div className="scheduled-channel-options"><label><input type="checkbox" checked={(step.sourceIds??[step.parentId??'$main']).includes('$main')} onChange={e=>stepPatch(step.id,item=>{const selected=item.sourceIds??[item.parentId??'$main'];const next=e.target.checked?[...selected,'$main']:selected.filter(id=>id!=='$main');return{...item,sourceIds:next.length?next:['$main'],parentId:undefined};})}/>{en?'Main task result':'主任务结果'}</label>{workflow.steps.slice(0,index).map(source=><label key={source.id}><input type="checkbox" checked={(step.sourceIds??[step.parentId??'$main']).includes(source.id)} onChange={e=>stepPatch(step.id,item=>{const selected=item.sourceIds??[item.parentId??'$main'];const next=e.target.checked?[...selected,source.id]:selected.filter(id=>id!==source.id);return{...item,sourceIds:next.length?next:['$main'],parentId:undefined};})}/>{source.name|| (en?'Untitled step':'未命名步骤')}</label>)}</div></div></div>
      <label>{en?'Condition for continuing':'继续条件'}<textarea rows={2} value={step.condition} placeholder={en?'e.g. The project has an unresolved regression':'例如：项目存在尚未解决的回归问题'} onChange={e=>stepPatch(step.id,item=>({...item,condition:e.target.value}))}/></label>
      <label>{en?'Instructions to prepare this result (optional)':'命中后如何整理结果（可选）'}<textarea rows={2} value={step.instructions??''} placeholder={en?'e.g. Summarize impact and next actions for an email':'例如：整理影响范围和建议措施，适合邮件阅读'} onChange={e=>stepPatch(step.id,item=>({...item,instructions:e.target.value}))}/></label>
      <div className="scheduled-step-targets"><strong>{en?'Sub-step output targets':'子步骤输出目标'}</strong><p className="muted small">{en?'Matching results are sent to the selected channels.':'命中后将整理结果发送到所选渠道。'}</p><div className="scheduled-channel-options">{channels.filter(channel=>channel.enabled).map(channel=><label key={channel.id}><input type="checkbox" checked={step.targets.some(target=>target.type==='channel'&&target.channelId===channel.id)} onChange={()=>stepPatch(step.id,item=>({...item,targets:toggleTarget(item.targets,{type:'channel',channelId:channel.id})}))}/>{channel.name}</label>)}</div></div>
     </div>)}
    <button type="button" className="scheduled-add-step" onClick={()=>patchWorkflow(current=>({...current,steps:[...current.steps,{id:`step-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,name:en?'New step':'新步骤',sourceIds:['$main'],condition:'',instructions:'',targets:[]}]}))}>{en?'Add step':'添加步骤'}</button>
   </section>
   <div className="scheduled-fields"><label>{en?'Timeout (minutes)':'超时（分钟）'}<input type="number" min={1} max={120} value={task.timeoutMinutes??30} onChange={e=>patch({timeoutMinutes:Number(e.target.value)})}/></label><label className="scheduled-enabled"><input type="checkbox" checked={task.enabled} onChange={e=>patch({enabled:e.target.checked})}/>{en?'Enabled':'启用'}</label></div>
  </fieldset>
  {error&&<p role="alert" className="file-error">{error}</p>}
  <div className="clarify-actions"><button disabled={busy} onClick={onCancel}>{en?'Cancel':'取消'}</button><button className="btn-primary" disabled={busy} onClick={()=>void save()}>{busy?(en?'Saving…':'保存中…'):(dialog?(en?'Save task':'保存任务'):(en?'Confirm':'确认'))}</button></div>
 </section>;
}
