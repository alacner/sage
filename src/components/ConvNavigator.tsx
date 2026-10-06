import { navigationPreviews } from '../../shared/navigation-preview';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { translate } from '../i18n';

/** Independent message marks with a stronger current/hovered position.
 * Click or drag to navigate; the nearby marks widen to help locate the target.
 */

export function ConvNavigator() {
  const messages = useAppStore((s) => s.currentConversation?.messages);

  const userMsgs = useMemo(
    () => (messages ?? []).filter((m) => m.role === 'user' && !m.pending && !m.queued),
    [messages]
  );

  const previews = useMemo(() => navigationPreviews(messages ?? []), [messages]);
  const [focusIdx, setFocusIdx] = useState(-1);
  const count = userMsgs.length;
  const [visibleIndices, setVisibleIndices] = useState<number[]>([]);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [scrollerMounted, setScrollerMounted] = useState(false);
  // 窗口/容器尺寸变化时触发重新计算 track 高度
  const [sizeTick, setSizeTick] = useState(0);

  const trackRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragged = useRef(false);
  const dragStart = useRef({ y: 0, index: 0 });
  const [dragOffset, setDragOffset] = useState(0);
  const getScroller = useCallback(() => {
    return document.querySelector('.chat-scroller') as HTMLElement | null;
  }, []);

  // 通过 MutationObserver 监听 .chat-scroller 是否挂载
  useLayoutEffect(() => {
    const check = () => setScrollerMounted(!!document.querySelector('.chat-scroller'));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  // 监听 chat-scroller 尺寸变化（应用窗口缩放 / 分栏拖拽），触发重新计算 track 高度
  useEffect(() => {
    if (!scrollerMounted) return;
    const scroller = document.querySelector('.chat-scroller') as HTMLElement | null;
    if (!scroller) return;
    const ro = new ResizeObserver(() => setSizeTick((k) => k + 1));
    ro.observe(scroller);
    // 也监听 window resize（窗口大小变化时 scroller 自身不一定触发）
    const onResize = () => setSizeTick((k) => k + 1);
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [scrollerMounted]);

  // Each mark represents a user turn, including its replies. Highlight every
  // turn intersecting the visible area above the composer, even during hover.
  useEffect(() => {
    if (!scrollerMounted) return;
    const scroller = getScroller();
    if (!scroller) return;
    let rafId = 0;
    const update = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const rect = scroller.getBoundingClientRect();
        const composer = (scroller.closest('.chat-view') ?? scroller.parentElement)?.querySelector('.chat-input')?.getBoundingClientRect();
        const bottom = Math.min(rect.bottom, composer && composer.height > 0 ? composer.top : rect.bottom);
        const positions = userMsgs.map(m => document.getElementById(`chat-msg-${m.id}`)?.getBoundingClientRect());
        const visible: number[] = [];
        positions.forEach((position, i) => {
          if (!position) return;
          const next = positions[i + 1];
          const end = next?.top ?? rect.top + scroller.scrollHeight - scroller.scrollTop;
          if (position.top < bottom && end > rect.top && bottom > rect.top) visible.push(i);
        });
        setVisibleIndices(previous => previous.length === visible.length && previous.every((v,i) => v === visible[i]) ? previous : visible);
      });
    };
    scroller.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const resize = new ResizeObserver(update);
    resize.observe(scroller);
    for (const child of Array.from(scroller.children)) resize.observe(child);
    const composer = (scroller.closest('.chat-view') ?? scroller.parentElement)?.querySelector('.chat-input');
    if (composer) resize.observe(composer);
    const changes = new MutationObserver(update);
    changes.observe(scroller, { childList: true, subtree: true, characterData: true });
    update();
    return () => {
      scroller.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      resize.disconnect(); changes.disconnect(); cancelAnimationFrame(rafId);
    };
  }, [userMsgs, getScroller, scrollerMounted]);

  // 滚动到指定消息。behavior: 'smooth' 用于点击，'instant' 用于拖动
  const scrollToMessage = useCallback((msgId: string, behavior: ScrollBehavior = 'smooth') => {
    const scroller = getScroller();
    const dom = document.getElementById(`chat-msg-${msgId}`);
    if (!scroller || !dom) return;

    const parentRect = scroller.getBoundingClientRect();
    const rect = dom.getBoundingClientRect();
    const offset = rect.top - parentRect.top + scroller.scrollTop;
    const target = offset - 80;
    scroller.scrollTo({ top: Math.max(0, target), behavior });

    // 只在点击时触发闪烁，拖动时跳过
    if (behavior === 'smooth') {
      setTimeout(() => {
        dom.classList.add('msg-navigator-flash');
        const onEnd = () => {
          dom.classList.remove('msg-navigator-flash');
          dom.removeEventListener('animationend', onEnd);
        };
        dom.addEventListener('animationend', onEnd);
      }, 450);
    }
  }, [getScroller]);

  // 根据鼠标在 track 内的 Y 坐标，计算对应的消息索引并跳转
  const handleTrackAtY = useCallback((clientY: number, behavior: ScrollBehavior = 'instant') => {
    const track = trackRef.current;
    if (!track || count === 0) return;
    const rect = track.getBoundingClientRect();
    const y = clientY - rect.top;
    const ratio = Math.max(0, Math.min(1, y / (track.clientHeight || 1)));
    const idx = Math.round(ratio * (count - 1));
    scrollToMessage(userMsgs[idx].id, behavior);
  }, [count, userMsgs, scrollToMessage]);

  // ── 拖动交互 ─────────────────────────────────────────────────────────
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const delta = e.clientY - dragStart.current.y;
      if (Math.abs(delta) >= 3) dragged.current = true;
      const idx = Math.max(0, Math.min(count - 1, dragStart.current.index + Math.round(delta / 6)));
      setDragOffset(Math.max(-4, Math.min(4, delta * 0.25)));
      if (userMsgs[idx]) scrollToMessage(userMsgs[idx].id, 'instant');
    };
    const endDrag = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setDragOffset(0);
      setHoverIdx(-1);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', endDrag);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', endDrag);
    };
  }, [count, userMsgs, scrollToMessage]);

  useEffect(() => () => {
    if (isDraggingRef.current) {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  }, []);

  const handleTrackMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dragged.current = false;
    const track = trackRef.current;
    if (!track || count === 0) return;
    const rect = track.getBoundingClientRect();
    dragStart.current = { y: e.clientY, index: Math.round(Math.max(0, Math.min(1, (e.clientY - rect.top) / (track.clientHeight || 1))) * (count - 1)) };
    isDraggingRef.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    handleTrackAtY(e.clientY, 'instant');
    e.preventDefault();
  }, [handleTrackAtY, count]);

  const handleTickClick = useCallback((msgId: string) => {
    setHoverIdx(-1);
    scrollToMessage(msgId, 'smooth');
  }, [scrollToMessage]);

  if (count < 3 || !scrollerMounted) return null;

  // track 高度：用实际 DOM 高度而非估算值，避免刻度超出可见区域被裁剪
  void sizeTick;
  const scroller = getScroller();
  // Fixed spacing for short conversations; long conversations fit the viewport.
  const trackHeight = Math.min((count - 1) * 10 + 6, Math.max(26, (scroller?.clientHeight ?? 600) - 32));

  const previewIndex = hoverIdx >= 0 ? hoverIdx : focusIdx;
  const previewMessage = userMsgs[previewIndex];
  const previewContent = previewMessage ? previews.get(previewMessage.id) : undefined;
  const previewAnchor = 3 + (previewIndex / Math.max(1, count - 1)) * (trackHeight - 6);
  const outsideSpace = Math.max(0, ((scroller?.clientHeight ?? 600) - trackHeight) / 2);
  const previewHalfHeight = previewMessage?.images?.length ? 110 : 70;
  const previewTop = Math.max(previewHalfHeight - outsideSpace, Math.min(trackHeight + outsideSpace - previewHalfHeight, previewAnchor));

  return (
    <div
      className="conv-navigator"
      onMouseLeave={() => setHoverIdx(-1)}
    >
      <div
        ref={trackRef}
        className="conv-navigator-track"
        style={{ height: trackHeight, transform: `translateY(${dragOffset}px)` }}
        onMouseDown={handleTrackMouseDown}
        onMouseMove={(e) => {
          if (isDraggingRef.current) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top - 3) / Math.max(1, e.currentTarget.clientHeight - 6)));
          setHoverIdx(Math.round(ratio * (count - 1)));
        }}
      >
        {userMsgs.map((m, i) => {
          const isVisible = visibleIndices.includes(i);
          const highlighted = hoverIdx >= 0 ? i === hoverIdx : isVisible;
          const preview = previews.get(m.id)?.question || (m.images?.length ? translate('conv.previewImages', { n: m.images.length }) : translate('conv.emptyMsg'));
          // 刻度均匀分布，上下各留 3px 边距，避免首尾刻度被 overflow: hidden 裁剪
          const PAD = 3;
          const usableHeight = Math.max(20, trackHeight - PAD * 2);
          const tickTop = count > 1 ? PAD + (i / (count - 1)) * usableHeight : trackHeight / 2;
          return (
            <button
              key={m.id}
              className={`conv-navigator-tick${highlighted ? ' visible' : ''}`}
              type="button"
              aria-label={preview}
              data-visible={isVisible}
              data-distance={hoverIdx < 0 ? 99 : Math.abs(i - hoverIdx)}
              onMouseEnter={() => setHoverIdx(i)}
              style={{ top: `${tickTop}px` }}
              onClick={(e) => {
                if (isDraggingRef.current || dragged.current) {
                  dragged.current = false;
                  e.preventDefault();
                  return;
                }
                handleTickClick(m.id);
              }}
              onMouseDown={handleTrackMouseDown}
              onFocus={() => setFocusIdx(i)}
              onBlur={() => setFocusIdx(-1)}
              aria-describedby={previewIndex === i ? `nav-preview-${m.id}` : undefined}
            />
          );
        })}
        {previewContent && previewMessage && <div id={`nav-preview-${previewMessage.id}`} role="tooltip" className="conv-navigator-preview" style={{top:previewTop}}>
          <strong>{previewContent.question || (previewMessage.images?.length ? translate('conv.previewImages', { n: previewMessage.images.length }) : translate('conv.emptyMsg'))}</strong>
          {!!previewMessage.images?.length && <div className="conv-navigator-preview-images">{previewMessage.images.map((image, i) => <img key={i} src={`data:${image.mimeType};base64,${image.dataBase64}`} alt={image.name || translate('conv.previewImages', { n: i + 1 })} />)}</div>}
          <p>{previewContent.answer || translate('conv.previewNoReply')}</p>
        </div>}
      </div>

    </div>
  );
}
