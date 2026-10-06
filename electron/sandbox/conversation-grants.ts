import { createHash } from 'node:crypto';
type Grants = { all: boolean; commands: Set<string> };
const grants = new Map<string, Grants>();
function clean(value: any): any {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => !k.startsWith('__sage')).map(k => [k, clean(value[k])]));
  return value;
}
const key = (tool: string, input: unknown) => createHash('sha256').update(JSON.stringify([tool.replace(/^mcp__sage__/, ''), clean(input)])).digest('hex');
export function grantConversation(convId: string, kind: 'all' | 'command', tool: string, input: unknown) {
  const entry = grants.get(convId) ?? { all: false, commands: new Set<string>() };
  if (kind === 'all') entry.all = true;
  if(entry.commands.size<512)entry.commands.add(key(tool, input));
  if (!grants.has(convId) && grants.size >= 256) grants.delete(grants.keys().next().value!);
  grants.set(convId, entry);
}
export function matchConvGrant(convId: string, tool: string, input: unknown): 'all' | 'command' | null {
  const entry = grants.get(convId);
  if (!entry) return null;
  return entry.all ? 'all' : entry.commands.has(key(tool, input)) ? 'command' : null;
}
/** Save only exact calls that actually passed approval, never an unrestricted future grant. */
export function recordGrantedCall(convId: string, tool: string, input: unknown) {
  const entry = grants.get(convId);
  if (entry && entry.commands.size < 512) entry.commands.add(key(tool, input));
}
export function snapshotConversationGrants(convId: string): string[] { return [...(grants.get(convId)?.commands ?? [])].slice(0, 512); }
export function installTaskGrants(convId: string, exactCalls: string[]): () => void {
  if (exactCalls.some(value => !/^[a-f0-9]{64}$/.test(value)) || exactCalls.length > 512) throw Error('Invalid inherited authorization');
  const entry = { all: false, commands: new Set(exactCalls) };
  grants.set(convId, entry);
  return () => { if (grants.get(convId) === entry) grants.delete(convId); };
}
