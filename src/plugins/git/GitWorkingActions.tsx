import type {GitFileStatus} from '../../../electron/git-utils';
import {useEffect,useRef,useState} from 'react';
import {useAppStore} from '../../stores/appStore';
import {resolveLanguage} from '../../../shared/language';
export function GitWorkingActions({root,file}:{root:string;file:string}){
  const en=useAppStore(s=>resolveLanguage(s.settings?.language,s.settings?._systemLocale)==='en'),copy=(zh:string,enText:string)=>en?enText:zh;
  const [status,setStatus]=useState<GitFileStatus[]>([]),[message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const pending=useRef(false),revision=useRef(0);
  const refresh=async()=>{const id=++revision.current;try{const result=await window.api.gitStatus(root);if(id===revision.current){setStatus(result);}}catch(error){if(id===revision.current)setError(String(error));}};
  useEffect(()=>{void refresh();const change=(event:Event)=>{const detail=(event as CustomEvent).detail;if(!detail||detail===root||detail.root===root)void refresh();};window.addEventListener('sage-git-changed',change);return()=>{revision.current++;window.removeEventListener('sage-git-changed',change);};},[root]);
  const staged=status.filter(item=>item.index&&item.index!=='untracked'&&item.index!=='ignored'),changed=status.filter(item=>item.workTree&&item.workTree!=='ignored');
  const conflict=status.some(item=>item.index==='conflicted'||item.workTree==='conflicted');
  const selected=status.find(item=>item.path===file);
  const run=async(action:()=>Promise<unknown>,commit=false)=>{
    if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');
    try{await action();if(commit)setMessage('');setNotice(copy('已完成','Completed'));}
    catch(error){setError(String(error));}
    finally{pending.current=false;setBusy(false);window.dispatchEvent(new CustomEvent('sage-git-changed',{detail:root}));}
  };
  return <form className="git-working-actions" onSubmit={event=>{event.preventDefault();if(staged.length&&!conflict&&message.trim())void run(()=>window.api.gitCommit(root,message.trim()),true);}}>
    <div><span>{copy(`已暂存 ${staged.length} · 未暂存 ${changed.length}`,`${staged.length} staged · ${changed.length} unstaged`)}</span>
      <button type="button" disabled={busy||!changed.length} onClick={()=>void run(()=>window.api.gitStage(root,changed.map(item=>item.path)))}>{copy('暂存全部','Stage all')}</button>
      <button type="button" disabled={busy||!staged.length} onClick={()=>void run(()=>window.api.gitUnstage(root,staged.map(item=>item.path)))}>{copy('取消全部暂存','Unstage all')}</button>
      <button type="button" disabled={busy||!selected?.workTree} onClick={()=>void run(()=>window.api.gitStage(root,[file]))}>{copy('暂存当前文件','Stage selected')}</button>
      <button type="button" disabled={busy||!selected?.index||selected.index==='untracked'} onClick={()=>void run(()=>window.api.gitUnstage(root,[file]))}>{copy('取消当前暂存','Unstage selected')}</button>
    </div>
    <div><input aria-label={copy('提交说明','Commit message')} placeholder={copy('提交说明（仅提交暂存区）','Commit message (staged changes only)')} value={message} disabled={busy} onChange={event=>setMessage(event.target.value)}/><button type="submit" disabled={busy||!staged.length||conflict||!message.trim()}>{copy('提交暂存更改','Commit staged changes')}</button></div>
    {conflict&&<p role="status">{copy('存在冲突。编辑文件并暂存解决结果，再继续合并或变基。','Resolve conflicts in the editor and stage the resolution before continuing the merge or rebase.')}</p>}
    {error&&<p role="alert">{error}</p>}{busy?<p role="status">{copy('正在执行…','Working…')}</p>:notice&&<p role="status">{notice}</p>}
  </form>;
}
