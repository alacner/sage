import {createPluginI18n} from '../../shared/plugins/i18n';
import {resolveLanguage} from '../../shared/language';
import {app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PluginContext, PluginCall, PluginPackage } from '../../shared/plugins/contract';
import type { RunnerFactory } from './manager';
interface Pending {ctx:PluginContext;resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}
const hosts=new Map<number,{pending:Map<string,Pending>;request:(req:PluginCall,ctx:PluginContext)=>Promise<unknown>}>();
const reusablePartitions:string[]=[];
const recyclingPartitions=new Set<Promise<void>>();
let partitionCount=0;
const sessionPrefix=crypto.randomUUID();
async function takePartition():Promise<string>{
 const recycled=reusablePartitions.pop();if(recycled)return recycled;
 if(partitionCount>=32){
  if(!recyclingPartitions.size)throw Error('Plugin sessions are busy; retry after running calls finish');
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Plugin session cleanup timed out; retry later')),5000);
   void Promise.race(recyclingPartitions).then(()=>{clearTimeout(timer);resolve();});
  });
  return takePartition();
 }
 return `sage-plugin-${sessionPrefix}-${++partitionCount}`;
}
let registered=false;
export function registerRuntime(){if(registered)return;registered=true;
 ipcMain.handle('plugins:runtime-request',async(event,token:string,request:PluginCall)=>{const host=hosts.get(event.sender.id),pending=host?.pending.get(token);if(!pending||event.senderFrame!==event.sender.mainFrame)throw Error('Invalid plugin call context');return host!.request(request,pending.ctx);});
 ipcMain.on('plugins:runtime-result',(event,id:string,value:any,error?:string)=>{const host=hosts.get(event.sender.id),pending=host?.pending.get(id);if(!pending||event.senderFrame!==event.sender.mainFrame)return;clearTimeout(pending.timer);host!.pending.delete(id);error?pending.reject(Error(String(error))):pending.resolve(value);});
}
const bootstrap=`
const createPluginI18n=${createPluginI18n.toString()};
const bridge=window.sageBridge;
bridge.listen(async ({id,service,method,args,locale,i18n})=>{
 try {
  const sdk=Object.freeze({
   i18n:createPluginI18n(i18n,locale).api,
   call:(plugin,service,method,args={})=>bridge.request(id,{plugin,service,method,args}),
   host:(service,method,args={})=>bridge.request(id,{plugin:'$host',service,method,args}),
   settings:{get:key=>bridge.request(id,{plugin:'$host',service:'settings',method:'get',args:{key}}),set:(key,value)=>bridge.request(id,{plugin:'$host',service:'settings',method:'set',args:{key,value}})}
  });
  if(service==='$lifecycle') { bridge.result(id,Object.fromEntries(Object.entries(globalThis.sagePlugin?.services??{}).map(([s,methods])=>[s,Object.keys(methods).filter(m=>typeof methods[m]==='function')])));return; }
  const fn=globalThis.sagePlugin?.services?.[service]?.[method];
  if(typeof fn!=='function')throw Error('Plugin method not implemented: '+service+'.'+method);
  const result=await fn(args,sdk);bridge.result(id,result??null);
 }catch(e){bridge.result(id,null,String(e?.message??e));}
});
`;
export const electronRunner:RunnerFactory=async(p:PluginPackage,project,request)=>{
 registerRuntime();const nonce=crypto.randomBytes(18).toString('base64');const partition=await takePartition();
 let win:BrowserWindow;
 try { win=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,partition}}); }
 catch(error){reusablePartitions.push(partition);throw error;}
 const pending=new Map<string,Pending>();const id=win.webContents.id;hosts.set(id,{pending,request});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.on('will-attach-webview',e=>e.preventDefault());win.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
 win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('data:text/html')}));
 const session=win.webContents.session;
 let closed=false;
 const close=()=>{
  if(closed)return;closed=true;hosts.delete(id);
  for(const v of pending.values()){clearTimeout(v.timer);v.reject(Error('Plugin stopped'));}pending.clear();
  if(!win.isDestroyed())win.destroy();
  // Do not hand one plugin another plugin's cookies/cache. Failed cleanup
  // quarantines this slot, while callers can wait for other slots to finish.
  const cleanup=Promise.all([session.clearStorageData(),session.clearCache(),session.closeAllConnections()])
   .then(()=>{reusablePartitions.push(partition);}).catch(()=>{}).finally(()=>recyclingPartitions.delete(cleanup));
  recyclingPartitions.add(cleanup);
 };
 win.webContents.on('render-process-gone',close);win.on('closed',close);
 const call=async(service:string,method:string,args:unknown,ctx:PluginContext)=>{
  const {readSettings}=await import('../main');
  const locale=resolveLanguage((await readSettings()).language,app.getLocale());
  return new Promise<unknown>((resolve,reject)=>{
  if(pending.size>=16){reject(Error('Too many concurrent plugin calls'));return;}if(closed){reject(Error('Plugin runtime stopped'));return;}const token=crypto.randomUUID();const timer=setTimeout(()=>{pending.delete(token);reject(Error('Plugin call timed out; runtime stopped'));close();},Math.max(1,Math.min(ctx.development?300000:30000,ctx.deadline-Date.now())));pending.set(token,{ctx,resolve,reject,timer});win.webContents.send('plugins:runtime-call',{id:token,service,method,args,locale,i18n:p.manifest.i18n});
 });};
 const html=`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><script nonce="${nonce}">${p.files['plugin.js'].replace(/<\/script/gi,'<\\/script')}</script><script nonce="${nonce}">${bootstrap}</script>`;
 let loadingTimer:NodeJS.Timeout|undefined;try{await Promise.race([win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html)),new Promise((_,reject)=>{loadingTimer=setTimeout(()=>{close();reject(Error('Plugin initialization timed out'));},5000);})]);clearTimeout(loadingTimer);const actual=await call('$lifecycle','ready',{}, {project,chain:[],trace:crypto.randomUUID(),deadline:Date.now()+5000});if(!actual||typeof actual!=='object'||Object.entries(p.manifest.services).some(([s,service])=>Object.keys(service.methods).some(method=>!Array.isArray((actual as any)[s])||!(actual as any)[s].includes(method))))throw Error('Declared service is not implemented');}catch(e){clearTimeout(loadingTimer);close();throw e;}
 return {call,close,isClosed:()=>closed,inspect:()=>win.webContents.openDevTools({mode:'detach'})};
};
