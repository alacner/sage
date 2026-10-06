import { DEFAULT_MODEL } from '../shared/model-defaults';
import { conversationExecutionMeta, conversationExecutionModel } from './conversation-execution';
import { effectiveModelSelection } from '../shared/model-selection';
import { modelTimeRangeActive } from '../shared/model-availability';
/**
 * 统一解析当前生效的模型配置。
 *
 * 新架构优先级：
 * 1. 对话级 selectedModel > 2. 项目级 selectedModel > 3. 全局 selectedModel
 *
 * 旧架构（ModelProfile）保留向后兼容，但已废弃。
 */

import { resolveRelayModel } from './relay-models';
import {AsyncLocalStorage} from 'node:async_hooks';
const routingCalls=new AsyncLocalStorage<Set<string>>();
import { readSettings } from './main';
import { listProjects } from './store';
import { pickApiKey, pickWeightedMember } from './utils/api-key-picker';
import { decryptSecret } from './sandbox/secrets';
import { supportsNativeVision } from './vision-routing';
import type { AppSettings, ConversationMeta, SelectedModel, ModelProvider, CompositeMember, ModelMapping } from '../shared/types';


export interface ResolvedModel {
  relayTransport?: import("./relay-tls").RelayTransport;
  thinkingEffort?: import("../shared/types").ThinkingEffort;
  thinkingModel?: string;
  apiKey: string;
  baseUrl?: string;
  model: string;
  protocol: 'anthropic' | 'openai';
  /** true = 来自模型配置（强制 API 直连）。 */
  fromProfile: boolean;
  /** 命中的提供商名称（用于日志/统计，复合提供商解析到实际成员）。 */
  providerName?: string;
  /** 命中的提供商 id（复合提供商解析到实际成员），统计归属用。 */
  providerId?: string;
  /**
   * 用户本轮选中的提供商/模型（对话级选中的原始值，未做复合解析）。
   * 统计时复合类型需要「双算」：既归入用户选中的复合维度，
   * 也归入实际产生调用的成员维度。
   */
  selectedProviderId?: string;
  selectedModelId?: string;
  /** 显示用模型名（复合成员实际模型名与复合声明不一致时，取复合声明值）。 */
  modelDisplayName?: string;
}

/**
 * 解析成员针对某个复合模型名的实际模型名。
 *
 * 优先使用 modelMappings（新架构），回退 modelOverride（旧字段向后兼容）。
 * - modelMappings 非空时：查找 compositeModel === modelId 的映射项，返回 memberModel
 * - modelMappings 为空且 modelOverride 非空：旧字段，仅适用于单模型场景
 * - 两者都为空：同名直传（返回 modelId 原值）
 */
function resolveMemberModel(
  member: CompositeMember,
  modelId: string,
): string {
  // 新架构：modelMappings 优先
  if (member.modelMappings && member.modelMappings.length > 0) {
    const mapping = member.modelMappings.find((m) => m.compositeModel === modelId);
    if (mapping) return mapping.activeTimeRanges && !modelTimeRangeActive(mapping.activeTimeRanges)
      ? (mapping.fallbackModel || mapping.memberModel)
      : mapping.memberModel;
    // 未命中映射项：同名直传（兜底）
    return modelId;
  }
  // 旧字段兼容
  if (member.modelOverride?.trim()) return member.modelOverride.trim();
  // 默认同名直传
  return modelId;
}

/**
 * 复合提供商解析：按权重随机挑选一个有效成员，再用该成员的实际配置解析。
 *
 * 有效成员条件：成员提供商存在、已启用、支持该模型（含映射解析后的实际模型名）。
 * 挑出成员后，模型名使用成员上的实际名称（经 modelMappings 解析），保证发给成员端点的模型名是正确的。
 */
