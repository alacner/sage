import type {ConversationMeta,ScheduledTask,ScheduledRun} from '../../shared/types';
import {useAppStore} from '../stores/appStore';

export function findScheduledSourceMessage(task:ScheduledTask,conv:ConversationMeta):string|undefined {
 if(task.sourceMessageId&&conv.messages.some(m=>m.id===task.sourceMessageId))return task.sourceMessageId;
 return conv.messages.find(m=>m.toolCalls?.some(call=>{
  if(call.name!=='ScheduledTask'&&!call.name.endsWith('__ScheduledTask'))return false;
  try {const result=JSON.parse(call.result??'');return result.saved===true&&result.task?.id===task.id&&(result.action==='create'||call.input?.action==='create');}catch{return false;}
 }))?.id;
}

/** Locate the actual creation message, or persist a new management conversation. */
const opening=new Map<string,Promise<string|undefined>>();
export function openScheduledConversation(task:ScheduledTask,en:boolean){
 const key=task.projectPath+':'+task.id;
 const existing=opening.get(key);if(existing)return existing;
 const request=openConversation(task,en).finally(()=>opening.delete(key));
 opening.set(key,request);return request;
}
async function openConversation(task:ScheduledTask,en:boolean){
 const store=useAppStore.getState();
 if(store.currentProject?.path!==task.projectPath)throw Error(en?'Project changed':'项目已切换');
 let conv=task.sourceConvId?await window.api.getConv(task.sourceConvId) as ConversationMeta|null:null;
 let messageId=conv&&conv.projectPath===task.projectPath&&!conv.archived?findScheduledSourceMessage(task,conv):undefined;
 if(useAppStore.getState().currentProject?.path!==task.projectPath)return;
 if(!messageId){
  conv=await window.api.createConv(task.projectPath,task.name,store.settings?.permissionMode??'plan');
  if(!conv)throw Error(en?'Unable to create conversation':'无法创建对话');
  messageId=crypto.randomUUID();
  const content=en?`Scheduled task: ${task.name}\n\nTask ID: ${task.id}\n\n${task.prompt}\n\nUse this conversation to adjust this existing task. Changes take effect after you confirm the task settings.`:`定时任务：${task.name}\n\n任务 ID：${task.id}\n\n${task.prompt}\n\n可以在此对话中调整该任务，确认配置后修改才会生效。`;
  const result=await window.api.updateConvMeta(conv.id,{title:task.name,messages:[{id:messageId,role:'assistant',content,ts:new Date().toISOString()}]});
  if(!result?.ok)throw Error(en?'Unable to save task context':'无法保存任务上下文');
  const saved=await window.api.updateScheduled(task.id,{sourceConvId:conv.id,sourceMessageId:messageId,...(task.output==='conversation'&&task.targetConvId===task.sourceConvId?{targetConvId:conv.id}:{})},task.updatedAt);
  if(!saved)throw Error(en?'Task no longer exists':'任务已不存在');
  await store.refreshScheduledTasks();
  await store.refreshConversations();
 }
 if(useAppStore.getState().currentProject?.path!==task.projectPath)return;
 await store.selectConversation(conv!.id);
 useAppStore.setState({scheduledMessageTarget:{convId:conv!.id,messageId,nonce:Date.now()}});
 return conv!.id;
}

/** Prefer the execution transcript; a delivery conversation may have no result after a failed run. */
export async function openScheduledRunConversation(run: ScheduledRun, en: boolean, open: (id: string) => void | Promise<void>) {
 const project = useAppStore.getState().currentProject?.path;
 if (project !== run.projectPath) throw Error(en ? 'Project changed' : '项目已切换');
 for (const id of [...new Set([run.convId, run.outputConvId].filter((id): id is string => !!id))]) {
  const conv = await window.api.getConv(id);
  if (useAppStore.getState().currentProject?.path !== project) return;
  if (conv?.projectPath === project) { await open(id); return; }
 }
 throw Error(en ? 'The execution conversation is no longer available. The status and approval history remain in this record.' : '执行对话已不存在，仍可在此记录中查看状态与审批记录。');
}
