import {readDataRetention} from '../data-retention';
/** Date/project shards with bounded retention. Legacy logs remain readable. */
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync, unlinkSync, readdirSync, rmdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
export const AUDIT_SHARD_BYTES = 5 * 1024 * 1024;
export const AUDIT_TOTAL_BYTES = 100 * 1024 * 1024;
export const AUDIT_RETENTION_DAYS = 30;
const DAY = 86400000;
const lastCleanup = new Map<string, {time:number;policy:string}>();
export const auditDirectory = (userData: string) => join(userData, 'decisions');
export function auditProjectKey(project?: string): string {
  return project ? basename(project).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) + '-' + createHash('sha256').update(resolve(project)).digest('hex').slice(0, 24) : 'global';
}
function dayName(now: number) { const date = new Date(now); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
export function auditFiles(userData: string): {path:string;size:number;mtime:number;day?:string;project?:string}[] {
  const root = auditDirectory(userData);
  if (!existsSync(root)) return [];
  const files = [];
  for (const dir of readdirSync(root, {withFileTypes:true})) {
    if (!dir.isDirectory() || (!/^\d{4}-\d{2}-\d{2}$/.test(dir.name) && dir.name !== 'legacy')) continue;
    for (const file of readdirSync(join(root, dir.name), {withFileTypes:true})) {
      if (!file.isFile() || !(dir.name === 'legacy' ? /^decisions\.log(?:\.[12])?$/.test(file.name) : /^(?:global|[\w-]+-[a-f0-9]{24})-\d{6}\.jsonl$/.test(file.name))) continue;
      const p=join(root,dir.name,file.name),info=statSync(p);
      files.push({path:p,size:info.size,mtime:info.mtimeMs,day:dir.name==='legacy'?undefined:dir.name,project:dir.name==='legacy'?undefined:file.name.replace(/-\d{6}\.jsonl$/,'')});
    }
  }
  return files.sort((a,b)=>b.mtime-a.mtime || b.path.localeCompare(a.path));
}
export function maintainAuditStorage(userData: string, now=Date.now(), force=false): void {
  const config=readDataRetention(userData),signature=JSON.stringify(config),last=lastCleanup.get(userData);
  if (!force && last?.policy===signature && now-last.time<3600000) return;
  const root=auditDirectory(userData);mkdirSync(root,{recursive:true});
  for (const name of ['decisions.log','decisions.log.1','decisions.log.2']) {
    const old=join(userData,name),to=join(root,'legacy',name);
    if (existsSync(old) && !existsSync(to)) {mkdirSync(join(root,'legacy'),{recursive:true});renameSync(old,to);}
  }
  const files=auditFiles(userData);let total=files.reduce((n,f)=>n+f.size,0);
  for (const file of [...files].reverse()) {
    const expired=file.day ? file.day<dayName(now-config.decisionDays*DAY) : file.mtime<now-config.decisionDays*DAY;
    if (expired || total>config.decisionTotalMB*1024*1024) {unlinkSync(file.path);total-=file.size;}
  }
  for (const dir of readdirSync(root,{withFileTypes:true})) {
    if (!dir.isDirectory() || (!/^\d{4}-\d{2}-\d{2}$/.test(dir.name) && dir.name!=='legacy')) continue;
    const p=join(root,dir.name);if (readdirSync(p).length===0) rmdirSync(p);
  }
  lastCleanup.set(userData,{time:now,policy:signature});
}
export function appendAuditRecord(userData: string, project: string | undefined, line: string, now=Date.now()): string {
  maintainAuditStorage(userData,now);
  const dir=join(auditDirectory(userData),dayName(now));mkdirSync(dir,{recursive:true});
  const key=auditProjectKey(project);
  const shards=readdirSync(dir).filter(n=>n.startsWith(key+'-')&&/\d{6}\.jsonl$/.test(n)).sort();
  let index=shards.length?Number(shards.at(-1)!.match(/(\d{6})\.jsonl$/)![1]):1;
  const size=Buffer.byteLength(line);
  const maxBytes=readDataRetention(userData).decisionFileMB*1024*1024;
  let file=join(dir,`${key}-${String(index).padStart(6,'0')}.jsonl`);
  if (existsSync(file)&&statSync(file).size+size>maxBytes) file=join(dir,`${key}-${String(++index).padStart(6,'0')}.jsonl`);
  const newShard=!existsSync(file);
  appendFileSync(file,line,'utf8');
  if(newShard) maintainAuditStorage(userData,now,true);
  return file;
}
/** Cap old unsplit files too; omit a partial leading line when reading a tail. */
export function readAuditTail(file: string, maxBytes=100*1024*1024): string {
  const fd=openSync(file,'r');
  try { const size=statSync(file).size,start=Math.max(0,size-maxBytes),buf=Buffer.alloc(Math.min(size,maxBytes));const length=readSync(fd,buf,0,buf.length,start);const text=buf.subarray(0,length).toString('utf8');return start>0?text.slice(text.indexOf('\n')+1):text; }
  finally {closeSync(fd);}
}
