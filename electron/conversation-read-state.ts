import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConversationReadState } from '../shared/types';

interface Receipt extends ConversationReadState { version: 1; recentReplyIds: string[] }
const writes = new Map<string, Promise<unknown>>();
const empty = (): Receipt => ({ version: 1, activityRevision: 0, readRevision: 0, unread: false, recentReplyIds: [] });
const file = (directory: string) => path.join(directory, 'read-state.json');
async function load(directory: string): Promise<Receipt> {
  let raw: any;
  try { raw = JSON.parse(await fs.readFile(file(directory), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return empty(); throw error; }
  if (raw.version !== 1 || !Number.isSafeInteger(raw.activityRevision) || raw.activityRevision < 0
    || !Number.isSafeInteger(raw.readRevision) || raw.readRevision < 0 || raw.readRevision > raw.activityRevision
    || !Array.isArray(raw.recentReplyIds) || raw.recentReplyIds.length > 128
    || raw.recentReplyIds.some((id: unknown) => typeof id !== 'string' || id.length > 200)
    || (raw.lastReplyId !== undefined && (typeof raw.lastReplyId !== 'string' || raw.lastReplyId.length > 200))) throw Error('Invalid conversation read receipt');
  return { ...raw, unread: raw.activityRevision > raw.readRevision };
}
async function save(directory: string, receipt: Receipt) {
  // A deleted conversation must never be recreated by a late completion/ack.
  await fs.access(path.join(directory, 'meta.json'));
  const temporary = `${file(directory)}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file(directory));
  } finally { await fs.rm(temporary, { force: true }); }
}
function transaction<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const pending = (writes.get(directory) ?? Promise.resolve()).catch(() => {}).then(operation);
  writes.set(directory, pending);
  void pending.finally(() => { if (writes.get(directory) === pending) writes.delete(directory); }).catch(() => {});
  return pending;
}
function snapshot(receipt: Receipt): ConversationReadState {
  return { activityRevision: receipt.activityRevision, readRevision: receipt.readRevision,
    unread: receipt.activityRevision > receipt.readRevision, ...(receipt.lastReplyId ? { lastReplyId: receipt.lastReplyId } : {}) };
}
export async function conversationReadState(directory: string): Promise<ConversationReadState> {
  await writes.get(directory)?.catch(() => {});
  return snapshot(await load(directory));
}
export function recordConversationReply(directory: string, messageId: string): Promise<{ changed: boolean; state: ConversationReadState }> {
  return transaction(directory, async () => {
    if (!messageId || messageId.length > 200) throw Error('Invalid reply identifier');
    const receipt = await load(directory);
    if (receipt.recentReplyIds.includes(messageId)) return { changed: false, state: snapshot(receipt) };
    if (receipt.activityRevision >= Number.MAX_SAFE_INTEGER) throw Error('Read receipt revision exhausted');
    receipt.activityRevision++;
    receipt.lastReplyId = messageId;
    receipt.recentReplyIds = [...receipt.recentReplyIds, messageId].slice(-128);
    await save(directory, receipt);
    return { changed: true, state: snapshot(receipt) };
  });
}
export function acknowledgeConversationRead(directory: string, revision: number): Promise<{ changed: boolean; state: ConversationReadState }> {
  return transaction(directory, async () => {
    if (!Number.isSafeInteger(revision) || revision < 0) throw Error('Invalid read revision');
    const receipt = await load(directory);
    if (revision > receipt.activityRevision) throw Error('Read revision is newer than the conversation');
    const next = Math.max(receipt.readRevision, revision);
    if (next === receipt.readRevision) return { changed: false, state: snapshot(receipt) };
    receipt.readRevision = next;
    await save(directory, receipt);
    return { changed: true, state: snapshot(receipt) };
  });
}
