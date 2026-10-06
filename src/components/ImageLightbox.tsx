import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ZoomIn, ZoomOut, Maximize2, Copy, Loader2, AlertTriangle, Check, Download, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { useT } from '../i18n';
import { copyImageToClipboard, downloadPreviewImage } from '../lib/exportImage';

export function ImageLightbox({ src: initialSrc, sources, initialIndex, onClose }: { src: string; initialIndex?: number; sources?: Array<{src:string;name:string;description?:string}>; onClose: () => void }) {
  const gallery = sources?.length ? sources : [{src:initialSrc,name:'image.png'}];
  const [index,setIndex] = useState(() => Math.max(0,Math.min(initialIndex ?? gallery.findIndex(image=>image.src===initialSrc),gallery.length-1)));
  const current = gallery[Math.min(index,gallery.length-1)];
  const src = current.src;
  const t = useT();
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (gallery.length > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); changeImage(e.key === 'ArrowRight' ? 1 : -1); }
      if (e.key === '0' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        resetView();
      }
      if (e.key === '=' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); zoomIn(); }
      if (e.key === '-' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); zoomOut(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, gallery.length, index]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetView = () => { setScale(1); setTx(0); setTy(0); };
  const changeImage = (delta:number) => { const next = Math.max(0, Math.min(index + delta, gallery.length - 1)); if (next === index) return; setIndex(next); resetView(); setCopied(false); setCopyFailed(false); };
  const fitView = () => { setScale(1); setTx(0); setTy(0); };
  const zoomIn = () => setScale((s) => Math.min(s * 1.25, 8));
  const zoomOut = () => setScale((s) => {
    const next = Math.max(s / 1.25, 0.1);
    if (next <= 1.001) { setTx(0); setTy(0); }
    return next;
  });

  // Wheel zoom — anchored to cursor position
  const stageRef = useRef<HTMLDivElement>(null);
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return; // let browser handle
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.min(Math.max(scale * factor, 0.1), 8);
    const ratio = newScale / scale;
    // Keep the point under the cursor stationary
    setTx(mx - ratio * (mx - tx));
    setTy(my - ratio * (my - ty));
    setScale(newScale);
  };

  // Drag to pan
  const dragState = useRef<{ startX: number; startY: number; tx0: number; ty0: number; dragging: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragState.current = { startX: e.clientX, startY: e.clientY, tx0: tx, ty0: ty, dragging: true };
    setIsDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragState.current;
    if (!d || !d.dragging) return;
    setTx(d.tx0 + (e.clientX - d.startX));
    setTy(d.ty0 + (e.clientY - d.startY));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragState.current) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      dragState.current.dragging = false;
      setIsDragging(false);
    }
  };

  // Double-click: toggle between fit and 100%
  const onDoubleClick = () => {
    if (Math.abs(scale - 1) < 0.01 && tx === 0 && ty === 0) {
      setScale(2);
    } else {
      fitView();
    }
  };

  const showResetBtn = scale !== 1 || tx !== 0 || ty !== 0;
  const percentText = `${Math.round(scale * 100)}%`;

  // 复制图片到剪贴板
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyPending = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const onCopy = async () => {
    if (copyPending.current) return;
    copyPending.current = true;
    setCopying(true); setCopied(false); setCopyFailed(false);
    clearTimeout(copyTimer.current);
    try {
      const ok = await copyImageToClipboard(src);
      setCopied(ok); setCopyFailed(!ok);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } finally {
      copyPending.current = false;
      setCopying(false);
    }
  };

  return createPortal(
    <div className="img-lightbox" data-window-overlay="true" role="dialog" aria-modal="true" aria-label={current.name} onClick={onClose}>
      {/* Toolbar: zoom controls */}
      <div className="img-lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <button className="img-lightbox-btn" onClick={zoomOut} title={t('chat.lbZoomOut')}>
          <ZoomOut size={14} />
        </button>
        <span className="img-lightbox-percent" title={t('chat.lbResetHint')} onClick={resetView}>
          {percentText}
        </span>
        <button className="img-lightbox-btn" onClick={zoomIn} title={t('chat.lbZoomIn')}>
          <ZoomIn size={14} />
        </button>
        <button className="img-lightbox-btn" onClick={fitView} title={t('chat.lbFit')}>
          <Maximize2 size={14} />
        </button>
        {showResetBtn ? (
          <button className="img-lightbox-btn" onClick={resetView} title={t('chat.lbReset')}>
            100%
          </button>
        ) : null}
        <button className="img-lightbox-btn" onClick={onCopy} disabled={copying} aria-busy={copying} aria-label={t('chat.copyImage')} title={t(copyFailed ? 'common.copyFailed' : copied ? 'chat.imageCopied' : 'chat.copyImage')}>
          {copying ? <Loader2 size={14} /> : copyFailed ? <AlertTriangle size={14} /> : copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button type="button" className="img-lightbox-btn" aria-label={t('chat.lbDownload')} title={t('chat.lbDownload')} onClick={async () => setDownloadFailed(!await downloadPreviewImage(src, current.name))}><Download size={14}/></button>
        <button type="button" className="img-lightbox-btn" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}><X size={14}/></button>
        {downloadFailed && <span className="img-lightbox-copy-status" role="status">下载失败，请重试</span>}
        {(copyFailed || copied) && <span className="img-lightbox-copy-status" role="status">{t(copyFailed ? 'common.copyFailed' : 'chat.imageCopied')}</span>}
      </div>

      {gallery.length > 1 && <>
        {index > 0 && <button type="button" className="img-lightbox-nav previous" aria-label={t('chat.lbPrevious')} onClick={e=>{e.stopPropagation();changeImage(-1);}}><ChevronLeft size={24}/></button>}
        {index < gallery.length - 1 && <button type="button" className="img-lightbox-nav next" aria-label={t('chat.lbNext')} onClick={e=>{e.stopPropagation();changeImage(1);}}><ChevronRight size={24}/></button>}
        <span className="img-lightbox-counter">{index+1} / {gallery.length}</span>
      </>}
      {current.description && <div className="img-lightbox-delivery" role="note">{current.name} · {current.description}</div>}
      {/* Stage: the zoomable/pannable area */}
      <div
        ref={stageRef}
        className="img-lightbox-stage"
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        style={{ cursor: isDragging ? 'grabbing' : scale > 1 ? 'grab' : 'zoom-in' }}
      >
        <img
          src={src}
          alt="preview"
          draggable={false}
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: '0 0',
            transition: isDragging ? 'none' : 'transform 0.1s ease-out',
          }}
        />
      </div>

      {/* Bottom hint */}
      <div className="img-lightbox-hint">
        {t('chat.lbHint')}
      </div>
    </div>, document.body
  );
}

