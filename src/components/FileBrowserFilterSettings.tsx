import {useEffect,useState} from 'react';
import {useAppStore} from '../stores/appStore';
import {resolveLanguage} from '../../shared/language';

export function FileBrowserFilterSettings(){
 const settings=useAppStore(s=>s.settings);
 const en=resolveLanguage(settings?.language,settings?._systemLocale)==='en';
 const [text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 useEffect(()=>{setText((settings?.fileBrowserHiddenDirectories??['.sage']).join('\n'));},[settings?.fileBrowserHiddenDirectories]);
 const save=async()=>{
  const names=[...new Set(text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean))];
  if(names.some(s=>s==='.'||s==='..'||/[\\/*?\x00]/.test(s))){setError(en?'Enter directory names only, without paths or wildcards.':'请填写目录名，不包含路径或通配符。');return;}
  setBusy(true);setError('');setSaved(false);
  try{await useAppStore.getState().saveSettings({fileBrowserHiddenDirectories:names});setSaved(true);}catch(e:any){setError(e.message??String(e));}finally{setBusy(false);}
 };
 return <section className="settings-card" style={{marginTop:24,padding:20}}>
  <h3>{en?'File browser directory filters':'文件列表目录过滤'}</h3>
  <p className="muted">{en?'Applies to all projects. Hide directories with these exact names at any depth from the file list, filename search and content search. One name per line; clear to disable these extra filters.':'适用于所有项目。在文件列表、文件名搜索及内容搜索中隐藏任意层级的同名目录。每行一个目录名；清空可取消额外过滤。'}</p>
  <label>{en?'Hidden directory names':'隐藏的目录名'}<textarea rows={4} style={{display:'block',width:'100%',marginTop:8,boxSizing:'border-box'}} value={text} disabled={busy} onChange={e=>{setText(e.target.value);setSaved(false);}} placeholder={'.sage\ntmp'}/></label>
  <p className="muted small">{en?'This changes browsing visibility only. It does not delete files or restrict model and tool access; use approval policies for access control. Existing system exclusions still apply.':'仅影响文件浏览显示，不删除文件，也不限制模型和工具访问；访问控制请使用上方审批策略。原有系统过滤仍然生效。'}</p>
  {error&&<p role="alert" className="security-error">{error}</p>}
  <button className="btn-secondary" disabled={busy} onClick={()=>void save()}>{busy?(en?'Saving…':'保存中…'):(en?'Save filters':'保存过滤设置')}</button>
  {saved&&<span role="status" className="muted"> {en?'Saved':'已保存'}</span>}
 </section>;
}
