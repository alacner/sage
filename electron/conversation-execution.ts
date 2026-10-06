import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConversationMeta, SecurityProfile } from '../shared/types';
import type { ResolvedModel } from './model-resolver';

type Configuration = Pick<ConversationMeta, 'selectedModel' | 'modelProfileId' | 'thinkingEffort' | 'securityProfile'>;
interface ExecutionScope {
  conversationId: string;
  configuration: Configuration;
  initialSecurityReference: SecurityProfile | undefined;
  security?: Promise<SecurityProfile>;
  model?: Promise<ResolvedModel | null>;
}
const execution = new AsyncLocalStorage<ExecutionScope>();
const scopeFor = (meta: ConversationMeta) => {
  const scope = execution.getStore();
  return scope?.conversationId === meta.id ? scope : undefined;
};

/** Freeze configuration for a logical turn, including retries, continuations and expert workers.
 * History, tool results and metadata persistence keep their original shared object ownership.
 */
export function withConversationExecution<T>(meta: ConversationMeta, action: () => Promise<T>, forceNew = false): Promise<T> {
  if (!forceNew && scopeFor(meta)) return action();
  const { selectedModel, modelProfileId, thinkingEffort, securityProfile } = meta;
  return execution.run({ conversationId: meta.id,
    configuration: structuredClone({ selectedModel, modelProfileId, thinkingEffort, securityProfile }),
    initialSecurityReference: securityProfile,
  }, action);
}

/** Use only for configuration reads; never save this copy or replace the shared live history. */
export function conversationExecutionMeta<T extends Partial<ConversationMeta> & Pick<ConversationMeta, 'id'>>(meta: T): T {
  const scope = execution.getStore();
  if (!scope || !meta.id || scope.conversationId !== meta.id) return meta;
  return { ...meta, ...scope.configuration };
}
export function conversationExecutionEffort(meta: ConversationMeta) {
  return conversationExecutionMeta(meta).thinkingEffort;
}

/** Resolve a logical turn's default model once; explicit review/summary model requests stay independent. */
export function conversationExecutionModel(meta: ConversationMeta, resolve: () => Promise<ResolvedModel | null>): Promise<ResolvedModel | null> {
  const scope = scopeFor(meta);
  if (!scope) return resolve();
  return scope.model ??= resolve();
}

/** Initialize the original selected policy once before any tools, without overwriting a pending edit. */
export async function conversationExecutionSecurity(meta: ConversationMeta, initialize: (meta: ConversationMeta) => Promise<void>): Promise<SecurityProfile> {
  const scope = scopeFor(meta);
  if (!scope) { await initialize(meta); return meta.securityProfile!; }
  return scope.security ??= (async () => {
    const executionMeta = conversationExecutionMeta(meta);
    await initialize(executionMeta);
    const profile = structuredClone(executionMeta.securityProfile!);
    scope.configuration.securityProfile = profile;
    if (meta.securityProfile === scope.initialSecurityReference) meta.securityProfile = structuredClone(profile);
    return profile;
  })();
}
