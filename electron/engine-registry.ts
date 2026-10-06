import {RESPONSE_STYLE} from '../shared/response-style';
import type {EngineAdapter,EngineRunOptions,EngineResult} from '../shared/engine';
import {pluginManager} from './plugins';
import {readSettings} from './main';
import {createRequire} from 'node:module';
import {app} from 'electron';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {emitPluginEvent} from './plugins/extensions';

/** Native engine adapters are explicitly trusted at installation, unlike sandboxed UI plugins. */
export async function selectedEngine(){return (await readSettings()).backendEngine || 'api';}
const hostModules:Record<string,()=>unknown>={
 'api-tool-defs':()=>require('./api-tool-defs'), 'api-tool-executor':()=>require('./api-tool-executor'),
 'sandbox/env':()=>require('./sandbox/env'), 'skills':()=>require('./skills'),
 'request-monitor':()=>require('./request-monitor'),
};
function engineHostApi(key:string,engine:{id:string;name:string}) {
 const factory=hostModules[key];if(!factory)throw Error('Unknown engine host API: '+key);
 const api=factory();
 if(key!=='request-monitor')return api;
 const monitor=api as typeof import('./request-monitor');
 return {...monitor,beginRecord:(input:import('./request-monitor').BeginRecordInput)=>monitor.beginRecord({...input,engineId:engine.id,engineName:/^%[^%]+%$/.test(engine.name)?engine.id:engine.name})};
}
export async function runEngine(id:string,options:EngineRunOptions):Promise<EngineResult>{
 const runId=randomUUID(),startedAt=Date.now();
 let notify:((event:string,payload:Record<string,unknown>)=>Promise<unknown>)|undefined;
 let outcome:'success'|'error'|'aborted'='error';
 let started=false;
 try {
  if(options.signal?.aborted)return {text:'',error:'aborted'};
  const manager=pluginManager(),p=manager.enginePackage(options.cwd,id);
  // Observational events never contain prompts, model output, settings or credentials.
  // Per-run chaining preserves start/finish order without delaying model execution.
  let events=Promise.resolve<unknown>(undefined);
  notify=(event,payload)=>(events=events.then(()=>emitPluginEvent(manager,options.cwd,event,{apiVersion:1,runId,engineId:id,...payload})).catch(()=>undefined));
  const settings=Object.fromEntries(await Promise.all(Object.keys(p.manifest.settings).map(async key=>[key,await manager.setting(options.cwd,id,key)])));
  if(manager.enginePackage(options.cwd,id).digest!==p.digest)throw Error('Engine plugin changed during startup');
  if(options.signal?.aborted)return {text:'',error:'aborted'};
  const nativeRequire=createRequire(path.join(app.getAppPath(),'package.json'));
  const module={exports:{} as any};
  const engineRequire=(name:string)=>{if(name.startsWith('@sage/engine-host/')){return engineHostApi(name.slice(18),{id,name:p.manifest.name});}return nativeRequire(name);};
  // This is a native extension API, not a VM security boundary. engine.native is required.
  new Function('module','exports','require',p.files['engine.js'])(module,module.exports,engineRequire);
  const adapter=module.exports as EngineAdapter;
  if(adapter.apiVersion!==1||typeof adapter.run!=='function')throw Error('Invalid engine adapter API');
  const controller=new AbortController();
  const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)controller.abort();
  if(options.monitor?.convId&&[...activeRuns].some(r=>r.project===options.cwd&&r.convId===options.monitor?.convId)){options.signal?.removeEventListener('abort',abort);throw Error('This conversation already has an active engine run');}
  const active={id,project:options.cwd,convId:options.monitor?.convId,digest:p.digest,controller};activeRuns.add(active);
  started=true;void notify('sage/engine.started',{startedAt});
  let settled=false;
  const deliver=<T>(callback:((value:T)=>void)|undefined)=>(value:T)=>{if(!settled&&!controller.signal.aborted)callback?.(value);};
  try{
   const result=await adapter.run({...options,onText:deliver(options.onText),onSessionId:deliver(options.onSessionId),onToolUse:deliver(options.onToolUse),onToolResult:deliver(options.onToolResult),prompt:RESPONSE_STYLE+'\n\nUser request:\n'+options.prompt,signal:controller.signal},settings);
   if(!result||typeof result.text!=='string')throw Error('Engine returned an invalid result');
   outcome=controller.signal.aborted?'aborted':result.error?'error':'success';
   return controller.signal.aborted?{...result,error:'aborted'}:result;
  }catch(error){if(controller.signal.aborted){outcome='aborted';return {text:'',error:'aborted'};}throw error;}
  finally{settled=true;if(options.monitor?.convId)await (await import('./browser-agent')).releaseConversationBrowser(options.cwd,options.monitor.convId);activeRuns.delete(active);options.signal?.removeEventListener('abort',abort);}

 }catch(e:any){return {text:'',error:String(e?.message??e)};}
 finally{if(started&&notify)void notify('sage/engine.finished',{status:outcome,durationMs:Date.now()-startedAt});}
}

/** Run an installed engine's bounded detector for the settings UI.  Detection
 * never starts a chat or grants an engine permission; it only reports whether
 * the configured/auto-discovered executable is usable. */
export async function detectEngine(id:string,project:string){
 const manager=pluginManager(),p=manager.enginePackage(project,id);
 const settings=Object.fromEntries(await Promise.all(Object.keys(p.manifest.settings).map(async key=>[key,await manager.setting(project,id,key)])));
 if(manager.enginePackage(project,id).digest!==p.digest)throw Error('Engine plugin changed during detection');
 const nativeRequire=createRequire(path.join(app.getAppPath(),'package.json'));
 const module={exports:{} as any};
 const engineRequire=(name:string)=>{if(name.startsWith('@sage/engine-host/')){return engineHostApi(name.slice(18),{id,name:p.manifest.name});}return nativeRequire(name);};
 new Function('module','exports','require',p.files['engine.js'])(module,module.exports,engineRequire);
 const adapter=module.exports as EngineAdapter & {detect?:(settings:any)=>Promise<unknown>};
 if(adapter.apiVersion!==1||typeof adapter.detect!=='function')throw Error('该引擎不支持自动识别');
 return adapter.detect(settings);
}

const activeRuns=new Set<{id:string;project:string;convId?:string;digest:string;controller:AbortController}>();
export function invalidateEngineRuns(){for(const run of activeRuns){try{if(pluginManager().enginePackage(run.project,run.id).digest===run.digest)continue;}catch{}run.controller.abort();}}
