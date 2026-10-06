import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { placeCursorMenu } from '../../shared/popover-placement';

/**
 * 光标处弹出菜单的定位 hook：右键菜单以前一律 `top: clientY / left: clientX`，
 * 在列表底部（或右边缘）打开时菜单有一半掉出视口，下面的条目根本点不到。
 *
 * 做法：先按光标位置渲染但 visibility:hidden（仍参与布局，所以能量到真实尺寸），
 * 同一个 layout 阶段量 getBoundingClientRect() 交给 placeCursorMenu 算出
 * 「下方放不下就翻到上方 + 左右钳位 + maxHeight 内部滚动」，再显示。
 * useLayoutEffect 在浏览器绘制前完成，不会看到跳位。
 *
 * 用法：`<div ref={ref} style={style} className="file-ctx-menu">…</div>`
 */
export function useCursorMenuStyle<T extends HTMLElement = HTMLDivElement>(x: number, y: number, enabled = true, aboveY = y, align: 'start' | 'end' = 'start') {
  const ref = useRef<T>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) { setPos(null); return; }
    const place = () => {
      const r = el.getBoundingClientRect();
      const next = placeCursorMenu(align === 'end' ? x - r.width : x, y, { width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight }, { aboveY });
      setPos(prev => prev && prev.left === next.left && prev.top === next.top && prev.maxHeight === next.maxHeight ? prev : next);
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    observer?.observe(el);
    window.addEventListener('resize', place);
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); };
  }, [x, y, enabled, aboveY, align]);

  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
    : { left: x, top: y, visibility: 'hidden' };
  style.maxWidth = 'calc(100vw - 16px)';
  style.boxSizing = 'border-box';
  style.overflowY = 'auto';
  return { ref, style };
}
