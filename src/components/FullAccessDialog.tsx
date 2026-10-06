import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TriangleAlert, Folder, TerminalSquare, Globe } from 'lucide-react';
import { useSecurityCopy } from './SecurityProfileIcon';
import './security-settings.css';

export function SecurityConfirmationDialog({ onCancel, onConfirm, title, children, confirmLabel }: {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  title: string;
  children: ReactNode;
  confirmLabel: string;
}) {
  const copy = useSecurityCopy();
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cancel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!busyRef.current) cancelRef.current();
      }
      if (event.key === 'Tab') {
        event.stopPropagation();
        const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const first = buttons[0], last = buttons.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const confirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await onConfirm(); }
    catch (e: any) { setError(e?.message || copy('操作失败，请重试。', 'Could not save. Please try again.')); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return createPortal(<div className="full-access-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busyRef.current) onCancel(); }}>
    <div ref={dialog} className="full-access-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <h2 id={titleId}><TriangleAlert size={24}/>{title}</h2>
      <div id={descriptionId}>{children}</div>
      {error && <p role="alert" className="security-error">{error}</p>}
      <div className="full-access-actions">
        <button ref={cancel} type="button" disabled={busy} onClick={onCancel}>{copy('取消','Cancel')}</button>
        <button type="button" className="full-access-confirm" disabled={busy} onClick={() => void confirm()}><TriangleAlert size={17}/>{busy ? copy('正在确认…','Confirming…') : confirmLabel}</button>
      </div>
    </div>
  </div>, document.body);
}


export function FullAccessDialog({onCancel,onConfirm,asDefault=false}:{onCancel:()=>void;onConfirm:()=>Promise<void>;asDefault?:boolean}) {
  const copy=useSecurityCopy();
  return <SecurityConfirmationDialog onCancel={onCancel} onConfirm={onConfirm} title={copy('开启完全访问权限？','Turn on Full Access?')} confirmLabel={copy('确认开启','Confirm')}>
      <p>{copy('Sage 将能够直接运行命令、使用互联网，并在这台电脑上创建和编辑文件，无需逐次征得你的许可。包括但不限于：', 'Sage will be able to run commands, use the internet, and create and edit files on this computer without asking for your permission each time. This includes:')}</p>
      <div className="full-access-capabilities">
        <div><Folder className="files" size={25}/><span><strong>{copy('文件和文件夹','Files and folders')}</strong><small>{copy('读取、创建、修改、上传或删除这台电脑上的文件','Read, create, modify, upload, or delete files on this computer')}</small></span></div>
        <div><TerminalSquare size={25}/><span><strong>{copy('终端命令','Terminal commands')}</strong><small>{copy('运行命令、安装软件和更改系统设置','Run commands, install software, and change system settings')}</small></span></div>
        <div><Globe className="internet" size={25}/><span><strong>{copy('互联网和已连接的应用','Internet and connected apps')}</strong><small>{copy('访问网站、发送数据和使用已启用的插件','Access websites, send data, and use enabled plugins')}</small></span></div>
      </div>
      <p>{copy('这可能带来数据丢失、敏感信息泄露和提示词注入等风险。你可以随时切换回其它策略。', 'This comes with risks such as data loss, exposure of sensitive information, and prompt injection. You can switch back to another policy at any time.')}</p>
      {asDefault && <p className="full-access-default-note">{copy('确认后，新对话将默认使用完全访问权限。','New conversations will use Full Access by default after you confirm.')}</p>}
  </SecurityConfirmationDialog>;
}
