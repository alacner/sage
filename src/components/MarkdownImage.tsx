import { isTemporaryImageUrl } from './CopyImageAddress';
import { useEffect, useState } from 'react';
import { ImageLightbox } from './ImageLightbox';
import { useT } from '../i18n';

export function MarkdownImage({ src, alt = '', title, ...props }: any) {
  const [open, setOpen] = useState(false);
  const [gallery, setGallery] = useState<Array<{src:string;name:string}>>([]);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const t = useT();
  const [localImage, setLocalImage] = useState<{source: string; data: string | null} | null>(null);
  const local = typeof src === 'string' && src.startsWith('/') && !src.startsWith('//') && src.includes('/browser-evidence/');
  useEffect(() => {
    if (!local) return;
    let live = true;
    let source = src;
    try { source = decodeURIComponent(src); } catch { /* retain literal path */ }
    void window.api.readBrowserEvidence(source).then(data => {
      if (live) setLocalImage({source: src, data});
    }).catch(() => { if (live) setLocalImage({source: src, data: null}); });
    return () => { live = false; };
  }, [src, local]);
  const imageSrc = local ? (localImage?.source === src ? localImage.data : null) : src;


  if (local && !imageSrc) return <span className="md-image-unavailable">{alt || '图片'}（{localImage?.source === src ? '本地图片不可用' : '加载中…'}）</span>;

  if (isTemporaryImageUrl(src) && failedSource === src) return <span className="temp-image-unavailable">图片已失效<br/>或无法加载</span>;

  return <>
    <button
      type="button"
      className={`md-image-preview-trigger${isTemporaryImageUrl(src) ? ' temp-image-thumbnail' : ''}`}
      title={title || t('chat.imageClickEnlarge')}
      aria-label={`${t('chat.imageClickEnlarge')}${alt ? `: ${alt}` : ''}`}
      onClick={event => {
        const group = event.currentTarget.closest('.upload-results, [data-markdown-document]');
        setGallery(group ? Array.from(group.querySelectorAll<HTMLImageElement>('.md-image-preview-trigger img')).map(image => ({src:image.src,name:image.alt || 'image.png'})) : []);
        setOpen(true);
      }}
    >
      <img src={imageSrc || undefined} alt={alt} loading="lazy" {...props} onError={() => { if (isTemporaryImageUrl(src)) setFailedSource(src); }} />
    </button>
    {open && imageSrc && <ImageLightbox src={imageSrc} sources={gallery.length ? gallery : [{src:imageSrc,name:alt || 'image.png'}]} onClose={() => setOpen(false)}/>}

  </>;
}
