import {formatDateTime,useDateTimeSettings} from '../lib/date-time';
import {useState,useEffect,useCallback,useRef} from 'react';
import type {AuditEntry,AuditQuery} from '../../shared/types';
import {useSecurityCopy} from './SecurityProfileIcon';
export function SandboxAuditLog({profileId,convId}:{profileId?:string;convId?:string}={}) {
  useDateTimeSettings();
  const copy=useSecurityCopy();const revision=useRef(0);
  const [entries,setEntries]=useState<AuditEntry[]>([]);
  const [error,setError]=useState('');const [loading,setLoading]=useState(false);
  const [action,setAction]=useState('');const [stage,setStage]=useState('');const [project,setProject]=useState('');const [profile,setProfile]=useState(profileId??'');const [conversation,setConversation]=useState(convId??'');const [search,setSearch]=useState('');
  useEffect(()=>{setProfile(profileId??'');setConversation(convId??'');setProject('');setStage('');setAction('');setSearch('');},[profileId,convId]);
  const load=useCallback(async()=>{const request=++revision.current;setLoading(true);setError('');try{const q:AuditQuery={limit:10000,profileId,convId};const r=await window.api.getAuditLog(q);if(request!==revision.current)return;setEntries(r.entries??[]);setError(r.error??'');}catch(e:any){if(request===revision.current)setError(e.message);}finally{if(request===revision.current)setLoading(false);}},[profileId,convId]);
  useEffect(()=>{void load();return()=>{revision.current++;};},[load]);
  const stages:Record<string,string>={'direct-deny':copy('直接拒绝','Direct deny'),'direct-allow':copy('直接允许','Direct allow'),'ai-review':copy('AI 预审','AI review'),'human-review':copy('人工审核','Human review'),execution:copy('执行边界检查','Execution boundary'),'full-access':copy('完全访问权限','Full access'),hook:copy('Hook 拦截','Hook block')};
  const actions:Record<string,string>={cancel:copy('已取消','Cancelled'),allow:copy('放行','Allow'),deny:copy('拒绝','Deny'),approve:copy('批准','Approve'),review:copy('转人工审核','Human review required')};
  const filtered=entries.filter(e=>(!action||e.action===action)&&(!stage||(e.stage??'legacy')===stage)&&(!project||e.projectPath===project)&&(!profile||e.profileId===profile)&&(!conversation||e.convId===conversation)&&(!search||JSON.stringify(e).toLowerCase().includes(search.toLowerCase())));
  const options=(key:'projectPath'|'profileId'|'convId')=>[...new Map(entries.filter(e=>e[key]).map(e=>[e[key]!,key==='profileId'?e.profileName??e[key]!:key==='convId'?e.convTitle??e[key]!:e[key]!])).entries()];
  return <div className="sandbox-audit decision-history">
    <p className="security-muted">{copy('汇总各项目、对话的决策；记录保留当次使用的方案和理由。','Decisions across projects and conversations retain the policy and reason used at the time.')}</p>
    <div className="decision-filters">
      <input aria-label={copy('搜索决策','Search decisions')} placeholder={copy('搜索操作、理由、项目或对话…','Search operations, reasons, projects or conversations…')} value={search} onChange={e=>setSearch(e.target.value)}/>
      <select aria-label={copy('决策结果','Decision result')} value={action} onChange={e=>setAction(e.target.value)}><option value="">{copy('全部结果','All results')}</option>{Object.entries(actions).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>
      <select aria-label={copy('决策层级','Decision stage')} value={stage} onChange={e=>setStage(e.target.value)}><option value="">{copy('全部层级','All stages')}</option>{Object.entries(stages).map(([id,label])=><option key={id} value={id}>{label}</option>)}<option value="legacy">{copy('旧记录（层级未知）','Legacy (unknown stage)')}</option></select>
      <select aria-label={copy('项目','Project')} value={project} onChange={e=>setProject(e.target.value)}><option value="">{copy('全部项目','All projects')}</option>{options('projectPath').map(([id,label])=><option value={id} key={id}>{label}</option>)}</select>
      <select aria-label={copy('方案','Policy')} value={profile} disabled={!!profileId} onChange={e=>setProfile(e.target.value)}><option value="">{copy('全部方案','All policies')}</option>{options('profileId').map(([id,label])=><option value={id} key={id}>{label}</option>)}{profileId&&!options('profileId').some(([id])=>id===profileId)&&<option value={profileId}>{profileId}</option>}</select>
      <select aria-label={copy('对话','Conversation')} value={conversation} disabled={!!convId} onChange={e=>setConversation(e.target.value)}><option value="">{copy('全部对话','All conversations')}</option>{options('convId').map(([id,label])=><option value={id} key={id}>{label}</option>)}{convId&&!options('convId').some(([id])=>id===convId)&&<option value={convId}>{convId}</option>}</select>
      <button className="btn-secondary" disabled={loading} onClick={()=>void load()}>{copy('刷新','Refresh')}</button><button className="btn-secondary" onClick={()=>void window.api.openAuditLogInFinder()}>{copy('打开日志目录','Open log folder')}</button>
    </div>
    <p className="security-muted">{copy(`共 ${filtered.length} 条 · 放行 ${filtered.filter(e=>['allow','approve'].includes(e.action)).length} · 拒绝 ${filtered.filter(e=>e.action==='deny').length} · 取消 ${filtered.filter(e=>e.action==='cancel').length}`,`${filtered.length} decisions`)}</p>
    {error&&<p role="alert">{error}</p>}{loading?<p>{copy('加载中…','Loading…')}</p>:filtered.length===0?<p>{copy('暂无符合条件的决策记录','No matching decisions')}</p>:<div className="decision-entries">{filtered.map((e,i)=><article key={e.ts+'-'+i} className={`decision-entry ${e.action}`}>
      <header><strong>{actions[e.action]??e.action}</strong><b>{stages[e.stage??'']??copy('旧记录（层级未知）','Legacy (unknown stage)')}{e.category?' / '+e.category:''}</b><time>{formatDateTime(e.ts)}</time></header>
      <div className="decision-context">{e.profileName??copy('旧方案未知','Unknown legacy policy')} · {e.projectPath??copy('项目未知','Unknown project')} · {e.convTitle??e.convId??copy('对话未知','Unknown conversation')}</div>
      <div className="decision-operation"><b>{e.tool}</b> <code>{e.detail.command??e.detail.url??e.detail.path??''}</code></div>
      {e.detail.pattern&&<p>匹配表达式：<code>{e.detail.pattern}</code></p>}
      <p>{e.detail.reason??copy('旧记录未保存理由','No reason saved in legacy record')}</p>
    </article>)}</div>}
    <p className="security-muted">{copy('最多显示最近 10,000 条匹配记录。旧日志缺少的方案与层级不会推测补填。','Shows up to 10,000 matching records. Missing policy and stage metadata in legacy logs is not inferred.')}</p>
  </div>;
}
