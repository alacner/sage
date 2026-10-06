import {workflowRequest} from './workflow-bridge';
import {ArrowLeft} from 'lucide-react';
import {createPluginI18n,localizePluginManifest} from '../../../shared/plugins/i18n';
import {collectPluginColorGroups} from '../../../shared/plugins/colors';
import {THEME_CHANGE_EVENT} from '../../theme';
import {HOOK_PERMISSION} from '../../../shared/plugins/contract';
import {BuiltInBadge} from '../BuiltInBadge';
import {resolveLanguage} from '../../../shared/language';
import {formatConversationError} from '../../../shared/conversation-error';
import {copyMarkdown} from '../../lib/clipboard';
import {isRequiredBuiltin,builtinPlugins,installedBuiltins,builtinMode,enabledBuiltins,builtinPluginSettings,builtinSettingValue} from '../../../shared/builtin-plugins';
import {useCallback,useEffect,useRef,useState,useMemo} from 'react';
import {create} from 'zustand';
import {appendTab, useAppStore,saveTabsToStorage} from '../../stores/appStore';
import type {PluginSnapshot,PluginInfo,PluginManifest} from '../../../shared/plugins/contract';
import './plugins.css';
const categories = {engine:['执行引擎','Engines'],workflow:['工作流','Workflows'],documentation:['文档与知识','Documentation'],development:['开发工具','Development'],integration:['渠道与集成','Integrations'],other:['其他','Other']} as const;
const categoryOf=(p:PluginInfo)=>p.manifest.category??(p.manifest.engine?'engine':'other');
const isBuiltin=(id:string)=>builtinPlugins.some(p=>p.id===id);
/**
 * Return prerequisites that are not currently active.  Package dependencies
 * are checked against the plugin snapshot, while hostDependencies (Git,
 * Browser, and future built-in integrations) are checked against the same
 * activation state used by the sidebar.  Keeping this in the UI gives users
 * a useful reason before the manager rejects an enable operation.
 */
function activationDependencies(p:PluginInfo,snapshot:PluginSnapshot|null,settings:any,project:any,scope:'project'|'global'){
 const missing=Object.keys(p.manifest.dependencies??{}).filter(id=>{
  const dependency=snapshot?.plugins.find(candidate=>candidate.manifest.id===id);
  return !dependency||(scope==='global'?!dependency.globalEnabled:!dependency.enabled);
 });
 const installed=new Set<string>(installedBuiltins(settings).map(item=>item.id));
 const activeProject=new Set(enabledBuiltins(settings,project));
 for(const id of Object.keys(p.manifest.hostDependencies??{})){
  if(!installed.has(id))missing.push(`${id}（未安装）`);
  else if(!isRequiredBuiltin(id)&&(scope==='global'?!settings?.builtinPluginActivation?.global?.[id]:!activeProject.has(id)))missing.push(`${id}（未启用）`);
 }
 return [...new Set(missing)];
}
async function setActivation(project:string,id:string,enabled:boolean|null,global=false){
 if(isRequiredBuiltin(id))return;
 if(!isBuiltin(id))return window.api.plugins(global?'enable-global':'enable',{project,id,enabled});
 const state=useAppStore.getState(),old=state.settings?.builtinPluginActivation??{};
 const mode:'inherit'|'enabled'|'disabled'=enabled===null?'inherit':enabled?'enabled':'disabled';
 const next=global?{...old,global:{...old.global,[id]:!!enabled}}:{...old,projects:{...old.projects,[project]:{...old.projects?.[project],[id]:mode}}};
 return state.saveSettings({builtinPluginActivation:next});
}
const usePlugins=create<{snapshot:PluginSnapshot|null;project:string;error:string}>()(()=>({snapshot:null,project:'',error:''}));
let announcedProject='';
const snapshotRevisions=new Map<string,number>();
const snapshotSubscribers=new Map<string,{count:number;close:()=>void}>();
function subscribeSnapshot(project:string){
 let subscription=snapshotSubscribers.get(project);
 if(!subscription){subscription={count:0,close:window.api.onPluginsChanged(()=>void refresh(project))};snapshotSubscribers.set(project,subscription);void refresh(project);}
 subscription.count++;
 return ()=>{if(--subscription!.count===0){subscription!.close();snapshotSubscribers.delete(project);}};
}
async function refresh(project:string){const revision=(snapshotRevisions.get(project)??0)+1;snapshotRevisions.set(project,revision);try{const snapshot=await window.api.plugins('snapshot',{project});if(snapshotRevisions.get(project)===revision&&(useAppStore.getState().currentProject?.path??'')===project){usePlugins.setState({snapshot,project,error:''});if(announcedProject!==project){announcedProject=project;void window.api.plugins('workspace-opened',{project}).catch(()=>{});}}}catch(e:any){if(snapshotRevisions.get(project)===revision&&(useAppStore.getState().currentProject?.path??'')===project)usePlugins.setState({error:e.message});}}
export function usePluginSnapshot(){const project=useAppStore(s=>s.currentProject?.path??'');const state=usePlugins();useEffect(()=>subscribeSnapshot(project),[project]);const settings=useAppStore(s=>s.settings),currentProject=useAppStore(s=>s.currentProject);const effective=enabledBuiltins(settings,currentProject);const installed=state.project===project?state.snapshot:null;
 const locale=resolveLanguage(settings?.language,settings?._systemLocale);
 useEffect(()=>{if(!installed)return;useAppStore.setState(state=>{let changed=false;const openTabs=state.openTabs.map(tab=>{if(tab.kind!=='plugin')return tab;const manifest=installed.plugins.find(p=>p.manifest.id===tab.data.plugin)?.manifest;if(!manifest)return tab;const title=localizePluginManifest(manifest,locale).contributes.find(c=>c.id===tab.data.contribution)?.title;if(!title||title===tab.data.title)return tab;changed=true;return {...tab,data:{...tab.data,title}};});return changed?{openTabs}:state;});},[installed,locale]);
const builtins:PluginInfo[]=installedBuiltins(settings).map(p=>{const english=resolveLanguage(settings?.language,settings?._systemLocale)==='en';const fields=builtinPluginSettings[p.id]??{};return {manifest:{format:1,id:p.id,name:english?p.name:p.nameZh,version:'1.0.0',sdk:'1.0.0',entry:'plugin.js',category:p.category,scope:'both',description:resolveLanguage(settings?.language,settings?._systemLocale)==='en'?p.en:p.zh,permissions:[],dependencies:{},optionalDependencies:{},hostDependencies:{},services:{},consumes:[],skills:[],hooks:[],contributes:[],settings:Object.fromEntries(Object.entries(fields).map(([key,f])=>[key,{title:english?f.en:f.zh,description:english?f.descriptionEn:f.descriptionZh,type:f.type,scope:f.scope,default:f.default,visible:true}]))},digest:'builtin',enabled:effective.includes(p.id),globalEnabled:isRequiredBuiltin(p.id)||!!settings?.builtinPluginActivation?.global?.[p.id],projectMode:builtinMode(settings,currentProject,p.id)};});
 return {project,snapshot:installed?{...installed,plugins:[...builtins,...installed.plugins.map(p=>({...p,manifest:localizePluginManifest(p.manifest,resolveLanguage(settings?.language,settings?._systemLocale))}))]}:null,error:state.error};}
