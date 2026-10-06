import type { AppSettings, ModelProvider } from '../shared/types';
import { fetchProviderModelList, type NamedProviderModel } from './provider-models';
import { pickApiKey } from './utils/api-key-picker';
import { decryptSecret } from './sandbox/secrets';
// 清单同步判定与复合联动清理是双端共享逻辑（渲染层测试连接写回时同样需要）。
export { isListSyncedProvider, pruneComposites } from '../shared/model-providers';
import { isListSyncedProvider, pruneComposites } from '../shared/model-providers';

/** A single main-process poller for all windows; failures retain the last valid catalog. */
export function createProviderModelSync(deps: {
  read: () => Promise<AppSettings>;
  commit: (before: AppSettings, providers: ModelProvider[]) => Promise<void>;
}) {
  let busy = false, stopped = false;
  return {
    isRefreshing() { return busy; },
    stop() { stopped = true; },
    async tick() {
      if (busy || stopped) return;
      busy = true;
      try {
        const before = await deps.read();
        const targets = (before.modelProviders ?? []).filter(p => p.enabled && isListSyncedProvider(p));
        if (!targets.length) return;
        let providers = before.modelProviders ?? [];
        let changed = false;
        for (const target of targets) {
          // 密文绝不允许直接发出；decryptSecret 对明文幂等。
          const res = await fetchProviderModelList({
            apiKey: decryptSecret(pickApiKey(target.apiKey)),
            baseUrl: target.baseUrl || undefined,
            protocol: target.protocol,
          });
          if (stopped) return;
          // 清单失败保留上次的有效列表，下次 tick 重试。
          if (!res.ok || !res.models.length) continue;
          const models = res.models.slice().sort((a, b) => a.localeCompare(b));
          const named: NamedProviderModel[] = res.named.slice().sort((a, b) => a.id.localeCompare(b.id));
          const current = providers.find(p => p.id === target.id);
          if (current && JSON.stringify(current.models) === JSON.stringify(models) && JSON.stringify(current.relayModels ?? null) === JSON.stringify(named)) continue;
          providers = providers.map(p => p.id === target.id ? { ...p, models, relayModels: named } : p);
          changed = true;
        }
        if (!changed || stopped) return;
        // 成员模型变化 → 复合提供商联动清理后再提交。
        await deps.commit(before, pruneComposites(providers));
      } catch { /* Network failures and revision conflicts retain the last valid catalog. */ }
      finally { busy = false; }
    },
  };
}
