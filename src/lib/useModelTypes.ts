import { useEffect, useState } from 'react';
import type { ModelProvider } from '../../shared/types';
import { modelCapabilityKey, type ModelTypeCaps } from '../../shared/model-types';

let cache: Record<string, ModelTypeCaps> = {};
let cacheSignature = '{}';
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let pending = false;
async function refresh() {
  if (pending || document.visibilityState === 'hidden' || !window.api?.modelCapsGet) return;
  pending = true;
  try {
    const next = await window.api.modelCapsGet();
    const signature = JSON.stringify(next);
    if (signature !== cacheSignature) {
      cache = next;
      cacheSignature = signature;
      for (const listener of listeners) listener();
    }
  } catch { /* Preserve confirmed results while IPC is temporarily unavailable. */ }
  finally { pending = false; }
}

export function useModelTypes(providers: ModelProvider[]) {
  const [, rerender] = useState(0);
  const signature = providers.map(p => `${p.id}:${p.enabled}:${p.models.join(',')}`).join('|');
  useEffect(() => {
    const listener = () => rerender(n => n + 1);
    listeners.add(listener);
    void refresh();
    if (listeners.size === 1) document.addEventListener('visibilitychange', refresh);
    timer ??= setInterval(() => void refresh(), 2000);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        clearInterval(timer); timer = undefined;
        document.removeEventListener('visibilitychange', refresh);
      }
    };
  }, []);
  useEffect(() => {
    void window.api?.modelCapsProbe?.([]).then(() => refresh()).catch(() => {});
  }, [signature]);
  return (provider: ModelProvider, modelId: string): ModelTypeCaps => cache[modelCapabilityKey(provider, modelId)] ?? {};
}
