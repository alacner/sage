import {webContents,type WebContents} from 'electron';
const tabs=new Map<number,{project:string;host:number;tabId?:string}>();
export function registerBrowserTab(id:number,project:string,host:number,tabId?:string){
 const wc=webContents.fromId(id);
 if(!wc||wc.getType()!=='webview'||wc.hostWebContents?.id!==host)throw Error('Unknown integrated browser tab');
 if(!tabs.has(id))wc.once('destroyed',()=>tabs.delete(id));
 tabs.set(id,{project,host,tabId});return true;
}
export function integratedBrowserTabs(project:string){
 return [...tabs].filter(([,t])=>t.project===project).flatMap(([id])=>{const wc=webContents.fromId(id);return wc&&!wc.isDestroyed()?[{id:String(id),url:wc.getURL(),title:wc.getTitle(),tabId:tabs.get(id)?.tabId,host:tabs.get(id)?.host}]:[];});
}
export function integratedBrowserTab(id:string,project:string):WebContents{
 if(!integratedBrowserTabs(project).some(t=>t.id===id))throw Error('Browser tab is not in this project');
 return webContents.fromId(Number(id))!;
}
