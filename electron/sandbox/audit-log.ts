/** Global append-only decision history, enriched from the immutable execution context. */
import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { appendAuditRecord, auditDirectory, auditFiles, auditProjectKey, maintainAuditStorage, readAuditTail } from './audit-storage';
import { join } from 'node:path';
import { app } from 'electron';
import { contextualAudit } from './conversation-policy';
import type { AuditEntry, AuditQuery } from '../../shared/types';
export type { AuditEntry } from '../../shared/types';
/** Retained for old clients; never changes the writer's destination. */
export function setAuditProject(_project: string | null): void {}
export function getAuditLogPath(): string { const userData=app.getPath('userData');maintainAuditStorage(userData);return auditDirectory(userData); }
export function audit(entry: AuditEntry): void {
  try {
    const detail=Object.fromEntries(Object.entries(entry.detail).slice(0,32).filter(([,v])=>typeof v==='string').map(([k,v])=>[k,typeof v==='string'?v.slice(0,8000):v]));
    const ctx=contextualAudit();
    const record={...ctx,...entry,profileId:ctx?.profileId??entry.profileId,profileName:ctx?.profileName??entry.profileName,convId:entry.convId??ctx?.convId,projectPath:entry.projectPath??ctx?.projectPath,detail};
    appendAuditRecord(app.getPath('userData'),record.projectPath,JSON.stringify(record)+'\n');
  } catch(error){console.error('[audit] write failed',error);}
}
type Context=Partial<Pick<AuditEntry,'projectPath'|'convId'|'stage'|'category'|'profileId'|'profileName'>>;
export function auditAllow(source:AuditEntry['source'],tool:string,detail:AuditEntry['detail'],ctx?:Context){audit({ts:new Date().toISOString(),source,tool,action:'allow',stage:'execution',...ctx,detail:{reason:'执行边界检查通过：操作符合路径、网络或执行授权约束',...detail}});}
export function auditDeny(source:AuditEntry['source'],tool:string,detail:AuditEntry['detail'],ctx?:Context){audit({ts:new Date().toISOString(),source,tool,action:'deny',stage:'execution',category:source==='fs'?'文件保护':source==='net'?'网页访问':source==='bash'?'命令规则':'工具',...ctx,detail});}
export function readAuditLog(query:AuditQuery|number=500,projects:string[]=[]):{entries:AuditEntry[];error?:string}{
  const q=typeof query==='number'?{limit:query}:query;
  const userData=app.getPath('userData');
  try { maintainAuditStorage(userData); } catch(error) { return {entries:[],error:String(error)}; }
  const p=join(userData,'decisions.log');
  const shards=auditFiles(userData).filter(f=>!q.projectPath||!f.project||f.project===auditProjectKey(q.projectPath)).map(f=>f.path);
  const paths=[...shards,p,`${p}.1`,`${p}.2`,join(app.getPath('userData'),'audit.log'),...projects.flatMap(project=>[join(project,'.sage','audit.log'),join(project,'.sage','audit.log.1.log'),join(project,'.sage','audit.log.2.log')])];
  const entries:AuditEntry[]=[];const seen=new Set<string>();
  // Bound work even when retention has been configured to several gigabytes.
  let remaining=100*1024*1024,truncated=false;
  for(const file of paths){
    try{if(!existsSync(file))continue;if(remaining<=0){truncated=true;break;}const size=statSync(file).size;const text=readAuditTail(file,remaining);truncated ||= size>remaining;remaining-=Math.min(size,remaining);for(const line of text.split('\n')){if(!line.trim())continue;const digest=createHash('sha256').update(line).digest('hex');if(seen.has(digest))continue;seen.add(digest);try{
      const e=JSON.parse(line) as AuditEntry;
      if(typeof e.ts!=='string'||!e.detail||typeof e.detail!=='object'||!['allow','deny','approve','review','cancel'].includes(e.action))continue;
      e.detail=Object.fromEntries(Object.entries(e.detail).filter(([,v])=>typeof v==='string'));
      for(const key of ['profileId','profileName','convId','convTitle','projectPath','tool','stage','category'] as const)if(e[key]!==undefined&&typeof e[key]!=='string')delete e[key];
      if(!e.projectPath){const project=projects.find(project=>file.startsWith(join(project,'.sage')+'/'));if(project)e.projectPath=project;}
      if(q.profileId&&e.profileId!==q.profileId||q.convId&&e.convId!==q.convId||q.projectPath&&e.projectPath!==q.projectPath)continue;
      entries.push(e);
    }catch{/* malformed legacy lines */}}
    entries.sort((a,b)=>b.ts.localeCompare(a.ts));entries.splice(Math.min(10000,Math.max(1,q.limit??2000)));
    }catch(error){return {entries:[],error:String(error)};}
  }
  return {entries:entries.sort((a,b)=>b.ts.localeCompare(a.ts)).slice(0,Math.min(10000,Math.max(1,q.limit??2000))),...(truncated?{error:'日志较多，本次仅检索前 100 MB；更早记录请在日志目录中查看。 / Search limited to 100 MB; older records remain in the log folder.'}:{})};
}
