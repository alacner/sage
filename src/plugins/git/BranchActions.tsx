import {WindowOverlay} from '../../components/WindowOverlay';
import { useGitT } from './locales';
import { useCursorMenuStyle } from '../../lib/cursor-menu';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { GitBranchAction, GitBranchRequest } from '../../../shared/git-branch-action';
import { copyMarkdown } from '../../lib/clipboard';
type Branch = Awaited<ReturnType<typeof window.api.gitBrowserRefs>>['branches'][number];
export function useBranchActions(path: string, branches: Branch[], refresh: () => void) {
  const t = useGitT();
  const [menu, setMenu] = useState<{ branch: Branch; x: number; y: number }>();
  const [dialog, setDialog] = useState<{ branch: Branch; action: GitBranchAction; title: string }>();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const { ref: menuRef, style: menuStyle } = useCursorMenuStyle(menu?.x ?? 0, menu?.y ?? 0, !!menu);
  const dialogRef = useRef<HTMLDivElement>(null);
  const current = branches.find(b => b.current)?.name;
  const close = () => { if (!running.current) { setDialog(undefined); setError(''); } };
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(undefined); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menu]);
  useEffect(() => {
    if (!dialog) return;
    const el = dialogRef.current?.querySelector<HTMLInputElement>('input');
    if (el) { el.focus(); el.select(); } else dialogRef.current?.focus();
  }, [dialog]);
  const execute = async (request: GitBranchRequest) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try { await window.api.gitBranchAction(path, request); setDialog(undefined); }
    catch (e) { setError(String(e)); }
    finally { running.current = false; setBusy(false); refresh(); window.dispatchEvent(new CustomEvent('sage-git-changed', { detail: path })); }
  };
  const ask = (branch: Branch, action: GitBranchAction, title: string) => {
    setMenu(undefined); setError(''); setName(action === 'track' ? branch.name.split('/').slice(1).join('/') : action === 'rename' ? branch.name : action === 'upstream' ? branch.upstream ?? '' : '');
    setDialog({ branch, action, title });
  };
  const checkout = (branch: Branch) => {
    if (running.current || branch.current) return;
    if (branch.remote) ask(branch, 'track', t("跟踪远程分支"));
    else { setDialog({ branch, action: 'checkout', title: t("切换分支") }); void execute({ branch: branch.name, remote: false, action: 'checkout' }); }
  };
  const events = (branch: Branch) => ({
    onDoubleClick: () => checkout(branch),
    onContextMenu: (e: MouseEvent) => { e.preventDefault(); if (!running.current) setMenu({ branch, x: e.clientX, y: e.clientY }); },
  });
  const needsName = dialog && ['track', 'create', 'tag', 'rename', 'upstream'].includes(dialog.action);
  const duplicate = dialog && ['track', 'create', 'rename'].includes(dialog.action) && branches.some(b => !b.remote && b.name === name.trim());
  const invalid = needsName && (!name.trim() || duplicate || /^-|[\s~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.$/.test(name.trim()));
  const b = menu?.branch;
  const item = (action: GitBranchAction, title: string, disabled = false) => <button role="menuitem" title={title} disabled={disabled} onClick={() => b && ask(b, action, title)}>{title}</button>;
  const overlay = createPortal(<>
    {menu && b && <div className="git-branch-menu" role="menu" ref={menuRef} style={menuStyle} onKeyDown={e => {
      if (e.key === 'Escape') setMenu(undefined);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const i = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus(); }
    }}>
      {item(b.remote ? 'track' : 'checkout', b.remote ? t("检出 / 跟踪远程分支…") : t("切换分支"), b.current)}
      {!b.remote && item('fast-forward', t("快进到 {name}", { name: b.upstream ?? t("上游分支") }), !b.upstream)}
      {item('pull', b.remote ? t("拉取到 {name}…", { name: current ?? t("当前分支") }) : t("拉取上游（仅快进）…"), !current || (!b.remote && (!b.current || !b.upstream)))}
      {!b.remote && item('push', t("推送到上游…"), !b.upstream)}
      <hr/>{item('merge', t("合并到 {name}…", { name: current ?? t("当前分支") }), !current || b.current)}
      {item('rebase', t("将当前分支变基到 {name}…", { name: b.name }), !current || b.current)}
      <hr/>{item('create', t("从此处新建分支…"))}{item('tag', t("从此处新建标签…"))}
      {!b.remote && <>{item('upstream', t("设置跟踪分支…"))}{item('unset-upstream', t("取消跟踪分支"), !b.upstream)}{item('rename', t("重命名…"))}</>}
      {item('delete', b.remote ? t("删除远程分支…") : t("删除本地分支…"), b.current)}
      <hr/><button role="menuitem" onClick={() => { void copyMarkdown(b.name); setMenu(undefined); }}>{t("复制分支名称")}</button>
      <hr/>{item('abort-merge', t("中止进行中的合并…"))}{item('abort-rebase', t("中止进行中的变基…"))}{item('continue-rebase', t("继续变基（解决冲突后）…"))}
    </div>}
    {dialog && <WindowOverlay className="git-branch-backdrop" onKeyDown={e => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') { const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')]; const first = nodes[0], last = nodes[nodes.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    }}><div ref={dialogRef} tabIndex={-1} className="git-branch-dialog" role="dialog" aria-modal="true" aria-labelledby="git-branch-title">
      <h3 id="git-branch-title">{dialog.title}</h3><p>{dialog.branch.remote ? t("远程分支") : t("本地分支")}：{dialog.branch.name}</p>
      {dialog.action === 'track' && <p>{t("创建本地分支并切换，同时跟踪该远程分支。")}</p>}
      {['merge', 'rebase', 'pull'].includes(dialog.action) && <p>{t("当前分支：{name}。发生冲突时保留现场，可解决冲突后继续或从菜单中止。", { name: current ?? t("分离 HEAD") })}</p>}
      {dialog.action === 'delete' && <p>{dialog.branch.remote ? t("此操作会从远程仓库删除该分支。") : t("仅删除已合并的本地分支；未合并分支会被保护。")}</p>}
      <form onSubmit={e => { e.preventDefault(); if (!invalid) void execute({ action: dialog.action, branch: dialog.branch.name, remote: dialog.branch.remote, name: name.trim() }); }}>
        {needsName && <label>{dialog.action === 'upstream' ? t("上游分支") : dialog.action === 'tag' ? t("标签名称") : t("本地分支名称")}
          {dialog.action === 'upstream' ? <select value={name} disabled={busy} onChange={e => setName(e.target.value)}><option value="">{t("请选择")}</option>{branches.filter(b => b.remote && !b.name.endsWith('/HEAD')).map(b => <option key={b.name}>{b.name}</option>)}</select> : <input value={name} disabled={busy} onChange={e => setName(e.target.value)}/>}
        </label>}
        {invalid && <p role="alert">{duplicate ? t("本地分支 {name} 已存在，请更换名称", { name: name.trim() }) : t("请输入有效名称")}</p>}
        {error && <p role="alert">{error}</p>}{busy && <p role="status">{t("正在执行，请稍候…")}</p>}
        <footer><button type="button" disabled={busy} onClick={close}>{t("取消")}</button><button type="submit" disabled={busy || !!invalid}>{dialog.action === 'track' ? t("跟踪并切换") : t("确定")}</button></footer>
      </form>
    </div></WindowOverlay>}
  </>, document.body);
  return { events, overlay };
}
