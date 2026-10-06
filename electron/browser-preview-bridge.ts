import {ipcMain, type WebContents} from 'electron';
import {randomUUID} from 'node:crypto';
import type {BrowserPreviewCommand, BrowserPreviewReply} from '../shared/browser-agent';
const pending = new Map<string,{host:number;resolve:(reply:BrowserPreviewReply)=>void}>();
export function initializeBrowserPreviewBridge(isAppSender:(id:number)=>boolean) {
  ipcMain.on('browser-preview:reply',(event,reply:BrowserPreviewReply)=>{
    if(!isAppSender(event.sender.id)||event.senderFrame!==event.sender.mainFrame)return;
    const request=pending.get(reply?.requestId);
    if(request?.host===event.sender.id)request.resolve(reply);
  });
  ipcMain.handle('browser-preview:dispose-idle',async(event,args:unknown)=>{
    if(!isAppSender(event.sender.id)||event.senderFrame!==event.sender.mainFrame)throw Error('Untrusted browser caller');
    return (await import('./browser-agent')).approveIdleBrowserDisposal(event.sender.id,args);
  });
  ipcMain.handle('browser-preview:workspace',async(event,args:unknown)=>{
    if(!isAppSender(event.sender.id)||event.senderFrame!==event.sender.mainFrame)throw Error('Untrusted browser caller');
    return (await import('./browser-agent')).syncBrowserWorkspace(event.sender,args);
  });
  ipcMain.handle('browser-preview:control',async(event,args:{tabId:string;action:'pause'|'resume'|'retain'})=>{
    if(!isAppSender(event.sender.id)||event.senderFrame!==event.sender.mainFrame)throw Error('Untrusted browser caller');
    return (await import('./browser-agent')).manualBrowserControl(event.sender.id,args);
  });
}
export async function sendBrowserPreview(host:WebContents,command:Omit<BrowserPreviewCommand,'requestId'>,signal?:AbortSignal) {
  if(signal?.aborted)throw Error('Browser action canceled');
  const requestId=randomUUID();
  let timer:ReturnType<typeof setTimeout>|undefined;
  let abort:()=>void=()=>{};
  try {
    return await new Promise<BrowserPreviewReply>((resolve,reject)=>{
      abort=()=>reject(Error('Browser action canceled'));
      pending.set(requestId,{host:host.id,resolve:reply=>reply.error?reject(Error(reply.error)):resolve(reply)});
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>reject(Error('Browser preview unavailable: open this project in Sage and enable Browser')),10000);
      host.send('browser-preview:command',{...command,requestId});
    });
  } finally {if(timer)clearTimeout(timer);pending.delete(requestId);signal?.removeEventListener('abort',abort);}
}
