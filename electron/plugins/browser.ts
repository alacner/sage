import {registerCertificateBrowser} from '../browser-certificates';
import {BrowserWindow,type WebContents,type Session,type DownloadItem} from 'electron';
import {integratedBrowserTabs,integratedBrowserTab} from './browser-tabs';
import {emitPluginEvent} from './extensions';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {enforceInsideProject,isDeniedRead,isDeniedWrite} from '../sandbox/fs-policy';
import type {PluginManager} from './manager';
type PageWindow={webContents:WebContents;destroy():void;show():void;hide():void};
type PartitionSlot={partition:string;state:'free'|'used'|'cleaning'|'quarantined';owner?:string;project?:string;session?:Session};
type DebuggerLease={contents:WebContents;pages:Set<Page>;detach:()=>void};
type Page={win:PageWindow;owner:string;project:string;busy:boolean;paused:boolean;closed:boolean;downloadDir?:string;events:any[];operation?:AbortController;debuggerLease?:DebuggerLease;listen:(emitter:NodeJS.EventEmitter,event:string,listener:(...args:any[])=>void)=>void;cleanup:()=>boolean};
// Electron retains session contexts until app shutdown. Every fixed slot is
// permanently bound to its first plugin/project; it cannot carry another
// scope's login state. Reuse within that scope requires successful clearing.
const partitionSlots:PartitionSlot[]=Array.from({length:16},(_,i)=>({partition:`sage-plugin-browser-${i}`,state:'free'}));
const pages=new Map<string,Page>();
const debuggerLeases=new Map<WebContents,DebuggerLease>();
function claimPartition(owner:string,project:string){
 const slot=partitionSlots.find(x=>x.state==='free'&&x.owner===owner&&x.project===project)??partitionSlots.find(x=>x.state==='free'&&x.owner===undefined);
 if(!slot)throw Error('Browser capacity reached (16 isolated session slots); close pages and wait for cleanup, or restart Sage to release slots bound to other projects');
 slot.state='used';slot.owner=owner;slot.project=project;return slot;
}
function cleanPartition(slot:PartitionSlot){
 slot.state='cleaning';const session=slot.session;
 if(!session){slot.state='quarantined';return;}
 void Promise.resolve().then(async()=>{session.setPermissionRequestHandler(null);await Promise.all([session.clearStorageData(),session.clearCache(),session.closeAllConnections()]);}).then(()=>{slot.state='free';},()=>{slot.state='quarantined';});
}
function assertOpen(p:Page){if(p.closed||p.win.webContents.isDestroyed())throw Error('Browser handle closed');}
function releaseDebugger(p:Page){
 const lease=p.debuggerLease;if(!lease)return;p.debuggerLease=undefined;lease.pages.delete(p);
 if(lease.pages.size)return;
 if(debuggerLeases.get(lease.contents)===lease)debuggerLeases.delete(lease.contents);
 lease.contents.debugger.removeListener('detach',lease.detach);
 if(!lease.contents.isDestroyed()&&lease.contents.debugger.isAttached())try{lease.contents.debugger.detach();}catch{}
}
function ensureDebugger(p:Page){
 assertOpen(p);const contents=p.win.webContents;
 if(!contents.debugger.isAttached()){
  contents.debugger.attach('1.3');const lease:DebuggerLease={contents,pages:new Set(),detach:()=>{}};
  lease.detach=()=>{if(debuggerLeases.get(contents)===lease)debuggerLeases.delete(contents);for(const page of lease.pages)if(page.debuggerLease===lease)page.debuggerLease=undefined;lease.pages.clear();contents.debugger.removeListener('detach',lease.detach);};
  debuggerLeases.set(contents,lease);contents.debugger.on('detach',lease.detach);
 }
 const lease=debuggerLeases.get(contents);if(lease){lease.pages.add(p);p.debuggerLease=lease;}
}
function addPage(id:string,win:PageWindow,owner:string,project:string,slot?:PartitionSlot){
 const listeners:Array<()=>void>=[],downloads=new Map<DownloadItem,(_event:unknown,state:string)=>void>();
 const p:Page={win,owner,project,busy:false,paused:false,closed:false,events:[],listen:(emitter,event,listener)=>{emitter.on(event,listener);listeners.push(()=>emitter.removeListener(event,listener));},cleanup:()=>{
  if(p.closed)return !slot||(win as BrowserWindow).isDestroyed();p.closed=true;pages.delete(id);p.operation?.abort(Error('Browser handle closed'));
  for(const remove of listeners.splice(0))try{remove();}catch{}
  for(const [item,done]of downloads){item.removeListener('done',done);try{item.cancel();}catch{}}downloads.clear();releaseDebugger(p);
  if(slot){try{if(!(win as BrowserWindow).isDestroyed())win.destroy();}catch{slot.state='quarantined';return false;}cleanPartition(slot);}
  return true;
 }};
 pages.set(id,p);
 const listen=p.listen;
 listen(win.webContents,'destroyed',p.cleanup);
 if(slot){
  slot.session=win.webContents.session;
  listen(win as BrowserWindow,'closed',p.cleanup);listen(win as BrowserWindow,'focus',()=>{if(!p.closed)p.paused=true;});
  listen(win.webContents,'console-message',(_event,level,message)=>{if(p.closed)return;p.events.push({level,message:String(message).slice(0,2000)});if(p.events.length>100)p.events.shift();});
  listen(slot.session,'will-download',(event,item:DownloadItem,source:WebContents)=>{
   if(p.closed||source!==win.webContents||!p.downloadDir){event.preventDefault();return;}
   const file=path.join(p.downloadDir,crypto.randomUUID()+'-'+path.basename(item.getFilename()).replace(/[^a-zA-Z0-9_.-]/g,'_'));
   try{enforceInsideProject(file,p.project);if(isDeniedWrite(file))throw Error('Protected path');item.setSavePath(file);
    const done=(_event:unknown,state:string)=>{downloads.delete(item);if(p.closed)return;p.events.push({download:file,state});if(p.events.length>100)p.events.shift();};downloads.set(item,done);item.once('done',done);
   }catch{event.preventDefault();}
  });
 }
 return p;
}
async function operation<T>(p:Page,deadline:number,run:()=>Promise<T>|T):Promise<T>{
 assertOpen(p);if(Number.isFinite(deadline)&&deadline<=Date.now()){p.cleanup();throw Error('Browser operation timed out');}const controller=new AbortController();p.operation=controller;p.busy=true;
 let timer:ReturnType<typeof setTimeout>|undefined,onAbort:(()=>void)|undefined;
 const interrupted=new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(controller.signal.reason instanceof Error?controller.signal.reason:Error('Browser handle closed'));controller.signal.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>{controller.abort(Error('Browser operation timed out'));p.cleanup();},Math.max(1,Number.isFinite(deadline)?deadline-Date.now():30000));});
 const pending=Promise.resolve().then(()=>{assertOpen(p);return run();});
 try{const result=await Promise.race([pending,interrupted]);assertOpen(p);return result;}finally{if(timer)clearTimeout(timer);if(onAbort)controller.signal.removeEventListener('abort',onAbort);if(p.operation===controller){p.operation=undefined;p.busy=false;}}
}
export function registerBrowser(manager:PluginManager){
 manager.host.set('browser.tabs',{permission:'browser.tabs',description:'List integrated browser tabs in this project',input:{type:'object'},run:async(_a,c)=>integratedBrowserTabs(c.project)});
 manager.host.set('browser.attach',{permission:'browser.tabs',description:'Attach a scoped handle to an integrated browser tab',input:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},run:async(a,c)=>{
  const owner=c.chain[0];if(!owner)throw Error('Plugin caller required');if(Number.isFinite(c.deadline)&&c.deadline<=Date.now())throw Error('Browser operation timed out');const wc=integratedBrowserTab(a.id,c.project),id=crypto.randomUUID();
  addPage(id,{webContents:wc,destroy:()=>{},show:()=>{BrowserWindow.fromWebContents(wc.hostWebContents??wc)?.show();wc.focus();},hide:()=>{}},owner,c.project);return {id};
 }});
 const schema={type:'object',properties:{id:{type:'string'},url:{type:'string'},selector:{type:'string'},text:{type:'string'},key:{type:'string'},expression:{type:'string'},command:{type:'string'},params:{type:'object'},file:{type:'string'},width:{type:'integer',minimum:320,maximum:3840},height:{type:'integer',minimum:200,maximum:2160}},additionalProperties:false};
 for(const action of ['create','list','close','navigate','back','forward','reload','snapshot','screenshot','click','fill','select','press','scroll','wait','console','show','hide','pause','resume','evaluate','cdp','frames','upload','download'])manager.host.set(`browser.${action}`,{permission:['evaluate','cdp'].includes(action)?'browser.debug':['upload','download'].includes(action)?'browser.files':'browser.control',description:`Browser ${action}`,input:schema,run:async(a,ctx)=>{
  const owner=ctx.chain[0];if(!owner)throw Error('Browser requires a plugin caller');
  if(action==='list')return [...pages].filter(([,p])=>p.owner===owner&&p.project===ctx.project).map(([id,p])=>({id,url:p.win.webContents.getURL(),title:p.win.webContents.getTitle()}));
  if(action==='create'){
   if(Number.isFinite(ctx.deadline)&&ctx.deadline<=Date.now())throw Error('Browser operation timed out');
   const slot=claimPartition(owner,ctx.project);let win:BrowserWindow;
   try{win=new BrowserWindow({show:false,useContentSize:true,width:a.width??1100,height:a.height??800,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true,nodeIntegration:false,partition:slot.partition}});}catch(e){slot.state='quarantined';throw e;}
   const id=crypto.randomUUID(),p=addPage(id,win,owner,ctx.project,slot);
   const allowed=(url:string)=>{try{return ['http:','https:','about:'].includes(new URL(url).protocol);}catch{return false;}};
   try{registerCertificateBrowser(win.webContents);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));p.listen(win.webContents,'will-navigate',(e,url)=>{if(!allowed(url))e.preventDefault();});win.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
   if(a.url){if(!allowed(a.url))throw Error('HTTP(S) URLs only');await operation(p,ctx.deadline,()=>win.loadURL(a.url));}assertOpen(p);}catch(e){p.cleanup();throw e;}
   void emitPluginEvent(manager,ctx.project,'sage/browser.created',{url:a.url??'about:blank'},ctx);return {id};
  }
  const p=pages.get(a.id);if(!p||p.owner!==owner||p.project!==ctx.project)throw Error('Browser handle expired or belongs to another caller');if(action==='close'){if(!p.cleanup())throw Error('Browser window could not be closed; restart Sage to release its isolated session');return true;}if(p.busy)throw Error('Browser page is busy');
  return operation(p,ctx.deadline,async()=>{const wc=p.win.webContents;
   if(action==='show'){p.paused=true;p.win.show();return true;}if(action==='hide'){p.win.hide();return true;}
   if(action==='pause'){p.paused=true;return true;}if(action==='resume'){p.paused=false;return true;}
   if(p.paused&&!['snapshot','screenshot','console','frames'].includes(action))throw Error('Browser is under manual control; call resume to continue');
   if(action==='download'){const dir=path.join(ctx.project,'plugin-downloads',owner);enforceInsideProject(dir,ctx.project);if(isDeniedWrite(dir))throw Error('Protected download path');await fs.mkdir(dir,{recursive:true});const real=await fs.realpath(dir),root=await fs.realpath(ctx.project);if(!real.startsWith(root+path.sep)||isDeniedWrite(real))throw Error('Download path escapes project');assertOpen(p);p.downloadDir=real;return {directory:dir};}
   if(['cdp','frames','upload'].includes(action)){ensureDebugger(p);if(action==='frames')return wc.debugger.sendCommand('Page.getFrameTree');if(action==='upload'){if(typeof a.file!=='string'||typeof a.selector!=='string')throw Error('File and selector required');const file=enforceInsideProject(path.resolve(ctx.project,a.file),ctx.project);if(isDeniedRead(file))throw Error('Protected file');const real=await fs.realpath(file),root=await fs.realpath(ctx.project);assertOpen(p);if(!real.startsWith(root+path.sep)||isDeniedRead(real))throw Error('Upload path escapes project');const doc=await wc.debugger.sendCommand('DOM.getDocument');assertOpen(p);const node=await wc.debugger.sendCommand('DOM.querySelector',{nodeId:doc.root.nodeId,selector:a.selector});assertOpen(p);if(!node.nodeId)throw Error('File input not found');return wc.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[file]});}if(!/^(Page|Runtime|DOM|DOMSnapshot|Accessibility|Input|Network|Emulation|Overlay|Log|Performance)\.[A-Za-z]+$/.test(a.command??''))throw Error('CDP domain is not scoped to this page');if(['DOM.setFileInputFiles','Page.setDownloadBehavior'].includes(a.command))throw Error('Use the scoped upload/download API');if(a.command==='Page.navigate'&&!/^https?:\/\//i.test(a.params?.url??''))throw Error('HTTP(S) URL required');return wc.debugger.sendCommand(a.command,a.params??{});}
   if(action==='evaluate'){if(typeof a.expression!=='string'||a.expression.length>100000)throw Error('Expression required (max 100 KB)');return wc.executeJavaScript(a.expression);}
   if(action==='navigate'){if(!/^https?:\/\//i.test(a.url??''))throw Error('HTTP(S) URL required');await wc.loadURL(a.url);assertOpen(p);return {url:wc.getURL()};}
   if(action==='back'){if(wc.canGoBack())wc.goBack();return true;}if(action==='forward'){if(wc.canGoForward())wc.goForward();return true;}if(action==='reload'){wc.reload();return true;}
   if(action==='console')return p.events;
   if(action==='screenshot'){const shot=await wc.capturePage(undefined,{stayHidden:true,stayAwake:true});assertOpen(p);if(shot.isEmpty())throw Error('Browser capture is empty');return {mimeType:'image/png',base64:shot.toPNG().toString('base64'),...shot.getSize()};}
   if(action==='snapshot')return wc.executeJavaScript(`({url:location.href,title:document.title,text:document.body?.innerText.slice(0,60000),elements:Array.from(document.querySelectorAll('a,button,input,select,textarea')).slice(0,300).map(e=>({tag:e.tagName,role:e.getAttribute('role'),name:e.getAttribute('aria-label'),text:e.innerText?.slice(0,200),id:e.id}))})`);
   if(action==='press'){const key=String(a.key??'');if(!/^[a-zA-Z0-9_+-]{1,30}$/.test(key))throw Error('Invalid key');wc.sendInputEvent({type:'keyDown',keyCode:key});wc.sendInputEvent({type:'keyUp',keyCode:key});return true;}
   if(action==='scroll')return wc.executeJavaScript(`window.scrollBy(0,${a.text==='up'?-500:500})`);
   if(typeof a.selector!=='string'||a.selector.length>1000)throw Error('Selector required');
   const script=`(()=>{const all=document.querySelectorAll(${JSON.stringify(a.selector)});if(all.length!==1)throw Error('Selector must match exactly one element');const e=all[0];${action==='click'?'e.click();':action==='fill'?`const set=Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;set.call(e,${JSON.stringify(a.text??'')});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));`:action==='select'?`e.value=${JSON.stringify(a.text??'')};e.dispatchEvent(new Event('change',{bubbles:true}));`:''}return true;})()`;
   if(action==='wait'){while(Date.now()<ctx.deadline-250){try{assertOpen(p);const result=await wc.executeJavaScript(script);assertOpen(p);return result;}catch{assertOpen(p);await new Promise(r=>setTimeout(r,100));}}throw Error('Element wait timed out');}
   return await wc.executeJavaScript(script);
  });
 }});
 return ()=>{for(const p of [...pages.values()])p.cleanup();};
}
