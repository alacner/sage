import type {PluginPackage} from '../../shared/plugins/contract';
import type {PluginManager} from './manager';
import {workflowPermissions} from '../../shared/plugins/workflow';
export function authorizeWorkflow(m:PluginManager,project:string,id:string){
 const permission=workflowPermissions[id];
 if(!permission||!project||!m.enabled(project).has(id)||!m.grantedPermissions(project,id).includes(permission))throw Error('Workflow plugin unavailable or permission denied');
 return true;
}
/** Only declared package assets are substituted; no filesystem or network resolution. */
export function renderPackageView(p:PluginPackage,view:string){
 const html=p.files[view];if(typeof html!=='string')throw Error('Missing view');
 return html.replace(/<(script|style) data-sage-asset="(assets\/[a-zA-Z0-9_.-]+)"><\/\1>/g,(_all,tag,file)=>{
  const body=p.files[file];if(typeof body!=='string')throw Error('Missing view asset');
  return `<${tag}>${body.replace(new RegExp('</'+tag,'gi'),'<\\/'+tag)}</${tag}>`;
 });
}
export async function migrateWorkflowActivation(m:PluginManager,ids:string[],settings:any,projects:any[],save:(patch:any)=>Promise<unknown>){
 for(const id of ids){
  if(!workflowPermissions[id]||settings.pluginSettings?.[id]?.legacyActivationMigrated)continue;
  const short=id.slice(5),old=settings.builtinPluginActivation;
  if(old?.installed?.includes(short)){
   if(old.global?.[short])await m.enableGlobal(id,true);
   for(const project of projects){const mode=old.projects?.[project.path]?.[short];if(mode==='enabled'||mode==='disabled')await m.enable(project.path,id,mode==='enabled');else if(mode===undefined&&project.enabledPlugins?.includes(short))await m.enable(project.path,id,true);}
  }
  settings={...settings,pluginSettings:{...settings.pluginSettings,[id]:{...settings.pluginSettings?.[id],legacyActivationMigrated:true}}};
  await save({pluginSettings:settings.pluginSettings});
 }
}
