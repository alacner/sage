import { pluginManager } from './index';
import { invokeExtension } from './extensions';
import {applyContextSummary} from '../../shared/plugins/context';

/** Plugins summarize complete older turns; the host preserves system and recent
 * messages verbatim, so tool-call/result pairs cannot be split by an extension. */
export async function compactWithExtension<T extends {role:string;content?:unknown}>(project:string,key:string,messages:T[],budget:number):Promise<T[]> {
  const starts=messages.flatMap((m,i)=>m.role==='user'?[i]:[]);
  if(starts.length<2)return messages;
  const result=await invokeExtension(pluginManager(),project,'sage/context.compact',key,{
    messages,maxBodyChars:budget,
  }) as {summary:string;keepRecentTurns:number};
  return applyContextSummary(messages,result);
}
