import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { ConversationMeta } from '../shared/types';

interface Dependencies {
  directory(meta: ConversationMeta): string;
  current(id: string): Promise<ConversationMeta | null>;
  flush(id: string): Promise<void>;
  busy(id: string): boolean;
  acquire(id: string): boolean;
  release(id: string): void;
  windowAlive(senderId: number): boolean;
  deleted(meta: ConversationMeta): void;
}
interface Candidate {
  meta: ConversationMeta;
  raw: string;
  snapshot: string;
  directory: string;
  realDirectory: string;
  dev: number;
  ino: number;
}
function snapshot(meta: ConversationMeta): string {
  const { unread, activityRevision, readRevision, lastReplyId, runtime, ...history } = meta;
  return JSON.stringify(history);
}
const referenceKeys = new Set(['convId', 'conversationId', 'sourceConvId', 'targetConvId', 'lastConvId']);
function refersTo(value: unknown, id: string, depth = 0): boolean {
  if (depth > 20) throw Error('Reference metadata is too deep');
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => referenceKeys.has(key) && child === id || refersTo(child, id, depth + 1));
}
function readOptionalJson(file: string): unknown {
  try {
    const raw = readFileSync(file, 'utf8');
    if (raw.length > 5 * 1024 * 1024) throw Error('Reference metadata is too large');
    return JSON.parse(raw);
  } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
}
/** Only shells created by the current desktop process are candidates. Never infer ownership from a title. */
export class EmptyConversationLifecycle {
  private candidates = new Map<string, Candidate>();
  private views = new Map<number, Set<string>>();
  private openingViews = new Map<number, Set<string>>();
  constructor(private deps: Dependencies) {}

  remember(meta: ConversationMeta, senderId: number): void {
    if (!Array.isArray(meta.messages) || meta.messages.length) return;
    try {
      const directory = this.deps.directory(meta), identity = lstatSync(directory);
      if (!identity.isDirectory() || identity.isSymbolicLink()) return;
      this.candidates.set(meta.id, { meta: structuredClone(meta), raw: readFileSync(path.join(directory, 'meta.json'), 'utf8'),
        snapshot: snapshot(meta), directory, realDirectory: realpathSync(directory), dev: identity.dev, ino: identity.ino });
      const tabs = this.views.get(senderId) ?? new Set<string>(); tabs.add(meta.id); this.views.set(senderId, tabs);
      // Dropping an old candidate keeps its record; memory pressure must never trigger deletion.
      if (this.candidates.size > 256) this.retain(this.candidates.keys().next().value!);
    } catch { /* An unverifiable shell is retained. */ }
  }
  retain(id: string): void { this.candidates.delete(id); for (const ids of this.openingViews.values()) ids.delete(id); }
  view(id: string, senderId: number): void {
    if (!this.candidates.has(id) || this.views.get(senderId)?.has(id)) return;
    const loading = this.openingViews.get(senderId) ?? new Set<string>(); loading.add(id); this.openingViews.set(senderId, loading);
  }
  syncTabs(senderId: number, ids: string[]): void {
    this.views.set(senderId, new Set(ids));
    // An unrelated tab update during ConvGet cannot erase its in-flight reservation.
    // A cancelled/unacknowledged open fails closed until the window is gone.
    for (const id of ids) this.openingViews.get(senderId)?.delete(id);
  }
  forgetWindow(senderId: number): void { this.views.delete(senderId); this.openingViews.delete(senderId); }
  private hasView(id: string): boolean {
    for (const collection of [this.views, this.openingViews]) for (const [senderId, ids] of collection) {
      if (!this.deps.windowAlive(senderId)) { this.forgetWindow(senderId); continue; }
      if (ids.has(id)) return true;
    }
    return false;
  }
  private pristine(candidate: Candidate, live: ConversationMeta): boolean {
    const id = candidate.meta.id;
    if (this.deps.busy(id) || this.hasView(id) || snapshot(live) !== candidate.snapshot
      || !Array.isArray(live.messages) || live.messages.length || live.archived || live.pinned || live.scheduledExecution) return false;
    const identity = lstatSync(candidate.directory);
    if (!identity.isDirectory() || identity.isSymbolicLink() || identity.dev !== candidate.dev || identity.ino !== candidate.ino
      || realpathSync(candidate.directory) !== candidate.realDirectory) return false;
    if (readFileSync(path.join(candidate.directory, 'meta.json'), 'utf8') !== candidate.raw) return false;
    if (readdirSync(candidate.directory).some(name => name !== 'meta.json' && name !== 'read-state.json')) return false;
    const receipt: any = readOptionalJson(path.join(candidate.directory, 'read-state.json'));
    if (receipt !== undefined && (receipt.version !== 1 || receipt.activityRevision !== 0 || receipt.readRevision !== 0
      || receipt.lastReplyId || !Array.isArray(receipt.recentReplyIds) || receipt.recentReplyIds.length)) return false;
    const projectData = path.dirname(path.dirname(candidate.directory));
    for (const [subdir, file] of [['scheduled', 'tasks.json'], ['channels', 'channels.json']]) {
      const directory = path.join(projectData, subdir);
      try { if (readdirSync(directory).some(name => name.includes('.tmp'))) return false; }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      const references = readOptionalJson(path.join(directory, file));
      if (references !== undefined && (!Array.isArray(references) || refersTo(references, id))) return false;
    }
    return true;
  }
  async close(senderId: number, args: { id: string; projectPath: string; keep: boolean }): Promise<{ ok: true; deleted: boolean }> {
    const candidate = this.candidates.get(args.id);
    if (!candidate || candidate.meta.projectPath !== args.projectPath || !this.deps.windowAlive(senderId)) return { ok: true, deleted: false };
    if (args.keep) { this.retain(args.id); return { ok: true, deleted: false }; }
    if (this.deps.busy(args.id) || this.hasView(args.id) || !this.deps.acquire(args.id)) return { ok: true, deleted: false };
    let quarantine: string | undefined;
    try {
      await this.deps.flush(args.id);
      const live = await this.deps.current(args.id);
      if (!live || this.candidates.get(args.id) !== candidate || !this.pristine(candidate, live)) return { ok: true, deleted: false };
      // No await between the last disk/lease checks and removal from chats. Other local IPC cannot interleave here.
      quarantine = path.join(path.dirname(path.dirname(candidate.directory)), '.discarded-empty-chat-' + randomUUID());
      renameSync(candidate.directory, quarantine);
      this.candidates.delete(args.id);
      for (const collection of [this.views, this.openingViews]) for (const tabs of collection.values()) tabs.delete(args.id);
      try { this.deps.deleted(live); } catch (error) { console.warn('[empty-chat] Cannot notify committed removal', error); }
    } catch (error) {
      console.warn('[empty-chat] Retained unverifiable empty conversation', error);
      return { ok: true, deleted: false };
    } finally { this.deps.release(args.id); }
    if (quarantine) await rm(quarantine, { recursive: true, force: true }).catch(error => console.warn('[empty-chat] Cannot remove discarded shell', error));
    return { ok: true, deleted: true };
  }
}
