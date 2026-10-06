import { WindowPreviews } from '../utils/window-previews';
import {authorizeWorkflow,renderPackageView,migrateWorkflowActivation} from './workflow-packages';
import {contextualAttachments} from '../sandbox/conversation-policy';
import { compositeModelAvailableNow } from '../../shared/model-availability';
import {localizePluginManifest} from '../../shared/plugins/i18n';
import {marketplaceEndpoint} from '../../shared/plugins/market-url';
import {resolveLanguage} from '../../shared/language';
import {registerHostServices} from './host-services';
import {registerExtensions, extensionEntries, emitPluginEvent} from './extensions';
import {app,dialog,ipcMain,shell, BrowserWindow} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {PluginManager} from './manager';
import {electronRunner} from './runtime';
import {registerBrowser} from './browser';
import {packDirectory,parseBundle,resolveGraph,setPluginPackageLimit,satisfies,verifyPackage} from './packages';
import {resolveMarketDependencies} from './market-dependencies';
import type {PluginBundle,PluginCall} from '../../shared/plugins/contract';
import { listPluginSkills } from './skills';
import { mcpCallTool, mcpListTools } from '../mcp-client';
import { builtinPlugins, builtinPluginSettings, builtinSettingValue } from '../../shared/builtin-plugins';
import { probeHttp } from '../net-probe';
import { relayService } from '../relay-services';
import { PROTECTED } from '../settings-transfer';
let manager:PluginManager|undefined;
export function pluginManager(){if(!manager)throw Error('Plugin platform unavailable');return manager;}
export function listEnabledPluginSkills(project:string){return listPluginSkills(pluginManager(),project);}
async function pluginLocale(){return resolveLanguage((await (await import('../main')).readSettings()).language,app.getLocale());}
async function translatedPlan(m:PluginManager,bundle:PluginBundle){const plan=m.plan(bundle),locale=await pluginLocale();return {...plan,changes:plan.changes.map(change=>({...change,name:localizePluginManifest(bundle.packages.find(p=>p.manifest.id===change.id)!.manifest,locale).name}))};}
const object={type:'object'};
type MarketplaceSettings={skillMarketUrl?:string;pluginMarketUrl?:string;relayHookBaseUrl?:string;relayUrl?:string;relayToken?:string;relayCertificate?:import("../../shared/relay-certificate").RelayCertificatePolicy};
function configuredMarketplace(settings:MarketplaceSettings,argsUrl?:unknown,skills=false):string {
 const value=relayService(settings).base;
 if(!value)return '';
 if(!/^https?:\/\//i.test(value)&&!/^wss?:\/\//i.test(value))throw Error('插件市场地址必须使用 HTTP(S) 或 WS(S) 地址');
 return value;
}
function marketplaceHeaders(settings:MarketplaceSettings,accept='application/json'):Record<string,string>{
 return {accept,...relayService(settings).headers};
}
async function marketplaceRequest(settings:MarketplaceSettings,url:string,init:RequestInit={},maxBytes=1024*1024){
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),15000);
 try {
  const response=await relayService(settings).request(url,{...init,redirect:'error',signal:controller.signal,headers:{...marketplaceHeaders(settings,init.headers instanceof Headers?init.headers.get('accept')||'application/json':(init.headers as Record<string,string>|undefined)?.accept||'application/json'),...(init.headers instanceof Headers?Object.fromEntries(init.headers.entries()):init.headers as Record<string,string>|undefined)}});
  const declared=Number(response.headers.get('content-length')||0);
  const oversized=()=>Error(`插件包超过大小限制（上限 ${Math.round(maxBytes/1024/1024)} MB）`);
  if(declared>maxBytes){controller.abort();throw oversized();}
  const chunks:Uint8Array[]=[];let bytes=0;
  const reader=response.body?.getReader();
  if(reader)try{
   while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBytes){controller.abort();throw oversized();}chunks.push(part.value);}
  }finally{reader.releaseLock();}
  const body=Buffer.concat(chunks,bytes).toString('utf8');
  if(!response.ok){
   let message='请求失败';try{const parsed=JSON.parse(body);if(typeof parsed?.error==='string')message=parsed.error;}catch{if(body.trim())message=body.trim().slice(0,240);}
   throw Error(`${message}（HTTP ${response.status}）`);
  }
  return {response,body};
 }catch(error:any){
  if(error?.name==='AbortError')throw Error('插件市场请求超时（15 秒）');
  throw error;
 }finally{clearTimeout(timeout);}
}
function marketJson(body:string):any{
 try{return JSON.parse(body);}catch{throw Error('插件市场返回了无效数据');}
}
function validMarketPluginId(value:unknown):value is string{return typeof value==='string'&&/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(value);}
async function syncPluginRuntimeLimits() {
 const {readSettings}=await import('../main');
 const max = (await readSettings()).runtimeConfig?.maxPluginPackageBytes ?? 16*1024*1024;
 setPluginPackageLimit(max);
 return max;
}
export async function initializePlugins(isAppSender:(id:number)=>boolean){
 await syncPluginRuntimeLimits();
 const m=new PluginManager(path.join(app.getPath('userData'),'plugins'),electronRunner);await m.init().catch(e=>console.error('[plugins] Registry unavailable:',e.message));manager=m;
 m.globalSettings={get:async(id,key,secret)=>(await (await import('../main')).readSettings())[secret?'pluginSecrets':'pluginSettings']?.[id]?.[key],set:async(id,key,value,secret)=>(await import('../main')).patchPluginSetting(id,key,value,secret)};
 // Host integrations are built into Sage rather than installable package
 // entries.  Expose their project/global activation state to the manager so
 // plugins can declare and enforce prerequisites such as Git and Browser.
 m.hostDependencies=async()=>Object.fromEntries(['git','browser'].map(id=>[id,{installed:true,enabled:true,version:'1.0.0'}]));
 m.changed=()=>{(require('../engine-registry') as typeof import('../engine-registry')).invalidateEngineRuns();for(const w of BrowserWindow.getAllWindows())if(isAppSender(w.webContents.id))w.webContents.send('plugins:changed');};
 const closeBrowser=registerBrowser(m);m.onStop=closeBrowser;app.on('before-quit',()=>{m.stop();closeBrowser();void import('../mcp-client').then(x=>x.mcpCloseAll());});
 for(const method of ['get','set'])m.host.set(`settings.${method}`,{permission:'',description:'Namespaced plugin settings',input:{type:'object',properties:{key:{type:'string'},value:{type:'string'}},required:['key']},run:async(a,c)=>m.setting(c.project,c.chain.at(-1)!,a.key,method==='set'?a.value:undefined)});
 m.host.set('mcp.listTools',{permission:'mcp.connect',description:'Connect to a configured local MCP server and list tools',input:{type:'object',properties:{command:{type:'string'},args:{type:'array',items:{type:'string'}},env:{type:'object'},cwd:{type:'string'}},required:['command']},run:async(a)=>mcpListTools(a)});
 m.host.set('mcp.callTool',{permission:'mcp.connect',description:'Call a tool on a configured local MCP server',input:{type:'object',properties:{command:{type:'string'},args:{type:'array',items:{type:'string'}},env:{type:'object'},cwd:{type:'string'},name:{type:'string'},arguments:{type:'object'}},required:['command','name']},run:async(a)=>mcpCallTool(a,a.name,a.arguments)});
 // Setting values can be primitive strings, numbers or booleans; per-field schema checks happen in manager.
 m.host.get('settings.set')!.input=object;
 m.host.set('workspace.current',{permission:'workspace.read',description:'Current project path',input:object,run:async(_a,c)=>({path:c.project})});
 m.host.set('capabilities.list',{permission:'',description:'List stable host APIs',input:object,run:async()=>[...m.host].map(([id,x])=>({id,permission:x.permission,description:x.description,input:x.input}))});
 for(const name of ['Read','Glob','Grep','Write','Edit','Bash','WebFetch','SaveMemory','RecallMemory'])m.host.set(`tools.${name}`,{permission:['Read','Glob','Grep','RecallMemory'].includes(name)?'workspace.read':name==='WebFetch'?'network.fetch':'workspace.write',description:`Sage ${name} (existing sandbox applies)`,input:object,run:async(a,c)=>{
  const {executeTool}=await import('../api-tool-executor');const result=await executeTool(name,a,c.project);if(result.isError)throw Error(result.result);return result.result;
 }});
 m.host.set('models.list',{permission:'models.use',description:'List available models without credentials',input:object,run:async()=>{const {readSettings}=await import('../main');const s=await readSettings();return (s.modelProviders??[]).filter(p=>p.enabled).map(p=>({id:p.id,name:p.name,models:p.models.filter(id=>compositeModelAvailableNow(p,id,s.modelProviders??[])).map(id=>({id,name:p.relayModels?.find(x=>x.id===id)?.name??id}))}));}});
 m.host.set('conversations.list',{permission:'conversations.read',description:'Project conversation summaries',input:object,run:async(_a,c)=>{const {listConvsForProject}=await import('../store');return (await listConvsForProject(c.project)).map(x=>({id:x.id,title:x.title,createdAt:x.createdAt}));}});
 m.host.set('tasks.list',{permission:'tasks.read',description:'Project scheduled tasks',input:object,run:async(_a,c)=>{const {listScheduledTasks}=await import('../store');return (await listScheduledTasks(c.project)).map(x=>({id:x.id,name:x.name,enabled:x.enabled}));}});
 m.host.set('ui.notify',{permission:'ui',description:'Show a plugin notification',input:{type:'object',properties:{text:{type:'string',maxLength:1000}},required:['text']},run:async(a,c)=>{for(const w of BrowserWindow.getAllWindows())if(isAppSender(w.webContents.id))w.webContents.send('plugins:notification',{project:c.project,plugin:c.chain.at(-1),text:a.text});return true;}});
 registerHostServices(m,isAppSender);
 registerExtensions(m);
 const previews=new WindowPreviews<{ticket:string,bundle:PluginBundle,revision:number}>();
 ipcMain.handle('plugins:manage',async(event,op:string,args:any={})=>{
  if(!isAppSender(event.sender.id)||event.senderFrame!==event.sender.mainFrame)throw Error('Untrusted plugin management caller');
  const project=String(args.project??'');if(project){const {listProjects}=await import('../store');if(!(await listProjects()).some(p=>p.path===project))throw Error('Unknown project');}
  if(op==='manual'){const {readSettings}=await import('../main');const name=args.name??(resolveLanguage((await readSettings()).language,app.getLocale())==='en'?'PLUGIN_MANUAL.en.md':'PLUGIN_MANUAL.md');if(!['PLUGIN_MANUAL.md','PLUGIN_MANUAL.en.md','PLUGIN_PLATFORM_DESIGN.md','EXTENSIBILITY.md','EXTENSION_COOKBOOK.md','PLUGIN_EXTENSION_CATALOG.md','BACKEND_ENGINES.md'].includes(name))throw Error('Unknown bundled document');const file=app.isPackaged?path.join(process.resourcesPath,'plugin-sdk',name):path.join(app.getAppPath(),'docs',name);return {name,content:await fs.readFile(file,'utf8')};}
  if(op==='snapshot')return {...m.snapshot(project),recoveryError:m.recoveryError};
  if(op==='browser-register'){if(!project)throw Error('Project required');return (await import('./browser-tabs')).registerBrowserTab(args.id,project,event.sender.id,args.tabId);}
  if(op==='extensions')return extensionEntries(m,project,String(args.point));
  if(op==='workspace-opened'){return emitPluginEvent(m,project,'sage/workspace.opened',{project});}
  if(op==='settings-changed'){return emitPluginEvent(m,project,'sage/settings.changed',{keys:Array.isArray(args.keys)?args.keys.filter((k:unknown)=>typeof k==='string').slice(0,100):[]});}
  if(op==='history')return m.history();
  if(op==='history-preview'){const p=await m.previewHistory(args.name);return {revision:p.revision,packages:Object.values(p.state.packages).map(p=>({id:p.manifest.id,version:p.manifest.version,permissions:p.manifest.permissions})),enabled:p.state.enabled,globalEnabled:p.state.globalEnabled??[],disabled:p.state.disabled??{}};}
  if(op==='history-restore'){await m.restoreHistory(args.name,args.revision);return m.snapshot(project);}
  if(op==='preview'){
   const maxPackageBytes=await syncPluginRuntimeLimits();
   const file=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:args.kind==='skill'?'Sage skill':'Sage plugin',extensions:args.kind==='skill'?['sageplugin','md']:['sageplugin']}]});if(file.canceled)return null;
   const stat=await fs.stat(file.filePaths[0]);if(stat.size>maxPackageBytes*4)throw Error(`Bundle exceeds ${Math.round(maxPackageBytes*4/1024/1024)} MB`);
   const content=await fs.readFile(file.filePaths[0],'utf8');let bundle:PluginBundle;
   if(args.kind==='skill'&&path.extname(file.filePaths[0]).toLowerCase()==='.md'){
    if(stat.size>128*1024)throw Error('Skill exceeds 128 KB');
    const {parseSkillMeta}=await import('../skills');const meta=parseSkillMeta(content,path.basename(file.filePaths[0]));if(!meta)throw Error('Skill name and description required');
    const id='local.skill-'+crypto.createHash('sha256').update(meta.name).digest('hex').slice(0,16);
    const p=verifyPackage({manifest:{format:1,id,name:meta.name,description:meta.description,version:'1.0.0',sdk:'^1.2.0',entry:'plugin.js',artifactType:'skill',category:'documentation',skills:[{name:id,description:meta.description,file:'skills/SKILL.md'}]},files:{'plugin.js':'globalThis.sagePlugin={services:{}};','skills/SKILL.md':content}});
    bundle={format:'sageplugin',version:1,roots:[id],packages:[p]};
   }else bundle=parseBundle(content);
   const plan=await translatedPlan(m,bundle),ticket=crypto.randomUUID();previews.set(event.sender,{ticket,bundle,revision:plan.revision});return {...plan,ticket};
  }
  if(op==='install'){const draft=previews.get(event.sender.id);if(!draft||draft.ticket!==args.ticket)throw Error('Preview required');await m.install(draft.bundle,draft.revision);await migrateWorkflowActivation(m,draft.bundle.roots,await (await import('../main')).readSettings(),await (await import('../store')).listProjects(),(await import('../main')).patchSettings);previews.delete(event.sender.id);return m.snapshot(project);}
  if(op==='enable-global'){if(typeof args.enabled!=='boolean')throw Error('Invalid enabled value');await m.enableGlobal(args.id,args.enabled);return m.snapshot(project);}
  if(op==='enable'){if(!project)throw Error('Select a project');if(args.enabled!==null&&typeof args.enabled!=='boolean')throw Error('Invalid project override');await m.enable(project,args.id,args.enabled);return m.snapshot(project);}
  if(op==='engine-detect'){const {detectEngine}=await import('../engine-registry');return detectEngine(String(args.id||''),project);}
  if(op==='market-availability'){
   const {readSettings}=await import('../main');
   try { relayService(await readSettings()); return {ok:true}; }
   catch { return {ok:false}; }
  }
  if(op==='market-status'){
   const {readSettings}=await import('../main');const settings=await readSettings();let configured='';try{configured=configuredMarketplace(settings,args.url,args.kind==='skill');}catch(error:any){return {ok:false,url:String(args.url??''),error:error?.message||'invalid-url'};}
   if(!configured)return {ok:false,url:'',error:'not-configured'};
   const endpoint=marketplaceEndpoint(configured);return probeHttp(endpoint,8000,settings.relayToken?{authorization:`Bearer ${settings.relayToken}`} : undefined);
  }
  if(op==='market-list'){
   const {readSettings}=await import('../main');const settings=await readSettings();const configured=configuredMarketplace(settings,args.url,args.kind==='skill');if(!configured)return {ok:false,plugins:[],error:'未配置插件市场地址'};
   const endpoint=marketplaceEndpoint(configured);const {body}=await marketplaceRequest(settings,endpoint,{headers:{accept:'application/json'}});const data=marketJson(body);
   if(data?.ok===false)throw Error(typeof data.error==='string'?data.error:'插件市场暂不可用');
   if(!Array.isArray(data?.plugins))throw Error('插件市场返回的插件列表无效');
   return {ok:true,plugins:data.plugins};
  }
  if(op==='market-preview'){
   await syncPluginRuntimeLimits();const {readSettings}=await import('../main');const settings=await readSettings();const configured=configuredMarketplace(settings,args.url,args.kind==='skill');if(!configured)throw Error('未配置插件市场地址');
   const id=args.id; if(!validMarketPluginId(id))throw Error('插件标识无效');
   const endpoint=marketplaceEndpoint(configured);const detail=await marketplaceRequest(settings,`${endpoint}/${encodeURIComponent(id)}`,{headers:{accept:'application/json'}});const data=marketJson(detail.body);const entry=data?.plugin;
   if(!entry||typeof entry!=='object')throw Error('插件市场未返回插件详情');
   const versions=Array.isArray(entry.versions)?entry.versions:Array.isArray(entry.releases)?entry.releases:[];
   const version=String(args.version||entry.latestVersion||versions[0]?.version||'').trim();if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('插件市场未提供有效版本');
   const downloaded=await marketplaceRequest(settings,`${endpoint}/${encodeURIComponent(id)}/download/${encodeURIComponent(version)}`,{headers:{accept:'application/octet-stream'}},((await syncPluginRuntimeLimits())*4));
   const rootBundle=parseBundle(downloaded.body);
   if(!rootBundle.roots.includes(id)||!rootBundle.packages.some(p=>p.manifest.id===id&&p.manifest.version===version))throw Error('Marketplace package identity mismatch');
   const bundle=await resolveMarketDependencies(rootBundle,m.packages(''),async(dep,range)=>{
    const detail=marketJson((await marketplaceRequest(settings,`${endpoint}/${encodeURIComponent(dep)}`)).body)?.plugin;
    const versions=(detail?.versions??detail?.releases??[]).map((v:any)=>typeof v==='string'?v:v.version);
    if(detail?.latestVersion)versions.push(detail.latestVersion);
    const compatible=versions.filter((v:any)=>typeof v==='string'&&/^\d+\.\d+\.\d+$/.test(v)&&satisfies(v,range)).sort((a:string,b:string)=>b.localeCompare(a,undefined,{numeric:true}))[0];
    if(!compatible)throw Error(`No compatible marketplace dependency: ${dep}@${range}`);
    const result=parseBundle((await marketplaceRequest(settings,`${endpoint}/${encodeURIComponent(dep)}/download/${compatible}`,{},(await syncPluginRuntimeLimits())*4)).body);
    if(!result.roots.includes(dep)||!result.packages.some(p=>p.manifest.id===dep&&p.manifest.version===compatible))throw Error('Dependency identity mismatch');
    return result;
   });
   const plan=await translatedPlan(m,bundle);const ticket=crypto.randomUUID();previews.set(event.sender,{ticket,bundle,revision:plan.revision});
   return {...plan,ticket,source:'market',market:{id,version,name:entry.name||id}};
  }
  if(op==='uninstall'){await m.uninstall(args.id);return m.snapshot(project);}
  if(op==='export'){const bundle=await m.export(args.id);const picked=await dialog.showSaveDialog({defaultPath:`${args.id}.sageplugin`});if(!picked.canceled&&picked.filePath)await fs.writeFile(picked.filePath,JSON.stringify(bundle),{mode:0o600});return !picked.canceled;}
  if(op==='workflow-authorize')return authorizeWorkflow(m,project,args.id);
  if(op==='view'){const p=m.packages(project).get(args.id);if(!m.enabled(project).has(args.id))throw Error('Plugin disabled');const c=p?.manifest.contributes.find(x=>x.id===args.contribution);if(!c?.view)throw Error('Unknown plugin view');return renderPackageView(p!,c.view);}
  if(op==='call')return m.call(project,args.call);
  if(op==='setting'){
   // 内置插件（git/browser）配置白名单：全局值与外部插件同层（pluginSettings），
   // 项目级（scope='project'）覆盖值存 projectPluginSettings[project]。
   const builtinField=(builtinPluginSettings[args.id]??{})[args.key];
   if(builtinField){
    const {readSettings,patchPluginSetting,patchProjectPluginSetting}=await import('../main');
    // layer 显式指定读/写层：'global'=全局值，'project'=项目覆盖值；
    // 未指定时按字段 scope 推断（project→项目层，global/both→全局层）。
    // scope='both' 字段在全局配置面板写全局层、在项目卡片写项目层。
    const layer=args.layer==='project'?'project':args.layer==='global'?'global':(builtinField.scope==='project'?'project':'global');
    if(args.value===undefined){
     const s=await readSettings();
     if(layer==='project')return builtinSettingValue(s,project,args.id,args.key)??null;
     const gv=s?.pluginSettings?.[args.id]?.[args.key];
     return (typeof gv==='string'||typeof gv==='number'||typeof gv==='boolean')?gv:(builtinField.default??null);
    }
    if(layer==='project'){
     if(!project)throw Error('Select a project for project settings');
     await patchProjectPluginSetting(project,args.id,args.key,args.value);return args.value;
    }
    await patchPluginSetting(args.id,args.key,args.value);return args.value;
   }
   const field=m.packages(project).get(args.id)?.manifest.settings[args.key];
   if(!project&&field?.scope!=='global')throw Error('Select a project for project settings');
   if(field?.type==='secret'){
    if(args.value===PROTECTED)return PROTECTED;
    if(args.value!==undefined){await m.setting(project,args.id,args.key,args.value);return PROTECTED;}
    const saved=await m.setting(project,args.id,args.key);return saved?PROTECTED:null;
   }
   return m.setting(project,args.id,args.key,args.value);}
  if(op==='develop'){
   await syncPluginRuntimeLimits();
   if(!project)throw Error('Select a project');const picked=await dialog.showOpenDialog({properties:['openDirectory']});if(picked.canceled)return null;const dir=picked.filePaths[0],p=await packDirectory(dir);
   const confirm=await dialog.showMessageBox({type:'question',message:`开发插件 ${localizePluginManifest(p.manifest,await pluginLocale()).name}`,detail:`本次开发会话申请：\n${p.manifest.permissions.join('\n')||'无额外权限'}${p.manifest.engine?'\n本机引擎插件可以执行本机代码并访问文件与网络，仅加载可信代码。':''}\n目录：${dir}`,buttons:['取消','启动开发'],defaultId:0,cancelId:0});if(confirm.response!==1)return null;
   await m.develop(project,p);devDirectories.set(project+'\0'+p.manifest.id,{dir,digest:p.digest,permissions:JSON.stringify(p.manifest.permissions)});return m.snapshot(project);
  }
  if(op==='devtools'){if(!m.snapshot(project).plugins.some(p=>p.manifest.id===args.id&&p.development))throw Error('Load a development directory first');(await m.runner(args.id,project)).inspect?.();return true;}
  if(op==='dev-stop'){devDirectories.delete(project+'\0'+args.id);m.stopDevelopment(project,args.id);return m.snapshot(project);}
  if(op==='dev-package'){await syncPluginRuntimeLimits();const d=devDirectories.get(project+'\0'+args.id);if(!d)throw Error('Development session missing');const p=await packDirectory(d.dir);const map=m.packages(project);map.set(p.manifest.id,p);const bundle:PluginBundle={format:'sageplugin',version:1,roots:[p.manifest.id],packages:resolveGraph(map,[p.manifest.id]).map(id=>map.get(id)!)};const picked=await dialog.showSaveDialog({defaultPath:`${args.id}-${p.manifest.version}.sageplugin`});if(!picked.canceled&&picked.filePath)await fs.writeFile(picked.filePath,JSON.stringify(bundle),{mode:0o600});return !picked.canceled;}
 if(op==='market-publish'){await syncPluginRuntimeLimits();const d=devDirectories.get(project+'\0'+args.id);if(!d)throw Error('Development session missing');const p=await packDirectory(d.dir);const {readSettings}=await import('../main');const settings=await readSettings();const configured=configuredMarketplace(settings);const endpoint=marketplaceEndpoint(configured);const map=m.packages(project);map.set(p.manifest.id,p);const bundle:PluginBundle={format:'sageplugin',version:1,roots:[p.manifest.id],packages:resolveGraph(map,[p.manifest.id]).map(id=>map.get(id)!)};const {body}=await marketplaceRequest(settings,endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:p.manifest.id,name:p.manifest.name,version:p.manifest.version,description:p.manifest.description,category:p.manifest.category||'other',manifest:p.manifest,bundle:JSON.stringify(bundle)})});return marketJson(body);}
  if(op==='scaffold'){const picked=await dialog.showOpenDialog({properties:['openDirectory','createDirectory']});if(picked.canceled)return null;const {scaffold,scaffoldEngine,scaffoldSkill}=await import('./scaffold');const dir=await (args.kind==='skill'?scaffoldSkill:args.kind==='engine'?scaffoldEngine:scaffold)(picked.filePaths[0],args.id??(args.kind==='skill'?'local.skill':args.kind==='engine'?'local.cli':'local.hello'));return {directory:dir};}
  if(op==='examples'){await syncPluginRuntimeLimits();const base=app.isPackaged?path.join(process.resourcesPath,'plugins'):path.join(app.getAppPath(),'resources/plugins');const entries=await fs.readdir(base);const packages=[];for(const e of entries)packages.push(await packDirectory(path.join(base,e)));const bundle:PluginBundle={format:'sageplugin',version:1,roots:packages.map(p=>p.manifest.id),packages};const plan=await translatedPlan(m,bundle),ticket=crypto.randomUUID();previews.set(event.sender,{ticket,bundle,revision:plan.revision});return {...plan,ticket};}
  throw Error('Unknown plugin operation');
 });
 const timer=setInterval(async()=>{for(const [key,d] of devDirectories){if(d.busy)continue;d.busy=true;const [project,id]=key.split('\0');try{const p=await packDirectory(d.dir);if(p.digest!==d.digest){if(JSON.stringify(p.manifest.permissions)!==d.permissions)throw Error('Permissions changed; restart development to review grants');await m.develop(project,p);d.digest=p.digest;}}catch(e:any){m.stopDevelopment(project,id);devDirectories.delete(key);for(const w of BrowserWindow.getAllWindows())if(isAppSender(w.webContents.id))w.webContents.send('plugins:notification',{project,plugin:id,text:String(e.message)});}finally{d.busy=false;}}},1500);timer.unref();
}
const devDirectories=new Map<string,{dir:string;digest:string;permissions:string;busy?:boolean}>();
export async function pluginTool(project:string,input:any){const m=pluginManager();
 if(input.action==='list'){const locale=await pluginLocale();return {plugins:m.snapshot(project).plugins.filter(p=>p.enabled).map(p=>localizePluginManifest(p.manifest,locale)).map(p=>({id:p.id,description:p.description,services:p.services})),development:'Use Read/Write to create sage.plugin.json and plugin.js in an independent directory; load it through Settings > Plugins > Development.'};}
 if(input.action==='call'){const p=m.packages(project).get(input.plugin);if(!p?.manifest.services[input.service]?.methods[input.method]?.tool)throw Error('Method not exposed as a conversational tool');return m.call(project,{plugin:input.plugin,service:input.service,method:input.method,args:input.args??{}},contextualAttachments(project));}
 if(['scaffold','inspect','dev-start','dev-stop','package','validate'].includes(input.action)){const {developmentAction}=await import('./development');return developmentAction(m,project,input);}
 throw Error('Unknown plugin action');
}

export function trackDevelopment(project:string,id:string,dir?:string,digest?:string,permissions?:string[]){const key=project+'\0'+id;if(dir)devDirectories.set(key,{dir,digest:digest!,permissions:JSON.stringify(permissions)});else devDirectories.delete(key);}
