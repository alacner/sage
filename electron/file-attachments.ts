import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ImageAttachment } from '../shared/types';

/** Materialize user-selected bytes inside the project; never reopen the original path. */
export async function materializeFileImages(project: string, text: string, images?: ImageAttachment[]) {
  const files = images?.filter(image => image.attachmentPath) ?? [];
  if (!files.length) return { text, images };
  if (files.length > 8) throw Error('最多添加 8 张文件图片');
  const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
  const decoded = files.map(image => {
    if (!extensions[image.mimeType] || !image.dataBase64 || image.dataBase64.length > 13981016 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64) || image.dataBase64.length % 4) throw Error('无效的图片附件');
    const bytes = Buffer.from(image.dataBase64, 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw Error('图片附件不能超过 10 MB');
    return bytes;
  });
  const directory = await mkdtemp(path.join(await realpath(project), '.sage-attachments-'));
  const replacements = new Map<ImageAttachment, ImageAttachment>();
  try {
    for (let i = 0; i < files.length; i++) {
      const image = files[i];
      const target = path.join(directory, `${i + 1}${extensions[image.mimeType]}`);
      await writeFile(target, decoded[i], { flag: 'wx', mode: 0o600 });
      text = text.split(JSON.stringify(image.attachmentPath)).join(JSON.stringify(target));
      replacements.set(image, { ...image, attachmentPath: target });
    }
    return { text, images: images!.map(image => replacements.get(image) ?? image) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
