import { scheduledCapabilityDigest } from './scheduled-capabilities';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ConversationMeta, ScheduledAuthorization, ScheduledTask } from '../shared/types';
import { initializeConversationPolicy } from './sandbox/conversation-policy';
import { installTaskGrants, snapshotConversationGrants } from './sandbox/conversation-grants';
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, stable(value[k])]));
  return value;
}
export const authorizationDigest = (policy: unknown) => createHash('sha256').update(JSON.stringify(stable(policy))).digest('hex');
export async function captureScheduledAuthorization(source: ConversationMeta, project: string): Promise<ScheduledAuthorization> {
  if (!source || source.archived || resolve(source.projectPath) !== resolve(project)) throw Error('来源对话不可用，无法继承授权');
  await initializeConversationPolicy(source);
  return { version: 1, projectPath: resolve(project), sourceConvId: source.id, capturedAt: new Date().toISOString(), profile: structuredClone(source.securityProfile!), capabilityDigest: await scheduledCapabilityDigest(project), policyDigest: authorizationDigest(source.securityProfile!.policy), exactCalls: snapshotConversationGrants(source.id) };
}
export async function applyScheduledAuthorization(task: ScheduledTask, source: ConversationMeta | null, run: ConversationMeta): Promise<() => void> {
  const saved = task.authorization;
  if (saved?.projectPath && resolve(saved.projectPath) !== resolve(task.projectPath)) throw Error('项目目录已变化，继承授权需要重新确认；请编辑任务并重新保存来源对话授权');
  if (resolve(run.projectPath) !== resolve(task.projectPath) || !saved || saved.version !== 1 || !source || source.archived || source.id !== task.sourceConvId || saved.sourceConvId !== source.id || resolve(source.projectPath) !== resolve(task.projectPath)) throw Error('继承授权已失效，请编辑任务并重新保存来源对话授权');
  await initializeConversationPolicy(source);
  if (authorizationDigest(saved.profile.policy) !== saved.policyDigest || authorizationDigest(source.securityProfile!.policy) !== saved.policyDigest) throw Error('来源对话安全方案已变化；任务未扩大授权，请检查并重新保存任务');
  if(saved.capabilityDigest !== await scheduledCapabilityDigest(task.projectPath)) throw Error('插件或 MCP 配置已变化；请核验任务并重新保存继承授权');
  // A private id prevents profile resolution from replacing the captured ceiling on later turns.
  run.securityProfile = { ...structuredClone(saved.profile), id: `scheduled-inherited:${task.id}` };
  return installTaskGrants(run.id, saved.exactCalls);
}
