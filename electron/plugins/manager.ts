import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { slots, assertJson, validateValue, type PluginPackage, type PluginBundle, type PluginContext, type PluginCall, type PluginLog, type PluginSnapshot } from '../../shared/plugins/contract';
import { digest, parseBundle, resolveGraph, verifyPackage, stable, satisfies } from './packages';
export interface Runner {call(service:string,method:string,args:unknown,context:PluginContext):Promise<unknown>;close():void;isClosed?():boolean;inspect?():void}
export type RunnerFactory=(p:PluginPackage,project:string,call:(req:PluginCall,ctx:PluginContext)=>Promise<unknown>)=>Promise<Runner>;
export interface HostMethod {permission:string;description:string;input:any;run(args:any,ctx:PluginContext):Promise<unknown>}
interface State {version:1;revision:number;packages:Record<string,PluginPackage>;enabled:Record<string,string[]>;grants:Record<string,string[]>;globalEnabled?:string[];disabled?:Record<string,string[]>}
const empty=():State=>({version:1,revision:0,packages:{},enabled:{},grants:{}});
export class PluginManager {
 public uiState=new Map<string,Record<string,Partial<{title:string;visible:boolean;badge:string;order:number}>>>();
 public recoveryError='';
 public globalSettings?:{get:(id:string,key:string,secret?:boolean)=>Promise<unknown>;set:(id:string,key:string,value:unknown,secret?:boolean)=>Promise<void>};
 /** Resolves built-in host integrations such as Git and Browser.  The empty
  * project string asks for global activation state. */
 public hostDependencies?: (project:string)=>Promise<Record<string,{installed:boolean;enabled:boolean;version:string}>>;
 private state=empty();private queue:Promise<any>=Promise.resolve();private runners=new Map<string,Runner>();private starting=new Map<string,Promise<Runner>>();private logs:PluginLog[]=[];private generation=0;public onStop=()=>{};
 private activeRunners=new Map<string,number>();
 private trimRunners(limit=8){for(const [key,runner] of this.runners){if(this.runners.size<=limit)break;if(this.activeRunners.has(key)||this.dev.has(key))continue;this.runners.delete(key);runner.close();}}
 private dev=new Map<string,PluginPackage>();public host=new Map<string,HostMethod>();public changed=()=>{};
 constructor(public root:string,private factory:RunnerFactory){}
 private serial<T>(f:()=>Promise<T>):Promise<T>{const p=this.queue.then(f,f);this.queue=p.catch(()=>{});return p;}
 private validateState(raw:any):State {
  assertJson(raw);
  if(!raw?.state||raw.state.version!==1||!Number.isSafeInteger(raw.state.revision)||raw.state.revision<0||raw.checksum!==digest(raw.state))throw Error('Plugin registry damaged; restore a history snapshot');
  const state=raw.state as State;
  for(const key of ['packages','enabled','grants'] as const)if(!state[key]||typeof state[key]!=='object'||Array.isArray(state[key]))throw Error('Invalid registry section');
  // Re-verify and normalize every package while loading.  The manifest schema
  // gains defaulted fields over time; verifyPackage accepts a legacy source
  // digest and returns the current canonical package so an older registry can
  // keep working after an upgrade.  Keep the normalized value in memory so
  // engine startup and snapshots use the migrated digest immediately.
  const normalizedPackages:Record<string,PluginPackage>={};
  for(const [id,p] of Object.entries(state.packages)){const checked=verifyPackage(p);if(checked.manifest.id!==id)throw Error('Registry plugin ID mismatch');normalizedPackages[id]=checked;}
  const normalizedState={...state,packages:normalizedPackages};
  for(const ids of Object.values(state.enabled))if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))throw Error('Invalid enabled plugins');
  for(const values of Object.values(state.grants))if(!Array.isArray(values)||values.some(p=>typeof p!=='string'))throw Error('Invalid permission grants');
  const packages=new Map(Object.entries(normalizedState.packages));resolveGraph(packages,Object.keys(normalizedState.packages));
  for(const ids of Object.values(normalizedState.enabled))resolveGraph(packages,ids);
  if(normalizedState.globalEnabled!==undefined&&(!Array.isArray(normalizedState.globalEnabled)||normalizedState.globalEnabled.some(id=>typeof id!=='string')))throw Error('Invalid global plugins');
  if(normalizedState.disabled!==undefined&&(!normalizedState.disabled||typeof normalizedState.disabled!=='object'||Array.isArray(normalizedState.disabled)||Object.values(normalizedState.disabled).some(ids=>!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))))throw Error('Invalid project overrides');
  resolveGraph(packages,normalizedState.globalEnabled??[]);
  return normalizedState;
 }
 async init(){await fs.mkdir(this.root,{recursive:true,mode:0o700});try{const raw=JSON.parse(await fs.readFile(path.join(this.root,'state.json'),'utf8'));const state=this.validateState(raw);const migrated=Object.entries(raw.state?.packages??{}).some(([id,p]:[string,any])=>state.packages[id]?.digest!==p?.digest);this.state=state;if(migrated){try{await this.save(structuredClone(state));}catch(e:any){/* A read-only profile should still be usable; retry the repair on the next write. */console.warn('[plugins] Registry migration deferred:',e?.message??e);}}}catch(e:any){if(e.code!=='ENOENT'){this.recoveryError=String(e.message??e);throw e;}}}
 private async save(next:State){if(this.recoveryError)throw Error(this.recoveryError);next.revision=this.state.revision+1;await fs.mkdir(path.join(this.root,'history'),{recursive:true});const file=path.join(this.root,'state.json');const old=await fs.readFile(file).catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;});if(old)await fs.writeFile(path.join(this.root,'history',`${this.state.revision}-${Date.now()}.json`),old,{flag:'wx',mode:0o600});const tmp=`${file}.${crypto.randomUUID()}.tmp`;const h=await fs.open(tmp,'wx',0o600);try{await h.writeFile(stable({state:next,checksum:digest(next)}));await h.sync();}finally{await h.close();}await fs.rename(tmp,file);const dir=await fs.open(this.root,'r');try{await dir.sync();}finally{await dir.close();}this.state=next;this.stop();this.changed();}
 /**
  * Permissions actually granted to a plugin in a project: install-time grants for
  * registry packages, the manifest itself for a live development session (the
  * developer is watching the load).  Host gates (`engine.native`, `hooks.respond`)
  * resolve through this so every extension point honours the same approval.
  */
 grantedPermissions(project:string,id:string):string[] {
  if(this.dev.has(project+'\0'+id))return this.packages(project).get(id)?.manifest.permissions??[];
  return this.state.grants[id]??[];
 }
 enginePackage(project:string,id:string){const p=this.packages(project).get(id);if(!p?.manifest.engine||!this.enabled(project).has(id))throw Error('Engine plugin is not installed or enabled for this project');if(!this.grantedPermissions(project,id).includes('engine.native'))throw Error('Engine execution permission is missing');return p;}
 packages(project:string){return new Map([...Object.entries(this.state.packages),...[...this.dev].filter(([k])=>k.startsWith(project+'\0')).map(([,p])=>[p.manifest.id,p] as [string,PluginPackage])]);}
 snapshot(project:string):PluginSnapshot {const enabled=this.enabled(project),global=new Set(resolveGraph(new Map(Object.entries(this.state.packages)),this.state.globalEnabled??[]));return {revision:this.state.revision,plugins:[...this.packages(project).values()].map(p=>({manifest:{...p.manifest,contributes:p.manifest.contributes.map(c=>({...c,...this.uiState.get(project+'\0'+p.manifest.id)?.[c.id]}))},digest:p.digest,enabled:enabled.has(p.manifest.id),globalEnabled:global.has(p.manifest.id),projectMode:p.manifest.engine?'inherit':this.state.disabled?.[project]?.includes(p.manifest.id)?'disabled':this.state.enabled[project]?.includes(p.manifest.id)?'enabled':'inherit',development:this.dev.has(project+'\0'+p.manifest.id),granted:this.grantedPermissions(project,p.manifest.id)})),logs:this.logs.filter(l=>this.logProjects.get(l.trace)===project).slice(-100),slots};}
 private logProjects=new Map<string,string>();
 private async assertHostDependencies(project:string,p:PluginPackage,scope:'project'|'global'){
  const required=Object.entries(p.manifest.hostDependencies??{});if(!required.length)return;
  if(!this.hostDependencies)throw Error(`${p.manifest.id}: 宿主依赖检查不可用，请重启 Sage 后重试`);
  const available=await this.hostDependencies(scope==='global'?'':project);const missing:string[]=[];
  for(const [id,range] of required){const dep=available[id];if(!dep?.installed){missing.push(`${id}（未安装）`);continue;}if(!dep.enabled){missing.push(`${id}（未启用）`);continue;}if(!satisfies(dep.version,range))missing.push(`${id}（需要 ${range}，当前 ${dep.version}）`);}
  if(missing.length)throw Error(`${p.manifest.id} 需要先安装并启用宿主模块：${missing.join('、')}`);
 }
 private assertActivationScope(p:PluginPackage,scope:'project'|'global'){
  // CLI 引擎插件决定后端进程，必须全局统一，禁止项目级启用/覆盖。
  if(p.manifest.engine&&scope==='project')throw Error(`${p.manifest.id} 是 CLI 引擎插件，仅支持全局启用`);
  const supported=p.manifest.scope??'both';
  if(supported==='both')return;
  if(supported!==scope)throw Error(`${p.manifest.id} 仅支持${supported==='global'?'全局':'项目'}范围启用`);
 }
 private assertPackageDependenciesEnabled(project:string,id:string,scope:'project'|'global',state=this.state){
  const p=this.packages(project).get(id);if(!p)return;const required=Object.keys(p.manifest.dependencies??{});if(!required.length)return;
  const packages=this.packages(project);let roots:string[];
  if(scope==='global')roots=[...(state.globalEnabled??[])];
  else {const blocked=new Set(state.disabled?.[project]??[]);roots=[...(state.globalEnabled??[]),...(state.enabled[project]??[])].filter(x=>!blocked.has(x));}
  const active=new Set<string>();for(const root of roots){const graph=resolveGraph(packages,[root]);if(scope==='project'&&graph.some(x=>(state.disabled?.[project]??[]).includes(x)))continue;graph.forEach(x=>active.add(x));}
  const missing=required.filter(dep=>!active.has(dep));if(missing.length)throw Error(`${id} 需要先启用插件依赖：${missing.join('、')}`);
 }
 enabled(project:string){const packages=this.packages(project);
  // CLI 引擎插件只受全局开关控制：忽略历史遗留的项目级 enabled/disabled 覆盖。
  const engines=new Set([...packages.values()].filter(p=>p.manifest.engine).map(p=>p.manifest.id));
  const blocked=new Set((this.state.disabled?.[project]??[]).filter(id=>!engines.has(id)));
  const roots=[...(this.state.globalEnabled??[]),...(this.state.enabled[project]??[]).filter(id=>!engines.has(id))].filter(id=>!blocked.has(id));
  const active=roots.filter(id=>!resolveGraph(packages,[id]).some(dep=>blocked.has(dep)));const dev=[...this.dev].filter(([k])=>k.startsWith(project+'\0')).map(([,p])=>p.manifest.id);return new Set(resolveGraph(packages,[...active,...dev]));}
 async enableGlobal(id:string,on:boolean){return this.serial(async()=>{const p=this.state.packages[id];if(!p)throw Error('Plugin is not installed');this.assertActivationScope(p,'global');const next=structuredClone(this.state),roots=new Set(next.globalEnabled??[]);if(on){await this.assertHostDependencies('',p,'global');this.assertPackageDependenciesEnabled('',id,'global',next);roots.add(id);}else{roots.delete(id);if(resolveGraph(new Map(Object.entries(next.packages)),[...roots]).includes(id))throw Error('Required by another globally enabled plugin');}next.globalEnabled=[...roots];await this.save(next);});}

 plan(bundle:PluginBundle){const merged=new Map(Object.entries(this.state.packages));for(const p of bundle.packages){const old=this.state.packages[p.manifest.id];for(const [key,f] of Object.entries(p.manifest.settings)){const previous=old?.manifest.settings[key];if(previous&&(f.type!==previous.type||f.scope!==previous.scope))throw Error(`${p.manifest.id}.${key}: breaking setting schema; add a new key and migrate without deleting the old value`);}merged.set(p.manifest.id,p);}const order=resolveGraph(merged,[...merged.keys()]);return {revision:this.state.revision,order,changes:bundle.packages.map(p=>({id:p.manifest.id,name:p.manifest.name,from:this.state.packages[p.manifest.id]?.manifest.version,to:p.manifest.version,permissions:p.manifest.permissions,dependencies:p.manifest.dependencies,hostDependencies:p.manifest.hostDependencies,digest:p.digest}))};}
 async install(bundle:PluginBundle,revision:number){return this.serial(async()=>{if(revision!==this.state.revision)throw Error('Plugin registry changed; preview again');this.plan(bundle);for(const p of bundle.packages){const staged=await this.factory(p,'',async()=>{throw Error('Host calls are unavailable during installation validation');});staged.close();}const next=structuredClone(this.state);for(const p of bundle.packages){next.packages[p.manifest.id]=verifyPackage(p);next.grants[p.manifest.id]=p.manifest.permissions;}await this.save(next);return this.state.revision;});}
 async enable(project:string,id:string,on:boolean|null){return this.serial(async()=>{const p=this.packages(project).get(id);if(!p)throw Error('Plugin is not installed');this.assertActivationScope(p,'project');const next=structuredClone(this.state),roots=new Set(next.enabled[project]??[]),blocked=new Set(next.disabled?.[project]??[]);roots.delete(id);blocked.delete(id);if(on===true){await this.assertHostDependencies(project,p,'project');this.assertPackageDependenciesEnabled(project,id,'project',next);roots.add(id);}if(on===false){const remaining=[...(next.globalEnabled??[]),...roots].filter(x=>x!==id&&!blocked.has(x));if(resolveGraph(this.packages(project),remaining).includes(id))throw Error('Required by another enabled plugin; disable dependents first');blocked.add(id);}next.enabled[project]=[...roots];(next.disabled??={})[project]=[...blocked];await this.save(next);});}

 async uninstall(id:string){return this.serial(async()=>{const next=structuredClone(this.state);delete next.packages[id];delete next.grants[id];next.globalEnabled=(next.globalEnabled??[]).filter(x=>x!==id);for(const p of Object.keys(next.disabled??{}))next.disabled![p]=next.disabled![p].filter(x=>x!==id);for(const p of Object.keys(next.enabled))next.enabled[p]=next.enabled[p].filter(x=>x!==id);resolveGraph(new Map(Object.entries(next.packages)),Object.keys(next.packages));await this.save(next);});}
 async history(){const names=await fs.readdir(path.join(this.root,'history')).catch((e:any)=>{if(e.code==='ENOENT')return [];throw e;});return names.filter(n=>/^\d+-\d+\.json$/.test(n)).sort((a,b)=>Number(b.split('-')[1].slice(0,-5))-Number(a.split('-')[1].slice(0,-5))).slice(0,100);}
 async previewHistory(name:string){if(!(await this.history()).includes(name))throw Error('Unknown registry snapshot');const raw=JSON.parse(await fs.readFile(path.join(this.root,'history',name),'utf8'));const state=this.validateState(raw);return {state,revision:this.state.revision};}
 async restoreHistory(name:string,revision:number){return this.serial(async()=>{if(revision!==this.state.revision)throw Error('Registry changed; preview again');const {state}=await this.previewHistory(name);const oldError=this.recoveryError;this.recoveryError='';try{await this.save(state);}catch(e){this.recoveryError=oldError;throw e;}});}
 async export(id:string):Promise<PluginBundle>{const packages=new Map(Object.entries(this.state.packages));return {format:'sageplugin',version:1,roots:[id],packages:resolveGraph(packages,[id]).map(x=>packages.get(x)!)};}
 async develop(project:string,p:PluginPackage){return this.serial(async()=>{const key=project+'\0'+p.manifest.id,old=this.dev.get(key);this.dev.set(key,verifyPackage(p));try{resolveGraph(this.packages(project),[p.manifest.id]);}catch(e){if(old)this.dev.set(key,old);else this.dev.delete(key);throw e;}this.stop();this.changed();});}
 stopDevelopment(project:string,id:string){this.dev.delete(project+'\0'+id);this.stop();this.changed();}
 stop(){this.generation++;this.uiState.clear();this.onStop();for(const r of this.runners.values())r.close();this.runners.clear();}
 async runner(id:string,project:string){
  const key=project+'\0'+id,cached=this.runners.get(key);
  if(cached&&!cached.isClosed?.()){this.runners.delete(key);this.runners.set(key,cached);return cached;}
  if(cached)this.runners.delete(key);
  if(this.starting.has(key))return this.starting.get(key)!;
  this.trimRunners(Math.max(0,8-this.starting.size));
  if(this.runners.size+this.starting.size>=32)throw Error('Too many active plugin runtimes; wait for running calls to finish');
  const p=this.packages(project).get(id);if(!p)throw Error('Plugin missing');const generation=this.generation;
  const start=this.factory(p,project,(req,ctx)=>{const chain=ctx.chain.at(-1)===id?ctx.chain:[...ctx.chain,id];return this.invoke(req,{...ctx,chain});}).then(r=>{if(generation!==this.generation){r.close();throw Error('Plugin registry changed during activation');}this.runners.set(key,r);return r;}).finally(()=>this.starting.delete(key));
  this.starting.set(key,start);return start;
 }
 async call(project:string,req:PluginCall,attachments?:PluginContext['attachments']){return this.invoke(req,{project,attachments,chain:[],trace:crypto.randomUUID(),deadline:Date.now()+(this.dev.has(project+'\0'+req.plugin)?300000:30000),development:this.dev.has(project+'\0'+req.plugin)});}
 async invoke(req:PluginCall,ctx:PluginContext,extensionDispatch=false):Promise<unknown>{
  if(ctx.chain.length>12||Date.now()>ctx.deadline)throw Error('Plugin call deadline/depth exceeded');
  const payloadLimit=req.plugin==='$host'&&req.service==='models'&&req.method==='analyzeImage'?16:extensionDispatch?8:1;
  if(Buffer.byteLength(JSON.stringify(req.args??null))>payloadLimit*1024*1024)throw Error('Request exceeds plugin payload limit');
  const start=Date.now();let ok=false,error:string|undefined;
  try{
   const enabled=this.enabled(ctx.project),packages=this.packages(ctx.project);
   for(const id of ctx.chain)if(!enabled.has(id))throw Error('Caller no longer enabled');
   if(req.plugin==='$host'){
    if(['git','browser'].includes(req.service)&&this.hostDependencies){const integration=(await this.hostDependencies(ctx.project))[req.service];if(!integration?.installed||!integration.enabled)throw Error(`Host integration is disabled: ${req.service}`);}
    const method=this.host.get(`${req.service}.${req.method}`);if(!method)throw Error('Unknown host capability');
    for(const id of ctx.chain){const p=packages.get(id)!;const grants=this.dev.has(ctx.project+'\0'+id)?p.manifest.permissions:this.state.grants[id]??[];if(method.permission&&(!p.manifest.permissions.includes(method.permission)||!grants.includes(method.permission)))throw Error(`${id}: permission denied: ${method.permission}`);}
    validateValue(method.input,req.args);const result=await method.run(req.args,ctx);ok=true;return result;
   }
   if(!enabled.has(req.plugin))throw Error('Plugin not enabled for this project');
   const caller=ctx.chain.at(-1);if(caller&&caller!==req.plugin&&!extensionDispatch){const p=packages.get(caller)!;if(!p.manifest.consumes.some(c=>c.plugin===req.plugin&&c.service===req.service))throw Error('Undeclared service dependency');}
   const p=packages.get(req.plugin)!,method=p.manifest.services[req.service]?.methods[req.method];if(!method)throw Error('Unknown service method');validateValue(method.input,req.args);await this.assertHostDependencies(ctx.project,p,'project');
   const key=ctx.project+'\0'+req.plugin;
   this.activeRunners.set(key,(this.activeRunners.get(key)??0)+1);
   try {
    const r=await this.runner(req.plugin,ctx.project);const pluginContext={...ctx,chain:[...ctx.chain,req.plugin]};const value=await r.call(req.service,req.method,req.args,pluginContext);if(method.output)validateValue(method.output,value,'output');if(Buffer.byteLength(JSON.stringify(value??null))>8*1024*1024)throw Error('Result exceeds 8 MB');ok=true;return value;
   } finally {
    const active=(this.activeRunners.get(key)??1)-1;
    if(active)this.activeRunners.set(key,active);else this.activeRunners.delete(key);
    this.trimRunners();
   }
  }catch(e:any){error=String(e.message??e);throw e;}finally{this.logProjects.set(ctx.trace,ctx.project);this.logs.push({at:new Date().toISOString(),trace:ctx.trace,chain:[...ctx.chain,req.plugin],service:req.service,method:req.method,duration:Date.now()-start,ok,error});if(this.logs.length>500){this.logs.shift();const traces=new Set(this.logs.map(l=>l.trace));for(const t of this.logProjects.keys())if(!traces.has(t))this.logProjects.delete(t);}await fs.appendFile(path.join(this.root,'audit.jsonl'),JSON.stringify({at:new Date().toISOString(),trace:ctx.trace,chain:ctx.chain,target:req.plugin,service:req.service,method:req.method,ok,duration:Date.now()-start})+'\n',{mode:0o600}).catch(()=>{});}
 }
 async setting(project:string,id:string,key:string,value?:unknown){return this.serial(async()=>{const p=this.packages(project).get(id),field=p&&Object.hasOwn(p.manifest.settings,key)?p.manifest.settings[key]:undefined;if(!field)throw Error('Unknown plugin setting');if(field.scope==='global'&&this.globalSettings){if(value===undefined){const saved=await this.globalSettings.get(id,key,field.type==='secret');if(saved!==undefined)return saved;const legacy=path.join(this.root,'data',id,'global',`${key}.json`);let text:string;try{text=await fs.readFile(legacy,'utf8');}catch(e:any){if(e.code==='ENOENT')return field.default??null;throw e;}const raw=JSON.parse(text);if(raw.checksum!==digest(raw.value))throw Error('Legacy plugin setting checksum mismatch');validateValue({type:field.type==='secret'?'string':field.type},raw.value);await this.globalSettings.set(id,key,raw.value,field.type==='secret');await fs.rename(legacy,legacy+'.migrated');return raw.value;}validateValue({type:field.type==='secret'?'string':field.type},value);await this.globalSettings.set(id,key,value,field.type==='secret');return value;}const scope=field.scope==='global'?'global':digest(project);const dir=path.join(this.root,'data',id,scope);await fs.mkdir(dir,{recursive:true,mode:0o700});const file=path.join(dir,`${key}.json`);let current:any;try{const raw=JSON.parse(await fs.readFile(file,'utf8'));if(raw.checksum!==digest(raw.value))throw Error('Plugin setting checksum mismatch');current=raw.value;}catch(e:any){if(e.code!=='ENOENT')throw e;}
 if(value===undefined)return current??field.default??null;validateValue({type:field.type},value);if(current!==undefined)await fs.writeFile(path.join(dir,`${key}.${Date.now()}.history`),stable({value:current,checksum:digest(current)}),{flag:'wx',mode:0o600});const tmp=file+'.tmp';const h=await fs.open(tmp,'w',0o600);try{await h.writeFile(stable({value,checksum:digest(value)}));await h.sync();}finally{await h.close();}await fs.rename(tmp,file);return value;});}
}
