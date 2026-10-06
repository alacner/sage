import { useEffect, useRef } from 'react';
import {
  effectiveAccelerator,
  formatAccelerator,
  matchesAccelerator,
  type AcceleratorEventLike,
} from '../../shared/shortcuts';
import { useAppStore } from '../stores/appStore';

/**
 * 全局快捷键 hook：按 settings.shortcuts 生效 accelerator 监听 window keydown。
 * actionId 必须在 shared/shortcuts.ts 注册表内；未分配（null）时不监听。
 * handler 用 ref 捕获，避免回调变化导致频繁重绑。
 */
export function useShortcut(actionId: string, handler: (e: KeyboardEvent) => void) {
  const overrides = useAppStore((s) => s.settings?.shortcuts);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const accelerator = effectiveAccelerator(actionId, overrides);
  useEffect(() => {
    if (!accelerator) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || document.querySelector('[data-window-overlay="true"]')) return;
      if (!matchesAccelerator(accelerator, e as AcceleratorEventLike)) return;
      e.preventDefault();
      handlerRef.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [accelerator]);
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 展示文本（⌘N / Ctrl+N）；未分配返回 null。 */
export function shortcutDisplay(actionId: string, overrides?: Record<string, string | null>): string | null {
  return formatAccelerator(effectiveAccelerator(actionId, overrides), isMac) || null;
}

/** A held shortcut owns one press. Losing focus always releases it, including while permission is pending. */
export function useHoldShortcut(actionId: string, start: () => void, stop: () => void) {
  const overrides = useAppStore(s => s.settings?.shortcuts);
  const callbacks = useRef({ start, stop }); callbacks.current = { start, stop };
  const accelerator = effectiveAccelerator(actionId, overrides);
  useEffect(() => {
    if (!accelerator) return;
    let held: { code: string; key: string } | undefined;
    const release = () => { if (held) { held = undefined; callbacks.current.stop(); } };
    const down = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[data-window-overlay="true"]')) return;
      if (!matchesAccelerator(accelerator, event)) return;
      event.preventDefault();
      if (event.repeat || held) return;
      held = { code: event.code, key: event.key }; callbacks.current.start();
    };
    const up = (event: KeyboardEvent) => {
      if (held && ((held.code ? event.code === held.code : event.key === held.key) || ['Meta','Control','Alt','Shift'].includes(event.key))) release();
    };
    const visibility = () => { if (document.hidden) release(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    window.addEventListener('blur', release); document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility); release();
    };
  }, [accelerator]);
}
