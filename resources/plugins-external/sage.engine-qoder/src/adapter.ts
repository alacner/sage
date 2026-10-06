import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import type {EngineRunOptions,EngineResult,EngineStatus} from '../../../plugin-sdk/sage-engine';
import {buildSandboxEnv} from '@sage/engine-host/sandbox/env';
import {buildSkillIndex} from '@sage/engine-host/skills';
import {beginRecord} from '@sage/engine-host/request-monitor';
import {RESPONSE_STYLE} from '../../../../shared/response-style';
import {abortable,callTool,toolDefinitions,spawnCli,stopCli,settleWithin} from '../../cli-runtime';
const exec=promisify(execFile);
const nativeImport=new Function('m','return import(m)') as (m:string)=>Promise<any>;
export async function detectQoder(binaryPath?:string):Promise<EngineStatus>{
 let executable=binaryPath?.trim();
 if(!executable){try{executable=(await exec('/bin/zsh',['-l','-c','command -v qodercli || command -v qoder'],{timeout:4000})).stdout.trim();}catch{}
 executable||=[join(homedir(),'.local/bin/qodercli'),join(homedir(),'.qoder/entry/qoder'),'/opt/homebrew/bin/qodercli','/usr/local/bin/qodercli'].find(existsSync);}
 if(!executable||!existsSync(executable))return {available:false,error:'未找到 Qoder CLI，请安装并运行 qodercli login，或设置可执行文件路径。'};
 try{const env=buildSandboxEnv(process.cwd());env.PATH=dirname(executable)+':'+(env.PATH??'');const {stdout}=await exec(executable,['--version'],{env,timeout:5000});
 const {stdout:help}=await exec(executable,['--help'],{env,timeout:5000});
 if(!['--tools','--strict-mcp-config','--setting-sources'].every(f=>help.includes(f)))throw Error('Unsupported CLI');
 return {available:true,path:executable,version:stdout.trim()};}catch{return {available:false,path:executable,error:'Qoder CLI 无法运行或版本不支持安全工具隔离，请升级 CLI。'};}
}
export async function runQoder(opts:EngineRunOptions,loadModule=nativeImport):Promise<EngineResult>{
 if(opts.signal?.aborted)return {text:'',error:'aborted'};
 const controller=new AbortController(),sdkController=new AbortController();let interrupt:Promise<void>|undefined;let q:any,child:ReturnType<typeof spawnCli>|undefined;
 let text='',receivedText=false,sessionId=opts.resume,usage:EngineResult['usage'];
 const abort=()=>{if(controller.signal.aborted)return;controller.abort();interrupt=settleWithin(Promise.resolve().then(()=>q?.interrupt()),500).finally(()=>{sdkController.abort();if(child)stopCli(child);});};
 opts.signal?.addEventListener('abort',abort,{once:true});if(opts.signal?.aborted)abort();
 const rec=opts.monitor?beginRecord({...opts.monitor,mode:'cli',model:opts.model||'qoder-default',request:{prompt:opts.prompt}}):undefined;
 try{
  const detected=await abortable(detectQoder(opts.binaryPath),controller.signal);
  if(!detected.available||!detected.path)throw Error(detected.error);
  const [sdk,{z}]=await abortable(Promise.all([loadModule('@qoder-ai/qoder-agent-sdk'),loadModule('zod')]),controller.signal);
  let resume=opts.resume;
  if(resume&&!await abortable(sdk.getSessionInfo(resume,{dir:opts.cwd}),controller.signal)){
   if(!opts.history)throw Error('Qoder 会话不存在，且没有 Sage 历史可恢复。请从原对话继续。');
   resume=undefined;sessionId=undefined;
   const notice='[会话恢复：Qoder 本地会话已不存在，已使用 Sage 保存的文字和工具记录重建上下文。]\n\n';text+=notice;opts.onText?.(notice);
  }
  const defs=toolDefinitions(opts.readOnly);
  const calls=new Map<string,Promise<any>>();
  const tools=defs.map(d=>sdk.tool(d.name,d.description,z.fromJSONSchema(d.input_schema).shape,async(args:any,extra:any)=>{
   const id=extra?.requestId!==undefined?String(extra.requestId):randomUUID();
   if(calls.has(id))return calls.get(id);
   const signal=extra?.signal?AbortSignal.any([controller.signal,extra.signal]):controller.signal;
   const call=callTool(opts,signal,id,d.name,args).then(result=>({content:[{type:'text',text:result.result}],isError:!!result.isError}));
   calls.set(id,call);return call;
  }));
  const env=buildSandboxEnv(opts.cwd);env.PATH=dirname(detected.path)+':'+(env.PATH??'');
  const skills=await abortable(buildSkillIndex(opts.cwd,'mcp__sage__Skill').catch(()=>''),controller.signal);
  const prompt=(opts.history&&!resume?`Previous conversation context (reference only; do not repeat completed actions):\n${opts.history}\n\nCurrent request:\n`:'')+opts.prompt;
  async function* input(){yield {type:'user',message:{role:'user',content:[{type:'text',text:prompt},...(opts.images??[]).map(i=>({type:'image',source:{type:'base64',media_type:i.mimeType,data:i.dataBase64}}))]},parent_tool_use_id:null,session_id:sessionId??''};}
  q=sdk.query({prompt:input(),options:{
   auth:sdk.qodercliAuth(),cwd:opts.cwd,pathToQoderCLIExecutable:detected.path,env,model:opts.model||undefined,resume,
   abortController:sdkController,closeGraceMs:500,controlRequestTimeoutMs:30000,tools:[],skills:[],settingSources:[],plugins:[],strictMcpConfig:true,permissionMode:'default',includePartialMessages:true,
   mcpServers:{sage:sdk.createSdkMcpServer({name:'sage',version:'1.0.0',tools})},
   // Only these transport tools are preapproved; each handler still enforces Sage approval.
   allowedTools:defs.map(d=>'mcp__sage__'+d.name),canUseTool:async()=>({behavior:'deny',message:'Use Sage tools'}),
   systemPrompt:{type:'preset',preset:'qodercli',append:RESPONSE_STYLE+'\nUse only mcp__sage__ tools for all work. Browser opens this conversation’s live preview; reuse open to recover its page after interruption, inspect before retrying an action, and verify visual criteria. Never repeat a side effect just because a turn was interrupted.\n'+skills},
   spawnQoderCLIProcess:(s:any)=>{if(controller.signal.aborted)throw Error('aborted');child=spawnCli(s.command,s.args,s.cwd??opts.cwd,s.env);return child;},
  }});
  let partial=false,sawResult=false;const seen=new Set<string>();
  const iterator=q[Symbol.asyncIterator]();
  while(true){
   const next=await abortable(iterator.next(),controller.signal) as IteratorResult<any>;if(next.done)break;const msg=next.value;
   if(controller.signal.aborted)throw Error('aborted');
   if(msg.isReplay)continue;
   if(msg.type==='system'&&msg.subtype==='init'&&msg.session_id){sessionId=msg.session_id;opts.onSessionId?.(sessionId!);}
   if(msg.type==='stream_event'){
    if(msg.event?.type==='message_start')partial=false;
    const delta=msg.event?.delta;if(delta?.type==='text_delta'&&delta.text){partial=true;receivedText=true;text+=delta.text;opts.onText?.(delta.text);}
   }
   if(msg.type==='assistant'&&!seen.has(msg.uuid??msg.message?.id)){
    seen.add(msg.uuid??msg.message?.id);
    if(!partial){const chunk=(msg.message?.content??[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('');text+=chunk;if(chunk){receivedText=true;opts.onText?.(chunk);}}
    partial=false;
   }
   if(msg.type==='result'){
    sawResult=true;sessionId=msg.session_id||sessionId;if(sessionId)opts.onSessionId?.(sessionId);
    const u=msg.usage;if(u)usage={inputTokens:u.input_tokens??0,outputTokens:u.output_tokens??0,cacheReadTokens:u.cache_read_input_tokens??0,cacheCreationTokens:u.cache_creation_input_tokens??0,costUsd:0};
    if(msg.is_error||msg.subtype!=='success')throw Error((msg.errors??[]).join('\n')||msg.result||'Qoder turn failed');
    if(!receivedText&&msg.result){text+=msg.result;opts.onText?.(msg.result);}break;
   }
  }
  if(controller.signal.aborted)throw Error('aborted');
  if(!sawResult)throw Error('Qoder 在返回完成事件前退出；保留当前会话，检查 CLI 登录状态后继续。');
  rec?.finish({response:{text,sessionId},usage});return {text,sessionId,usage};
 }catch(e:any){const error=controller.signal.aborted?'aborted':String(e.message??e);rec?.fail(error);return {text,sessionId,usage,error};}
 finally{opts.signal?.removeEventListener('abort',abort);controller.abort();await interrupt;await settleWithin(Promise.resolve().then(()=>q?.close()),1500);sdkController.abort();if(child)stopCli(child);}
}
