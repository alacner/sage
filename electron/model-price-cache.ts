import { relayFetch } from './relay-tls';
import { modelPriceKey as normalize } from '../shared/model-price-key';
import { app, ipcMain } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readSettings } from './main';
import { relayConnection } from './relay-models';
import { canReuseModelPriceCache } from '../shared/model-price-cache-policy';

export type CachedModelPrice = { key: string; input: number | null; output: number | null; cacheRead: number | null; cacheWrite?: number | null; history?: Array<{date:string;input:number|null;output:number|null;cacheRead:number|null}> };
export type ModelPriceCache = { fetchedAt: number; date: string | null; usdCnyRate: number; prices: CachedModelPrice[]; cacheHit?: boolean };
const file = () => path.join(app.getPath('userData'), 'model-price-cache.json');
const fallback: ModelPriceCache = { fetchedAt: 0, date: null, usdCnyRate: 7.2, prices: [] };
let memory: ModelPriceCache | undefined;

export async function getModelPriceCache(): Promise<ModelPriceCache> {
  if (memory) return memory;
  try { memory = { ...fallback, ...JSON.parse(await fs.readFile(file(), 'utf8')) }; } catch { memory = fallback; }
  return memory!;
}
async function save(cache: ModelPriceCache) { memory = cache; await fs.writeFile(file(), JSON.stringify(cache)); }

/** Fetches only when a relay websocket is already authenticated. Cache remains useful while offline. */
export async function refreshModelPriceCache(models: string[] = [], { force = false }: { force?: boolean } = {}): Promise<ModelPriceCache> {
  const previous = await getModelPriceCache();
  const requested = [...new Set(models.slice(0, 500).map(normalize))];
  if (!force && canReuseModelPriceCache(previous, requested, Date.now())) return { ...previous, cacheHit: true };
  const settings = await readSettings();
  const connection = relayConnection(settings);
  const response = await relayFetch(connection.relayTransport)(`${connection.baseUrl}/provider/model-prices/lookup`, {
    method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ models: models.slice(0, 500), includeHistory: models.length > 0 }), signal: AbortSignal.timeout(12_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`模型价格获取失败（HTTP ${response.status}）`);
  const body = await response.json() as any;
  const data = body?.data;
  if (!data || !Array.isArray(data.prices) || !Number.isFinite(data.usdCnyRate)) throw new Error('中继返回的模型价格无效');
  const prices = data.prices.filter((p: any) => p && typeof p.key === 'string').map((p: any) => ({ key: normalize(p.key), input: Number.isFinite(p.input) ? p.input : null, output: Number.isFinite(p.output) ? p.output : null, cacheRead: Number.isFinite(p.cacheRead) ? p.cacheRead : null, cacheWrite: Number.isFinite(p.cacheWrite) ? p.cacheWrite : null, history: Array.isArray(p.history) ? p.history.filter((point: any) => point && typeof point.date === 'string').map((point: any) => ({ date: point.date, input: Number.isFinite(point.input) ? point.input : null, output: Number.isFinite(point.output) ? point.output : null, cacheRead: Number.isFinite(point.cacheRead) ? point.cacheRead : null })) : undefined }));
  const merged = models.length ? [...previous.prices.filter(p => !prices.some((fresh: CachedModelPrice) => fresh.key === p.key)), ...prices] : prices;
  const cache = { fetchedAt: Date.now(), date: typeof data.date === 'string' ? data.date : null, usdCnyRate: data.usdCnyRate, prices: merged };
  await save(cache);
  return cache;
}
export function estimateCachedModelCost(model: string, usage: {inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheCreationTokens:number}): number | undefined {
  const price = memory?.prices.find(p => p.key === normalize(model));
  if (!price || price.input == null || price.output == null) return undefined;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * (price.cacheRead ?? price.input) + usage.cacheCreationTokens * (price.cacheWrite ?? price.input)) / 1000;
}
export function applyCachedModelCost(model: string, usage: {inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheCreationTokens:number;costUsd:number;estimatedCost?:boolean}) {
  if (usage.costUsd === 0 || usage.estimatedCost) {
    const estimate = estimateCachedModelCost(model, usage);
    // Missing quotes intentionally retain the established Sonnet fallback, but
    // persist it too so monitors and historical statistics never stay at zero.
    usage.costUsd = estimate ?? ((usage.inputTokens * 3 + usage.outputTokens * 15 + usage.cacheReadTokens * 0.3 + usage.cacheCreationTokens * 3.75) / 1_000_000);
    usage.estimatedCost = true;
  }
  return usage;
}
export function registerModelPriceHandlers(): void {
  ipcMain.handle('model-prices-cache', async (_event, models: string[] = [], options: { force?: boolean } = {}) => {
    const cached = await getModelPriceCache();
    try {
      const fresh = await refreshModelPriceCache(models, options);
      if (fresh.cacheHit) return fresh;
      const [{ listProjects, readProjectStats, writeProjectStats, readGlobalStats, writeGlobalStats }, { repriceProjectRecords }] = await Promise.all([import('./store'), import('./request-monitor')]);
      const projects = await listProjects();
      await Promise.all(projects.map(async project => {
        await repriceProjectRecords(project.path);
        // Deleted conversations retain only aggregate tokens. Their original model
        // is unavailable, so use the latest Sonnet fallback once and persist it.
        const stats = await readProjectStats(project.path);
        if (stats.historicalUsage.costUsd === 0 && (stats.historicalUsage.inputTokens || stats.historicalUsage.outputTokens || stats.historicalUsage.cacheReadTokens || stats.historicalUsage.cacheCreationTokens)) {
          applyCachedModelCost('', stats.historicalUsage);
          await writeProjectStats(project.path, stats);
        }
      }));
      const global = await readGlobalStats();
      if (global.historicalUsage.costUsd === 0 && (global.historicalUsage.inputTokens || global.historicalUsage.outputTokens || global.historicalUsage.cacheReadTokens || global.historicalUsage.cacheCreationTokens)) {
        applyCachedModelCost('', global.historicalUsage);
        await writeGlobalStats(global);
      }
      return fresh;
    } catch { return { ...cached, refreshFailed: true }; }
  });
}
