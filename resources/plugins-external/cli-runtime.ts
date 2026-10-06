import {spawn, type ChildProcess} from 'node:child_process';
import {getToolDefinitions, normalizeAskUserInput, ASKUSER_EMPTY_RETRY_MSG} from '@sage/engine-host/api-tool-defs';
import {executeTool} from '@sage/engine-host/api-tool-executor';
import type {EngineRunOptions} from '../plugin-sdk/sage-engine';

export function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(Error('aborted'));
  if(signal.aborted){work.catch(()=>{});abort();return;}
  signal.addEventListener('abort',abort,{once:true});
  work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
/** A separate process group lets cancellation terminate descendants as well. */
export function spawnCli(command:string,args:string[],cwd:string,env:NodeJS.ProcessEnv){
 const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
 child.stderr.resume();child.stdin.on('error',()=>{});
 return child;
}
const stopping=new WeakSet<ChildProcess>();
export function stopCli(child:ChildProcess){
 if(stopping.has(child))return;stopping.add(child);
 const kill=(signal:NodeJS.Signals)=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{/* already exited */}};
 kill('SIGTERM');const timer=setTimeout(()=>kill('SIGKILL'),1000);timer.unref();
}
export function toolDefinitions(readOnly?:boolean){return getToolDefinitions().filter(t=>!readOnly||['Read','Glob','Grep','Skill','RecallMemory'].includes(t.name));}
/** Recheck cancellation after every external await, before effects and callbacks. */
export async function callTool(opts:EngineRunOptions,signal:AbortSignal,id:string,name:string,args:any){
 const input=args&&typeof args==='object'&&!Array.isArray(args)?{...args}:{};
 delete input.__sageApproval;delete input.__sageWebApproval;
 if(signal.aborted)return {result:'aborted',isError:true};
 opts.onToolUse?.({id,name,input});
 let result:Omit<import('../../shared/types').ToolResultInfo, 'id'>;
 try{
  if(name==='AskUser'){
   const normalized=normalizeAskUserInput(input);
   result=!normalized.question?{result:ASKUSER_EMPTY_RETRY_MSG,isError:true}:opts.askUser?{result:await abortable(opts.askUser(normalized),signal)}:{result:'AskUser is unavailable',isError:true};
  }else{
   const d=opts.canUseTool?await abortable(opts.canUseTool(name,input,{toolUseID:id,signal,suggestions:[]}),signal):opts.readOnly&&toolDefinitions(true).some(t=>t.name===name)?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'Tool approval is required'};
   if(signal.aborted)throw Error('aborted');
   result=d.behavior==='allow'?await abortable(executeTool(name,d.updatedInput??input,opts.cwd,signal,opts.monitor?.convId),signal):{result:d.message||'Tool denied',isError:true};
  }
 }catch(e:any){result={result:e.message,isError:true};}
 if(!signal.aborted)opts.onToolResult?.({id,...result});
 return result;
}

/** Cleanup has a deadline, and never leaves timeout handles behind. */
export async function settleWithin(work:Promise<unknown>|undefined,ms:number){
 let timer:NodeJS.Timeout|undefined;
 try{await Promise.race([Promise.resolve(work).catch(()=>{}),new Promise(r=>{timer=setTimeout(r,ms);})]);}
 finally{if(timer)clearTimeout(timer);}
}
