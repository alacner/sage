import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, FileText, CircleAlert } from 'lucide-react';
import { copyMarkdown, copyRichText } from '../lib/clipboard';
import { useT } from '../i18n';

interface CopyButtonsProps {
  /** Raw Markdown text to copy. */
  markdown: string;
  /** Ref to the rendered HTML container element. */
  htmlRef: React.RefObject<HTMLElement>;
  /** 优先于 htmlRef：动态取渲染容器（多段文本时合成临时容器）。 */
  htmlGetter?: () => HTMLElement | null;
  /** Compact mode — smaller buttons for inline use (chat bubbles). */
  compact?: boolean;
}

/**
 * A pair of copy buttons: "Copy Markdown" and "Copy Rich Text".
 * Shows a brief check-mark animation on success.
 * 失败时短暂显示红色告警图标——复制链路任何一环失败都不再静默。
 */
export function CopyButtons({ markdown, htmlRef, htmlGetter, compact }: CopyButtonsProps) {
  const t = useT();
  const [copiedMd, setCopiedMd] = useState(false);
  const [copiedRich, setCopiedRich] = useState(false);
  const [failed, setFailed] = useState<'' | 'md' | 'rich'>('');
  const timerMd = useRef<ReturnType<typeof setTimeout>>();
  const timerRich = useRef<ReturnType<typeof setTimeout>>();
  const timerFail = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timerMd.current);
      clearTimeout(timerRich.current);
      clearTimeout(timerFail.current);
    };
  }, []);

  const markFailed = useCallback((which: 'md' | 'rich') => {
    setFailed(which);
    clearTimeout(timerFail.current);
    timerFail.current = setTimeout(() => setFailed(''), 1800);
  }, []);

  const onCopyMd = useCallback(async () => {
    if (!markdown) return;
    const ok = await copyMarkdown(markdown);
    if (!mounted.current) return;
    if (ok) {
      setFailed('');
      setCopiedMd(true);
      clearTimeout(timerMd.current);
      timerMd.current = setTimeout(() => setCopiedMd(false), 1500);
    } else {
      markFailed('md');
    }
  }, [markdown, markFailed]);

  const onCopyRich = useCallback(async () => {
    const el = htmlGetter ? htmlGetter() : htmlRef.current;
    if (!el) { markFailed('rich'); return; }
    const ok = await copyRichText(el);
    if (!mounted.current) return;
    if (ok) {
      setFailed('');
      setCopiedRich(true);
      clearTimeout(timerRich.current);
      timerRich.current = setTimeout(() => setCopiedRich(false), 1500);
    } else {
      markFailed('rich');
    }
  }, [htmlRef, htmlGetter, markFailed]);

  const size = compact ? 14 : 15;

  return (
    <span className={`copy-btns${compact ? ' copy-btns-compact' : ''}`}>
      <button
        type="button"
        disabled={!markdown}
        aria-label={failed === 'md' ? t('common.copyFailed') : copiedMd ? t('common.copied') : t('common.copyMarkdown')}
        className={`copy-btn${copiedMd ? ' copied' : ''}${failed === 'md' ? ' failed' : ''}`}
        onClick={onCopyMd}
        title={failed === 'md' ? t('common.copyFailed') : copiedMd ? t('common.copied') : t('common.copyMarkdown')}
      >
        {failed === 'md' ? <CircleAlert size={size} /> : copiedMd ? <Check size={size} /> : <Copy size={size} />}
      </button>
      <button
        type="button"
        aria-label={failed === 'rich' ? t('common.copyFailed') : copiedRich ? t('common.copied') : t('common.copyRendered')}
        className={`copy-btn${copiedRich ? ' copied' : ''}${failed === 'rich' ? ' failed' : ''}`}
        onClick={onCopyRich}
        title={failed === 'rich' ? t('common.copyFailed') : copiedRich ? t('common.copied') : t('common.copyRendered')}
      >
        {failed === 'rich' ? <CircleAlert size={size} /> : copiedRich ? <Check size={size} /> : <FileText size={size} />}
      </button>
    </span>
  );
}
