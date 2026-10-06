import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useCursorMenuStyle } from '../lib/cursor-menu';

/**
 * 光标处弹出菜单的容器：Portal 到 body，并自动处理“贴光标弹但视口里放不下”。
 *
 * 以前每个右键菜单都自己写 `style={{ left: x, top: y }}`：在列表底部（文件树最
 * 下面几个文件、tab 栏、浏览器标签）打开时，菜单下半截掉到视口外，下面的条目
 * 根本点不到。统一走这里，规则见 shared/popover-placement。
 */
export function CursorMenu({
  x,
  y,
  className = 'file-ctx-menu',
  onMouseDown,
  children,
}: {
  x: number;
  y: number;
  className?: string;
  onMouseDown?: (e: MouseEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const { ref, style } = useCursorMenuStyle<HTMLDivElement>(x, y);
  return createPortal(
    <div ref={ref} className={className} style={style} onMouseDown={onMouseDown} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}
