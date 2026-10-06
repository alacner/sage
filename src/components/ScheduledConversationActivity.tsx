import {useEffect} from 'react';
import {scheduledTaskLinksConversation} from '../../shared/scheduled-association';
import {CalendarClock} from 'lucide-react';
import {useAppStore} from '../stores/appStore';
import {resolveLanguage} from '../../shared/language';
import {formatDateTime,useDateTimeSettings} from '../lib/date-time';

export function ScheduledConversationActivity({convId}:{convId:string}){
 useDateTimeSettings();
 const tasks=useAppStore(s=>s.scheduledTasks),runs=useAppStore(s=>s.scheduledRuns),project=useAppStore(s=>s.currentProject);
 const en=resolveLanguage(useAppStore(s=>s.settings?.language),useAppStore.getState().settings?._systemLocale)==='en';
 useEffect(()=>{void useAppStore.getState().refreshScheduledRuns().catch(()=>{});},[project?.path,convId]);
 const linked=tasks.filter(t=>scheduledTaskLinksConversation(t,convId));
 if(!linked.length)return null;
 const entries=runs.filter(r=>linked.some(t=>t.id===r.taskId)).sort((a,b)=>b.startedAt-a.startedAt);
 const completed=entries.filter(r=>r.status==='success'||r.status==='failed');
 const failed=completed.filter(r=>r.status==='failed'||r.deliveryError).length;
 const latest=entries.find(r=>r.status==='running')??entries[0];
 return <details className="scheduled-conversation-activity">
  <summary><CalendarClock size={14}/><span>{en?`Scheduled tasks: ${completed.length} runs, ${failed} failed`:`定时任务已执行 ${completed.length} 次，失败 ${failed} 次`}{latest?(en?' · Last check: ':' · 最近检查：')+formatDateTime(latest.finishedAt??latest.startedAt):''}{latest?.status==='success'&&latest.outputDisposition==='silent'?(en?' · No notification triggered':' · 未触发提醒'):''}{entries.some(r=>r.status==='running')?(en?' · Running':' · 执行中'):''}</span></summary>
  <div>{linked.map(task=><p key={task.id}>{task.name} · {task.enabled?(en?'Enabled':'已启用'):(en?'Paused / completed':'暂停 / 已完成')}</p>)}</div>
  <ul>{entries.map(run=><li key={run.id}><span>{formatDateTime(run.startedAt)} · {run.status==='success'&&run.outputDisposition==='silent'?(en?'Completed quietly':'静默完成'):en?run.status:({pending:'等待',running:'执行中',success:'完成',failed:'失败',missed:'错过'}[run.status])}</span>{run.convId&&<button onClick={()=>void useAppStore.getState().selectConversation(run.convId!)}>{en?'Execution details':'执行详情'}</button>}{(run.error||run.deliveryError)&&<p className="file-error">{run.error??run.deliveryError}</p>}</li>)}</ul>
 </details>;
}
