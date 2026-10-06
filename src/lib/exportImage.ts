import { toBlob } from 'html-to-image';
import { copyPngImage } from './clipboard';

export function boundedImageRatio(width: number, height: number, preferred: number): number {
  return Math.min(preferred, 8192 / Math.max(1, width), 8192 / Math.max(1, height), Math.sqrt(16_777_216 / Math.max(1, width * height)));
}

export async function previewImageBlob(src: string): Promise<Blob> {
  try { const response = await fetch(src); if (!response.ok) throw Error('Image unavailable'); return await response.blob(); }
  catch (error) {
    if (!/^https?:\/\//.test(src) || !window.api?.readPreviewImage) throw error;
    const image = await window.api.readPreviewImage(src);
    return new Blob([new Uint8Array(image.bytes)], {type:image.mimeType});
  }
}
export async function downloadPreviewImage(src: string, name: string): Promise<boolean> {
  try {
    const blob = await previewImageBlob(src), url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = /\.(png|jpe?g|gif|webp|svg)$/i.test(name) ? name : (name || 'image') + ({'image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp','image/svg+xml':'.svg'}[blob.type] || '.png'); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); return true;
  } catch { return false; }
}

/** Normalize preview images to PNG; copy original content independently of zoom/pan. */
export async function copyImageToClipboard(src: string): Promise<boolean> {
  let url: string | undefined;
  try {
    const blob = await previewImageBlob(src);
    url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    await image.decode();
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height) return false;
    const ratio = boundedImageRatio(width, height, 1);
    if (blob.type === 'image/png' && ratio === 1) return await copyPngImage(blob);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(width * ratio));
    canvas.height = Math.max(1, Math.floor(height * ratio));
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    return png ? await copyPngImage(png) : false;
  } catch { return false; }
  finally { if (url) URL.revokeObjectURL(url); }
}

/** Read a themed background color from the CSS variable (fallback white). */
function themedBackground(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim();
  return v || '#ffffff';
}

/**
 * 默认排除的元素类名（交互元素，截图时不应出现）：
 * - chat-msg-actions: 消息操作按钮（复制/删除）
 * - chat-msg-footer: 消息底栏（操作按钮 + 时间戳），含底部横线
 *   截图对话内容时这些是 UI 噪声，不应带入图片。
 */
const DEFAULT_EXCLUDE = ['chat-msg-actions', 'chat-msg-footer', 'markdown-table-actions'];

/** 合并默认排除列表与调用方传入的额外排除项。 */
function mergeExclude(extra?: string[]): string[] {
  // 去重，避免重复判断
  return Array.from(new Set([...DEFAULT_EXCLUDE, ...(extra ?? [])]));
}

/** Capture dimensions + render options shared by save & copy paths. */
function captureOptions(
  node: HTMLElement,
  exclude: string[],
  backgroundColor?: string,
) {
  const width = Math.ceil(node.scrollWidth || node.offsetWidth);
  const height = Math.ceil(node.scrollHeight || node.offsetHeight);
  const pixelRatio = boundedImageRatio(width + 64, height, Math.max(2, Math.min(window.devicePixelRatio || 1, 3)));
  return {
    pixelRatio,
    cacheBust: true,
    width,
    height,
    backgroundColor: backgroundColor ?? themedBackground(),
    style: { width: `${width}px`, height: `${height}px`, margin: '0',
      ...(node.tagName === 'TABLE' ? {display:'table', overflow:'visible', maxWidth:'none', maxHeight:'none', height:'auto'} : {}),
    },
    filter: (el: HTMLElement) => {
      const cls = el?.classList;
      if (!cls) return true;
      return !exclude.some((c) => cls.contains(c));
    },
  };
}

// Keep overlapping copy/save requests from restoring scrollbars before cloning ends.
const activeCaptures = new WeakMap<HTMLElement, number>();

/** Add 32 CSS pixels per side after capture, preserving content width and wrapping. */
async function captureWithMargins(node: HTMLElement, exclude: string[], backgroundColor?: string): Promise<Blob | null> {
  const options = captureOptions(node, exclude, backgroundColor);
  activeCaptures.set(node, (activeCaptures.get(node) ?? 0) + 1);
  node.classList.add('image-export-capture');
  let blob: Blob | null;
  try {
    blob = await toBlob(node, options);
  } finally {
    const remaining = (activeCaptures.get(node) ?? 1) - 1;
    if (remaining > 0) activeCaptures.set(node, remaining);
    else {
      activeCaptures.delete(node);
      node.classList.remove('image-export-capture');
    }
  }
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  try {
    const edge = Math.max(1, Math.floor(32 * options.pixelRatio));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width + edge * 2;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = options.backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, edge, 0);
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  } finally { bitmap.close(); }
}

/**
 * Render a DOM element to a PNG and trigger a download.
 *
 * - Captures the element at its full content size (works for scroll containers
 *   whose inner wrapper sizes to content).
 * - `exclude` selectors are skipped in the capture (merged with defaults).
 * Returns true on success.
 */
export async function saveElementAsImage(
  node: HTMLElement,
  filename: string,
  opts?: { exclude?: string[]; backgroundColor?: string },
): Promise<boolean> {
  try {
    const exclude = mergeExclude(opts?.exclude);
    const blob = await captureWithMargins(node, exclude, opts?.backgroundColor);
    if (!blob) return false;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Render a DOM element to a PNG and copy it directly to the system clipboard.
 *
 * Uses the browser Clipboard API with a native Electron PNG fallback.
 *
 * Returns true only when the image was written successfully.
 */
export async function copyElementToClipboard(
  node: HTMLElement,
  opts?: { exclude?: string[]; backgroundColor?: string },
): Promise<boolean> {
  try {
    const exclude = mergeExclude(opts?.exclude);
    const blob = await captureWithMargins(node, exclude, opts?.backgroundColor);
    if (!blob) return false;
    return await copyPngImage(blob);
  } catch {
    return false;
  }
}

/** Build a safe, timestamped image filename. */
export function imageFilename(prefix: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = prefix.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'sage';
  return `${safe}-${ts}.png`;
}
