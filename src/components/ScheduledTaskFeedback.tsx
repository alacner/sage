import type {ToolCall} from '../../shared/types';

export function ScheduledTaskFeedback({call,en}:{call:ToolCall;en:boolean}){
 if(call.name!=='ScheduledTask'&&!call.name.endsWith('__ScheduledTask'))return null;
 let result:any;try{result=JSON.parse(call.result??'');}catch{return null;}
 if(!result.saved&&!result.error&&!result.cancelled&&!result.deleted)return null;
 const labels:Record<string,string>=en?{securityProfileId:'Authorization policy',name:'Name',prompt:'Instructions',schedule:'Schedule',enabled:'Enabled',output:'Output',targetConvId:'Destination conversation',channelIds:'Channels',selectedModel:'Model / reasoning effort',timeoutMinutes:'Timeout (minutes)'}:{securityProfileId:'授权方案',name:'名称',prompt:'任务内容',schedule:'执行时间',enabled:'启用状态',output:'输出方式',targetConvId:'目标对话',channelIds:'通知渠道',selectedModel:'模型 / 思考强度',timeoutMinutes:'超时（分钟）'};
 const value=(v:any):string=>v==null?(en?'Default':'默认'):typeof v==='boolean'?(v?(en?'Enabled':'启用'):(en?'Disabled':'停用')):typeof v==='object'?JSON.stringify(v):String(v);
 const title=result.error?(en?'Task change failed':'定时任务修改失败'):result.cancelled?(en?'Canceled — task unchanged':'已取消，定时任务未修改'):result.deleted?(en?'Scheduled task deleted':'定时任务已删除'):result.action==='update'?(en?'Scheduled task updated':'定时任务已修改'):(en?'Scheduled task created':'定时任务已创建');
 const changes=Object.entries(result.changes??{});
 return <div className="scheduled-change-feedback" role="status"><strong>{title}{result.task?.name?` · ${result.task.name}`:''}</strong>{result.error&&<p className="file-error">{result.error}</p>}{changes.length>0?<details><summary>{en?`Changed ${changes.length} settings`:`已修改 ${changes.length} 项配置：`}{!en&&changes.map(([key])=>labels[key]??key).join('、')}</summary><dl>{changes.map(([key,change])=><div key={key}><dt>{labels[key]??key}</dt><dd>{value((change as any).before)} → {value((change as any).after)}</dd></div>)}</dl></details>:result.action==='update'&&result.saved?<p>{en?'Confirmed settings match the existing task.':'确认配置与原任务一致，无需变更。'}</p>:null}</div>;
}
