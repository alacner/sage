import {WSClient,EventDispatcher,LoggerLevel} from '@larksuiteoapi/node-sdk';
import {listProjects,listChannels} from '../store';
import type {ChannelConfig} from '../../shared/types';
import type {InboundHandler} from './inbound-server';
import {recordChannelDiag,registerChannelProjects} from './diagnostics';
const clients=new Map<string,{client:WSClient;signature:string;appId:string;count:number}>();
let syncing=false;

/**
 * 长连接实时状态（面板用）。
 * 光靠事件日志判断不了"现在到底连没连上"：一条消息都没推过来时，
 * 日志是空的，而 getConnectionStatus 能直接说 connected / failed / reconnecting。
 */
export function feishuConnectionStatus(){
 return [...clients.values()].map(({client,appId,count})=>{
  const st=client.getConnectionStatus?.();
  return {appId,channelCount:count,state:st?.state??'unknown',lastConnectTime:st?.lastConnectTime,reconnectAttempts:st?.reconnectAttempts??0};
 });
}

export async function syncFeishuConnections(handler:InboundHandler){
 if(syncing)return;syncing=true;
 try{
  // One connection per application: multiple connections otherwise load-balance events.
  const groups=new Map<string,ChannelConfig[]>();
  for(const project of await listProjects())for(const channel of await listChannels(project.path)){
   if(!channel.enabled||channel.type!=='feishu-app'||channel.config.connectionMode!=='websocket')continue;
   const key=channel.config.appId;const group=groups.get(key)??[];group.push({...channel,projectPath:project.path});groups.set(key,group);
  }
  // 长连接埋点（token / 出站）分散在拿不到 projectPath 的调用栈上，先登记渠道归属，
  // 诊断落盘才能写进对应项目的日志文件。
  registerChannelProjects([...groups.values()].flat());
  for(const [key,channels] of groups){
   const config=channels[0].config;const signature=JSON.stringify(channels.map(c=>[c.id,c.projectPath,c.config]));
   if(clients.get(key)?.signature===signature)continue;
   clients.get(key)?.client.close({force:true});
   // SDK 自己的 error 日志（拉凭证失败、连接异常）转进诊断通道：打包后的 .app 里 stderr 没人看得见。
   const sdkError=(...msg:any[])=>{recordChannelDiag({stage:'ws',ok:false,reason:'connect-failed',channelType:'feishu-app',config,detail:{sdk:'error',msg:msg.map(String).join(' ').slice(0,300)}});};
   // warn 里只有 "no <type> handle" 是链路问题（事件推进来了但没注册处理器），其余 warn
   // （重连提示等）含义没比对过，一律记成失败会把前面正常的结论抹掉，所以只挑这一条。
   const sdkWarn=(...msg:any[])=>{const text=msg.map(String).join(' ');const unregistered=/no (\S+) handle/.exec(text);if(unregistered)recordChannelDiag({stage:'inbound',ok:false,reason:'dropped-unregistered-event',channelType:'feishu-app',config,detail:{type:unregistered[1]}});};
   const client=new WSClient({appId:config.appId,appSecret:config.appSecret,loggerLevel:LoggerLevel.error,
    // 半开连接（网络切换/休眠后 TCP 已死但本地还认为 OPEN）SDK 默认永不自查，
    // 面板会一直显示"已连接"却收不到事件；带 pong 看门狗后超时即断开走重连。
    wsConfig:{pingTimeout:45},
    logger:{error:sdkError,warn:sdkWarn,info:()=>{},debug:()=>{},trace:()=>{}},
    onReady:()=>recordChannelDiag({stage:'ws',ok:true,reason:'connected',channelType:'feishu-app',config,channelName:channels[0]?.name,detail:{app:config.appId,channels:channels.length}}),
    onError:(err:Error)=>recordChannelDiag({stage:'ws',ok:false,reason:'connect-failed',channelType:'feishu-app',config,channelName:channels[0]?.name,detail:{error:err?.message??String(err)}}),
    onReconnecting:()=>recordChannelDiag({stage:'ws',ok:false,reason:'reconnecting',channelType:'feishu-app',config}),
    onReconnected:()=>recordChannelDiag({stage:'ws',ok:true,reason:'reconnected',channelType:'feishu-app',config})});
   clients.set(key,{client,signature,appId:key,count:channels.length});const seen=new Set<string>();
   void client.start({eventDispatcher:new EventDispatcher({}).register({'im.message.receive_v1':async(event:any)=>{
    const message=event.message;const chatId=message?.chat_id??'';const messageId=message?.message_id??'';
    // 每个事件先无条件留痕：「飞书到底推没推过来」是这条链上最值钱的一条信息，之前全是静默 return
    recordChannelDiag({stage:'inbound',ok:true,reason:'received',channelType:'feishu-app',config,channelName:channels[0]?.name,detail:{chatId,messageId,type:message?.message_type??''}});
    if(clients.get(key)?.client!==client){recordChannelDiag({stage:'inbound',ok:false,reason:'dropped-stale-connection',channelType:'feishu-app',config,detail:{chatId,messageId}});return;}
    if(!messageId){recordChannelDiag({stage:'inbound',ok:false,reason:'dropped-no-message-id',channelType:'feishu-app',config,detail:{chatId,type:message?.message_type??''}});return;}
    if(message.message_type!=='text'){recordChannelDiag({stage:'inbound',ok:false,reason:'dropped-not-text',channelType:'feishu-app',config,detail:{chatId,messageId,type:message.message_type??''}});return;}
    if(seen.has(messageId)){recordChannelDiag({stage:'inbound',ok:false,reason:'dropped-duplicate',channelType:'feishu-app',config,detail:{messageId}});return;}
    seen.add(messageId);if(seen.size>1000)seen.delete(seen.values().next().value!);
    let text='';try{text=JSON.parse(message.content).text??'';}catch{recordChannelDiag({stage:'inbound',ok:false,reason:'dropped-parse-fail',channelType:'feishu-app',config,detail:{messageId}});return;}
    if(!text.trim()){recordChannelDiag({stage:'inbound',ok:false,reason:'dropped-empty-content',channelType:'feishu-app',config,detail:{messageId}});return;}
    let matched=false;
    for(const channel of channels){
     const type=channel.config.receiveIdType||'chat_id';const recipient=type==='chat_id'?message.chat_id:event.sender?.sender_id?.[type];
     if(recipient!==channel.config.receiveId)continue;
     matched=true;
     // expected / actual 并排打出来：「配置了 A 群、在 B 群说话」以前只能靠猜，现在一行日志就能看出来
     recordChannelDiag({stage:'match',ok:true,reason:'matched',channelType:channel.type,config:channel.config,channelName:channel.name,detail:{chatId,expected:channel.config.receiveId,actual:recipient,receiveIdType:type}});
     void handler({channelId:channel.id,channelType:channel.type,text,senderId:event.sender?.sender_id?.open_id,raw:event,ts:Date.now()},channel)
      .then(()=>recordChannelDiag({stage:'inject',ok:true,reason:'injected',channelType:channel.type,config:channel.config,channelName:channel.name,detail:{messageId}}))
      .catch(error=>{recordChannelDiag({stage:'inject',ok:false,reason:'inject-failed',channelType:channel.type,config:channel.config,channelName:channel.name,detail:{messageId,error:error?.message??String(error)}});console.error('[feishu websocket] message handling failed',error);});
    }
    if(!matched)recordChannelDiag({stage:'match',ok:false,reason:'mismatch',channelType:'feishu-app',config,channelName:channels[0]?.name,detail:{chatId,messageId,actual:message.chat_id??event.sender?.sender_id?.open_id??'',expected:channels.map(c=>c.config.receiveId).filter(Boolean).join(',')}});
   }})}).catch(error=>{recordChannelDiag({stage:'ws',ok:false,reason:'connect-failed',channelType:'feishu-app',config,channelName:channels[0]?.name,detail:{error:error?.message??String(error)}});console.error('[feishu websocket] connection failed',error);if(clients.get(key)?.client===client){client.close({force:true});clients.delete(key);}});
  }
  for(const [key,entry] of clients)if(!groups.has(key)){entry.client.close({force:true});clients.delete(key);recordChannelDiag({stage:'ws',ok:false,reason:'not-connected',channelType:'feishu-app',detail:{app:key,why:'closed'}});}
 }finally{syncing=false;}
}
