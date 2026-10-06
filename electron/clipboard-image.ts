import { clipboard, nativeImage } from 'electron';

/** Accept bounded PNG bytes only, never renderer-supplied paths or arbitrary image URLs. */
export function writeClipboardPng(bytes: Uint8Array): boolean {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24 || bytes.byteLength > 64 * 1024 * 1024) return false;
    const buffer = Buffer.from(bytes);
    if (!buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || buffer.toString('ascii',12,16) !== 'IHDR') return false;
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216) return false;
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  } catch { return false; }
}
