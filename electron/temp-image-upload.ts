import type {ImageAttachment} from '../shared/types';
export interface TurnAttachments {messageId:string;images:ImageAttachment[]}
export function listTurnImages(turn?:TurnAttachments) {
  if(!turn)throw Error('No active conversation attachment context');
  return {messageId:turn.messageId,images:turn.images.map((image,index)=>({index,name:image.name,mimeType:image.mimeType,bytes:Math.floor(image.dataBase64.length*3/4) - (image.dataBase64.endsWith("==") ? 2 : image.dataBase64.endsWith("=") ? 1 : 0)}))};
}
/** The trusted turn context supplies bytes; model/tool inputs can only select an index. */
export function createAttachmentUploader(fetcher:typeof fetch=fetch) {
  const cache=new WeakMap<TurnAttachments,Map<number,Promise<any>>>();
  return async (turn:TurnAttachments|undefined,input:{messageId:string;index:number},service:{base:string;headers:Record<string,string>;request?:typeof fetch},deadline:number) => {
    if(!turn||input.messageId!==turn.messageId)throw Error('Attachment message is stale or unavailable');
    if(!Number.isInteger(input.index)||input.index<0||input.index>=turn.images.length)throw Error('Invalid attachment index');
    if(turn.images.length>8)throw Error('Upload at most 8 images per message');
    const image=turn.images[input.index];if(!image.dataBase64||image.dataBase64.length>Math.ceil(10*1024*1024*4/3))throw Error('Image is empty or exceeds 10 MB');
    let uploads=cache.get(turn);if(!uploads){uploads=new Map();cache.set(turn,uploads);}
    if(uploads.has(input.index))return uploads.get(input.index);
    const request=(async()=>{
      const remaining=deadline-Date.now();if(remaining<=0)throw Error('Upload deadline exceeded');
      const response=await (service.request??fetcher)(service.base+'/images/api/upload',{method:'POST',redirect:'error',headers:{...service.headers,'content-type':'application/json'},body:JSON.stringify({name:image.name,mimeType:image.mimeType,dataBase64:image.dataBase64}),signal:AbortSignal.timeout(Math.min(25000,remaining))});
      if(!response.ok)throw Error(`Temporary image upload failed (HTTP ${response.status}); check Client Token, image type/size and server availability`);
      const result:any=await response.json();
      if(!/^\/temp-images\/[a-f0-9]{48}$/.test(result.url)||!Number.isFinite(Date.parse(result.expiresAt)))throw Error('Invalid temporary image response');
      return {name:image.name,url:new URL(result.url,service.base).href,expiresAt:result.expiresAt};
    })();uploads.set(input.index,request);
    try{return await request;}catch(error){uploads.delete(input.index);throw error;}
  };
}
export const uploadTurnImage=createAttachmentUploader();

export function registerTempImageServices(m:import('./plugins/manager').PluginManager,getService:()=>Promise<{base:string;headers:Record<string,string>;request?:typeof fetch}>) {
 m.host.set('tempImages.list',{permission:'images.upload',description:'List this user message image attachments without image bytes',input:{type:'object',properties:{},additionalProperties:false},run:async(_a,c)=>listTurnImages(c.attachments)});
 m.host.set('tempImages.upload',{permission:'images.upload',description:'Upload one current-message image to the connected relay for one hour',input:{type:'object',properties:{messageId:{type:'string'},index:{type:'integer',minimum:0,maximum:7}},required:['messageId','index'],additionalProperties:false},run:async(a,c)=>uploadTurnImage(c.attachments,a,await getService(),c.deadline)});
}
