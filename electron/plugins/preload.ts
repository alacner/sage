// Standalone sandbox preload: no application's preload or filesystem access.
import {contextBridge,ipcRenderer} from 'electron';
const active=new Set<string>();let inFlight=0;
contextBridge.exposeInMainWorld('sageBridge',{
 request:async(token:string,request:unknown)=>{
  if(!active.has(token))throw Error('Plugin call has ended');
  if(inFlight>=32)throw Error('Too many concurrent host calls');
  if(JSON.stringify(request).length>1024*1024)throw Error('Request too large');
  inFlight++;try{return await ipcRenderer.invoke('plugins:runtime-request',token,request);}finally{inFlight--;}
 },
 result:(id:string,value:unknown,error?:string)=>{
  if(!active.delete(id))return;
  try{if(JSON.stringify(value??null).length>8*1024*1024)throw Error('Result too large');ipcRenderer.send('plugins:runtime-result',id,value,error?.slice(0,4000));}
  catch{ipcRenderer.send('plugins:runtime-result',id,null,'Result is not serializable or exceeds 8 MB');}
 },
 listen:(callback:(message:unknown)=>void)=>{ipcRenderer.on('plugins:runtime-call',(_e,m)=>{active.add(m.id);callback(m);});},
});
