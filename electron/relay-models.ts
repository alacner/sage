import { relayFetch, type RelayTransport } from './relay-tls';
import type { AppSettings, ModelProvider } from '../shared/types';
import { getConnectedRelay } from './channels/relay-client';
import { runtimeConfig } from '../shared/runtime-config';

// Website IDs can reach 881 characters (80-char provider + encoded 200-char UTF-8 model).
export const MAX_RELAY_MODEL_ID_LENGTH = 1024;

export function relayConnection(settings: AppSettings) {
  const connection = getConnectedRelay();
  if (!connection || !settings.relayUrl || !settings.relayToken || connection.url !== settings.relayUrl || connection.token !== settings.relayToken) {
    throw new Error(settings.language === 'en' ? 'Connect the configured relay first' : '请先连接当前配置的中继');
  }
  const raw = connection.url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  const url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid relay URL');
  url.pathname = url.pathname.replace(/\/ws\/?$/, '').replace(/\/+$/, '');
  return { baseUrl: url.toString().replace(/\/+$/, ''), token: connection.token, relayTransport:{origin:url.origin,certificate:settings.relayCertificate} as RelayTransport };
}
export async function fetchRelayModels(settings: AppSettings, timeoutMs?: number): Promise<NonNullable<ModelProvider['relayModels']>> {
  const connection = relayConnection(settings);
  const response = await relayFetch(connection.relayTransport)(`${connection.baseUrl}/provider/models`, {
    headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(Math.min(timeoutMs ?? Infinity, runtimeConfig(settings.runtimeConfig).apiRequestTimeoutMs)), redirect: 'error',
  });
  if (!response.ok) throw new Error(`中继模型列表获取失败（HTTP ${response.status}）`);
  const body = await response.json() as any;
  if (!Array.isArray(body.data) || body.data.length > 5000) throw new Error('中继返回的模型列表无效');
  const ids = new Set<string>();
  return body.data.map((m: any) => {
    if (!m || typeof m.id !== 'string' || !m.id || m.id.length > MAX_RELAY_MODEL_ID_LENGTH || ids.has(m.id) || !['openai', 'anthropic'].includes(m.protocol) || typeof m.name !== 'string') throw new Error('中继模型定义无效');
    ids.add(m.id);
    const displayName = typeof m.displayName === 'string' && m.displayName.trim()
      ? m.displayName
      : m.providerName && typeof m.providerName === 'string' ? `${m.providerName} · ${m.name}` : m.name;
    return { id: m.id, modelId: m.name, name: displayName, protocol: m.protocol as 'openai' | 'anthropic' };
  });
}
export function resolveRelayModel(settings: AppSettings, provider: ModelProvider, model: string) {
  const connection = relayConnection(settings);
  const entry = provider.relayModels?.find(m => m.id === model);
  if (!entry) throw new Error('中继模型配置已变化，请刷新模型列表');
  return { relayTransport:connection.relayTransport, apiKey: connection.token, baseUrl: `${connection.baseUrl}/provider${entry.protocol === 'openai' ? '/v1' : ''}`, protocol: entry.protocol, model };
}