function resolveComposite(
  settings: AppSettings,
  composite: ModelProvider,
  modelId: string,
): ResolvedModel | null {
  const members = composite.composite?.members ?? [];
  // 过滤出有效成员：存在、启用、支持该模型（含映射解析后的实际模型名）
  const valid: Array<CompositeMember & { member: ModelProvider; memberModel: string }> = [];
  for (const m of members) {
    const mapping = m.modelMappings?.find(x => x.compositeModel === modelId);
    const inWindow = modelTimeRangeActive(mapping?.activeTimeRanges);
    const requestedModel = mapping?.activeTimeRanges && !inWindow && mapping.fallbackModel
      ? mapping.fallbackModel
      : resolveMemberModel(m, modelId);
    if (mapping?.activeTimeRanges && !inWindow && !mapping.fallbackModel) continue;
    const member = (settings.modelProviders ?? []).find((p) => p.enabled && p.models.includes(requestedModel) &&
      (mapping?.activeTimeRanges && !inWindow && mapping.fallbackModel ? p.kind !== 'composite' : p.id === m.providerId));
    if (!member) continue;
    valid.push({ ...m, member, memberModel: requestedModel });
  }
  if (valid.length === 0) {
    const configured = members.some(m => !!m.modelMappings?.find(x=>x.compositeModel===modelId)?.activeTimeRanges);
    if(configured) throw new Error(`模型 ${modelId} 当前不在配置的生效时间段内`);
    return null;
  }

  // 加权随机挑选成员
  const chosen = pickWeightedMember(valid);
  if (!chosen) return null;
  const member = chosen.member;
  const memberModel = chosen.memberModel;

  const connection = member.kind === 'relay' ? resolveRelayModel(settings, member, memberModel) : { apiKey: decryptSecret(pickApiKey(member.apiKey)), baseUrl: member.baseUrl || undefined, relayTransport:undefined, protocol: member.protocol || 'openai' };
  return {
    relayTransport: connection.relayTransport,
    apiKey: connection.apiKey,
    baseUrl: connection.baseUrl,
    model: memberModel,
    thinkingModel: member.kind === 'relay' ? member.relayModels?.find(m => m.id === memberModel)?.modelId : memberModel,
    protocol: connection.protocol,
    fromProfile: true,
    providerName: `${composite.name} → ${member.name}`,
    // 实际产生调用的成员（真实调用链路归属）
    providerId: member.id,
    // 用户选中的复合维度（统计双算用）
    selectedProviderId: composite.id,
    selectedModelId: modelId,
    // 显示用模型名：成员实际模型名（可能与复合声明不同）
    modelDisplayName: memberModel,
  };
}

/**
 * 根据 SelectedModel（providerId + modelId）解析出完整的模型配置。
 * 支持普通提供商与复合提供商（kind === 'composite'）。
 */
function resolveFromSelectedModel(
  settings: AppSettings,
  selected: SelectedModel | undefined,
): ResolvedModel | null {
  if (!selected?.providerId || !selected?.modelId) return null;
  const provider = (settings.modelProviders ?? []).find((p) => p.id === selected.providerId);
  if (!provider) return null;
  if (provider.routingExtension) return null;
  // 验证 modelId 确实在 provider 的模型列表中
  if (!provider.models.includes(selected.modelId)) return null;

  // 复合提供商：加权随机挑成员，用成员实际配置解析
  if (provider.kind === 'composite') {
    const result = resolveComposite(settings, provider, selected.modelId);
    return result ? {...result,thinkingEffort:selected.thinkingEffort??'low'} : null;
  }

  const connection = provider.kind === 'relay' ? resolveRelayModel(settings, provider, selected.modelId) : { apiKey: decryptSecret(pickApiKey(provider.apiKey)), baseUrl: provider.baseUrl || undefined, relayTransport:undefined, protocol: provider.protocol || 'openai' };
  return {
    thinkingEffort:selected.thinkingEffort??'low',
    thinkingModel: provider.kind === 'relay' ? provider.relayModels?.find(m=>m.id===selected.modelId)?.modelId : selected.modelId,
    relayTransport: connection.relayTransport,
    apiKey: connection.apiKey,
    baseUrl: connection.baseUrl,
    model: selected.modelId,
    protocol: connection.protocol,
    fromProfile: true,
    providerName: provider.name,
    providerId: provider.id,
    // 普通类型：选中的即实际使用的（无双算）
    selectedProviderId: provider.id,
    selectedModelId: selected.modelId,
    modelDisplayName: provider.relayModels?.find(m => m.id === selected.modelId)?.name ?? selected.modelId,
  };
}

/**
 * 旧架构：根据 ModelProfile id 解析。
 * @deprecated 保留向后兼容，新代码请使用 resolveFromSelectedModel
 */
function resolveFromLegacyProfile(
  settings: AppSettings,
  profileId: string | undefined,
): ResolvedModel | null {
  if (!profileId) return null;
  const profile = (settings.modelProfiles ?? []).find((p) => p.id === profileId);
  if (!profile) return null;
  return {
    apiKey: decryptSecret(pickApiKey(profile.apiKey)),
    baseUrl: profile.baseUrl || undefined,
    model: profile.model || DEFAULT_MODEL,
    protocol: profile.protocol || 'anthropic',
    fromProfile: true,
  };
}

