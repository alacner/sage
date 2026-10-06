import crypto from 'node:crypto';
import type { PluginContext } from '../../shared/plugins/contract';
import { validateValue } from '../../shared/plugins/contract';
import { hostExtensionPoints, hostEvents } from '../../shared/plugins/extensions';
import type { PluginManager } from './manager';
import { satisfies } from './packages';

function definition(m:PluginManager, project:string, point:string) {
  if(Object.hasOwn(hostExtensionPoints,point))return hostExtensionPoints[point as keyof typeof hostExtensionPoints];
  const [owner,id]=point.split('/');
  if(!m.enabled(project).has(owner))throw Error('Extension owner is disabled');
  const found=m.packages(project).get(owner)?.manifest.extensionPoints?.find(p=>p.id===id);
  if(!found)throw Error('Unknown extension point');
  return {...found,permission:''};
}
export function extensionEntries(m:PluginManager,project:string,point:string) {
  const def=definition(m,project,point),active=m.enabled(project);
  return [...m.packages(project).values()].filter(p=>active.has(p.manifest.id))
    .flatMap(p=>(p.manifest.extensions??[]).filter(e=>e.point===point&&satisfies(def.version,e.version)
      &&(!def.permission||m.grantedPermissions(project,p.manifest.id).includes(def.permission)))
      .map(e=>({...e,plugin:p.manifest.id,key:`${p.manifest.id}/${e.id}`})))
    .sort((a,b)=>a.order-b.order||a.key.localeCompare(b.key));
}
export async function invokeExtension(m:PluginManager,project:string,point:string,key:string,args:unknown,context?:PluginContext) {
  const def=definition(m,project,point),entry=extensionEntries(m,project,point).find(e=>e.key===key);
  if(!entry)throw Error(`Extension unavailable: ${key}`);
  validateValue(def.input,args);
  const ctx=context??{project,chain:[],trace:crypto.randomUUID(),deadline:Date.now()+20000};
  // Dispatch is authorized by the point's owner, not by a consumes declaration
  // in the reverse direction. Retain the chain so host permissions still intersect.
  if(ctx.chain.includes(entry.plugin))throw Error('Recursive extension invocation');
  const value=await m.invoke({plugin:entry.plugin,service:entry.service,method:entry.method,args},ctx,true);
  validateValue(def.output,value,'extension output');return value;
}
export async function emitPluginEvent(m:PluginManager,project:string,event:string,payload:unknown,context?:PluginContext) {
  const ctx=context??{project,chain:[],trace:crypto.randomUUID(),deadline:Date.now()+5000};
  const results=[];
  const active=m.enabled(project);
  const handlers=[...m.packages(project).values()].filter(p=>active.has(p.manifest.id)&&m.grantedPermissions(project,p.manifest.id).includes('events.subscribe'))
    .flatMap(p=>(p.manifest.events??[]).filter(e=>e.event===event).map(e=>({...e,plugin:p.manifest.id})))
    .sort((a,b)=>a.order-b.order||a.plugin.localeCompare(b.plugin));
  for(const h of handlers){
    if(ctx.chain.includes(h.plugin))continue;
    try{await m.invoke({plugin:h.plugin,service:h.service,method:h.method,args:{event,payload}},ctx,true);results.push({plugin:h.plugin,ok:true});}
    catch(e){results.push({plugin:h.plugin,ok:false,error:String(e)});}
  }
  return results;
}
export function registerExtensions(m:PluginManager) {
  for(const [capability,event] of [['git.commit','sage/git.committed'],['browser.navigate','sage/browser.navigated'],['browser.close','sage/browser.closed']] as const){
    const method=m.host.get(capability);if(!method)continue;
    m.host.set(capability,{...method,run:async(a,c)=>{const result=await method.run(a,c);void emitPluginEvent(m,c.project,event,{source:c.chain.at(-1)},c);return result;}});
  }
  const object={type:'object'};
  m.host.set('extensions.list',{permission:'',description:'Discover versioned extension points and active handlers',input:object,run:async(a,c)=>{
    if(a.point)return extensionEntries(m,c.project,a.point);
    return [...Object.entries(hostExtensionPoints).map(([id,p])=>({id,...p})),
      ...[...m.packages(c.project).values()].filter(p=>m.enabled(c.project).has(p.manifest.id)).flatMap(p=>(p.manifest.extensionPoints??[]).map(e=>({...e,id:`${p.manifest.id}/${e.id}`})))];
  }});
  m.host.set('extensions.invoke',{permission:'',description:'Invoke a handler of an owned extension point',input:object,run:async(a,c)=>{
    if(typeof a.point!=='string'||a.point.split('/')[0]!==c.chain.at(-1))throw Error('Only the extension point owner may dispatch');
    return invokeExtension(m,c.project,a.point,a.key,a.input,c);
  }});
  m.host.set('events.emit',{permission:'events.publish',description:'Publish a namespaced event to declared subscribers',input:object,run:async(a,c)=>{
    if(typeof a.event!=='string'||!a.event.startsWith(c.chain.at(-1)+'/')||a.event.length>180)throw Error('Event namespace must belong to caller');
    return emitPluginEvent(m,c.project,a.event,a.payload,c);
  }});
  m.host.set('events.list',{permission:'',description:'Discover host event names',input:object,run:async()=>hostEvents});
}
