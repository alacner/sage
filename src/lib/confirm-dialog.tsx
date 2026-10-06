import {WindowOverlay} from '../components/WindowOverlay';
/**
 * 应用内确认对话框：替代原生 window.confirm。
 * 原生 confirm 的按钮文字（Cancel/OK）由操作系统语言决定，应用层无法干预；
 * 本组件按钮文案走 i18n（跟随应用内语言切换），样式与应用内其它弹窗一致。
 *
 * 用法：`if (!(await confirmDialog({ message: t('xxx.confirm') }))) return;`
 * ConfirmDialogHost 为全局单例，挂载于 App.tsx。
 */
import { useId, useSyncExternalStore } from 'react';
import { useT } from '../i18n';

export interface ConfirmOptions {
  /** 正文（调用侧已本地化的文本；\n 会按换行渲染） */
  message: string;
  /** 标题（可选） */
  title?: string;
  /** 确认按钮文案（缺省 i18n confirm.ok） */
  okLabel?: string;
  /** 取消按钮文案（缺省 i18n confirm.cancel） */
  cancelLabel?: string;
  /** 危险操作：确认按钮使用 danger 样式 */
  danger?: boolean;
}

interface ConfirmState {
  open: boolean;
  options?: ConfirmOptions;
}

let state: ConfirmState = { open: false };
let resolveFn: ((ok: boolean) => void) | null = null;
const listeners = new Set<() => void>();

function setState(next: ConfirmState) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function close(ok: boolean) {
  const r = resolveFn;
  resolveFn = null;
  setState({ open: false });
  r?.(ok);
}

/** Promise 化确认框：确认 resolve(true)，取消 / 点遮罩 / Esc resolve(false)。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  // 单例保护：理论上不会重入，若发生则旧等待按取消结算
  if (resolveFn) {
    resolveFn(false);
    resolveFn = null;
  }
  return new Promise<boolean>((resolve) => {
    resolveFn = resolve;
    setState({ open: true, options });
  });
}

/** 全局确认对话框宿主（App.tsx 挂载一次）。 */
export function ConfirmDialogHost() {
  const current = useSyncExternalStore(subscribe, () => state);
  const t = useT();
  const titleId = useId(), messageId = useId();

  if (!current.open || !current.options) return null;
  const opts = current.options;
  return (
    <WindowOverlay className="confirm-dialog-backdrop" onEscape={() => close(false)} onClick={() => close(false)}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={opts.title ? titleId : messageId} aria-describedby={opts.title ? messageId : undefined} onClick={(e) => e.stopPropagation()}>
        {opts.title ? <div id={titleId} className="confirm-dialog-title">{opts.title}</div> : null}
        <div id={messageId} className="confirm-dialog-message">{opts.message}</div>
        <div className="confirm-dialog-actions">
          <button type="button" data-autofocus className="btn-ghost" onClick={() => close(false)}>
            {opts.cancelLabel ?? t('confirm.cancel')}
          </button>
          <button
            type="button"
            className={opts.danger ? 'btn-danger' : 'btn-primary'}
            onClick={() => close(true)}
          >
            {opts.okLabel ?? t('confirm.ok')}
          </button>
        </div>
      </div>
    </WindowOverlay>
  );
}
