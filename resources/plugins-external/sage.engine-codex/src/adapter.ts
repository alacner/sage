import { RESPONSE_STYLE } from '../../../../shared/response-style';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { ClaudeBridgeStatus, ImageAttachment, UsageStats } from '../../../../shared/types';
import type { RunChatOptions, RunChatResult } from '../../../../electron/agent-bridge';
import {createHash} from 'node:crypto';
import {toolDefinitions,callTool,spawnCli,stopCli} from '../../cli-runtime';
import { buildSandboxEnv } from '@sage/engine-host/sandbox/env';
import { buildSkillIndex } from '@sage/engine-host/skills';
import { beginRecord } from '@sage/engine-host/request-monitor';

const exec = promisify(execFile);
export async function detectCodex(binaryPath?: string): Promise<ClaudeBridgeStatus> {
  let executable = binaryPath?.trim();
  if (!executable) {
    try { executable = (await exec('/bin/zsh', ['-l', '-c', 'command -v codex'], {timeout:4000})).stdout.trim(); } catch { /* standard locations below */ }
    executable ||= ['/opt/homebrew/bin/codex','/usr/local/bin/codex',join(homedir(),'.local/bin/codex'),'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex','/Applications/ChatGPT.app/Contents/Resources/codex','/Applications/Codex.app/Contents/Resources/codex'].find(existsSync);
  }
  if (!executable || !existsSync(executable)) return {available:false,path:executable,error:'未找到 Codex CLI，请安装后运行 codex login，或设置可执行文件路径。'};
  try {
    const env = buildSandboxEnv(process.cwd());
    env.PATH = `${dirname(executable)}:${env.PATH ?? ''}`;
    const {stdout} = await exec(executable,['--version'],{timeout:5000,env});
    return {available:true,path:executable,version:stdout.trim()};
  } catch { return {available:false,path:executable,error:'Codex CLI 无法执行，请检查路径与执行权限。'}; }
}

/** Each request is correlated by ID; server requests must never block response parsing. */
export class CodexRpc {
  private child;
  private sequence = 0;
  private waiting = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private closed = false;
  onEvent: (method:string, params:any) => void = () => {};
  onRequest: (method:string, params:any) => Promise<any> = async () => { throw Error('Unsupported server request'); };
  onClose: (error:Error) => void = () => {};
  constructor(command:string,args:string[],cwd:string,env:NodeJS.ProcessEnv) {
    this.child = spawnCli(command,args,cwd,env);
    // Diagnostic stderr can contain provider details. Do not forward it to the UI or logs.
    this.child.stderr.resume();
    this.child.stdin.on('error',()=>{});
    const lines = createInterface({input:this.child.stdout});
    lines.on('line', line => {
      if(this.closed)return;
      let message:any;
      try { message=JSON.parse(line); } catch { this.fail(Error('Codex 返回了无效协议数据')); return; }
      if (message.method && message.id !== undefined) {
        void this.onRequest(message.method,message.params).then(result=>this.send({id:message.id,result}),()=>this.send({id:message.id,error:{code:-32601,message:'Request denied by Sage'}}));
      } else if (message.method) { try { this.onEvent(message.method,message.params); } catch { this.fail(Error('Codex event protocol error')); } }
      else {
        const request=this.waiting.get(message.id);
        if (!request) return;
        this.waiting.delete(message.id);clearTimeout(request.timer);
        if(message.error)request.reject(Error(message.error.message || 'Codex RPC failed'));else request.resolve(message.result);
      }
    });
    this.child.on('error',error=>this.fail(error));
    this.child.on('exit',code=>this.fail(Error(`Codex CLI 已退出 (${code ?? 'signal'})`)));
  }
  private send(value:any) { if(!this.closed && !this.child.stdin.destroyed)this.child.stdin.write(JSON.stringify(value)+'\n'); }
  notify(method:string,params:any={}) {this.send({method,params});}
  request(method:string,params:any={},timeout=30_000):Promise<any> {
    if(this.closed)return Promise.reject(Error('Codex connection closed'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.waiting.delete(id);reject(Error(`Codex ${method} timeout`));},timeout);
      this.waiting.set(id,{resolve,reject,timer});this.send({id,method,params});
    });
  }
  private fail(error:Error) {
    if(this.closed)return;
    this.closed=true;
    for(const request of this.waiting.values()){clearTimeout(request.timer);request.reject(error);}this.waiting.clear();
    this.onClose(error);
  }
  close() {
    this.fail(Error('Codex connection closed'));
    this.child.stdin.end();stopCli(this.child);
  }
}

