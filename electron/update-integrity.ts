import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';

export function validateUpdateChecksum(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)) {
    throw new Error('更新清单缺少有效的 SHA-256 校验值，已阻止更新。请联系更新源维护者重新发布清单。');
  }
}

/** Hash the bytes saved on disk before allowing the installer to mount them. */
export async function verifyUpdateFile(file: string, expected: string): Promise<void> {
  validateUpdateChecksum(expected);
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== expected.toLowerCase()) {
      throw new Error('安装包 SHA-256 校验失败，文件可能损坏或被篡改。已阻止安装，请重新下载。');
    }
  } catch (error) {
    await fs.unlink(file).catch(() => {});
    throw error;
  }
}
