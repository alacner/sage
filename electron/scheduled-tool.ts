import { conversationExecutionMeta } from './conversation-execution';
import {effectiveModelSelection} from '../shared/model-selection';
import type { ConversationMeta, ScheduledProposal, ScheduledTaskInput } from '../shared/types';
import { loadTasksForProject, createScheduledTask, updateScheduledTask, deleteScheduledTask, runScheduledTaskNow } from './scheduler';
import { listChannels, listProjects } from './store';
import { readSettings } from './main';

/** Models propose; only an explicit response from the task card can commit. */
export async function handleScheduledTool(meta: ConversationMeta, input: any, confirm:(proposal:ScheduledProposal)=>Promise<string>, signal?:AbortSignal, sourceMessageId?:string):Promise<string> {
  try {
    const tasks=await loadTasksForProject(meta.projectPath);
    if(input?.action==='list') return JSON.stringify({tasks, models:(await readSettings()).modelProviders?.filter(p=>p.enabled!==false).map(p=>({providerId:p.id,name:p.name,models:p.models})), channels:(await listChannels(meta.projectPath)).map(c=>({id:c.id,name:c.name,enabled:c.enabled})),currentConversationId:meta.id,now:new Date().toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});
    if(!['create','update','delete','run'].includes(input?.action)) throw new Error('Invalid scheduled task action');
    const existing=input.action==='create'?undefined:tasks.find(t=>t.id===input.taskId);
    if(input.action!=='create'&&!existing) throw new Error('Task not found in this project. List tasks and use the exact ID.');
    const settings=await readSettings();
    const project=(await listProjects()).find(p=>p.path===meta.projectPath);
    const executionMeta=conversationExecutionMeta(meta);
    const inherited=effectiveModelSelection(executionMeta.selectedModel,effectiveModelSelection(project?.selectedModel,settings.selectedModel));
    const task:ScheduledTaskInput=existing?{...existing}:{name:'',prompt:'',schedule:{type:'daily',at:''},enabled:true,authorizationMode:'source',sourceConvId:meta.id,targetConvId:meta.id,output:'conversation',selectedModel:inherited,timeoutMinutes:30};
    if(!existing && executionMeta.thinkingEffort && task.selectedModel) task.selectedModel={...task.selectedModel,thinkingEffort:executionMeta.thinkingEffort};
    for(const key of ['name','prompt','schedule','enabled','output','channelIds','selectedModel','timeoutMinutes'] as const) if(input[key]!==undefined) Object.assign(task,{[key]:input[key]});
    if(task.output==='conversation'&&!task.targetConvId) task.targetConvId=meta.id;
    task.sourceConvId??=meta.id;
    const proposal:ScheduledProposal={action:input.action,taskId:existing?.id,expectedUpdatedAt:existing?.updatedAt,task};
    const raw=await confirm(proposal);
    if(signal?.aborted) return JSON.stringify({cancelled:true});
    let answer:any;try{answer=JSON.parse(raw);}catch{return JSON.stringify({cancelled:true});}
    if(answer?.confirmed!==true) return JSON.stringify({cancelled:true});
    const latest=(await loadTasksForProject(meta.projectPath)).find(t=>t.id===existing?.id);
    if(existing&&(!latest||latest.updatedAt!==existing.updatedAt)) throw new Error('Task changed while confirmation was open. List tasks and ask again.');
    if(input.action==='delete'){await deleteScheduledTask(existing!.id);return JSON.stringify({deleted:existing!.id});}
    if(input.action==='run'){void runScheduledTaskNow(existing!.id);return JSON.stringify({requested:existing!.id,message:'Run requested. Check task history for final status.'});}
    const draft={...answer.task,sourceConvId:task.sourceConvId,sourceMessageId:existing?existing.sourceMessageId:sourceMessageId} as ScheduledTaskInput;
    const saved=input.action==='create'
      ?await createScheduledTask(meta.projectPath,draft.name,draft.prompt,draft.schedule,draft)
      :await updateScheduledTask(existing!.id,draft,existing!.updatedAt);
    if(!saved)throw new Error('Task no longer exists');
    const changes=existing?Object.fromEntries(['name','prompt','schedule','enabled','output','targetConvId','channelIds','selectedModel','timeoutMinutes','securityProfileId'].filter(key=>JSON.stringify((existing as any)[key])!==JSON.stringify((saved as any)[key])).map(key=>[key,{before:(existing as any)[key]??null,after:(saved as any)[key]??null}])):undefined;
    return JSON.stringify({saved:true,action:input.action,task:saved,changes});
  }catch(error:any){return JSON.stringify({error:error?.message??String(error),saved:false});}
}