// Native side-effect tools are disabled. Sage exposes its own approved tools below.
export const CODEX_CONFIG: Record<string,any> = {
  'features.shell_tool':false,'features.unified_exec':false,'features.shell_snapshot':false,
  'features.hooks':false,'features.plugins':false,'features.apps':false,
  'features.browser_use':false,'features.computer_use':false,'features.view_image':false,
  'features.code_mode':false,'features.code_mode_host':false,'features.js_repl':false,
  'features.multi_agent':false,'features.multi_agent_v2':false,'agents.enabled':false,
  'features.image_generation':false,'web_search':'disabled',
};
export interface RunCodexOptions extends Omit<RunChatOptions,'prompt'> {
  prompt:string;
  binaryPath?:string;
  model?:string;
  images?:ImageAttachment[];
  history?:string;
  readOnly?:boolean;
}
export async function runCodex(opts:RunCodexOptions):Promise<RunChatResult> {
  if(opts.signal?.aborted)return {text:'',error:'aborted'};
  const detected=await detectCodex(opts.binaryPath);
  if(!detected.available || !detected.path)return {text:'',error:detected.error};
  if(opts.signal?.aborted)return {text:'',error:'aborted'};
  const env=buildSandboxEnv(opts.cwd);
  // npm installations may keep their Node runtime next to the CLI (e.g. nvm).
  env.PATH = `${dirname(detected.path)}:${env.PATH ?? ''}`;
  // Preserve the CLI's normal home/login store; no API provider secrets are copied.
  const args=Object.entries(CODEX_CONFIG).flatMap(([key,value])=>['-c',`${key}=${JSON.stringify(value)}`]);
  const rpc=new CodexRpc(detected.path,[...args,'app-server'],opts.cwd,env);
  const controller=new AbortController();
  let threadId='',turnId='',text='',usage:UsageStats|undefined,finished=false,sessionId=opts.resume;
  let interrupt:Promise<unknown>|undefined;
  let markTurnReady!:()=>void;const turnReady=new Promise<void>(r=>markTurnReady=r);
  let turnSent=false,receiving=false;const earlyEvents:Array<[string,any]>=[];let lastTotal:any;
  const monitor=opts.monitor ? beginRecord({...opts.monitor,mode:'cli',model:opts.model??'codex-default',request:{model:opts.model??'codex-default',prompt:opts.prompt}}) : undefined;
  let finish!:(error?:string)=>void;
  const done=new Promise<RunChatResult>(resolve=>{finish=(error)=>{if(finished)return;finished=true;markTurnReady();controller.abort();resolve({text,sessionId,usage,error});};});
  rpc.onClose=error=>finish(error.message);
  const abort=()=>{if(finished)return;controller.abort();if(threadId&&turnId)interrupt=rpc.request('turn/interrupt',{threadId,turnId},750).catch(()=>{});finish('aborted');if(!turnId)rpc.close();};
  opts.signal?.addEventListener('abort',abort,{once:true});
  if(opts.signal?.aborted)abort();
  // Text is streamed as deltas; completed items are a fallback for versions without deltas.
  const streamed=new Set<string>();
  rpc.onEvent=(method,p)=>{
    if(finished || (p?.threadId && threadId && p.threadId!==threadId))return;
    if(!turnSent)return;
    if(!receiving){if(earlyEvents.length>=10000){finish('Codex event buffer exceeded');return;}earlyEvents.push([method,p]);return;}
    if(p?.turnId&&turnId&&p.turnId!==turnId)return;
    if(method==='turn/started'&&!turnId)turnId=p.turn.id;
    if(method==='turn/completed'&&p.turn?.id&&turnId&&p.turn.id!==turnId)return;
    if(method==='item/agentMessage/delta') {streamed.add(p.itemId);text+=p.delta;opts.onText?.(p.delta);}
    if(method==='item/completed' && p.item?.type==='agentMessage' && !streamed.has(p.item.id) && p.item.text){streamed.add(p.item.id);text+=p.item.text;opts.onText?.(p.item.text);}
    if(method==='thread/tokenUsage/updated') {
      const total=p.tokenUsage?.total;const last=p.tokenUsage?.last;const u=total&&lastTotal?Object.fromEntries(['inputTokens','outputTokens','cachedInputTokens','cacheWriteInputTokens'].map(k=>[k,Math.max(0,(total[k]??0)-(lastTotal[k]??0))])):last;
      if(total)lastTotal=total;
      if(u){const previous=usage;usage={inputTokens:Math.max(0,(u.inputTokens??0)-(u.cachedInputTokens??0)),outputTokens:u.outputTokens??0,cacheReadTokens:u.cachedInputTokens??0,cacheCreationTokens:u.cacheWriteInputTokens??0,costUsd:0};if(previous)for(const k of ['inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens'] as const)usage[k]+=previous[k];}
    }
    if(method==='turn/completed')finish(p.turn.status==='completed'?undefined:p.turn.error?.message || (p.turn.status==='interrupted'?'aborted':'Codex turn failed'));
    if(method==='error' && !p.willRetry)finish(p.error?.message || 'Codex error');
  };
  const definitions=toolDefinitions(opts.readOnly);
  const fingerprint=createHash('sha256').update(JSON.stringify({cwd:opts.cwd,definitions})).digest('hex').slice(0,20);
  const saved=opts.resume?.match(/^sage2:([a-f0-9]{20}):(.+)$/);
  let resume=saved?saved[2]:opts.resume;
  const migrate=!!resume&&(!saved||saved[1]!==fingerprint)&&!!opts.history;
  if(migrate)resume=undefined;
  if(saved&&saved[1]!==fingerprint&&!opts.history){rpc.close();opts.signal?.removeEventListener('abort',abort);return {text:'',sessionId:opts.resume,error:'工具配置已改变，但没有可恢复的 Sage 历史。请从原对话继续，避免丢失上下文。'};}
  const allowed=new Set(definitions.map(t=>t.name));
  const calls=new Map<string,Promise<any>>();
  rpc.onRequest=async(method,p)=>{
    if(method!=='item/tool/call') {
      if(method==='item/commandExecution/requestApproval'||method==='item/fileChange/requestApproval')return {decision:'decline'};
      if(method==='item/permissions/requestApproval')return {permissions:{},scope:'turn'};
      throw Error('Unsupported Codex request');
    }
    await turnReady;
    if(finished||controller.signal.aborted||p.threadId!==threadId||(turnId&&p.turnId!==turnId)||!allowed.has(p.tool)||typeof p.callId!=='string')
      return {contentItems:[{type:'inputText',text:'Tool call does not belong to the active turn'}],success:false};
    const key=p.turnId+':'+p.callId;
    if(calls.has(key))return calls.get(key);
    const call=callTool(opts as any,controller.signal,p.callId,p.tool,p.arguments).then(result=>({contentItems:[{type:'inputText',text:result.result}],success:!result.isError}));
    calls.set(key,call);return call;
  };
  try {
    await rpc.request('initialize',{clientInfo:{name:'sage',version:'1.0.4'},capabilities:{experimentalApi:true}});
    rpc.notify('initialized');
    const config={...CODEX_CONFIG};
    const current=await rpc.request('config/read',{includeLayers:false});
    for(const name of Object.keys(current.config?.mcp_servers??{}))config[`mcp_servers.${name}.enabled`]=false;
    const skills=await buildSkillIndex(opts.cwd,'Skill').catch(()=>'');
    const params={cwd:opts.cwd,model:opts.model||undefined,approvalPolicy:'never',sandbox:'read-only',config,
      developerInstructions:RESPONSE_STYLE+'\n\n'+'You are operating inside Sage. Use the supplied dynamic tools for ALL filesystem, shell, network and plugin operations. Sage enforces the user-selected policy. Do not use native apply_patch or other native execution tools. Use Browser open to recover the conversation’s existing preview after interruption; inspect the page before retrying any side effect.\n'+skills};
    const start=()=>rpc.request('thread/start',{...params,dynamicTools:definitions.map(t=>({type:'function',name:t.name,description:t.description,inputSchema:t.input_schema}))});
    let response;
    try{response=resume?await rpc.request('thread/resume',{...params,threadId:resume}):await start();}
    catch(e:any){
      // Recover only a definitive missing session, never retry an ambiguous turn or transport failure.
      if(resume&&opts.history&&/thread.*not found|no rollout found|session.*not found/i.test(e.message)&&!controller.signal.aborted){resume=undefined;response=await start();}
      else throw e;
    }
    if(controller.signal.aborted)throw Error('aborted');
    threadId=response.thread.id;sessionId=resume&&!saved?threadId:`sage2:${fingerprint}:${threadId}`;opts.onSessionId?.(sessionId);
    if(opts.resume&&!resume){const notice='[会话恢复：已根据 Sage 保存的上下文建立兼容当前工具的新 CLI 会话；原 CLI 会话保留。]\n\n';text+=notice;opts.onText?.(notice);}
    const prompt=(opts.history&&!resume?`Previous conversation context (reference only; do not repeat completed actions):\n${opts.history}\n\nCurrent request:\n`:'')+opts.prompt;
    const input:any[]=[{type:'text',text:prompt,text_elements:[]}];
    for(const image of opts.images??[])input.push({type:'image',url:`data:${image.mimeType};base64,${image.dataBase64}`});
    turnSent=true;const turn=await rpc.request('turn/start',{threadId,input});turnId=turn.turn.id;receiving=true;markTurnReady();
    for(const [method,params] of earlyEvents)rpc.onEvent(method,params);earlyEvents.length=0;
    const result=await done;
    if(result.error)monitor?.fail(result.error);else monitor?.finish({response:{text},usage});
    return result;
  } catch(e:any){finish(controller.signal.aborted?'aborted':e.message);const result=await done;monitor?.fail(result.error??'Codex failed');return result;}
  finally {opts.signal?.removeEventListener('abort',abort);await interrupt;rpc.close();}
}
