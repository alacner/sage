import fs from 'node:fs/promises';
import path from 'node:path';

/** Only locally generated PNG evidence is available to Markdown, never arbitrary files. */
export async function readBrowserEvidence(directory: string, source: string): Promise<string | null> {
  try {
    if (typeof source !== 'string' || source.length > 8192) return null;
    const file = path.resolve(source);
    if (path.dirname(file) !== path.resolve(directory) || !/^[0-9a-f-]{36}\.png$/i.test(path.basename(file))) return null;
    if (path.dirname(await fs.realpath(file)) !== await fs.realpath(directory)) return null;
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return null;
    const bytes = await fs.readFile(file);
    if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return null;
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch { return null; }
}
