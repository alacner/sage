import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Check, Download, Minus, Plus, Maximize2, X } from 'lucide-react';
import { sanitizeMermaidSource } from '../lib/mermaidSanitize';
import { mermaidFontOptions } from '../lib/mermaidFont';
import { mermaidThemeOptions } from '../lib/mermaidTheme';
import { THEME_CHANGE_EVENT } from '../theme';
import { copyPngImage } from '../lib/clipboard';
import { downloadMermaidImage, mermaidExportBlob, type MermaidExportFormat } from '../lib/mermaidExport';
import { readableMermaidSvg } from '../lib/mermaidContrast';
import { copyMarkdown } from '../lib/clipboard';

let renderCounter = 0;

interface MermaidBlockProps {
  source: string;
}

/**
 * Renders a Mermaid diagram from source code.
 *
 * - Lazy-loads the mermaid library (code-split via dynamic import)
 * - Auto-detects light/dark theme from <html data-theme>
 * - Falls back to a <details> with raw source on render failure
 * - Each instance gets a unique ID to avoid DOM collisions
 * - Only renders when source is complete (avoid flicker during streaming)
 * - Keeps last successful render while loading new one
 */
export function MermaidBlock({ source }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const lastSourceRef = useRef<string>('');
  const [showLightbox, setShowLightbox] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [downloadState, setDownloadState] = useState<'idle' | 'working' | 'done' | 'failed'>('idle');
  const [downloadFormat, setDownloadFormat] = useState<MermaidExportFormat>('png');
  const downloadBusy = useRef(false);
  const downloadResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(downloadResetTimer.current), []);
  /** 本次渲染是否经过语法自动修正（用于给用户一个轻提示）。 */
  const [autoFixed, setAutoFixed] = useState(false);
  // 是否已有过成功渲染：失败时若已有旧图，保留旧图不闪错误（闭包里读 state 会拿到
  // effect 创建时的旧值，用 ref 才能拿到最新状态）。
  const hasRenderedRef = useRef(false);
  /**
   * 主题版本号：配色是在 render() 当时从 CSS 变量算出来写进 SVG 的，
   * 换了主题/改了配色后旧图不会自己变色，必须重渲染一次。
   * 取色器拖动时会连着发事件，这里消抖 200ms，避免每帧重画。
   */
  const [themeRev, setThemeRev] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setThemeRev((n) => n + 1), 200);
    };
    window.addEventListener(THEME_CHANGE_EVENT, bump);
    return () => { clearTimeout(timer); window.removeEventListener(THEME_CHANGE_EVENT, bump); };
  }, []);

  /** Copy and save use the full natural SVG, never the scaled preview card. */
  const capturePngBlob = async (): Promise<Blob | null> => {
    const diagram = containerRef.current?.querySelector('svg');
    if (!diagram) return null;
    try { return await mermaidExportBlob(diagram, 'png'); }
    catch { return null; }
  };

  /** 复制为 PNG 图片到剪贴板。 */
  const handleCopyImage = async (e: React.MouseEvent) => {
    e.stopPropagation(); // 不触发外层打开 lightbox
    try {
      const blob = await capturePngBlob();
      if (!blob || !await copyPngImage(blob)) throw new Error('Image clipboard write failed');
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    setTimeout(() => setCopyState('idle'), 2000);
  };

  const handleDownload = async (e: React.MouseEvent, format: MermaidExportFormat) => {
    e.stopPropagation();
    if (downloadBusy.current) return;
    downloadBusy.current = true;
    clearTimeout(downloadResetTimer.current);
    setDownloadFormat(format);
    setDownloadState('working');
    try {
      const diagram = containerRef.current?.querySelector('svg');
      if (!diagram) throw Error('图表不可用');
      await downloadMermaidImage(diagram, format);
      setDownloadState('done');
    } catch { setDownloadState('failed'); }
    finally { downloadBusy.current = false; }
    downloadResetTimer.current = setTimeout(() => setDownloadState('idle'), 2000);
  };

  const downloadButtons = (fullscreen = false) => (['png', 'svg'] as const).map(format => (
    <button
      key={format}
      type="button"
      className={fullscreen ? 'mermaid-lightbox-btn mermaid-lightbox-download' : 'mermaid-block-action'}
      title={`下载为 ${format.toUpperCase()} 图片`}
      aria-label={`下载为 ${format.toUpperCase()} 图片`}
      disabled={downloadState === 'working' || !svg}
      onClick={event => void handleDownload(event, format)}
    >
      {downloadState === 'done' && downloadFormat === format ? <Check size={fullscreen ? 18 : 12} /> : <Download size={fullscreen ? 18 : 12} />}
      <span>{downloadFormat === format && downloadState === 'failed' ? '下载失败' : downloadFormat === format && downloadState === 'working' ? '导出中…' : fullscreen ? format.toUpperCase() : `下载 ${format.toUpperCase()}`}</span>
    </button>
  ));

  // Check if source looks complete (contains common mermaid keywords)
  const isComplete = /graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|flowchart|journey|gantt|pie|gitGraph/i.test(source);

  // 同一份源码 + 同一套主题 = 同一张图；主题变了要重画（见上方 themeRev 注释）。
  const renderKey = `${source}#${themeRev}`;

  useEffect(() => {
    // Skip if source hasn't changed
    if (lastSourceRef.current === renderKey) return;
    lastSourceRef.current = renderKey;

    // Only render if source looks complete
    if (!isComplete) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const id = `mermaid-${++renderCounter}`;

    setLoading(true);
    setError('');

    (async () => {
      const mermaid = (await import('mermaid')).default;

      // 配色不再用 mermaid 自带的 default/dark 调色板，而是从当前主题 token 推一套
      // theme:'base' 的 themeVariables（详见 src/lib/mermaidTheme.ts）。
      const font = mermaidFontOptions(containerRef.current);
      const colors = mermaidThemeOptions(containerRef.current);
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        // 字族继承正文，字号量出来（详见 src/lib/mermaidFont.ts）：mermaid 默认 16px，
        // 正文是 12.5px，不量就会看到图里的字比周围一大圈。
        ...font,
        theme: colors.theme,
        themeVariables: { ...font.themeVariables, ...colors.themeVariables },
      });

      let renderedSvg = '';
      let fixed = false;
      try {
        renderedSvg = (await mermaid.render(id, source)).svg;
      } catch (firstErr: any) {
        // 原样渲染失败 → 自动修正常见语法错误后重试一次。
        // 只在失败路径上做修正，本来就合法的图表不会被改动。
        const sanitized = sanitizeMermaidSource(source);
        if (sanitized === source) throw firstErr;
        try {
          renderedSvg = (await mermaid.render(`${id}-fix`, sanitized)).svg;
          fixed = true;
        } catch (secondErr: any) {
          throw secondErr;
        }
      } finally {
        // 清理 mermaid 可能残留的临时元素（两次渲染的 id 都清）
        document.getElementById(id)?.remove();
        document.getElementById(`${id}-fix`)?.remove();
      }

      if (!cancelled) {
        hasRenderedRef.current = true;
        setSvg(readableMermaidSvg(renderedSvg));
        setAutoFixed(fixed);
        setError('');
        setLoading(false);
      }
    })().catch((err: any) => {
      document.getElementById(id)?.remove();
      document.getElementById(`${id}-fix`)?.remove();
      if (!cancelled) {
        // 已有成功渲染过的旧图时不覆盖成错误态，避免内容闪没
        if (!hasRenderedRef.current) setError(err?.message ?? String(err));
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [renderKey, isComplete]);

  // Don't show loading state if we already have content
  if (loading && !svg) {
    return (
      <div className="mermaid-block mermaid-loading" ref={containerRef}>
        <span className="mermaid-loading-spinner" />
        <span>Rendering diagram…</span>
      </div>
    );
  }

  if (error && !svg) {
    return (
      <div className="mermaid-block mermaid-error" ref={containerRef}>
        <div className="mermaid-error-head">
          <span className="mermaid-error-title">图表渲染失败</span>
          <button
            type="button"
            className="mermaid-block-action"
            title="复制图表源码"
            onClick={() => {
              void copyMarkdown(source).then(ok => { if (!ok) window.alert('复制失败，请重试'); });
            }}
          >
            <Copy size={12} />
            <span>复制源码</span>
          </button>
        </div>
        <p className="mermaid-error-hint">
          图表语法不被解析器接受（AI 生成的图表常见），已尝试自动修正仍未成功。
          源码如下，可复制到 mermaid.live 排查。
        </p>
        <pre className="mermaid-error-msg">{error}</pre>
        <details>
          <summary>查看图表源码</summary>
          <pre className="mermaid-source">{source}</pre>
        </details>
      </div>
    );
  }

  return (
    <>
      <div className="mermaid-block-wrap">
        <div
          className="mermaid-block mermaid-rendered"
          ref={containerRef}
          dangerouslySetInnerHTML={{ __html: svg }}
          onClick={() => setShowLightbox(true)}
          style={{ cursor: 'pointer' }}
          title="点击查看大图"
        />
        {/* 工具条：复制图片 / 下载（悬浮显示） */}
        <div className="mermaid-block-actions" onClick={(e) => e.stopPropagation()}>
          {autoFixed ? (
            <span className="mermaid-autofix-badge" title="原图表语法有误，已自动修正后渲染">
              已自动修正语法
            </span>
          ) : null}
          <button
            type="button"
            className="mermaid-block-action"
            title="复制图片到剪贴板"
            onClick={(e) => void handleCopyImage(e)}
          >
            <Copy size={12} />
            <span>{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制图片'}</span>
          </button>
          {downloadButtons()}
        </div>
      </div>
      {showLightbox && (
        <MermaidLightbox
          svg={svg}
          onClose={() => setShowLightbox(false)}
          downloadButtons={downloadButtons(true)}
        />
      )}
    </>
  );
}

/**
 * Full-screen lightbox for Mermaid diagrams with zoom/pan support.
 */
function MermaidLightbox({ svg, onClose, downloadButtons }: { svg: string; onClose: () => void; downloadButtons?: React.ReactNode }) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fitScale = useRef(1);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const content = contentRef.current;
    const diagram = content?.querySelector('svg');
    if (!stage || !content || !diagram) return;
    const bounds = diagram.viewBox.baseVal;
    const width = bounds.width || diagram.getBoundingClientRect().width || 300;
    const height = bounds.height || diagram.getBoundingClientRect().height || 150;
    diagram.style.width = `${width}px`;
    diagram.style.height = `${height}px`;
    diagram.style.maxWidth = 'none';
    const fit = () => {
      const style = getComputedStyle(stage);
      const availableWidth = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const availableHeight = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      fitScale.current = Math.min(1, availableWidth / (width + 32), availableHeight / (height + 32));
      setScale(fitScale.current);
      setPosition({ x: 0, y: 0 });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [svg]);

  const zoomIn = () => setScale((s) => Math.min(s * 1.5, 30));
  const zoomOut = () => setScale((s) => Math.max(s / 1.5, 0.1));
  const resetView = () => {
    setScale(fitScale.current);
    setPosition({ x: 0, y: 0 });
  };

  // Mouse wheel zoom
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setScale((s) => Math.max(0.1, Math.min(30, s * delta)));
    };

    const stage = stageRef.current;
    if (stage) {
      stage.addEventListener('wheel', handleWheel, { passive: false });
      return () => stage.removeEventListener('wheel', handleWheel);
    }
  }, []);

  // Mouse drag to pan
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') zoomIn();
      if (e.key === '-') zoomOut();
      if (e.key === '0') resetView();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="mermaid-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图表预览"
      onClick={onClose}
    >
      <div className="mermaid-lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
        <button className="mermaid-lightbox-btn" onClick={zoomOut} title="缩小 (-)">
          <Minus size={18} />
        </button>
        <button className="mermaid-lightbox-percent" title="实际大小 (100%)" onClick={() => { setScale(1); setPosition({ x: 0, y: 0 }); }}>
          {Math.round(scale * 100)}%
        </button>
        <button className="mermaid-lightbox-btn" onClick={zoomIn} title="放大 (+)">
          <Plus size={18} />
        </button>
        <button className="mermaid-lightbox-btn" onClick={resetView} title="适应窗口 (0)">
          <Maximize2 size={18} />
        </button>
        {downloadButtons}
        <button className="mermaid-lightbox-btn" onClick={onClose} title="关闭 (ESC)" aria-label="关闭预览">
          <X size={18} />
        </button>
      </div>

      <div
        ref={stageRef}
        className="mermaid-lightbox-stage"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      >
        <div
          className="mermaid-lightbox-content"
          ref={contentRef}
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transformOrigin: 'center center',
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

    </div>,
    document.body,
  );
}
