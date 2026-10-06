import type { ImageAttachment } from '../../shared/types';

/** File references must never accidentally enter the model's vision payload. */
export function prepareImageSubmission(text: string, images: ImageAttachment[], fileLabel: string) {
  const files = images.filter(image => image.attachmentPath);
  return {
    text: [text, files.length ? `${fileLabel}\n${files.map(image => JSON.stringify(image.attachmentPath)).join('\n')}` : ''].filter(Boolean).join('\n\n'),
    images: images.filter(image => !image.attachmentPath),
    attachments: images, // Trusted IPC transport; the main process separates file and vision modes.
  };
}

/** Hide only Sage's generated trailing file block; keep the stored/model prompt intact. */
export function visibleImageMessage(text: string): string {
  for (const label of ['文件附件（仅提供路径，尚未读取图片内容）：', 'File attachments (paths only; image contents have not been read):']) {
    const at = text.startsWith(label + '\n') ? 0 : text.lastIndexOf('\n\n' + label + '\n');
    if (at < 0) continue;
    const start = at === 0 ? label.length + 1 : at + 2 + label.length + 1;
    const lines = text.slice(start).trim().split('\n');
    try {
      if (lines.length && lines.every(line => { const file = JSON.parse(line); return typeof file === 'string' && file.startsWith('/'); })) {
        return text.slice(0, at).trimEnd();
      }
    } catch { /* Ordinary user text, not an auto-generated attachment block. */ }
  }
  return text;
}
