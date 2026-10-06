import { useCursorMenuStyle } from '../lib/cursor-menu';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Languages, X } from 'lucide-react';
import type { AiTranslationItem } from '../lib/ai-translate';
import { copyMarkdown } from '../lib/clipboard';

/** 翻译浮窗状态：右键位置 + 原文 + loading/error + 多语言译文。 */
export interface TranslatePopState {
  x: number;
  y: number;
  text: string;
  loading: boolean;
  error?: string;
  detected?: string;
  items: AiTranslationItem[];
}

/** 关闭翻译浮窗：点击浮窗外部 / Escape（浮窗内可选中复制，不拦截内部事件）。 */
export function useTranslatePopDismiss(active: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.translate-pop')) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [active]);
}

/** AI 翻译浮窗（Portal 到 body）：跟在右键位置后，多语言译文逐条可复制，点浮窗外/Esc 关闭。 */
export function TranslatePop({ pop, onClose }: { pop: TranslatePopState; onClose: () => void }) {
  const { ref, style } = useCursorMenuStyle(pop.x, pop.y);
  return createPortal(
    <div
      className="translate-pop"
      role="dialog"
      aria-label="AI 翻译"
      ref={ref}
      style={style}
    >
      <div className="translate-pop-head">
        <Languages size={13} />
        <strong>AI 翻译</strong>
        {pop.detected ? <span className="muted small">源语言：{pop.detected}</span> : null}
        <button type="button" className="translate-pop-close" title="关闭" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="translate-pop-body">
        {pop.loading ? (
          <p className="muted small">正在翻译…</p>
        ) : pop.error ? (
          <p className="translate-pop-error" role="alert">{pop.error}</p>
        ) : (
          pop.items.map((item, i) => (
            <section key={i} className="translate-pop-item">
              <header>
                <span>{item.lang}</span>
                <button
                  type="button"
                  title="复制译文"
                  onClick={async (e) => { if (!await copyMarkdown(item.text)) { (e.currentTarget as HTMLButtonElement).title = '复制失败，请重试'; } else { (e.currentTarget as HTMLButtonElement).title = '已复制'; } }}
                >
                  <Copy size={12} /> 复制
                </button>
              </header>
              <pre>{item.text}</pre>
            </section>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
