import { create } from 'zustand';
import type { ModelProvider, SelectedModel } from '../../shared/types';
import { splitApiKeys } from '../../shared/model-providers';
import { PROTECTED } from '../../shared/settings-protection';

// Only readiness metadata crosses from settings into the guide, never credentials.
export interface SetupProvider {
  id: string;
  name: string;
  kind: ModelProvider['kind'];
  customRouting: boolean;
  enabled: boolean;
  hasHost: boolean;
  hasKey: boolean;
  protocol: string;
  models: string[];
}
export function validSetupUrl(value: string, relay = false) {
  try { const url = new URL(value.trim()); return !!url.hostname && (relay ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol); }
  catch { return false; }
}
export function setupProvider(provider: ModelProvider): SetupProvider {
  return {id: provider.id, name: provider.name, kind: provider.kind, customRouting: !!provider.routingExtension, enabled: provider.enabled !== false,
    hasHost: provider.baseUrl === PROTECTED || validSetupUrl(provider.baseUrl), hasKey: splitApiKeys(provider.apiKey).length > 0,
    protocol: provider.protocol, models: provider.models};
}
export interface SetupSnapshot {
  tab: string;
  providers: SetupProvider[];
  relay: {hasAddress: boolean; hasToken: boolean; status: string; error?: string; apply: 'checking' | 'available' | 'unavailable'};
  test: {id: string; busy: boolean; result?: {ok: boolean; listSupported?: boolean; count: number; error?: string}};
  defaultModel: SelectedModel | null;
  visionModel: SelectedModel | null;
  backend: string;
  cliReady: boolean;
  saving: boolean;
  error?: string;
}
export interface SetupProbe {
  loaded: boolean;
  pending: number;
  running: boolean;
  attempts: number;
  error?: string;
}
export const useOnboardingContext = create<{
  snapshot: SetupSnapshot | null;
  selectedProviderId: string | null;
  probe: SetupProbe | null;
}>(() => ({snapshot: null, selectedProviderId: null, probe: null}));

export function setupModelReady(providers: SetupProvider[], model: SelectedModel | null | undefined) {
  return !!model && providers.some(p => p.enabled && p.id === model.providerId && p.models.includes(model.modelId));
}