function openView(plugin:string,contribution:string,title:string){const id=`plugin:${plugin}:${contribution}`;useAppStore.setState(s=>({openTabs:s.openTabs.some(t=>t.id===id)?s.openTabs:appendTab(s.openTabs, {id,kind:'plugin',data:{plugin,contribution,title}}, s.activeTabId),activeTabId:id}));const state=useAppStore.getState();if(state.currentProject)saveTabsToStorage(state.currentProject.path,state.openTabs,id);}
function CopyButton({text,t}:{text:string;t:(zh:string,en:string)=>string}){const [copied,setCopied]=useState(false);const copy=async()=>{try{if(!await copyMarkdown(text))throw new Error('Clipboard unavailable');setCopied(true);window.setTimeout(()=>setCopied(false),1400);}catch{setCopied(false);}};return <button type="button" className="plugin-copy-button" onClick={()=>void copy()}>{copied?t('已复制','Copied'):t('复制','Copy')}</button>;}
function PluginErrorNotice({error,t}:{error:string;t:(zh:string,en:string)=>string}){const display=formatConversationError(error);return <div className="plugin-error-notice" role="alert"><div className="plugin-error-summary"><strong>{t('操作未完成','Operation could not be completed')}</strong><span>{display.summary}</span></div>{display.detail&&<details><summary>{t('查看技术详情','Technical details')}</summary><pre>{display.detail}</pre></details>}</div>;}
export function PluginSlot({slot,context}:{slot:string;context?:Record<string,string>}){
 const {project,snapshot}=usePluginSnapshot();const [error,setError]=useState(''),[busy,setBusy]=useState(''),[done,setDone]=useState('');
 const running=useRef(false),generation=useRef(0);const en=useAppStore(s=>resolveLanguage(s.settings?.language,s.settings?._systemLocale)==='en');
 useEffect(()=>{generation.current++;setError('');setDone('');return()=>{generation.current++;};},[project,slot,JSON.stringify(context)]);
 const entries=(snapshot?.plugins??[]).filter(p=>p.enabled).flatMap(p=>p.manifest.contributes.filter(c=>c.visible!==false&&c.slot===slot&&(c.when==='always'||project)).map(c=>({p,c}))).sort((a,b)=>a.c.order-b.c.order||`${a.p.manifest.id}.${a.c.id}`.localeCompare(`${b.p.manifest.id}.${b.c.id}`));
 if(!entries.length)return null;
 const execute=async(p:PluginInfo,c:PluginManifest['contributes'][number])=>{
   if(running.current)return;
   if(c.view){openView(p.manifest.id,c.id,c.title);return;}
   running.current=true;const id=`${p.manifest.id}.${c.id}`,current=generation.current;setBusy(id);setError('');setDone('');
   try{await window.api.plugins('call',{project,call:{plugin:p.manifest.id,service:c.service,method:c.method,args:context?{context}:{}}});if(current===generation.current)setDone(en?'Completed':'已完成');}
   catch(error){if(current===generation.current)setError(String((error as Error).message??error));}
   finally{running.current=false;setBusy('');}
 };
 return <div className="plugin-slot" data-plugin-slot={slot}>{entries.map(({p,c})=><button type="button" key={`${p.manifest.id}.${c.id}`} className="btn-ghost" title={p.manifest.name} disabled={!!busy} aria-busy={busy===`${p.manifest.id}.${c.id}`} onClick={()=>void execute(p,c)}>{c.title}{c.badge&&<span className="plugin-badge">{c.badge}</span>}</button>)}{error&&<small role="alert">{error}</small>}{done&&<small className="plugin-slot-status" role="status">{done}</small>}</div>;
}
export function PluginView({plugin,contribution,onClose}:{plugin:string;contribution:string;onClose?:()=>void}){
 const locale=useAppStore(s=>resolveLanguage(s.settings?.language,s.settings?._systemLocale));
 const {project,snapshot}=usePluginSnapshot(),frame=useRef<HTMLIFrameElement>(null);const [html,setHtml]=useState(''),[error,setError]=useState('');const p=snapshot?.plugins.find(p=>p.manifest.id===plugin),digest=p?.digest;
 const sendColors=useCallback(()=>{
  if(!p)return;
  const style=window.getComputedStyle(document.documentElement);
  const mode=document.documentElement.dataset.theme==='dark'?'dark':'light';
  const colors=Object.fromEntries(collectPluginColorGroups([p]).flatMap(group=>group.tokens.map(token=>[token.varName,style.getPropertyValue(token.varName).trim()||token.defaults[mode]])));
  frame.current?.contentWindow?.postMessage({type:'sage:colors',mode,colors},'*');
 },[p?.digest,plugin]);
 useEffect(()=>{sendColors();window.addEventListener(THEME_CHANGE_EVENT,sendColors);return()=>window.removeEventListener(THEME_CHANGE_EVENT,sendColors);},[sendColors,html]);
 useEffect(()=>{let alive=true;setHtml('');setError('');if(p?.enabled)void window.api.plugins('view',{project,id:plugin,contribution}).then(v=>{if(alive)setHtml(v);}).catch((e:any)=>{if(alive)setError(e.message);});return()=>{alive=false;};},[project,plugin,contribution,digest,p?.enabled]);
 useEffect(()=>{let alive=true;const handler=async(event:MessageEvent)=>{if(event.source!==frame.current?.contentWindow)return;if(event.data?.type==='sage:workflow'){
 const {id,request}=event.data;if(typeof id!=='string'||id.length>100)return;
 try{if(request?.action==='openView'){await window.api.plugins('workflow-authorize',{project,id:plugin});const view=request.args?.[0];if(plugin!=='sage.specs'||!['new','analyze','timeline'].includes(view))throw Error('Unsupported workflow view');openView(plugin,view,p?.manifest.contributes?.find(c=>c.id===view)?.title||view);frame.current?.contentWindow?.postMessage({type:'sage:workflow-result',id,value:true},'*');return;}const value=request?.action==='closeView'?(await window.api.plugins('workflow-authorize',{project,id:plugin}),(onClose?onClose():useAppStore.getState().closeTab(`plugin:${plugin}:${contribution}`)),true):await workflowRequest(project,plugin,request);if(alive)frame.current?.contentWindow?.postMessage({type:'sage:workflow-result',id,value},'*');}
 catch(e:any){if(alive)frame.current?.contentWindow?.postMessage({type:'sage:workflow-result',id,error:e.message},'*');}return;
 }if(event.data?.type==='sage:dirty'){useAppStore.setState(s=>({openTabs:s.openTabs.map(t=>t.kind==='plugin'&&t.data.plugin===plugin&&t.data.contribution===contribution?{...t,data:{...t.data,dirty:!!event.data.value}}:t)}));return;}if(event.data?.type!=='sage:call')return;const {id,service,method,args}=event.data;if(typeof id!=='string'||id.length>100)return;try{const value=await window.api.plugins('call',{project,call:{plugin,service,method,args}});if(alive)frame.current?.contentWindow?.postMessage({type:'sage:result',id,value},'*');}catch(e:any){if(alive)frame.current?.contentWindow?.postMessage({type:'sage:result',id,error:e.message},'*');}};window.addEventListener('message',handler);return()=>{alive=false;window.removeEventListener('message',handler);};},[project,plugin,contribution,digest,onClose]);
 const srcDoc=useMemo(()=>{const bridge=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>body{font:14px system-ui;padding:16px;color:#252537}button,input{padding:8px;margin:4px}pre{white-space:pre-wrap}</style><script>const translation=(${createPluginI18n.toString()})(${JSON.stringify(p?.manifest.i18n??null).replace(/</g,'\\u003c')},${JSON.stringify(locale)});addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='sage:locale'&&['zh','en'].includes(e.data.locale))translation.setLocale(e.data.locale)});addEventListener('message',e=>{if(e.source!==parent||e.data?.type!=='sage:colors')return;document.documentElement.dataset.theme=e.data.mode==='dark'?'dark':'light';for(const [name,value] of Object.entries(e.data.colors||{})){if(/^--sage-plugin-[a-zA-Z0-9_-]+$/.test(name)&&typeof value==='string'&&/^(#[0-9a-fA-F]{3,8}|rgba?\\([\\d\\s.,%]+\\))$/.test(value))document.documentElement.style.setProperty(name,value)}});const pending=new Map();window.sage=Object.freeze({i18n:translation.api,setDirty:value=>parent.postMessage({type:'sage:dirty',value:!!value},'*'),call:(service,method,args={})=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(Error('Call timed out'))},${p?.development?301000:31000});pending.set(id,{resolve,reject,timer});parent.postMessage({type:'sage:call',id,service,method,args},'*')})});addEventListener('message',e=>{if(e.source!==parent||e.data?.type!=='sage:result')return;const p=pending.get(e.data.id);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.id);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.value)});</script>`;
 return bridge+html;},[html,digest,p?.development]);
 useEffect(()=>{frame.current?.contentWindow?.postMessage({type:'sage:locale',locale},'*');},[locale,html]);
 if(!p?.enabled)return <div className="plugin-placeholder">插件已停用或未安装。重新启用后可恢复此视图。 / Plugin unavailable.</div>;
 if(error)return <p role="alert">{error}</p>;
 return <iframe onLoad={()=>{frame.current?.contentWindow?.postMessage({type:'sage:locale',locale},'*');sendColors();}} key={digest} ref={frame} title={p.manifest.name} className="plugin-frame" sandbox="allow-scripts" srcDoc={srcDoc}/>;
}
function PluginSettings({plugin,project}:{plugin:PluginInfo;project:string}){
 const english=useAppStore(s=>resolveLanguage(s.settings?.language,s.settings?._systemLocale)==='en'),builtin=isBuiltin(plugin.manifest.id);
 const [values,setValues]=useState<Record<string,any>>({}),[error,setError]=useState('');
 const detectionScope=useMemo(()=>({project,id:plugin.manifest.id}),[project,plugin.manifest.id,plugin.manifest.engine,plugin.enabled,plugin.digest]);
 const [detectionState,setDetectionState]=useState<{scope:typeof detectionScope;loading:boolean;value:any}|null>(null),[detectionRevision,setDetectionRevision]=useState(0);
 const detectionGeneration=useRef(0),detection=detectionState?.scope===detectionScope?detectionState.value:null;
 const detecting=!!plugin.enabled&&(detectionState?.scope!==detectionScope||!!detectionState.loading);
 const invalidateDetection=()=>{detectionGeneration.current++;setDetectionState({scope:detectionScope,loading:true,value:null});};
 type EditContext={live:boolean;focused:Set<string>;dirty:Set<string>;edits:Map<string,number>;requests:Map<string,number>;reload:(keys:string[])=>Promise<void>};
 const editing=useRef<EditContext>({live:false,focused:new Set(),dirty:new Set(),edits:new Map(),requests:new Map(),reload:async()=>{}});
 useEffect(()=>{
  const context:EditContext={live:true,focused:new Set(),dirty:new Set(),edits:new Map(),requests:new Map(),reload:async()=>{}};
  editing.current=context;setValues({});setError('');
  const keys=Object.keys(plugin.manifest.settings).filter(key=>{const field=plugin.manifest.settings[key];return field.visible!==false&&key!=='activeRun'&&(project||field.scope==='global'||field.scope==='both')&&!(builtin&&field.scope==='project');});
  context.reload=async selected=>{
   const versions=new Map(selected.map(key=>{const request=(context.requests.get(key)??0)+1;context.requests.set(key,request);return [key,{request,edit:context.edits.get(key)??0}];}));
   try{
    const entries=await Promise.all(selected.map(async key=>[key,await window.api.plugins('setting',{project,id:plugin.manifest.id,key,layer:builtin?'global':undefined})] as const));
    if(!context.live||editing.current!==context)return;
    setValues(previous=>{const next={...previous};for(const [key,value] of entries){const version=versions.get(key)!;if(context.requests.get(key)===version.request&&(context.edits.get(key)??0)===version.edit&&!context.focused.has(key)&&!context.dirty.has(key))next[key]=value;}return next;});
   }catch(err:any){if(context.live&&editing.current===context&&!context.dirty.size)setError(err.message);}
  };
  void context.reload(keys);
  const off=window.api.onMobileManagementChanged?.(event=>{
   if(!context.live||editing.current!==context)return;
   if(event.section!=='plugins'||event.itemId!==plugin.manifest.id||(event.projectPath!==undefined&&event.projectPath!==project))return;
   const changed=keys.filter(key=>{const field=plugin.manifest.settings[key];return builtin?event.projectPath===undefined:event.projectPath===undefined?(field.scope==='global'||field.scope==='both'||!project):field.scope!=='global';});
   if(changed.length)void context.reload(changed);
   if(plugin.manifest.engine&&changed.includes('binaryPath')){invalidateDetection();setDetectionRevision(value=>value+1);}
  });
  return()=>{context.live=false;off?.();};
 },[project,plugin.manifest.id,plugin.digest,builtin]);
 const commit=(key:string,value:unknown)=>{
  const context=editing.current,version=(context.edits.get(key)??0)+1;context.edits.set(key,version);context.dirty.add(key);
  if(plugin.manifest.engine&&key==='binaryPath')invalidateDetection();
  setValues(previous=>({...previous,[key]:value}));
  void window.api.plugins('setting',{project,id:plugin.manifest.id,key,value,layer:builtin?'global':undefined}).then(()=>{
   if(!context.live||editing.current!==context||context.edits.get(key)!==version)return;
   context.dirty.delete(key);setError('');if(!context.focused.has(key))void context.reload([key]);
   if(plugin.manifest.engine&&key==='binaryPath')setDetectionRevision(value=>value+1);
  }).catch((err:any)=>{if(context.live&&editing.current===context&&context.edits.get(key)===version){setError(err.message);if(plugin.manifest.engine&&key==='binaryPath')setDetectionState({scope:detectionScope,loading:false,value:{available:false,error:err.message}});}});
 };
 useEffect(()=>{
  if(!plugin.manifest.engine||!plugin.enabled||editing.current.dirty.has('binaryPath'))return;
  const ticket=++detectionGeneration.current;let alive=true;setDetectionState({scope:detectionScope,loading:true,value:null});
  window.api.plugins('engine-detect',{project,id:plugin.manifest.id}).then(value=>{if(alive&&ticket===detectionGeneration.current)setDetectionState({scope:detectionScope,loading:false,value});}).catch((err:any)=>{if(alive&&ticket===detectionGeneration.current)setDetectionState({scope:detectionScope,loading:false,value:{available:false,error:err?.message||String(err)}});});
  return()=>{alive=false;};
 },[detectionScope,detectionRevision]);
 return <div className="plugin-fields">{plugin.manifest.engine&&<><p className={`plugin-engine-detection ${detection?.available?'ok':detection?'error':''}`} role="status"><span className="relay-status-dot"/>{detecting?(english?'Detecting CLI…':'正在识别 CLI…'):detection?.available?(english?`Detected: ${detection.path||'available'}${detection.version?' · '+detection.version:''}`:`已识别：${detection.path||'可用'}${detection.version?' · '+detection.version:''}`):(english?`CLI unavailable${detection?.error?': '+detection.error:''}`:`未识别到 CLI${detection?.error?'：'+detection.error:''}`)}</p></>}{Object.entries(plugin.manifest.settings).filter(([key,f])=>f.visible!==false&&key!=='activeRun'&&(project||f.scope==='global'||f.scope==='both')&&!(builtin&&f.scope==='project')).map(([key,f])=>{const secret=f.type==='secret',saved=values[key]==='〔受保护：仅系统可用〕';return <label key={key}><span className="plugin-field-label">{f.title}{f.description&&<small>{f.description}</small>}</span><input placeholder={secret?(saved?(english?'Saved securely; enter a new value to replace':'已加密保存；输入新值可替换'):english?'Enter secret':'输入密钥'):key==='binaryPath'?(english?'Auto-detect (leave blank)':'自动识别（留空）'):f.placeholder} aria-label={f.title} title={f.description} type={f.type==='boolean'?'checkbox':secret?'password':f.type==='number'?'number':'text'} autoComplete={secret?'new-password':undefined} checked={f.type==='boolean'?!!values[key]:undefined} value={f.type==='boolean'||secret?undefined:values[key]??''} onFocus={()=>editing.current.focused.add(key)} onBlur={()=>{const context=editing.current;context.focused.delete(key);if(!context.dirty.has(key))void context.reload([key]);}} onChange={e=>{const value=f.type==='boolean'?e.target.checked:f.type==='number'?Number(e.target.value):e.target.value;if(secret&&!value)return;commit(key,value);}}/></label>;})}{error&&<p role="alert">{error}</p>}</div>;
}


export function PluginWorkbench({onConfigure,kind='plugin'}:{onConfigure?:(id:string)=>void;kind?:'plugin'|'skill'}){
 const skills=kind==='skill';
 const {project,snapshot,error:loadError}=usePluginSnapshot();const currentProject=useAppStore(s=>s.currentProject);const settings=useAppStore(s=>s.settings);const english=useAppStore(s=>resolveLanguage(s.settings?.language,s.settings?._systemLocale)==='en');const t=(zh:string,en:string)=>english?en:zh;
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[plan,setPlan]=useState<any>(null),[selected,setSelected]=useState(''),[method,setMethod]=useState(''),[args,setArgs]=useState('{}'),[result,setResult]=useState(''),[history,setHistory]=useState<string[]>([]),[historyPreview,setHistoryPreview]=useState<any>(null),[marketPlugins,setMarketPlugins]=useState<any[]|null>(null),[marketFilter,setMarketFilter]=useState(''),[marketCategory,setMarketCategory]=useState('all');
 useEffect(()=>{const closeMenus=(event:MouseEvent)=>{const target=event.target as Node|null;document.querySelectorAll<HTMLDetailsElement>('details.plugin-row-more[open]').forEach(menu=>{if(target&&!menu.contains(target))menu.open=false;});};const closeOnEscape=(event:KeyboardEvent)=>{if(event.key!=='Escape')return;document.querySelectorAll<HTMLDetailsElement>('details.plugin-row-more[open]').forEach(menu=>{menu.open=false;});};document.addEventListener('click',closeMenus,true);document.addEventListener('keydown',closeOnEscape);return()=>{document.removeEventListener('click',closeMenus,true);document.removeEventListener('keydown',closeOnEscape);};},[]);
 const run=async(f:()=>Promise<any>)=>{setBusy(true);setError('');try{const result=await f();await refresh(project);return result;}catch(e:any){setError(e.message);}finally{setBusy(false);}};
 const builtinSettings=settings;
 const [filter,setFilter]=useState(''),[category,setCategory]=useState('all'),[status,setStatus]=useState('all');
 const [marketConfigured,setMarketConfigured]=useState(false);
 useEffect(()=>{
  let live=true, generation=0;
  const check=async()=>{const ticket=++generation;if(!settings?.relayToken?.trim()||!settings?.relayUrl?.trim()){setMarketConfigured(false);return;}try{const r=await window.api.plugins('market-availability');if(live&&ticket===generation)setMarketConfigured(!!r?.ok);}catch{if(live&&ticket===generation)setMarketConfigured(false);}};
  setMarketConfigured(false);
  if(settings?.relayToken?.trim()&&settings?.relayUrl?.trim())void check();
  const off=window.api.onRelayStatus?.(e=>{generation++;setMarketConfigured(false);if(e.status==='connected')void check();});
  const timer=window.setInterval(()=>void check(),15000);
  return()=>{live=false;off?.();clearInterval(timer);};
 },[settings?.relayToken,settings?.relayUrl]);
 const marketCategoryOf=(p:any)=>categories[p.category as keyof typeof categories]?p.category:'other';
 const managedPlugins=snapshot?.plugins.filter(p=>p.manifest.scope!=='project'&&(!skills||p.manifest.skills.length>0))??[];
 const visibleMarketPlugins=(marketPlugins??[]).filter(p=>(marketCategory==='all'||marketCategoryOf(p)===marketCategory)&&[p.id,p.name,p.description,p.category].join(' ').toLocaleLowerCase().includes(marketFilter.trim().toLocaleLowerCase()));
 const visiblePlugins=managedPlugins.filter(p=>p.manifest.scope!=='project'&&(category==='all'||categoryOf(p)===category)&&(status==='all'||(status==='enabled'?p.enabled:!p.enabled))&&[p.manifest.name,p.manifest.id,p.manifest.description].join(' ').toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))??[];
 const pendingBuiltins=(skills?[]:builtinPlugins).filter(p=>!installedBuiltins(builtinSettings).some(i=>i.id===p.id));
 const chosen=snapshot?.plugins.find(p=>p.manifest.id===selected);
 const methods=chosen?Object.entries(chosen.manifest.services).flatMap(([s,v])=>Object.keys(v.methods).map(m=>`${s}/${m}`)):[];
 return <section className="plugin-workbench">
 <div className="plugin-workbench-heading"><p>{t('全局启用后，所有项目默认继承；项目可单独关闭。','Global activation applies to all projects; projects can override it.')}</p><div className="plugin-actions">{[[undefined,t('使用与开发手册','User & developer manual')],['EXTENSION_COOKBOOK.md',t('场景二开手册','Extension cookbook')],...(!skills?[['PLUGIN_EXTENSION_CATALOG.md',t('扩展点清单','Extension catalog')]]:[])].map(([name,label])=><button key={name??'manual'} disabled={busy} onClick={()=>void run(async()=>{const sourceTabId=useAppStore.getState().activeTabId;const doc=await window.api.plugins('manual',{name});const id=name?'file:sage-plugin-manual:'+name:'file:sage-plugin-manual';useAppStore.setState(s=>({openTabs:s.openTabs.some(tab=>tab.id===id)?s.openTabs:appendTab(s.openTabs, {kind:'file',id,data:{source:'virtual',relPath:doc.name,content:doc.content,originalContent:doc.content,binary:false,size:new TextEncoder().encode(doc.content).length,view:'preview',readOnly:true}}, sourceTabId),activeTabId:id}));})}>{label}</button>)}</div></div>
 <div className="plugin-management-grid">
 <section className="plugin-management-section" aria-labelledby="plugin-install-title"><h3 id="plugin-install-title">{t(skills?'技能安装':'插件安装',skills?'Install skills':'Install plugins')}</h3><div className="plugin-actions"><button disabled={busy} onClick={()=>void run(async()=>setPlan(await window.api.plugins('preview',{project,kind:skills?'skill':undefined})))}>{t(skills?'离线安装技能包':'离线安装插件包',skills?'Install offline skill package':'Install offline package')}</button>{marketConfigured&&<button disabled={busy} onClick={()=>void run(async()=>{const response=await window.api.plugins('market-list',{project,kind:skills?'skill':undefined});if(!response?.ok)throw Error(response?.error||t('插件市场暂不可用','Plugin marketplace is unavailable'));setMarketPlugins(Array.isArray(response.plugins)?response.plugins.filter((p:any)=>!skills||p.artifactType==='skill'||p.skillCount>0||p.manifest?.skills?.length):[]);})}>{t('在线安装','Install online')}</button>}</div>{marketConfigured&&marketPlugins!==null&&<div className="plugin-market-browser"><div className="plugin-market-browser-head"><strong>{t(skills?'在线技能':'在线插件',skills?'Online skills':'Online plugins')}</strong><button type="button" className="settings-inline-link" onClick={()=>setMarketPlugins(null)}>{t('关闭','Close')}</button></div><input type="search" value={marketFilter} onChange={e=>setMarketFilter(e.target.value)} placeholder={t(skills?'搜索技能…':'搜索插件…',skills?'Search skills…':'Search plugins…')} aria-label={t(skills?'搜索在线技能':'搜索在线插件',skills?'Search online skills':'Search online plugins')}/><select aria-label={t('插件分类','Plugin category')} value={marketCategory} onChange={e=>setMarketCategory(e.target.value)}><option value="all">{t('全部分类','All categories')}</option>{Object.entries(categories).filter(([id])=>!skills||id!=='engine').map(([id,labels])=><option key={id} value={id}>{labels[english?1:0]}</option>)}</select>{!visibleMarketPlugins.length?<p className="muted small">{t(skills?'没有可安装的技能。':'没有可安装的插件。',skills?'No skills available.':'No plugins available.')}</p>:<div className="plugin-market-list">{visibleMarketPlugins.map(p=><article key={p.id} className="plugin-market-item"><div><strong>{p.name||p.id}</strong><span className="muted small">{p.id} · v{p.latestVersion||'?'} · {categories[marketCategoryOf(p) as keyof typeof categories][english?1:0]}</span><p>{p.description||t('暂无描述','No description')}</p></div><button disabled={busy||!p.id} onClick={()=>void run(async()=>setPlan(await window.api.plugins('market-preview',{project,kind:skills?'skill':undefined,id:p.id,version:p.latestVersion})))}>{t('预览安装','Preview install')}</button></article>)}</div>}</div>}{pendingBuiltins.length>0&&<div className="plugin-preinstalled"><strong>{t('预置但未安装','Preinstalled but not installed')}</strong><p className="muted small">{t('这些插件随 Sage 提供，按需安装后才会出现在已安装列表。','These plugins ship with Sage and appear in the installed list after you install them.')}</p><div className="plugin-actions">{pendingBuiltins.map(p=><button key={p.id} disabled={busy} onClick={()=>void run(async()=>{const state=useAppStore.getState(),old=state.settings?.builtinPluginActivation??{};await state.saveSettings({builtinPluginActivation:{...old,installed:[...new Set([...(old.installed??[]),p.id])]}});})}>{t('安装','Install')} {p.name}</button>)}</div></div>}</section>
 </div>
 <section className="plugin-management-section" aria-labelledby="plugin-development-title"><h3 id="plugin-development-title">{t('开发与调试','Development & debugging')}</h3><p>{t(skills?'创建技能工程，或加载源码目录进行调试。':'创建插件工程，或加载源码目录进行调试。',skills?'Create a skill project or load source code for debugging.':'Create a plugin project or load source code for debugging.')}</p><div className="plugin-project-context"><span>{t('测试项目','Test project')}</span><span title={project}>{project||t('请先打开一个项目','Open a project first')}</span></div><div className="plugin-actions"><button disabled={busy} onClick={()=>void run(async()=>{const r=await window.api.plugins('scaffold',{project,kind:skills?'skill':undefined});if(r)setResult(t('工程已生成：','Project created: ')+r.directory);})}>{t(skills?'创建技能工程':'创建插件工程',skills?'Create skill project':'Create plugin project')}</button>{!skills&&<button disabled={busy} onClick={()=>void run(async()=>{const r=await window.api.plugins('scaffold',{kind:'engine'});if(r)setResult(r.directory);})}>{t('创建 CLI 引擎插件','Create CLI engine plugin')}</button>}<button disabled={busy||!project} onClick={()=>void run(()=>window.api.plugins('develop',{project}))}>{t('加载开发目录','Load development folder')}</button></div></section>
 {snapshot?.recoveryError&&<p role="alert">{snapshot.recoveryError}</p>}
 {(error||loadError)&&<PluginErrorNotice error={error||loadError} t={t}/>}
 {plan&&<div className="plugin-plan"><div className="plugin-copy-row"><h4>{t('安装计划：请核对来源、依赖和权限','Installation plan: review source, dependencies and permissions')}</h4><CopyButton text={JSON.stringify(plan,null,2)} t={t}/></div><p>{t('校验和用于检测损坏，不证明发布者可信。','Checksums detect corruption, not publisher trust.')}</p>{plan.changes.map((x:any)=><div key={x.id}><strong>{x.name} · {x.id}</strong><p>{x.from??'—'} → {x.to}</p>{x.permissions.includes('engine.native')&&<p role="note">{t('本机引擎权限：此插件可执行本机代码与启动 CLI，可访问本机文件及网络。仅安装你信任的来源。','Native engine permission: this plugin can execute local code, launch a CLI, and access files and the network. Install only trusted sources.')}</p>}{(x.dependencies&&Object.keys(x.dependencies).length>0)&&<p role="note">{t(`插件依赖：${Object.entries(x.dependencies).map(([id,range])=>`${id}@${range}`).join('、')}；安装后仍需先启用依赖插件。`,`Plugin dependencies: ${Object.entries(x.dependencies).map(([id,range])=>`${id}@${range}`).join(', ')}; dependencies must be enabled before this plugin.`)}</p>}{(x.hostDependencies&&Object.keys(x.hostDependencies).length>0)&&<p role="note">{t(`宿主依赖：${Object.entries(x.hostDependencies).map(([id,range])=>`${id}@${range}`).join('、')}；启用前需安装并启用对应宿主模块。`,`Host dependencies: ${Object.entries(x.hostDependencies).map(([id,range])=>`${id}@${range}`).join(', ')}; install and enable these host integrations before enabling the plugin.`)}</p>}<code>{x.permissions.join(', ')||t('无额外权限','No extra permissions')}</code><small>{x.digest}</small></div>)}<p>{plan.order.join(' → ')}</p><button disabled={busy} onClick={()=>void run(async()=>{await window.api.plugins('install',{project,ticket:plan.ticket});setPlan(null);})}>{t('授权并安装','Grant and install')}</button><button onClick={()=>setPlan(null)}>{t('取消','Cancel')}</button></div>}
 <section className="plugin-installed-section" aria-labelledby="plugin-installed-title"><div className="plugin-section-heading"><h3 id="plugin-installed-title">{t(skills?'已安装技能':'已安装插件',skills?'Installed skills':'Installed plugins')} <span className="muted small">{managedPlugins.length}</span></h3><button disabled={busy} onClick={()=>void refresh(project)}>{t('刷新','Refresh')}</button></div>{snapshot&&!managedPlugins.length&&<p className="plugin-empty">{t(skills?'尚未安装技能，可从上方导入或选择安装。':'尚未安装插件，可从上方导入或选择安装。',skills?'No skills installed. Import or install one above.':'No plugins installed. Import or install one above.')}</p>}
 <div className="plugin-list-toolbar"><input className="plugin-list-search" type="search" aria-label={t(skills?'搜索技能':'搜索插件',skills?'Search skills':'Search plugins')} placeholder={t(skills?'搜索技能名称或描述…':'搜索插件名称或描述…',skills?'Search skills…':'Search plugins…')} value={filter} onChange={e=>setFilter(e.target.value)}/>
 <select aria-label={t('插件分类','Plugin category')} value={category} onChange={e=>setCategory(e.target.value)}><option value="all">{t('全部分类','All categories')}</option>{Object.entries(categories).filter(([id])=>!skills||id!=='engine').map(([id,labels])=><option key={id} value={id}>{labels[english?1:0]}</option>)}</select><select aria-label={t('插件状态','Plugin status')} value={status} onChange={e=>setStatus(e.target.value)}><option value="all">{t('全部状态','All status')}</option><option value="enabled">{t('已启用','Enabled')}</option><option value="disabled">{t('已停用','Disabled')}</option></select></div>
 <div className="plugin-list">{!visiblePlugins.length&&<p className="plugin-empty">{t(skills?'没有匹配的技能':'没有匹配的插件',skills?'No matching skills':'No matching plugins')}</p>}{visiblePlugins.map(p=><article className="plugin-list-row" key={p.manifest.id}>
 <div className="plugin-list-info"><strong>{p.manifest.name}</strong>{isBuiltin(p.manifest.id)&&<BuiltInBadge/>}{!skills&&p.manifest.hooks.length>0&&<span className="plugin-badge">{t(`钩子 ×${p.manifest.hooks.length}`,`hooks ×${p.manifest.hooks.length}`)}</span>}<span className="muted small">{p.development?t('开发目录','Development'):t('本地/市场','Local / marketplace')} · {p.manifest.version} · {categories[categoryOf(p)][english?1:0]} · {p.manifest.engine||p.manifest.scope==='global'?t('全局','Global'):p.manifest.scope==='project'?t('项目','Project'):t('全局+项目','Global + project')}{p.development?' · DEV':''}</span><p>{p.manifest.description}</p><small className="muted">{p.manifest.id}</small>{skills&&<details className="plugin-skill-contents"><summary>{t('包含的技能','Included skills')} · {p.manifest.skills.length}</summary>{p.manifest.skills.map(skill=><p key={skill.name}><strong>{skill.name}</strong> · {skill.description}</p>)}</details>}</div>
 <div className="plugin-list-actions">{!isRequiredBuiltin(p.manifest.id)&&(()=>{const missing=activationDependencies(p,snapshot,settings,currentProject,'global');return <label className="plugin-global-toggle" title={missing.length?t(`需先满足依赖：${missing.join('、')}`,`Prerequisites: ${missing.join(', ')}`):undefined}><input type="checkbox" checked={!!p.globalEnabled} disabled={busy||!!p.development||(!p.globalEnabled&&missing.length>0)} onChange={e=>{const enabled=e.target.checked;void run(async()=>{if(!enabled&&p.manifest.engine&&useAppStore.getState().settings?.backendEngine===p.manifest.id)throw Error(t(`当前后端引擎正在使用“${p.manifest.name}”，请先切换后端引擎后再停用。`,`“${p.manifest.name}” is the current backend. Switch backends before disabling it.`));if(!enabled&&useAppStore.getState().openTabs.some(t=>t.kind==='plugin'&&t.data.plugin===p.manifest.id&&t.data.dirty))throw Error('请先保存插件视图 / Save plugin views first');return setActivation(project,p.manifest.id,enabled,true);});}}/>{t('全局启用','Enable globally')}{missing.length>0&&<small className="muted">{t(`需先启用：${missing.join('、')}`,`Enable first: ${missing.join(', ')}`)}</small>}</label>})()}
 {(Object.keys(p.manifest.settings).length>0||(!skills&&p.manifest.hooks.length>0))&&<button onClick={()=>onConfigure?.(p.manifest.id)}>{t('配置','Configure')}</button>}
 {!isRequiredBuiltin(p.manifest.id)&&<details className="plugin-row-more"><summary>{t('更多','More')}</summary><div className="plugin-row-menu">
 <button disabled={busy} onClick={()=>void run(()=>window.api.plugins(p.development?'dev-package':'export',{project,id:p.manifest.id}))}>{t('导出（含依赖）','Export with dependencies')}</button>
 <CopyButton text={JSON.stringify({manifest:p.manifest,digest:p.digest},null,2)} t={t}/>
 {p.development?<>{!skills&&<button onClick={()=>void run(()=>window.api.plugins('devtools',{project,id:p.manifest.id}))}>{t('打开调试器','Open debugger')}</button>}{marketConfigured&&<button onClick={()=>void run(()=>window.api.plugins('market-publish',{project,id:p.manifest.id}))}>{t(skills?'提交到技能市场':'提交到插件市场',skills?'Publish to skill marketplace':'Publish to marketplace')}</button>}<button onClick={()=>void run(()=>window.api.plugins('dev-stop',{project,id:p.manifest.id}))}>{t('停止开发','Stop development')}</button></>:<button disabled={busy||p.enabled||p.globalEnabled||(isBuiltin(p.manifest.id)&&['git','browser'].includes(p.manifest.id))} title={isBuiltin(p.manifest.id)&&['git','browser'].includes(p.manifest.id)?t('Git 和 Browser 是 Sage 宿主模块，不能卸载。','Git and Browser are Sage host integrations and cannot be uninstalled.'):undefined} onClick={()=>void run(async()=>{if(isBuiltin(p.manifest.id)){if(p.enabled||p.globalEnabled)throw Error(t('请先停用该预装插件再卸载。','Disable this preinstalled plugin before uninstalling it.'));const state=useAppStore.getState(),old=state.settings?.builtinPluginActivation??{};await state.saveSettings({builtinPluginActivation:{...old,installed:(old.installed??[]).filter(id=>id!==p.manifest.id)}});return;}await window.api.plugins('uninstall',{project,id:p.manifest.id});})}>{isBuiltin(p.manifest.id)?(['git','browser'].includes(p.manifest.id)?t('预装宿主不可卸载','Host integration'):t('卸载（保留数据）','Uninstall (keep data)')):t('卸载（保留数据）','Uninstall (keep data)')}</button>}
 {!skills&&Object.keys(p.manifest.services).length>0&&<button disabled={!p.enabled} onClick={()=>{setSelected(p.manifest.id);setMethod('');setResult('');}}>{t('调试服务','Test service')}</button>}
 <details><summary>{t(skills?'依赖与权限':'依赖与扩展点',skills?'Dependencies & permissions':'Dependencies & contributions')}</summary><div className="plugin-copy-row"><span className="muted small">{t(skills?'技能依赖与权限':'插件清单与扩展点',skills?'Skill dependencies and permissions':'Plugin dependencies and contributions')}</span><CopyButton text={JSON.stringify(skills?{dependencies:p.manifest.dependencies,hostDependencies:p.manifest.hostDependencies,permissions:p.granted??p.manifest.permissions}:{dependencies:p.manifest.dependencies,hostDependencies:p.manifest.hostDependencies,consumes:p.manifest.consumes,hooks:p.manifest.hooks,granted:p.granted,contributes:p.manifest.contributes},null,2)} t={t}/></div><pre>{JSON.stringify(skills?{dependencies:p.manifest.dependencies,hostDependencies:p.manifest.hostDependencies,permissions:p.granted??p.manifest.permissions}:{dependencies:p.manifest.dependencies,hostDependencies:p.manifest.hostDependencies,consumes:p.manifest.consumes,hooks:p.manifest.hooks,granted:p.granted,contributes:p.manifest.contributes},null,2)}</pre></details>
 </div></details>}</div></article>)}</div>
 </section>
 {!skills&&chosen&&<div className="plugin-plan"><div className="plugin-copy-row"><h4>{chosen.manifest.name} · {t('服务调试','Service tester')}</h4>{method&&<CopyButton text={JSON.stringify(chosen.manifest.services[method.split('/')[0]]?.methods[method.split('/')[1]],null,2)} t={t}/>}</div><select value={method} onChange={e=>setMethod(e.target.value)}><option value="">{t('选择方法','Select method')}</option>{methods.map(m=><option key={m}>{m}</option>)}</select><textarea aria-label="JSON arguments" rows={5} value={args} onChange={e=>setArgs(e.target.value)}/><button disabled={busy||!method} onClick={()=>void run(async()=>{const [service,name]=method.split('/');setResult(JSON.stringify(await window.api.plugins('call',{project,call:{plugin:selected,service,method:name,args:JSON.parse(args)}}),null,2));})}>{t('执行','Run')}</button><pre>{method&&JSON.stringify(chosen.manifest.services[method.split('/')[0]]?.methods[method.split('/')[1]],null,2)}</pre></div>}
 {result&&<div className="plugin-result-wrap"><div className="plugin-copy-row"><span className="muted small">{t(skills?'操作结果':'服务调用结果',skills?'Operation result':'Service call result')}</span><CopyButton text={result} t={t}/></div><pre className="plugin-result">{result}</pre></div>}
 {!skills&&<section className="plugin-management-section plugin-diagnostics" aria-labelledby="plugin-diagnostics-title"><h3 id="plugin-diagnostics-title">{t('维护与诊断','Maintenance & diagnostics')}</h3><p>{t('查看历史版本、调用记录及界面扩展状态。','Inspect registry history, calls and UI contributions.')}</p><div className="plugin-history"> <button disabled={busy} onClick={()=>void run(async()=>setHistory(await window.api.plugins('history',{project})))}>{t('插件历史版本','Registry history')}</button>
 {history.length>0&&<select aria-label="Registry history" defaultValue="" onChange={e=>{const name=e.target.value;if(name)void run(async()=>setHistoryPreview({name,...await window.api.plugins('history-preview',{project,name})}));}}><option value="">{t('选择历史版本以预览','Select a snapshot to preview')}</option>{history.map(h=><option key={h}>{h}</option>)}</select>}
 {historyPreview&&<div className="plugin-plan"><div className="plugin-copy-row"><span className="muted small">{t('历史版本预览','History snapshot preview')}</span><CopyButton text={JSON.stringify(historyPreview,null,2)} t={t}/></div><pre>{JSON.stringify(historyPreview,null,2)}</pre><button disabled={busy} onClick={()=>void run(async()=>{await window.api.plugins('history-restore',{project,name:historyPreview.name,revision:historyPreview.revision});setHistoryPreview(null);})}>{t('确认恢复插件与权限','Restore plugins and permissions')}</button></div>}
</div>
 <details><summary>{t('调用审计（最近 100 条）','Call audit (last 100)')}</summary><div className="plugin-copy-row"><span className="muted small">{t('最近的插件调用记录','Recent plugin calls')}</span><CopyButton text={JSON.stringify(snapshot?.logs,null,2)} t={t}/></div><pre>{JSON.stringify(snapshot?.logs,null,2)}</pre></details><details><summary>{t('界面插槽检查器','UI slot inspector')}</summary><div className="plugin-copy-row"><span className="muted small">{t('当前界面插槽状态','Current UI slot state')}</span><CopyButton text={snapshot?.slots.map(slot=>`${slot}: ${snapshot.plugins.filter(p=>p.enabled).flatMap(p=>p.manifest.contributes.filter(c=>c.slot===slot).map(c=>p.manifest.id+'/'+c.id)).join(', ')||'—'}`).join('\n')||''} t={t}/></div><pre>{snapshot?.slots.map(slot=>`${slot}: ${snapshot.plugins.filter(p=>p.enabled).flatMap(p=>p.manifest.contributes.filter(c=>c.slot===slot).map(c=>p.manifest.id+'/'+c.id)).join(', ')||'—'}`).join('\n')}</pre></details>
 </section>}
 {skills&&<section className="plugin-management-section plugin-skill-diagnostics"><h3>{t('技能内容检查','Skill content checks')}</h3>{managedPlugins.map(p=><div key={p.manifest.id}><strong>{p.manifest.name}</strong>{p.manifest.skills.map(skill=><p key={skill.name}><code>{skill.file}</code> · {skill.name} · {skill.description}</p>)}</div>)}</section>}
 {!skills&&<PluginSlot slot="settings"/>}
 </section>;
}
export function PluginNotifications(){
 const project=useAppStore(s=>s.currentProject?.path),scope=useMemo(()=>({project}),[project]);
 const current=useRef<typeof scope|null>(scope);current.current=scope;
 const [notice,setNotice]=useState<{scope:typeof scope;text:string}|null>(null);
 useEffect(()=>{current.current=scope;const off=window.api.onPluginNotification(v=>{
  if(current.current!==scope||v.project!==scope.project)return;
  if(v.open)openView(v.plugin,v.open.contribution,v.open.title);else setNotice({scope,text:`${v.plugin}: ${v.text}`});
 });return()=>{if(current.current===scope)current.current=null;off();};},[scope]);
 return notice?.scope===scope?<div className="plugin-toast" role="status">{notice.text}<button onClick={()=>setNotice(null)}>×</button></div>:null;
}

