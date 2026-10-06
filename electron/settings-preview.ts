import type { AppSettings, SettingsVersionPreview } from '../shared/types';
import { publicSettings, policyUnion } from './settings-transfer';
import { modelLabel } from '../shared/model-label';

export function settingsVersionPreview(name: string, current: AppSettings, version: AppSettings): SettingsVersionPreview {
  // Current protection applies even if the selected snapshot predates import.
  const safe = publicSettings({ ...version, _secretPolicy: policyUnion(current._secretPolicy, version._secretPolicy) });
  const preferences = ['language', 'theme', 'backendEngine', 'preventSleep', 'expertsMaxParallel'] as const;
  const display = (value: unknown) => value === undefined ? '—' : String(value);
  return {
    name, revision: current._revision ?? 'legacy', createdAt: Number(name.split('-')[0]),
    providers: (safe.modelProviders ?? []).map(p => {
      const old = current.modelProviders?.find(v => v.id === p.id);
      const original = version.modelProviders?.find(v => v.id === p.id);
      return { id: p.id, name: p.name, kind: p.kind ?? 'normal', enabled: p.enabled, models: p.models.map(id => modelLabel(p, id)), apiHost: p.baseUrl ?? '', keyConfigured: !!original?.apiKey,
        change: !old ? 'added' : JSON.stringify(old) === JSON.stringify(original) ? 'unchanged' : 'changed' };
    }),
    removedProviders: (current.modelProviders ?? []).filter(p => !version.modelProviders?.some(v => v.id === p.id)).map(p => p.name),
    preferences: preferences.map(key => ({key, before:display(current[key]), after:display(version[key])})),
  };
}
