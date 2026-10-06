import {getTenantAccessToken} from './feishu-app';
import {listChannels} from '../store';
import type {ConversationMeta} from '../../shared/types';
import {channelConnectionTimeoutMs} from './runtime-config';
import {recordChannelDiag} from './diagnostics';
export async function createFeishuStream(meta:ConversationMeta){
 const ids=new Set([...(meta.outboundChannelIds??meta.channelIds??[]),...(meta.broadcastAssistantChannelIds??[])]);
 const channels=(await listChannels(meta.projectPath)).filter(c=>c.enabled&&c.type==='feishu-app'&&c.config.streamReplies==='true'&&ids.has(c.id));
 const sent=new Map<string,string>();let latest='',last='',closed=false,chain=Promise.resolve();let finished:Promise<string[]>|undefined;let writing=false;
 async function write(final:boolean,failed=false):Promise<string[]>{
  const successful:string[]=[];const text=latest;if(!text.trim())return successful;
  for(const ch of channels)try{
   const token=await getTenantAccessToken(ch.config.appId,ch.config.appSecret);
   const vars:Record<string,string>={content:text,conversation:meta.title,project:meta.projectPath.split('/').pop()??'',sender:'Sage',time:new Date().toLocaleString()};
   const replace=(s:string)=>s.replace(/\{\{(\w+)\}\}/g,(_,key)=>vars[key]??'');
   const bodyText=replace(ch.broadcastTemplate?.content??'{{content}}');
   const content=JSON.stringify({config:{update_multi:true},header:{title:{tag:'plain_text',content:replace(ch.broadcastTemplate?.title??'{{conversation}}')||'Sage'},template:failed?'red':final?'green':'blue'},elements:[{tag:'markdown',content:bodyText.slice(0,6000)+(bodyText.length>6000?'\n…（内容已截断）':'')}]});
   const id=sent.get(ch.id);const url=id?`https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(id)}`:`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(ch.config.receiveIdType||'chat_id')}`;
   const response=await fetch(url,{method:id?'PATCH':'POST',signal:AbortSignal.timeout(await channelConnectionTimeoutMs()),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(id?{content}:{receive_id:ch.config.receiveId,msg_type:'interactive',content})});
   const result=await response.json() as any;if(!response.ok||result.code!==0){recordChannelDiag({stage:'outbound',ok:false,reason:'api-error',channelType:ch.type,config:ch.config,channelName:ch.name,detail:{httpStatus:response.status,code:result.code,msg:result.msg,cardUpdate:!!id}});throw Error(result.msg??'卡片更新失败');}
   if(!id){if(!result.data?.message_id){recordChannelDiag({stage:'outbound',ok:false,reason:'no-message-id',channelType:ch.type,config:ch.config,channelName:ch.name,detail:{receiveId:ch.config.receiveId}});throw Error('未返回消息 ID');}sent.set(ch.id,result.data.message_id);
    // 流式卡片每秒更新一次，只给“首次创建”留一条出站回执（否则诊断会被更新海淹没）
    recordChannelDiag({stage:'outbound',ok:true,reason:'ok',channelType:ch.type,config:ch.config,channelName:ch.name,detail:{messageId:result.data.message_id,chatId:result.data.chat_id??'',receiveId:ch.config.receiveId,streamCard:true}});}successful.push(ch.id);
  }catch(error){recordChannelDiag({stage:'outbound',ok:false,reason:/timeout|ENOTFOUND|ECONN|ETIMEDOUT|网络|超时/i.test(String((error as any)?.message))?'network':'api-error',channelType:ch.type,config:ch.config,channelName:ch.name,detail:{error:(error as any)?.message??String(error)}});console.error('[feishu stream]',ch.id,error);}
  return successful;
 }
 const timer=setInterval(()=>{if(closed||writing||!latest||latest===last)return;last=latest;writing=true;chain=write(false).then(()=>{},()=>{}).finally(()=>{writing=false;});},1000);timer.unref();
 return {update(text:string){latest=text;},finish(text:string,failed=false){if(finished)return finished;closed=true;clearInterval(timer);latest=text;finished=chain.then(()=>write(true,failed));return finished;}};
}
