import fs from 'node:fs/promises';
import path from 'node:path';
import {packDirectory,resolveGraph,parseBundle,setPluginPackageLimit} from './packages';
import {scaffold} from './scaffold';
import type {PluginManager} from './manager';
import type {PluginBundle} from '../../shared/plugins/contract';
import {enforceInsideProject,isDeniedRead,isDeniedWrite} from '../sandbox/fs-policy';
/** Conversational development is confined to the current project. Export never runs package scripts. */
export async function developmentAction(m:PluginManager,project:string,input:any){
 if(!project)throw Error('Select a project for plugin development');
 const action=String(input.action);
 const checked=async(value:unknown,write=false)=>{if(typeof value!=='string')throw Error('path required');const file=path.resolve(project,value);enforceInsideProject(file,project);const root=await fs.realpath(project);let candidate=file;while(true){try{const resolved=await fs.realpath(candidate);if(resolved!==root&&!resolved.startsWith(root+path.sep))throw Error('Symlink escapes project');break;}catch(e:any){if(e.code!=='ENOENT')throw e;const parent=path.dirname(candidate);if(parent===candidate)throw e;candidate=parent;}}if((write?isDeniedWrite:isDeniedRead)(file))throw Error('Protected project path');return file;};
 if(action==='scaffold'){const parent=await checked(input.path??'.',true);return {directory:await scaffold(parent,input.plugin??'local.hello')};}
 if(action==='inspect'){const p=await packDirectory(await checked(input.path));return {manifest:p.manifest,digest:p.digest};}
 if(action==='dev-start'){
  const dir=await checked(input.path);const p=await packDirectory(dir);if(JSON.stringify([...p.manifest.permissions].sort())!==JSON.stringify([...(input.permissions??[])].sort()))throw Error('Inspect the manifest first and include the exact requested permissions');await m.develop(project,p);(await import('./index')).trackDevelopment(project,p.manifest.id,dir,p.digest,p.manifest.permissions);return {id:p.manifest.id,digest:p.digest,development:true};
 }
 if(action==='dev-stop'){(await import('./index')).trackDevelopment(project,input.plugin);m.stopDevelopment(project,input.plugin);return {stopped:true};}
 if(action==='package'){
  const p=await packDirectory(await checked(input.path));const all=m.packages(project);all.set(p.manifest.id,p);const bundle:PluginBundle={format:'sageplugin',version:1,roots:[p.manifest.id],packages:resolveGraph(all,[p.manifest.id]).map(id=>all.get(id)!)};const output=await checked(input.output??`${p.manifest.id}-${p.manifest.version}.sageplugin`,true);await fs.writeFile(output,JSON.stringify(bundle),{flag:'wx',mode:0o600});return {file:output,packages:bundle.packages.map(p=>({id:p.manifest.id,version:p.manifest.version,digest:p.digest}))};
 }
 if(action==='validate'){const file=await checked(input.path);const stat=await fs.stat(file);const {readSettings}=await import('../main');const max=(await readSettings()).runtimeConfig?.maxPluginPackageBytes??16*1024*1024;setPluginPackageLimit(max);if(stat.size>max*4)throw Error(`Bundle exceeds ${Math.round(max*4/1024/1024)} MB`);const b=parseBundle(await fs.readFile(file,'utf8'));return m.plan(b);}
 throw Error('Unknown development action');
}
