import { useLayoutEffect, useRef, useState, type HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { useCursorMenuStyle } from '../lib/cursor-menu';
/** Shared placement for inline trigger popovers; the marker retains the trigger's location. */
export function AnchoredPopover({ children, style, align = 'start', ...props }: HTMLAttributes<HTMLDivElement> & {align?: 'start' | 'end'}) {
  const marker = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; top: number }>();
  const { ref, style: placement } = useCursorMenuStyle(anchor?.x ?? 0, anchor?.y ?? 0, !!anchor, anchor?.top, align);
  useLayoutEffect(() => {
    const element = marker.current?.parentElement;
    if (!element) return;
    const update = () => { const r = element.getBoundingClientRect(); setAnchor({ x: align === 'end' ? r.right : r.left, y: r.bottom + 4, top: r.top }); };
    update();
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [align]);
  return <><span ref={marker} style={{ display: 'none' }}/>{createPortal(<div {...props} ref={ref} style={{ ...style, ...placement, position: 'fixed', bottom: 'auto', right: 'auto', margin: 0, transform: 'none', zIndex: 10000 }} onMouseDown={e => { e.stopPropagation(); props.onMouseDown?.(e); }} onClick={e => { e.stopPropagation(); props.onClick?.(e); }}>{children}</div>, document.body)}</>;
}
