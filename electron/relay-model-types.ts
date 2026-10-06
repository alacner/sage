import { relayFetch } from './relay-tls';
import type { AppSettings } from '../shared/types';
import type { ProbeFeature } from '../shared/model-probe-report';
import { relayConnection } from './relay-models';
export interface SharedModelType { model: string; type: ProbeFeature; supported: boolean; checkedAt: number }
const types = new Set(['chat', 'vision', 'webSearch', 'reasoning', 'tool', 'reranker', 'embedding', 'thinking:low', 'thinking:medium', 'thinking:xhigh']);
function record(value: any): SharedModelType {
  if (!value || typeof value.model !== 'string' || value.model.length > 500 || !types.has(value.type) || typeof value.supported !== 'boolean' || !Number.isFinite(value.checkedAt)) throw Error('中继模型类型缓存格式无效');
  return { model: value.model, type: value.type, supported: value.supported, checkedAt: value.checkedAt };
}
export function relayModelTypes(settings: AppSettings) {
  let connection: ReturnType<typeof relayConnection>;
  try { connection = relayConnection(settings); } catch { return undefined; }
  let supported = true;
  const request = async (action: string, body: unknown) => {
    if (!supported) return null;
    const current = relayConnection(settings);
    if (current.baseUrl !== connection.baseUrl || current.token !== connection.token) throw Error('中继连接已改变');
    const response = await relayFetch(connection.relayTransport)(`${connection.baseUrl}/provider/model-types/${action}`, {
      method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(4000),
    });
    // Older relays keep working without shared-cache support.
    if (response.status === 404 || response.status === 405) { supported = false; return null; }
    if (!response.ok) throw Error(`中继模型类型同步失败（HTTP ${response.status}）`);
    return response.json() as Promise<any>;
  };
  return {
    async lookup(models: string[]) {
      const data = await request('lookup', { models });
      if (!data) return [];
      if (!Array.isArray(data.data) || data.data.length > 3500) throw Error('中继模型类型缓存过大');
      return data.data.map(record).filter((r: SharedModelType) => models.includes(r.model));
    },
    async publish(items: SharedModelType[]) { await request('publish', { items: items.map(({ model, type, supported }) => ({ model, type, supported })) }); },
    async claim(model: string, type: ProbeFeature, force: boolean) {
      const data = await request('claim', { model, type, force });
      if (!data) return { local: true as const };
      if (data.record) {
        const r = record(data.record);
        if (r.model !== model || r.type !== type) throw Error('中继返回了不匹配的模型类型');
        return { record: r };
      }
      if (typeof data.lease === 'string' && data.lease.length < 100) return { lease: data.lease };
      if (data.busy === true) return { busy: true as const };
      throw Error('中继验证锁响应无效');
    },
    async finish(model: string, type: ProbeFeature, lease: string, supported?: boolean) { await request('result', { model, type, lease, ...(supported === undefined ? {} : { supported }) }); },
  };
}