/**
 * 未指定全局默认模型时的回退：取第一个已启用且配置了模型的提供商的首个模型。
 * 返回的 SelectedModel 仍走 resolveFromSelectedModel 解析（兼容复合/中继）。
 */
export function fallbackSelectedModel(settings: AppSettings): SelectedModel | null {
  const provider = (settings.modelProviders ?? []).find((p) => p.enabled && (p.models?.length ?? 0) > 0);
  return provider ? { providerId: provider.id, modelId: provider.models[0] } : null;
}

type ModelResolutionInput = {
  selectedModel?: SelectedModel;
  followGlobal?: boolean;
  task?: string;
  convMeta?: ConversationMeta;
  projectPath?: string;
};
export async function resolveModel(input: ModelResolutionInput): Promise<ResolvedModel | null> {
  const request = input.convMeta ? { ...input, convMeta: conversationExecutionMeta(input.convMeta) } : input;
  const resolve = () => resolveModelWithSettings(request);
  return input.convMeta && !input.selectedModel && !input.followGlobal
    ? conversationExecutionModel(input.convMeta, resolve) : resolve();
}
async function resolveModelWithSettings(input: ModelResolutionInput): Promise<ResolvedModel | null> {
  const settings = await readSettings();

  const routingProject=input.projectPath??input.convMeta?.projectPath??'';
  const projectSelection=!input.followGlobal&&routingProject?(await listProjects()).find(p=>p.path===routingProject)?.selectedModel:undefined;
  const globalSelection=settings.selectedModel??fallbackSelectedModel(settings);
  const projectModel=effectiveModelSelection(projectSelection,globalSelection);
  const conversationModel=effectiveModelSelection(input.convMeta?.selectedModel,projectModel);
  if(conversationModel && input.convMeta?.thinkingEffort !== undefined) conversationModel.thinkingEffort=input.convMeta.thinkingEffort;
  const selection=effectiveModelSelection(input.selectedModel,input.followGlobal?globalSelection:conversationModel);
  const routedProvider=settings.modelProviders?.find(p=>p.id===selection?.providerId&&p.enabled&&p.routingExtension);
  if(routedProvider){
    const active=routingCalls.getStore()??new Set<string>();
    if(active.has(routedProvider.routingExtension!))throw Error('Recursive model routing: choose an explicit base provider for planning');
    const {pluginManager}=await import('./plugins');
    const {invokeExtension}=await import('./plugins/extensions');
    const candidates=(settings.modelProviders??[]).filter(p=>p.enabled&&!p.routingExtension&&p.kind!=='composite').map(p=>({providerId:p.id,name:p.name,models:p.models}));
    const selected=await routingCalls.run(new Set([...active,routedProvider.routingExtension!]),()=>invokeExtension(pluginManager(),routingProject,'sage/models.route',routedProvider.routingExtension!,{
      requestedModel:selection?.modelId,
      task:input.task??input.convMeta?.messages?.filter(m=>m.role==='user').at(-1)?.content??'',
      candidates,
    })) as SelectedModel;
    if(!candidates.some(p=>p.providerId===selected.providerId&&p.models.includes(selected.modelId)))throw Error('Model router selected an unavailable model');
    const resolved=resolveFromSelectedModel(settings,selected);
    if(!resolved)throw Error('Model router could not resolve selection');
    return {...resolved,thinkingEffort:selection?.thinkingEffort??resolved.thinkingEffort,selectedProviderId:routedProvider.id,selectedModelId:selection?.modelId};
  }

  if(input.selectedModel||input.followGlobal) {
    const explicit=resolveFromSelectedModel(settings,selection??undefined);
    if(input.selectedModel&&!explicit)throw new Error('Selected model is unavailable');
    return explicit;
  }

  // 1. 对话级（新架构）
  const convSelected = resolveFromSelectedModel(settings, effectiveModelSelection(input.convMeta?.selectedModel,projectModel));
  if (convSelected) return convSelected;

  // 2. 项目级（新架构）
  const projectPath = input.projectPath ?? input.convMeta?.projectPath;
  if (projectPath) {
    const projects = await listProjects();
    const entry = projects.find((p) => p.path === projectPath);
    const projSelected = resolveFromSelectedModel(settings, effectiveModelSelection(entry?.selectedModel,globalSelection));
    if (projSelected) return projSelected;
  }

  // 3. 全局默认（新架构）
  const globalSelected = resolveFromSelectedModel(settings, settings.selectedModel);
  if (globalSelected) return globalSelected;

  // 3.5 回退：未指定全局默认模型时，取第一个已启用提供商的首个模型
  const fallback = resolveFromSelectedModel(settings, fallbackSelectedModel(settings) ?? undefined);
  if (fallback) return fallback;

  // ─── 以下为旧架构兼容（已废弃） ───

  // 4. 对话级（旧架构）
  const convLegacy = resolveFromLegacyProfile(settings, input.convMeta?.modelProfileId);
  if (convLegacy) return convLegacy;

  // 5. 项目级（旧架构）
  if (projectPath) {
    const projects = await listProjects();
    const entry = projects.find((p) => p.path === projectPath);
    const projLegacy = resolveFromLegacyProfile(settings, entry?.modelProfileId);
    if (projLegacy) return projLegacy;
  }

  // 6. 全局默认（旧架构）
  const globalLegacy = resolveFromLegacyProfile(settings, settings.defaultModelProfileId);
  if (globalLegacy) return globalLegacy;

  // 7. 遗留单一 Key
  if (settings.anthropicApiKey) {
    return {
      apiKey: decryptSecret(pickApiKey(settings.anthropicApiKey)),
      baseUrl: settings.anthropicBaseUrl || undefined,
      model: settings.model || DEFAULT_MODEL,
      protocol: settings.apiProtocol || 'anthropic',
      fromProfile: false,
    };
  }

  return null;
}

