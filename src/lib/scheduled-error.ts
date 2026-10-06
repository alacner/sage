/** Translate scheduling failures without exposing Electron's IPC wrapper. */
export function scheduledError(error: unknown, en: boolean): string {
 const raw=error instanceof Error?error.message:String(error);
 const message=raw.replace(/^Error: /,'').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
 const messages:Record<string,string>={
  'Scheduled task reached the maximum tool iterations before a final response':'工具调用已达到轮次上限，任务还未生成最终结果。请查看执行详情，检查是否在重复抓取、重试或调用同一工具；可缩小任务范围或修正工具调用后再执行。',
  'Scheduled task returned a tool response without executable tool calls':'模型返回了工具响应，但没有可执行的工具调用，任务未完成。请检查模型及提供商的工具调用支持。',
  'Scheduled authorization policy is missing or disabled; edit the task and select an available policy':'定时任务的授权方案已删除或禁用，请编辑任务并选择可用方案。',
  'Restore the associated conversation before enabling this task':'关联对话已归档。请先在配置中的归档列表恢复该对话，再手动启用定时任务。',
  'Source conversation not found':'关联对话已不存在，请重新关联可用对话后手动启用任务。',
  'Output conversation is missing or archived':'输出对话已删除或归档，请恢复或重新关联可用对话后手动启用任务。',
 };
 return en?message:messages[message]??message;
}

/** A short task-local summary; the original message remains in expandable details. */
export function scheduledErrorSummary(error:string,en:boolean):{text:string;permission:boolean}{
 // Match the host message after stripping the optional IPC wrapper, just as the details do.
 const message=scheduledError(error,true);
 if(message==='Scheduled task reached the maximum tool iterations before a final response')return {text:en?'Tool iteration limit reached before a final result':'工具调用达到轮次上限，尚未生成最终结果',permission:false};
 const tool=message.match(/无法现场审批\s+([A-Za-z][\w:]*)/i)?.[1];
 const permission=!!tool||/authorization policy|授权方案.*(?:删除|禁用)|cannot approve additional permissions/i.test(message);
 if(permission)return {text:(en?'Authorization required':'需要授权')+(tool?'：'+tool:''),permission:true};
 const text=scheduledError(error,en).split('\n')[0];
 return {text:text.length>80?text.slice(0,80)+'…':text,permission:false};
}
