import { conversationExecutionSecurity } from '../conversation-execution';
import type {TurnAttachments} from '../temp-image-upload';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import type { ConversationMeta, SandboxOverrides } from '../../shared/types';
import { defaultSecurityProfile, securityProfiles, securitySnapshot } from '../../shared/security-profiles';
import { readSettings } from '../main';
import { listProjects } from '../store';

const context = new AsyncLocalStorage<{ project: string; audit: {projectPath:string;convId:string;convTitle?:string;profileId?:string;profileName?:string}; get: () => SandboxOverrides; attachments?:TurnAttachments }>();
export function contextualPolicy(project?: string): SandboxOverrides | undefined {
  const current = context.getStore();
  return current && (!project || resolve(project) === resolve(current.project)) ? current.get() : undefined;
}
export function setTurnAttachments(messageId:string,images:import('../../shared/types').ImageAttachment[] = []) { const current=context.getStore();if(current)current.attachments={messageId,images:images.map(({name,mimeType,dataBase64})=>({name,mimeType,dataBase64}))}; }
export function contextualAttachments(project:string) { const current=context.getStore();return current&&resolve(project)===resolve(current.project)?current.attachments:undefined; }
export function contextualAudit() { return context.getStore()?.audit; }
/** Resolve the selected profile at execution start; deleted profiles keep their saved snapshot. */
export async function initializeConversationPolicy(meta: ConversationMeta) {
  const settings = await readSettings();
  if (meta.securityProfile) {
    const saved = securityProfiles(settings).find(p=>p.id===meta.securityProfile!.id);
    if (saved) meta.securityProfile=securitySnapshot(saved.enabled===false ? defaultSecurityProfile(settings) : saved);
    return;
  }
  const profile = defaultSecurityProfile(settings);
  if (profile && meta.messages.length === 0) meta.securityProfile = securitySnapshot(profile);
  else {
    const project = (await listProjects()).find(p=>resolve(p.path) === resolve(meta.projectPath));
    meta.securityProfile = { id: 'legacy', name: '原项目策略', description: '', policy: structuredClone({ ...project?.sandboxOverrides, review: { ...project?.sandboxOverrides?.review, projectFiles: project?.sandboxOverrides?.review?.projectFiles ?? settings.autoApproveProjectScope !== false } }) };
  }
}
export async function withConversationPolicy<T>(meta: ConversationMeta, action: () => Promise<T>): Promise<T> {
  const profile = await conversationExecutionSecurity(meta, initializeConversationPolicy);
  const snapshot = structuredClone(profile.policy);
  return context.run({ project: meta.projectPath, audit: {projectPath:meta.projectPath,convId:meta.id,convTitle:meta.title,profileId:profile.id,profileName:profile.name}, get: () => snapshot }, action);
}
