import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, mkdirSync, renameSync, rmdirSync } from 'node:fs';

function stat(file: string) {
  try { return lstatSync(file); } catch (error: any) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Move legacy data without overwriting files already stored in chats. */
export function chatDirectory(dataDir: string): string {
  const target = path.join(dataDir, 'chats');
  const legacy = path.join(dataDir, 'conversations');
  const oldStat = stat(legacy);
  if (!oldStat) return target;
  if (!oldStat.isDirectory()) throw new Error(`对话迁移失败：旧目录不是普通目录 ${legacy}`);
  const newStat = stat(target);
  if (!newStat) {
    renameSync(legacy, target);
    return target;
  }
  if (!newStat.isDirectory()) throw new Error(`对话迁移失败：目标不是普通目录 ${target}`);

  const merge = (source: string, destination: string, relative: string) => {
    const current = stat(destination);
    if (!current) { renameSync(source, destination); return; }
    const old = lstatSync(source);
    if (old.isDirectory() && current.isDirectory()) {
      for (const name of readdirSync(source)) {
        merge(path.join(source, name), path.join(destination, name), path.join(relative, name));
      }
      rmdirSync(source);
      return;
    }
    // Keep even identical legacy files as backups; no migration deletes file contents.
    const backup = path.join(target, '.legacy-conversations', randomUUID(), relative);
    mkdirSync(path.dirname(backup), { recursive: true });
    renameSync(source, backup);
    console.warn(`[chat-migration] 同名旧文件已备份：${backup}；当前文件保留：${destination}`);
  };
  for (const name of readdirSync(legacy)) merge(path.join(legacy, name), path.join(target, name), name);
  rmdirSync(legacy);
  return target;
}
