import type { AppSettings, ModelProvider } from '../shared/types';
type Models = NonNullable<ModelProvider['relayModels']>;
export interface RelayCatalogConnection { url: string; token: string }
const sameConnection = (a: RelayCatalogConnection, b: RelayCatalogConnection) => a.url === b.url && a.token === b.token;

/** A single main-process poller for all windows; failed/stale reads never write settings. */
export function createRelayModelSync(deps: {
  connected: () => boolean;
  connection: (settings: AppSettings) => RelayCatalogConnection;
  read: () => Promise<AppSettings>;
  fetch: (settings: AppSettings) => Promise<Models>;
  commit: (before: AppSettings, providers: ModelProvider[], source: RelayCatalogConnection) => Promise<void>;
}) {
  let pending: Promise<void> | undefined, stopped = false, lastSuccess = 0;
  let lastConnection: RelayCatalogConnection | undefined;
  return {
    isRefreshing() { return !!pending; },
    stop() { stopped = true; },
    async tick(maxAgeMs = 0) {
      // Model pickers join an in-flight poll, including its bounded CAS retries.
      if (pending) return pending;
      if (stopped || !deps.connected()) return;
      pending = (async () => {
        try {
          let before = await deps.read();
          const source = deps.connection(before);
          if (maxAgeMs > 0 && lastConnection && sameConnection(source, lastConnection) && Date.now() - lastSuccess < maxAgeMs) return;
          // Starting a new refresh invalidates the earlier success marker. A failed
          // forced/background refresh must not suppress the next picker retry.
          lastSuccess = 0;
          lastConnection = undefined;
          const originalRelayIds = (before.modelProviders ?? []).filter(p => p.kind === 'relay').map(p => p.id);
          const models = (await deps.fetch(before)).slice().sort((a, b) => a.id.localeCompare(b.id));
          // Retry only revision conflicts, with the current provider metadata and the
          // original authenticated catalog source. Never overwrite another edit.
          for (let attempt = 0; attempt < 3; attempt++) {
            if (stopped || !deps.connected() || !sameConnection(source, deps.connection(before))) return;
            const current = before.modelProviders ?? [];
            // A relay deleted/replaced during this request must not be resurrected.
            if (originalRelayIds.length && !current.some(p => p.kind === 'relay' && originalRelayIds.includes(p.id))) return;
            let providers = current.map(p => p.kind === 'relay' ? { ...p, models: models.map(m => m.id), relayModels: models } : p);
            if (!current.some(p => p.kind === 'relay') && models.length) {
              const en = String(before.language ?? '').startsWith('en');
              providers = [...providers, {
                id: Math.random().toString(36).slice(2, 10),
                name: en ? 'Relay provider' : '中继提供商',
                kind: 'relay', apiKey: '', baseUrl: '', protocol: 'openai', enabled: true,
                models: models.map(m => m.id), relayModels: models,
              }];
            }
            if (JSON.stringify(providers) === JSON.stringify(current)) {
              // A no-op still needs a current revision and matching live connection.
              const latest = await deps.read();
              if (stopped || !deps.connected() || !sameConnection(source, deps.connection(latest))) return;
              if ((latest._revision ?? 'legacy') !== (before._revision ?? 'legacy')) { before = latest; continue; }
            } else {
              try { await deps.commit(before, providers, source); }
              catch (error: any) {
                if (error?.code !== 'SETTINGS_CONFLICT' || attempt === 2) throw error;
                before = await deps.read();
                continue;
              }
            }
            lastSuccess = Date.now();
            lastConnection = source;
            return;
          }
        } catch {
          // Retain the valid stored catalog, while allowing an immediate safe retry.
          lastSuccess = 0;
          lastConnection = undefined;
        }
      })();
      try { await pending; } finally { pending = undefined; }
    },
  };
}
