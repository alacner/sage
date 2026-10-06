import { matchConvGrant, recordGrantedCall } from './conversation-grants';
export { grantConversation } from './conversation-grants';
import { contextualAudit } from './conversation-policy';
import { isDeniedRead, isDeniedWrite, enforceInsideProject, matchedFileRule } from './fs-policy';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ConversationMeta, AuditStage } from '../../shared/types';
import { commandPolicy, decideCommand, approveCommand } from './command-decision';
import { checkUrl, getAllowedHosts } from './net-policy';
import { reportReview } from './review-status';
import { preReviewBash } from './pre-review';
import { autoApproveProjectTool } from '../project-scope';
import { readSettings } from '../main';
import { audit } from './audit-log';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const grants=new Map<string,{url:string;project:string;policy:string;expires:number;convId?:string}>();
async function issueWeb(input:any,meta:ConversationMeta){
  for(const [key,g] of grants)if(g.expires<Date.now())grants.delete(key);
  if(grants.size>=512)grants.delete(grants.keys().next().value!);
  const token=randomBytes(24).toString('hex');
  grants.set(token,{convId:contextualAudit()?.convId,url:new URL(input.url).href,project:resolve(meta.projectPath),policy:digest(await commandPolicy(meta.projectPath)),expires:Date.now()+60000});
  return {...input,__sageWebApproval:token};
}
export async function consumeWebApproval(input:any,project:string):Promise<boolean>{
  const token=input?.__sageWebApproval;if(typeof token!=='string')return false;
  const grant=grants.get(token);grants.delete(token);
  if(!grant||grant.convId!==contextualAudit()?.convId||grant.expires<Date.now()||grant.project!==resolve(project)||grant.url!==new URL(input.url).href||grant.policy!==digest(await commandPolicy(project)))throw Error('网页授权已失效，请重新审核');
  return true;
}
export function recordDecision(tool:string,input:any,meta:ConversationMeta,decision:'allow'|'deny'|'ask'|'cancel',stage:AuditStage,reason:string,category?:string){
  audit({ts:new Date().toISOString(),source:tool==='Bash'?'bash':tool==='WebFetch'?'net':['Read','Write','Edit','Glob','Grep','MultiEdit','NotebookEdit'].includes(tool)?'fs':'tool',tool,action:decision==='ask'?'review':decision,stage,category,projectPath:meta.projectPath,convId:meta.id,profileId:contextualAudit()?.profileId ?? meta.securityProfile?.id,profileName:contextualAudit()?.profileName ?? meta.securityProfile?.name,detail:{command:input?.command,path:input?.file_path??input?.notebook_path??input?.path??(['Glob','Grep'].includes(tool)?meta.projectPath:undefined),pattern:input?.pattern,url:input?.url,reason}});
}
export async function decideTool(toolName:string,input:any,meta:ConversationMeta,signal?:AbortSignal){
  const tool=toolName.replace(/^mcp__sage__/,'');
  if(!signal?.aborted){
    const scope=matchConvGrant(meta.id,tool,input);
    if(scope){
      // Deterministic hard-deny and runtime capability checks remain authoritative.
      const policy=await commandPolicy(meta.projectPath);
      if(tool==='Bash'){
        const {classifyCommand}=await import('./command-decision');
        const base=classifyCommand(String(input?.command??''),meta.projectPath,policy);
        if(base.decision==='deny'){recordDecision(tool,input,meta,'deny','direct-deny',base.reason);return base;}
      }
      try{const approved=await approveTool(toolName,input,meta);recordGrantedCall(meta.id,tool,input);const reason=scope==='all'?'命中本对话授权':'命中同命令本对话授权';recordDecision(tool,input,meta,'allow','human-review',reason,'会话授权');reportReview({state:'approved',detail:reason,startedAt:Date.now(),finishedAt:Date.now()});return {decision:'allow' as const,reason,stage:'human-review' as const,input:approved};}catch{}
    }
  }
  const review=tool==='Bash'?await decideCommand(input,meta,signal):await decideOtherTool(tool,input,meta,signal);
  // 会话级批量授权：把「转人工」的 ask 转为 allow。
  // 只在常规决策之后生效：直接拒绝规则、AI 预审 deny 均不被绕过；
  // 签发仍走 approveTool/approveCommand，执行沙箱与联网令牌机制不变。
  if(review.decision==='ask'&&!signal?.aborted){
    const scope=matchConvGrant(meta.id,tool,input);
    if(scope){
      try{
        const approved=await approveTool(toolName,review.input??input,meta);
        recordGrantedCall(meta.id,tool,input);
        const reason=scope==='all'?'命中会话授权：本对话都通过':'命中会话授权：同命令本对话都通过';
        recordDecision(tool,input,meta,'allow','human-review',reason,'会话授权');
        return {decision:'allow' as const,reason,stage:'human-review' as const,input:approved};
      }catch(e:any){
        recordDecision(tool,input,meta,'deny','human-review',`会话授权签发失败：${e?.message??e}`,'会话授权');
        return review;
      }
    }
  }
  return review;
}
async function decideOtherTool(tool:string,input:any,meta:ConversationMeta,signal?:AbortSignal){
  const policy=await commandPolicy(meta.projectPath);
  const fileTool=['Read','Write','Edit','MultiEdit','NotebookEdit','Glob','Grep'].includes(tool);
  if(fileTool&&!policy.runtime?.fullAccess){
    const path=String(input?.file_path??input?.notebook_path??input?.path??meta.projectPath);
    const writing=['Write','Edit','MultiEdit','NotebookEdit'].includes(tool);
    const denied=writing?isDeniedWrite(path,policy.fs,meta.projectPath):isDeniedRead(path,policy.fs,meta.projectPath);
    if(denied){const reason=`文件保护规则拒绝${writing?'修改':'读取'}：${path}；命中 ${matchedFileRule(path,writing,policy.fs,meta.projectPath)??'文件保护规则'}`;recordDecision(tool,input,meta,'deny','direct-deny',reason,'文件保护');return {decision:'deny' as const,reason,stage:'direct-deny' as const,input};}
    try{enforceInsideProject(path,meta.projectPath,!writing);}catch(e:any){recordDecision(tool,input,meta,'deny','execution',e.message,'文件保护');return {decision:'deny' as const,reason:e.message,stage:'execution' as const,input};}
  }
  let decision:'allow'|'deny'|'ask'='ask';let reason='未命中直接允许规则';let stage:AuditStage='direct-allow';
  if(policy.runtime?.fullAccess){decision='allow';stage='full-access';reason='用户选择完全访问权限';}
  else if(tool==='WebFetch'){
    const check=checkUrl(String(input?.url??''),getAllowedHosts());
    decision=check.ok?'allow':check.decision??'deny';reason=check.reason??'命中网页直接允许规则';
    if(decision==='deny')stage='direct-deny';
  }else if(await autoApproveProjectTool(tool,input,meta.projectPath,readSettings)){decision='allow';reason=['Read','Glob','Grep'].includes(tool)?'命中内置项目内只读规则：Read / Glob / Grep；目标必须位于当前项目内':'命中 review.projectFiles=true（项目内文件修改自动允许）；目标必须位于当前项目内';}
  if(decision==='ask'&&policy.review?.enabled){
    const review=await preReviewBash(tool,input,meta,policy,signal);decision=review.decision;reason=review.reason;stage='ai-review';
  }else if(decision==='ask'){stage='human-review';reason='AI 预审未开启，转人工审核';}
  if(signal?.aborted){decision='deny';reason='操作已取消';}
  recordDecision(tool,input,meta,signal?.aborted?'cancel':decision,stage,reason,tool==='WebFetch'?'网页访问':undefined);
  return {decision,reason,stage,input:decision==='allow'&&tool==='WebFetch'?await issueWeb(input,meta):input};
}
export async function approveTool(toolName:string,input:any,meta:ConversationMeta){
  const tool=toolName.replace(/^mcp__sage__/,'');
  if(tool==='Bash')return approveCommand(input,meta);
  if(['Read','Write','Edit','MultiEdit','NotebookEdit','Glob','Grep'].includes(tool)){
    const policy=await commandPolicy(meta.projectPath);
    if(!policy.runtime?.fullAccess){
      const path=String(input?.file_path??input?.notebook_path??input?.path??meta.projectPath),writing=['Write','Edit','MultiEdit','NotebookEdit'].includes(tool);
      if(writing?isDeniedWrite(path,policy.fs,meta.projectPath):isDeniedRead(path,policy.fs,meta.projectPath))throw Error('文件保护规则拒绝此操作');
      enforceInsideProject(path,meta.projectPath,!writing);
    }
  }
  if(tool==='WebFetch'){
    const check=checkUrl(String(input?.url??''),getAllowedHosts());
    if(!check.ok&&check.decision!=='ask')throw Error(check.reason);
    return issueWeb(input,meta);
  }
  return input;
}
