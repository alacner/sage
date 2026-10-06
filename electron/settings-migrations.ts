import type { AppSettings, ModelProvider, SelectedModel } from '../shared/types';
import { policyUnion, fieldProtection, protectionFor } from '../shared/settings-protection';

export function migrateModelProfiles(settings: AppSettings): AppSettings {
  if (settings._modelMigrationVersion === 1 || !settings.modelProfiles || settings.modelProfiles.length === 0) {
    return settings; // 无需迁移
  }

  const migratedProviders: ModelProvider[] = [];
  let defaultSelectedModel: SelectedModel | undefined;

  for (const profile of settings.modelProfiles) {
    if (!profile.model) continue; // 跳过空档案

    // 为每个 profile 创建一个 provider
    const provider: ModelProvider = {
      id: `migrated-${profile.id}`,
      name: profile.name || profile.model || '未命名',
      baseUrl: profile.baseUrl || '',
      apiKey: profile.apiKey,
      protocol: profile.protocol || 'anthropic',
      models: [profile.model],
      enabled: true,
    };
    migratedProviders.push(provider);

    // 如果是默认档案，记录对应的 selectedModel
    if (settings.defaultModelProfileId === profile.id) {
      defaultSelectedModel = {
        providerId: provider.id,
        modelId: profile.model,
      };
    }
  }

  // 合并到现有的 modelProviders
  const existingProviders = settings.modelProviders ?? [];
  const mergedProviders = [...existingProviders, ...migratedProviders.filter(p => !existingProviders.some(e => e.id === p.id))];

  // 返回更新后的 settings
  const migrated: AppSettings = {
    ...settings,
    modelProviders: mergedProviders,
    // Keep legacy IDs for project/conversation references, including incomplete profiles.
    _modelMigrationVersion: 1,
    _secretPolicy: policyUnion(settings._secretPolicy),
  };

  for (const profile of settings.modelProfiles) {
    if (!profile.model) continue;
    const id = `migrated-${profile.id}`;
    migrated._secretPolicy!.providers![id] = fieldProtection(migrated._secretPolicy!.providers?.[id], protectionFor(settings, profile.id, 'modelProfiles'));
  }

  // 如果有默认档案，设置 selectedModel
  if (defaultSelectedModel && !settings.selectedModel) {
    migrated.selectedModel = defaultSelectedModel;
  }

  return migrated;
}

/** Move the former host-owned credential vault into the matching external plugin settings. */
export function migrateExternalCredentialPlugins(settings: AppSettings): AppSettings {
  const legacy = settings as AppSettings & { credentialSnippets?: Array<{id:string;name:string;keyword:string;snippet:string}>; mfaEntries?: Array<{id:string;name:string;secret:string;prepend:string;append:string}> };
  if (!legacy.credentialSnippets?.length && !legacy.mfaEntries?.length) return settings;
  const pluginSecrets = { ...(settings.pluginSecrets ?? {}) };
  if (legacy.credentialSnippets?.length && !pluginSecrets['sage.snippets']?.entries) {
    pluginSecrets['sage.snippets'] = { ...pluginSecrets['sage.snippets'], entries: JSON.stringify(legacy.credentialSnippets) };
  }
  if (legacy.mfaEntries?.length && !pluginSecrets['sage.mfa']?.entries) {
    pluginSecrets['sage.mfa'] = { ...pluginSecrets['sage.mfa'], entries: JSON.stringify(legacy.mfaEntries) };
  }
  const { credentialSnippets: _snippets, mfaEntries: _mfa, ...rest } = settings as AppSettings & { credentialSnippets?: unknown; mfaEntries?: unknown };
  return { ...rest, pluginSecrets };
}
