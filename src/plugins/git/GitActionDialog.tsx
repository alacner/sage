import { useRef, useState } from 'react';
import { WindowOverlay } from '../../components/WindowOverlay';
import { useAppStore } from '../../stores/appStore';
import { resolveLanguage } from '../../../shared/language';
export type GitDialogAction = 'checkout' | 'branch' | 'publish';
export function GitActionDialog({ root, action, commit, remotes, onClose, onDone }: {
  root: string; action: GitDialogAction; commit?: string; remotes: string[];
  onClose: () => void; onDone: () => void;
}) {
  const en = resolveLanguage(useAppStore(s => s.settings?.language),useAppStore.getState().settings?._systemLocale) === 'en';
  const text = (zh: string, english: string) => en ? english : zh;
  const [name, setName] = useState(''), [remote, setRemote] = useState(remotes.includes('origin') ? 'origin' : remotes[0] ?? '');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const running = useRef(false);
  const close = () => { if (!running.current) onClose(); };
  const title = action === 'publish' ? text('首次推送分支', 'Publish branch') : action === 'branch' ? text('从此提交新建分支', 'Create branch from commit') : text('检出提交', 'Check out commit');
  const submit = async () => {
    if (running.current || (action === 'publish' ? !remote : action === 'branch' && !name.trim())) return;
    running.current = true; setBusy(true); setError('');
    try {
      if (action === 'publish') await window.api.gitPush(root, { setUpstream: true, remote, forceWithLease: false });
      else if (name.trim()) await window.api.gitBranchCreate(root, name.trim(), { base: commit, checkout: action === 'checkout' });
      else await window.api.gitCheckout(root, commit!);
      onDone(); onClose();
    } catch (e) { setError(String(e)); }
    finally { running.current = false; setBusy(false); }
  };
  return <WindowOverlay className="git-branch-backdrop" onEscape={close} onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <form className="git-branch-dialog" role="dialog" aria-modal="true" aria-labelledby="git-action-title" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <h3 id="git-action-title">{title}</h3>
      {commit && <p>{commit.slice(0, 12)}</p>}
      {action === 'publish' ? <><p>{text('推送当前分支并设置上游。请选择目标远程仓库。', 'Push the current branch and set its upstream. Choose the remote destination.')}</p><label>{text('远程仓库', 'Remote')}<select data-autofocus value={remote} disabled={busy} onChange={e => setRemote(e.target.value)}>{remotes.map(r => <option key={r}>{r}</option>)}</select></label>{!remotes.length && <p role="alert">{text('尚未配置远程仓库。请先在终端使用 git remote add 添加远程。', 'No remote configured. Add one with git remote add in the terminal.')}</p>}</>
        : <><label>{text('新分支名称', 'New branch name')}<input data-autofocus value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>{action === 'checkout' && <p>{text('输入名称将创建并切换分支；留空会进入分离 HEAD，后续提交请先新建分支保存。', 'Enter a name to create and switch branches. Leaving it empty detaches HEAD; create a branch to retain later commits.')}</p>}</>}
      {error && <p role="alert">{error}</p>}{busy && <p role="status">{text('正在执行…', 'Working…')}</p>}
      <footer><button type="button" disabled={busy} onClick={close}>{text('取消', 'Cancel')}</button><button type="submit" disabled={busy || (action === 'publish' ? !remote : action === 'branch' && !name.trim())}>{text('确定', 'Confirm')}</button></footer>
    </form>
  </WindowOverlay>;
}
