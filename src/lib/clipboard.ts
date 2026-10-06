/**
 * Clipboard utilities — copy raw Markdown or rendered rich text.
 *
 * 写入顺序：渲染层 navigator.clipboard → 主进程 electron.clipboard 兜底。
 * 打包环境（file:// 渲染页）里 navigator.clipboard 可能因焦点/权限策略被拒，
 * 之前失败是静默的（按钮无反应），现在一律落到主进程通道并回报成败。
 */

/** 主进程兜底写入（preload 暴露的 clipWriteText / clipWriteRich）。 */
async function writeViaMain(text: string, html?: string): Promise<boolean> {
  const api = typeof window !== 'undefined' ? window.api : undefined;
  if (!api) return false;
  try {
    if (html != null) return !!(await api.clipWriteRich?.(html, text));
    return !!(await api.clipWriteText?.(text));
  } catch {
    return false;
  }
}

/** Copy PNG bytes, falling back to Electron when the browser clipboard is unavailable. */
export async function copyPngImage(blob: Blob): Promise<boolean> {
  if (!blob.size || blob.type !== 'image/png') return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    try {
      return !!(await window.api?.clipWriteImage?.(new Uint8Array(await blob.arrayBuffer())));
    } catch { return false; }
  }
}

/** Copy plain text (raw Markdown) to the clipboard. */
export async function copyMarkdown(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return writeViaMain(text);
  }
}

/**
 * Copy rendered HTML as rich text to the clipboard.
 *
 * Writes both `text/html` (for pasting into Word / Google Docs / 飞书 etc.)
 * and `text/plain` (fallback for plain-text editors).
 */
export async function copyRichText(el: HTMLElement): Promise<boolean> {
  const html = el.innerHTML;
  const plain = el.innerText;
  try {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
    return true;
  } catch {
    // Fallback: try writeText if ClipboardItem is unsupported
    try {
      await navigator.clipboard.writeText(plain);
      return true;
    } catch {
      return writeViaMain(plain, html);
    }
  }
}
