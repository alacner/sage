import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';

/**
 * 溢出跑马灯（一行文字放不下时才动）。
 *
 * 平时保持省略号；实测发现文字比可视区宽时，把溢出量写进 --title-marquee-shift，
 * 悬停期间整行平移到末尾，离开立刻回到开头（动画在 :hover 上，见 index.css
 * .title-marquee--long）。用实测值而不是按字数估，所以任何容器宽度、任何字号档
 * 都恰好滚到最后一个字符。
 *
 * 侧栏对话标题、专家角色名、项目路径行共用这一份：这三处以前各写各的，第二份
 * 复制出现时细节就开始漂移（aria-label 一个有一个没有、行高写死 20px）。
 */
export function TitleMarquee({
  text,
  className = '',
  onDoubleClick,
}: {
  text: string;
  /** 附加类名：既当样式钩子，也用来加 .title-marquee--auto（小字号行不要 20px 行高）。 */
  className?: string;
  onDoubleClick?: (event: ReactMouseEvent<HTMLSpanElement>) => void;
}) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current;
      const track = trackRef.current;
      if (!viewport || !track) return;
      setShift(Math.max(0, track.scrollWidth - viewport.clientWidth));
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined;
    if (observer) {
      if (viewportRef.current) observer.observe(viewportRef.current);
      if (trackRef.current) observer.observe(trackRef.current);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [text]);

  const long = shift > 1;
  const trackStyle = long
    ? ({ '--title-marquee-shift': `-${shift}px` } as CSSProperties)
    : undefined;

  return (
    <span
      ref={viewportRef}
      className={`title-marquee${className ? ` ${className}` : ''}${long ? ' title-marquee--long' : ''}`}
      aria-label={text}
      onDoubleClick={onDoubleClick}
    >
      <span ref={trackRef} className="title-marquee-track" style={trackStyle}>{text}</span>
    </span>
  );
}
