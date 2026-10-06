import type {PendingApproval,ScheduledRun} from '../shared/types';
type Decision={decision:'allow'|'deny';message?:string;expired?:boolean};
const pending=new Map<string,{project:string;run:string;expiresAt?:number;settle:(decision:Decision)=>void}>();
export function respondScheduledApproval(project:string,run:string,requestId:string,decision:'allow'|'deny'){
 if(decision!=='allow'&&decision!=='deny')throw Error('Invalid approval decision');
 const key=run+':'+requestId,entry=pending.get(key);
 if(!entry||entry.project!==project||entry.run!==run)throw Error('Approval expired or already handled');
 if(entry.expiresAt&&Date.now()>=entry.expiresAt){entry.settle({decision:'deny',message:'Approval expired',expired:true});throw Error('Approval expired');}
 entry.settle({decision,message:decision==='allow'?'用户批准本次定时任务操作':'用户拒绝本次定时任务操作'});
 return {ok:true};
}
export function scheduledApprovals(run:ScheduledRun,signal:AbortSignal,publish:()=>Promise<void>){
 let writes=Promise.resolve();
 const update=()=>{writes=writes.catch(()=>{}).then(publish);return writes;};
 const wait=(request:PendingApproval):Promise<Decision>=>new Promise((resolve,reject)=>{
  if(signal.aborted){reject(Error('Scheduled task timed out'));return;}
  const requestedAt=Date.now(),expiresAt=run.approvalDeadline;
  const key=run.id+':'+request.requestId;
  if(pending.has(key)){reject(Error('Duplicate approval request'));return;}
  const settle=(decision:Decision)=>{
   if(!pending.delete(key))return;
   signal.removeEventListener('abort',abort);
   run.approvalHistory=[...(run.approvalHistory??[]),{requestId:request.requestId,toolName:request.toolName,requestedAt,decidedAt:Date.now(),decision:decision.expired?'expired':decision.decision,actor:decision.expired?'system':'user'}];
   run.pendingApprovals=run.pendingApprovals?.filter(p=>p.requestId!==request.requestId);
   void update().then(()=>resolve(decision),reject);
  };
  const abort=()=>settle({decision:'deny',message:'Scheduled task timed out or canceled',expired:true});
  pending.set(key,{project:run.projectPath,run:run.id,expiresAt,settle});
  run.pendingApprovals=[...(run.pendingApprovals??[]),{...structuredClone(request),requestedAt,expiresAt}];
  signal.addEventListener('abort',abort,{once:true});
  void update().catch(error=>{pending.delete(key);signal.removeEventListener('abort',abort);run.pendingApprovals=run.pendingApprovals?.filter(p=>p.requestId!==request.requestId);reject(error);});
 });
 return {wait,close:async()=>{for(const entry of [...pending.values()])if(entry.run===run.id&&entry.project===run.projectPath)entry.settle({decision:'deny',message:'Run ended',expired:true});await writes;delete run.pendingApprovals;}};
}