export function ProjectPluginActivation({skillsOnly=false}:{skillsOnly?:boolean}){
 const {project,snapshot,error}=usePluginSnapshot();
 const currentProject=useAppStore(s=>s.currentProject),settings=useAppStore(s=>s.settings);
 const english=useAppStore(s=>resolveLanguage(s.settings?.language,s.settings?._systemLocale)==='en'),t=(zh:string,en:string)=>english?en:zh;
 const scope=useMemo(()=>({project,running:false}),[project]);
 const current=useRef<typeof scope|null>(scope);current.current=scope;
 type PageState={scope:typeof scope;busy:boolean;failure:string;configured:string|null;debugging:string|null};
 const empty=():PageState=>({scope,busy:false,failure:'',configured:null,debugging:null});
 const [page,setPage]=useState<PageState>(empty);
 const {busy,failure,configured,debugging}=page.scope===scope?page:empty();
 const update=(patch:Partial<Omit<PageState,'scope'>>)=>{if(current.current===scope)setPage(previous=>({...((previous.scope===scope)?previous:empty()),...patch}));};
 const setConfigured=(configured:string|null)=>update({configured}),setDebugging=(debugging:string|null)=>update({debugging});
 useEffect(()=>{current.current=scope;return()=>{if(current.current===scope)current.current=null;};},[scope]);
 const manage=async(action:()=>Promise<unknown>)=>{
  if(scope.running)return;scope.running=true;update({busy:true,failure:''});
  try{await action();if(current.current===scope)await refresh(project);}catch(err:any){update({failure:err?.message||String(err)});}finally{scope.running=false;update({busy:false});}
 };
 const activate=(p:PluginInfo,enabled:boolean|null)=>manage(async()=>{
  if(enabled===false&&useAppStore.getState().openTabs.some(tab=>tab.kind==='plugin'&&tab.data.plugin===p.manifest.id&&tab.data.dirty))throw Error('请先保存插件视图 / Save plugin views first');
  await setActivation(project,p.manifest.id,enabled);
 });
 if(configured)return <PluginConfiguration pluginId={configured} skills={skillsOnly} onBack={()=>setConfigured(null)} backLabel={t(skillsOnly?'项目技能':'项目插件',skillsOnly?'Project skills':'Project plugins')}/>;
 const rows=snapshot?.plugins.filter(p=>p.manifest.scope!=='global'&&!p.manifest.engine&&(!skillsOnly||p.manifest.skills.length>0))??[];
 const debugPlugin=rows.find(p=>p.manifest.id===debugging);
 return <div className="settings-card settings-card-pad">
  <p className="muted small">{t('默认继承全局启用状态，可单独开启、关闭或恢复继承。','Projects inherit global activation. Override a plugin here, or restore inheritance.')}</p>
  {rows.map(p=>{
   const missing=activationDependencies(p,snapshot,settings,currentProject,'project'),inherited=p.projectMode!=='enabled'&&p.projectMode!=='disabled',checked=!!p.enabled;
   return <div key={project+'/'+p.manifest.id} className="plugin-project-row">
    <div>
     <strong>{p.manifest.name}</strong><span className="plugin-badge">{categories[categoryOf(p)][english?1:0]}</span>
     <p className="muted small">{isRequiredBuiltin(p.manifest.id)?t('始终启用','Always enabled'):inherited?t(`跟随全局 · ${checked?'开':'关'}`,`Following global · ${checked?'On':'Off'}`):t(checked?'当前项目已开启':'当前项目已关闭',checked?'Enabled for this project':'Disabled for this project')}{p.development?' · DEV':''}</p>
     {missing.length>0&&<p className="muted small" role="note">{t(`需先启用：${missing.join('、')}`,`Enable first: ${missing.join(', ')}`)}</p>}
     {Object.entries(builtinPluginSettings[p.manifest.id]??{}).filter(([,f])=>f.scope==='project'||f.scope==='both').map(([key,f])=>{
      const raw=builtinSettingValue(settings,project,p.manifest.id,key);
      const commit=(value:unknown)=>void manage(()=>window.api.plugins('setting',{project,id:p.manifest.id,key,value,layer:'project'}));
      return <label key={key} className="plugin-project-setting">
       {f.type==='boolean'?<input type="checkbox" checked={raw===true} disabled={busy||!!p.development} onChange={e=>commit(e.target.checked)}/>:f.type==='string'?<input type="text" className="plugin-project-text" defaultValue={typeof raw==='string'?raw:''} placeholder={String(f.default??'')} disabled={busy||!!p.development} onBlur={e=>{if(e.target.value!==(typeof raw==='string'?raw:''))commit(e.target.value);}}/>:<input type="number" className="plugin-project-number" value={typeof raw==='number'?raw:''} placeholder={String(f.default??'')} disabled={busy||!!p.development} onChange={e=>{if(e.target.value!=='')commit(Number(e.target.value));}}/>}
       <span>{english?f.en:f.zh}{(english?f.descriptionEn:f.descriptionZh)&&<small className="muted">{english?f.descriptionEn:f.descriptionZh}</small>}</span>
      </label>;
     })}
    </div>
    {!isRequiredBuiltin(p.manifest.id)&&<div className="plugin-project-actions">
     <label className="plugin-project-toggle" title={missing.length&&!checked?t(`需先满足依赖：${missing.join('、')}`,`Prerequisites: ${missing.join(', ')}`):undefined}>
      <input type="checkbox" aria-label={p.manifest.name} checked={checked} disabled={busy||!!p.development||(!checked&&missing.length>0)} onChange={e=>void activate(p,e.target.checked)}/>
      <span>{t('当前项目启用','Enable for this project')}</span>
     </label>
     {!inherited&&<button type="button" className="plugin-project-inherit" disabled={busy||!!p.development} onClick={()=>void activate(p,null)}>{t('跟随全局','Follow global')}</button>}
     {p.manifest.scope==='project'&&<details className="plugin-row-more"><summary>{t('更多','More')}</summary><div className="plugin-row-menu">
      {(Object.keys(p.manifest.settings).length>0||(!skillsOnly&&p.manifest.hooks.length>0))&&<button disabled={busy} onClick={()=>setConfigured(p.manifest.id)}>{t('配置','Configure')}</button>}
      <button disabled={busy} onClick={()=>void manage(()=>window.api.plugins(p.development?'dev-package':'export',{project,id:p.manifest.id}))}>{t('导出（含依赖）','Export with dependencies')}</button>
      {!skillsOnly&&Object.keys(p.manifest.services).length>0&&<button disabled={busy||!p.enabled} onClick={()=>setDebugging(p.manifest.id)}>{t('调试服务','Test service')}</button>}
      {p.development?<><button disabled={busy} onClick={()=>void manage(()=>window.api.plugins('devtools',{project,id:p.manifest.id}))}>{t('打开调试器','Open debugger')}</button><button disabled={busy} onClick={()=>void manage(()=>window.api.plugins('dev-stop',{project,id:p.manifest.id}))}>{t('停止开发','Stop development')}</button></>:<button disabled={busy||p.enabled||p.globalEnabled} onClick={()=>void manage(()=>window.api.plugins('uninstall',{project,id:p.manifest.id}))}>{t('卸载（保留数据）','Uninstall (keep data)')}</button>}
     </div></details>}
    </div>}
   </div>;
  })}
  {debugPlugin&&<ProjectPluginDebug key={project+'/'+debugPlugin.manifest.id} plugin={debugPlugin} project={project} onClose={()=>setDebugging(null)} t={t}/>}
  {(error||failure)&&<p role="alert">{error||failure}</p>}
 </div>;
}
function ProjectPluginDebug({plugin,project,onClose,t}:{plugin:PluginInfo;project:string;onClose:()=>void;t:(zh:string,en:string)=>string}){
 const [method,setMethod]=useState(''),[args,setArgs]=useState('{}'),[result,setResult]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0);useEffect(()=>()=>{generation.current++;},[]);
 const methods=Object.entries(plugin.manifest.services).flatMap(([service,value])=>Object.keys(value.methods).map(method=>`${service}/${method}`));
 const run=async()=>{const ticket=++generation.current;setBusy(true);setError('');setResult('');try{
  const [service,name]=method.split('/'),output=await window.api.plugins('call',{project,call:{plugin:plugin.manifest.id,service,method:name,args:JSON.parse(args)}});
  if(ticket===generation.current)setResult(JSON.stringify(output,null,2));
 }catch(err:any){if(ticket===generation.current)setError(err?.message||String(err));}finally{if(ticket===generation.current)setBusy(false);}};
 return <section className="plugin-test" aria-label={t('调试服务','Test service')}>
  <div className="plugin-section-heading"><strong>{plugin.manifest.name}</strong><button onClick={onClose}>{t('关闭','Close')}</button></div>
  <select aria-label={t('服务方法','Service method')} value={method} disabled={busy} onChange={e=>{setMethod(e.target.value);setResult('');setError('');}}><option value="">{t('选择服务方法','Select a service method')}</option>{methods.map(value=><option key={value}>{value}</option>)}</select>
  <textarea aria-label={t('调用参数','Call arguments')} value={args} disabled={busy} onChange={e=>setArgs(e.target.value)}/>
  <button disabled={busy||!plugin.enabled||!method} onClick={()=>void run()}>{t('执行','Run')}</button>
  {method&&<details><summary>{t('参数说明','Parameters')}</summary><pre>{JSON.stringify(plugin.manifest.services[method.split('/')[0]]?.methods[method.split('/')[1]],null,2)}</pre></details>}
  {result&&<div className="plugin-result-wrap"><CopyButton text={result} t={t}/><pre>{result}</pre></div>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
export function PluginConfiguration({pluginId,onBack,skills=false,backLabel}:{pluginId:string;onBack:()=>void;skills?:boolean;backLabel?:string}){
 const {project,snapshot,error}=usePluginSnapshot();const english=useAppStore(s=>resolveLanguage(s.settings?.language,s.settings?._systemLocale)==='en');const t=(zh:string,en:string)=>english?en:zh;const plugin=snapshot?.plugins.find(p=>p.manifest.id===pluginId);
 return <section className="plugin-workbench plugin-config-page"><div><button className="plugin-config-back" onClick={onBack}><ArrowLeft size={14}/> {backLabel??(skills?(english?'Skill list':'技能列表'):(english?'Plugin list':'插件列表'))}</button></div>{plugin?<section className="plugin-config-content">{!isBuiltin(plugin.manifest.id)&&Object.values(plugin.manifest.settings).some(f=>f.scope==='project')&&<p className="plugin-project-context">{project||(english?'Open a project to edit its settings.':'请打开项目以编辑项目配置。')}</p>}<PluginSettings plugin={plugin} project={project}/>{!skills&&<PluginHooksSummary plugin={plugin} t={t}/>}</section>:<p role="status">{error||(english?'Plugin unavailable':'插件未安装或正在加载')}</p>}</section>;
}

/**
 * 钩子订阅（插件类型之一）在插件详情的展示区：hooks 与外部命令钩子跑在同一条决策链上，
 * 但只有安装时授予了 hooks.respond 才会真的执行，所以这里把“声明 / 已授权”分开显示，
 * 避免用户看到插件列了钩子却没有任何效果。
 */
function PluginHooksSummary({plugin,t}:{plugin:PluginInfo;t:(zh:string,en:string)=>string}){
 const hooks=plugin.manifest.hooks;if(!hooks.length)return null;
 const granted=plugin.granted??plugin.manifest.permissions;
 const active=granted.includes(HOOK_PERMISSION);
 return <div className="plugin-hooks-summary">
  <h4>{t('钩子订阅','Hook subscriptions')}</h4>
  <p className="muted small">{t('与用户自写的外部命令钩子（设置 → 插件 → 插件包 → 钩子插槽）共用事件与决策合并规则：同一事件先跑完外部命令，再按 order 依次跑插件订阅。', 'Same events and decision-merge rules as user-authored command hooks (Settings → Plugins → Plugin packages → Hook slots): for one event the commands run first, then plugin subscriptions run in order.')}</p>
  {!active&&<p className="plugin-hooks-warning" role="note">⚠ {t(`本插件安装时未授予 ${HOOK_PERMISSION} 权限，以下订阅只展示、不会执行；重新安装或更新该插件并授权后才会参与决策。`, `This package was installed without the ${HOOK_PERMISSION} permission, so the subscriptions below are listed but never run. Reinstall or update the plugin and grant it to activate.`)}</p>}
  {hooks.map(h=><div className="plugin-hooks-row" key={h.id}><strong>{h.title||`${h.service}.${h.method}`}</strong><span className="muted small">{h.event}{h.matcher&&` · matcher ${h.matcher}`} · {h.service}/{h.method} · {t('顺序','order')} {h.order} · {Math.round(h.timeoutMs/1000)}s</span><code>{active?'✓':'—'}</code></div>)}
 </div>;
}