/**
 * 解析当前生效的视觉模型（图片→文字预处理用）。
 *
 * 优先级：对话级 selectedVisionModel > 项目级 selectedVisionModel > 全局 selectedVisionModel
 *   > 当前生效默认模型（项目 selectedModel > 全局 selectedModel > 首个提供商回退，且支持视觉）
 *   > 旧架构 visionModel + 遗留单一 Key。
 * 未配置时返回 null：新架构下调用方应报错提醒配置全局视觉模型，
 * 遗留单一 Key 用户回退为原始图片直传。
 */
export async function resolveVisionModel(input: {
  projectPath?: string;
  convMeta?: (Pick<ConversationMeta, 'selectedVisionModel' | 'selectedModel'> & Partial<Pick<ConversationMeta, 'id'>>) | null;
}): Promise<ResolvedModel | null> {
  if (input.convMeta?.id) input = { ...input, convMeta: conversationExecutionMeta({ ...input.convMeta, id: input.convMeta.id }) };
  const settings = await readSettings();
  const conversationVision = resolveFromSelectedModel(settings, input.convMeta?.selectedVisionModel?.followDefault ? undefined : input.convMeta?.selectedVisionModel);
  if (conversationVision) return conversationVision;

  // 1. 项目级（新架构）
  let projectEntry;
  if (input.projectPath) {
    const projects = await listProjects();
    projectEntry = projects.find((p) => p.path === input.projectPath);
    const projVision = resolveFromSelectedModel(settings, effectiveModelSelection(projectEntry?.selectedVisionModel,settings.selectedVisionModel));
    if (projVision) return projVision;
  }

  // 2. 全局（新架构）
  const globalVision = resolveFromSelectedModel(settings, settings.selectedVisionModel);
  if (globalVision) return globalVision;

  // 2.5 回退：未显式配置视觉模型时，若当前生效的默认模型支持视觉，则复用它
  const effectiveDefault =
    resolveFromSelectedModel(settings, input.convMeta?.selectedModel?.followDefault ? undefined : input.convMeta?.selectedModel) ??
    resolveFromSelectedModel(settings, effectiveModelSelection(projectEntry?.selectedModel,settings.selectedModel)) ??
    resolveFromSelectedModel(settings, settings.selectedModel) ??
    resolveFromSelectedModel(settings, fallbackSelectedModel(settings) ?? undefined);
  if (effectiveDefault && await supportsNativeVision(effectiveDefault)) return effectiveDefault;

  // 3. 旧架构：visionModel + 遗留单一 Key
  if (settings.visionModel && settings.anthropicApiKey) {
    return {
      apiKey: decryptSecret(pickApiKey(settings.anthropicApiKey)),
      baseUrl: settings.anthropicBaseUrl || undefined,
      model: settings.visionModel,
      protocol: settings.apiProtocol || 'anthropic',
      fromProfile: false,
    };
  }

  return null;
}

/**
 * 数据迁移：将旧的 ModelProfile 转为 ModelProvider。
 * 在应用启动时调用一次。
 */
export { migrateModelProfiles } from './settings-migrations';
