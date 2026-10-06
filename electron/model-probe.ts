import { relayFetch, type RelayTransport } from './relay-tls';
import { visionProbePng } from './model-probe-image';
import { sanitizeProbeText, probeEndpoint } from './model-probe-log';
import { relayModelTypes, type SharedModelType } from './relay-model-types';
import { onRelayConnected } from './channels/relay-client';
import type { ProbeRecord, ProbeReport, ProbeRetry, ProbeLog } from '../shared/model-probe-report';
import { app, BrowserWindow, ipcMain, powerMonitor } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { readSettings } from './main';
import { resolveRelayModel } from './relay-models';
import { pickApiKey } from './utils/api-key-picker';
import { decryptSecret } from './sandbox/secrets';
import type { AppSettings, ModelProvider } from '../shared/types';
import { MODEL_TYPES, THINKING_EFFORTS, modelCapabilityKey, type ModelTypeCaps, type ThinkingEffortProbe } from '../shared/model-types';
import { audit } from './sandbox/audit-log';
import { getApiHeaders } from './utils/api-user-agent';

type Feature = keyof ModelTypeCaps;
type Entry = ModelTypeCaps & { attempts: number; nextAt: number; records?: Partial<Record<Feature, ProbeRecord>>; logs?: Partial<Record<Feature, ProbeLog[]>> };
export type CapsView = Record<string, ModelTypeCaps>;
type Cache = Record<string, Entry>;
const FEATURES: Feature[] = ['chat', ...MODEL_TYPES, ...THINKING_EFFORTS.map(effort => `thinking:${effort}` as const)];
const PNG = visionProbePng();
let loading: Promise<Cache> | undefined;
let active: Promise<CapsView> | undefined;
let stopped = false;
let manualActive: Promise<void> | undefined;
let manualCompleted = 0, manualTotal = 0;
let manualError: string | undefined;
const manualRunning = new Set<string>();
let backgroundTaskIdle = () => false;
const cacheFile = () => path.join(app.getPath('userData'), 'model-capability-cache.json');

async function load(): Promise<Cache> {
  return loading ??= (async () => {
    try {
      const data = JSON.parse(await fs.readFile(cacheFile(), 'utf8'));
      // Old provider-scoped results treated arbitrary 400 responses as unsupported. Do not migrate them.
      if (![2, 3, 4, 5].includes(data.version) || !data.models || typeof data.models !== 'object') return {};
      const clean: Cache = Object.create(null);
      for (const [key, value] of Object.entries(data.models)) {
        if (!key.startsWith('model:') || !value || typeof value !== 'object') continue;
        const v = value as Entry;
        // v2 的 Anthropic 请求路径错误；保留已确认结果，但立即重试未知能力。
        const e: Entry = { attempts: data.version >= 4 ? Number(v.attempts) || 0 : 0, nextAt: data.version >= 4 ? Number(v.nextAt) || 0 : 0 };
        for (const feature of FEATURES) if (typeof v[feature] === 'boolean') e[feature] = v[feature];
        if (v.records && typeof v.records === 'object') {
          e.records = {};
          for (const feature of FEATURES) {
            const r = v.records[feature];
            if (r && typeof r.providerId === 'string' && typeof r.providerName === 'string' && Number.isFinite(r.checkedAt)) e.records[feature] = r;
          }
        }
        if (v.logs && typeof v.logs === 'object') {
          e.logs = {};
          for (const feature of FEATURES) if (Array.isArray(v.logs[feature])) e.logs[feature] = v.logs[feature]!.slice(-5).filter(l => l && Number.isFinite(l.checkedAt) && typeof l.reason === 'string');
        }
        clean[key] = e;
      }
      return clean;
    } catch { return {}; }
  })();
}
async function persist(cache: Cache) {
  const temp = `${cacheFile()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify({ version: 5, models: cache }));
    await fs.rename(temp, cacheFile());
  } catch (error) { console.warn('[model-types] Cache persistence failed', String(error)); }
}
export async function getCachedCaps(): Promise<CapsView> {
  const result: CapsView = {};
  for (const [key, entry] of Object.entries(await load())) {
    result[key] = {};
    for (const feature of FEATURES) if (entry[feature] !== undefined) result[key][feature] = entry[feature];
  }
  return result;
}

interface Connection { relayTransport?:RelayTransport; apiKey: string; baseUrl: string; protocol: string; model: string }
function connection(settings: AppSettings, provider: ModelProvider, model: string): Connection {
  if (provider.kind === 'relay') return resolveRelayModel(settings, provider, model);
  return { apiKey: decryptSecret(pickApiKey(provider.apiKey)), baseUrl: provider.baseUrl, protocol: provider.protocol, model };
}

/** A gateway error is not evidence about the model. Only explicit model-capability refusals are negative. */
export function classifyProbe(status: number, data: any, feature: Feature): boolean | undefined {
  if (status < 200 || status >= 300) {
    if (![400, 422].includes(status)) return undefined;
    const message = String(data?.error?.message ?? data?.message ?? '');
    const names: Record<Feature, RegExp> = {
      chat: /chat|messages/, vision: /vision|image/, tool: /tool|function.call/, reasoning: /reasoning|thinking/, webSearch: /web.search/, embedding: /embedding/, reranker: /rerank/,
      'thinking:low': /reasoning|thinking/, 'thinking:medium': /reasoning|thinking/, 'thinking:xhigh': /reasoning|thinking/,
    };
    if (/model/i.test(message) && /(?:does not|doesn't|cannot) support|not supported by (?:this |the )?model/i.test(message) && names[feature].test(message.toLowerCase()) && !/provider|gateway|account|quota|parameter|tool_choice|format/i.test(message)) return false;
    return undefined;
  }
  if (feature.startsWith('thinking:')) return true; // A successful request proves this parameter level was accepted.
  if (feature === 'embedding') return Array.isArray(data?.data?.[0]?.embedding) && data.data[0].embedding.length > 0 ? true : undefined;
  if (feature === 'reranker') return Array.isArray(data?.results) && data.results.some((x: any) => typeof x.index === 'number' && typeof x.relevance_score === 'number') ? true : undefined;
  const message = data?.choices?.[0]?.message;
  const content = Array.isArray(data?.content) ? data.content : [];
  if (feature === 'tool') return message?.tool_calls?.some((x: any) => x.function?.name === 'capability_probe') || content.some((x: any) => x.type === 'tool_use' && x.name === 'capability_probe') ? true : undefined;
  if (feature === 'reasoning') return message?.reasoning_content || message?.reasoning || content.some((x: any) => x.type === 'thinking' && x.thinking) ? true : undefined;
  if (feature === 'webSearch') return content.some((x: any) => x.type === 'web_search_tool_result') || message?.annotations?.some((x: any) => x.type === 'url_citation') ? true : undefined;
  if (feature === 'vision') {
    const text = typeof message?.content === 'string' ? message.content : content.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('');
    try { const answer = JSON.parse(text.match(/\{[^{}]*\}/)?.[0] ?? ''); return String(answer.top).toLowerCase() === 'red' && String(answer.bottom).toLowerCase() === 'blue' ? true : undefined; } catch { return undefined; }
  }
  return typeof message?.content === 'string'  && message.content.length > 0 || content.some((x: any) => x.type === 'text' && x.text) ? true : undefined;
}

type ProbeOutcome = { result?: boolean; log: Omit<ProbeLog,'providerId'|'providerName'> };
async function probe(conn: Connection, feature: Feature): Promise<ProbeOutcome> {
  const checkedAt = Date.now();
  const baseLog = {checkedAt, protocol:conn.protocol, durationMs:0};
  const anthropic = conn.protocol === 'anthropic';
  if (anthropic && (feature === 'embedding' || feature === 'reranker')) return {log:{...baseLog,reason:'protocol-unavailable'}};
  let endpoint = anthropic ? '/v1/messages' : '/chat/completions';
  const thinkingLevel = feature.startsWith('thinking:') ? feature.slice(9) as ThinkingEffortProbe : undefined;
  const text = feature === 'tool' ? 'Call capability_probe with value 1.' : feature === 'reasoning' || thinkingLevel ? 'What is 17 times 19? Think briefly.' : feature === 'webSearch' ? 'Search the web for the official example.com page.' : 'Reply OK.';
  let content: any = text;
  if (feature === 'vision') content = anthropic
    ? [{ type: 'text', text: 'Identify the colors in the top and bottom halves of this image. Return only JSON with keys top and bottom, using English color names.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]
    : [{ type: 'text', text: 'Identify the colors in the top and bottom halves of this image. Return only JSON with keys top and bottom, using English color names.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }];
  let body: any = { model: conn.model, max_tokens: feature === 'vision' ? 1024 : 128, messages: [{ role: 'user', content }] };
  if (feature === 'tool') {
    const schema = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] };
    body.tools = anthropic ? [{ name: 'capability_probe', description: 'Return a value.', input_schema: schema }] : [{ type: 'function', function: { name: 'capability_probe', description: 'Return a value.', parameters: schema } }];
    body.tool_choice = anthropic ? { type: 'tool', name: 'capability_probe' } : { type: 'function', function: { name: 'capability_probe' } };
  }
  if (feature === 'reasoning') {
    if (anthropic) { body.thinking = { type: 'enabled', budget_tokens: 1024 }; body.max_tokens = 1152; }
    else { body.reasoning_effort = 'low'; body.max_tokens = 256; }
  }
  if (thinkingLevel) {
    const budget = thinkingLevel === 'low' ? 1024 : thinkingLevel === 'medium' ? 4096 : 8192;
    if (anthropic) { body.thinking = { type: 'enabled', budget_tokens: budget }; body.max_tokens = budget + 128; }
    else if (conn.model.toLowerCase().includes('qwen')) { body.enable_thinking = true; body.thinking_budget = budget; body.max_tokens = Math.max(256, budget + 128); }
    else { body.reasoning_effort = thinkingLevel === 'xhigh' ? 'high' : thinkingLevel; body.max_tokens = 256; }
  }
  if (feature === 'webSearch') body.tools = [anthropic ? { type: 'web_search_20250305', name: 'web_search', max_uses: 1 } : { type: 'web_search' }];
  if (feature === 'embedding') { endpoint = '/embeddings'; body = { model: conn.model, input: 'capability probe' }; }
  if (feature === 'reranker') { endpoint = '/rerank'; body = { model: conn.model, query: 'apple', documents: ['apple', 'stone'], top_n: 1 }; }
  const url = `${conn.baseUrl.replace(/\/+$/, '')}${endpoint}`;
  const diagnosticBody = JSON.parse(JSON.stringify(body).split(PNG).join('[test image: 64×64 PNG]'));
  const log = {...baseLog,endpoint:probeEndpoint(url),request:sanitizeProbeText(diagnosticBody,conn.apiKey)};
  try {
    const response = await relayFetch(conn.relayTransport)(`${conn.baseUrl.replace(/\/+$/, '')}${endpoint}`, {
      method: 'POST', headers: {
        ...await getApiHeaders(anthropic ? 'anthropic' : 'openai'),
        'content-type': 'application/json',
        ...(anthropic
          ? { 'x-api-key': conn.apiKey, 'anthropic-version': '2023-06-01' }
          : conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
      },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    let data, raw = '';
    try { if (typeof response.text === 'function') { raw = await response.text(); data = JSON.parse(raw); } else data = await response.json(); } catch(error) { return {log:{...log,httpStatus:response.status,durationMs:Date.now()-checkedAt,reason:'invalid-response',response:sanitizeProbeText(raw || String(error),conn.apiKey)}}; }
    const result = classifyProbe(response.status,data,feature);
    return {result,log:{...log,httpStatus:response.status,durationMs:Date.now()-checkedAt,result,reason:result === true ? 'confirmed' : result === false ? 'unsupported' : response.status < 200 || response.status >= 300 ? 'http-error' : 'no-evidence',response:sanitizeProbeText(data,conn.apiKey)}};
  } catch(error) { return {log:{...log,durationMs:Date.now()-checkedAt,reason:'network-error',response:sanitizeProbeText(String(error),conn.apiKey)}}; }
}

function applyShared(cache: Cache, value: SharedModelType) {
  const entry = cache[`model:${value.model}`] ??= { attempts: 0, nextAt: 0 };
  if (entry[value.type] !== value.supported || !entry.records?.[value.type]) {
    (entry.records ??= {})[value.type] = { providerId: 'relay-cache', providerName: '中继共享缓存', checkedAt: value.checkedAt, source: 'relay' };
  }
  entry[value.type] = value.supported;
}
async function syncShared(cache: Cache, settings: AppSettings) {
  const relay = relayModelTypes(settings);
  if (!relay) return;
  const models = [...new Set((settings.modelProviders ?? []).flatMap(p => p.models.map(m => modelCapabilityKey(p, m).slice(6))))];
  try {
    for (let i = 0; i < models.length; i += 500) {
      const group = models.slice(i, i + 500);
      const shared = await relay.lookup(group);
      const present = new Set(shared.map((r: SharedModelType) => `${r.model}\0${r.type}`));
      const upload: SharedModelType[] = [];
      for (const model of group) for (const type of FEATURES) {
        const entry = cache[`model:${model}`];
        if (typeof entry?.[type] === 'boolean' && entry.records?.[type]?.source !== 'relay' && !present.has(`${model}\0${type}`)) upload.push({ model, type, supported: entry[type]!, checkedAt: 0 });
      }
      for (const row of shared) applyShared(cache, row);
      for (let j = 0; j < upload.length; j += 500) await relay.publish(upload.slice(j, j + 500));
    }
    await persist(cache);
  } catch { /* Offline/older relays do not prevent use of the local cache. */ }
}
async function sharedProbe(settings: AppSettings, key: string, feature: Feature, conn: Connection, force = false): Promise<{ result?: boolean; shared?: SharedModelType; skipped?: boolean; log?: ProbeOutcome['log'] }> {
  const relay = relayModelTypes(settings);
  if (!relay) return probe(conn, feature);
  const relayLog = {checkedAt:Date.now(),protocol:conn.protocol,durationMs:0};
  let claim;
  try { claim = await relay.claim(key.slice(6), feature, force); }
  catch { return { skipped:true,log:{...relayLog,reason:'relay-unavailable'} }; }
  if (claim.record) return { result: claim.record.supported, shared: claim.record,log:{...relayLog,result:claim.record.supported,reason:'relay-cache'} };
  if (claim.busy) return { skipped:true,log:{...relayLog,reason:'relay-busy'} };
  const outcome = await probe(conn, feature);
  if (claim.lease) {
    try { await relay.finish(key.slice(6), feature, claim.lease, outcome.result); }
    catch { /* A locally confirmed result is retained and uploaded at the next sync. */ }
  }
  return outcome;
}

function appendLog(entry:Entry,feature:Feature,log:ProbeOutcome['log']|undefined,providerId:string,providerName:string) {
  if(!log)return;
  const logs=(entry.logs ??= {})[feature] ??= [];
  logs.push({...log,providerId,providerName});
  if(logs.length>5)logs.splice(0,logs.length-5);
}

/** Serial bounded batches, shared by the timer and every window. UI never waits for probes. */
export function probeModels(_items?: Array<{ providerId: string; modelId: string }>): Promise<CapsView> {
  if (active) return active;
  if (manualActive) return manualActive.then(() => getCachedCaps());
  active = (async () => {
    const cache = await load();
    const settings = await readSettings();
    if(settings.modelAutoVerifyEnabled===false)return getCachedCaps();
    await syncShared(cache, settings);
    const groups = new Map<string, Array<Connection & { providerId: string; providerName: string }>>();
    for (const provider of settings.modelProviders ?? []) {
      if (!provider.enabled || provider.kind === 'composite') continue;
      for (const model of provider.models) {
        const key = modelCapabilityKey(provider, model);
        const entry = cache[key];
        if (entry && (entry.nextAt > Date.now() || FEATURES.every(f => entry[f] !== undefined))) continue;
        try {
          const conn = connection(settings, provider, model);
          if (!conn.baseUrl || !['openai', 'anthropic'].includes(conn.protocol)) continue;
          const candidates = groups.get(key) ?? [];
          candidates.push({ ...conn, providerId: provider.id, providerName: provider.name || provider.id }); groups.set(key, candidates);
        } catch { /* A disconnected relay cannot be a probe candidate. */ }
      }
    }
    // Oldest pending model first so large lists cannot starve later entries.
    const pending = [...groups].sort(([a], [b]) => (cache[a]?.nextAt ?? 0) - (cache[b]?.nextAt ?? 0)).slice(0, 3);
    for (const [key, candidates] of pending) {
      if (stopped) break;
      const conn = candidates[Math.floor(Math.random() * candidates.length)];
      const entry: Entry = cache[key] ?? { attempts: 0, nextAt: 0 };
      for (const feature of FEATURES) {
        if ((await readSettings()).modelAutoVerifyEnabled===false) { cache[key]=entry;await persist(cache);return getCachedCaps(); }
        if (stopped || entry[feature] !== undefined) continue;
        // Unsupported chat does not imply unsupported embedding/reranking, or vice versa.
        if (feature !== 'chat' && entry.chat !== true && !['embedding', 'reranker'].includes(feature)) continue;
        const outcome = await sharedProbe(settings, key, feature, conn);
        appendLog(entry,feature,outcome.log,conn.providerId,conn.providerName);
        if (outcome.skipped) continue;
        if (outcome.shared) { cache[key] = entry; applyShared(cache, outcome.shared); }
        else {
          if (outcome.result !== undefined) entry[feature] = outcome.result;
          (entry.records ??= {})[feature] = { providerId: conn.providerId, providerName: conn.providerName, checkedAt: Date.now(), source: 'local' };
        }
      }
      entry.attempts++;
      entry.nextAt = Date.now() + Math.min(24 * 3600_000, 600_000 * 2 ** Math.min(entry.attempts - 1, 8));
      cache[key] = entry;
      await persist(cache);
    }
    return getCachedCaps();
  })().finally(() => { active = undefined; });
  return active;
}

/** Rows are shared by model identity, with evidence provenance preserved per feature. */
export async function getProbeReport(): Promise<ProbeReport> {
  const cache = await load();
  const settings = await readSettings();
  const models = new Map<string, { model: string; available: boolean }>();
  for (const provider of settings.modelProviders ?? []) {
    for (const model of provider.models) {
      const key = modelCapabilityKey(provider, model);
      let available = false;
      if (provider.enabled && provider.kind !== 'composite') {
        try { const conn = connection(settings, provider, model); available = !!conn.baseUrl && ['openai', 'anthropic'].includes(conn.protocol); } catch { /* no available relay */ }
      }
      models.set(key, { model: key.slice(6), available: available || !!models.get(key)?.available });
    }
  }
  return { rows: [...models].sort(([a],[b]) => a.localeCompare(b)).flatMap(([key, info]) => FEATURES.map(feature => ({ key, model: info.model, available: info.available, feature, supported: cache[key]?.[feature], record: cache[key]?.records?.[feature], logs: cache[key]?.logs?.[feature], running: manualRunning.has(`${key}\0${feature}`) }))), running: !!manualActive, completed: manualCompleted, total: manualTotal, error: manualError };
}

/** Manual jobs bypass backoff, run once per requested feature, and never block the renderer. */
export function retryProbeReport(request: ProbeRetry = {}): Promise<ProbeReport> {
  if (manualActive) return getProbeReport();
  if ((request.key !== undefined && typeof request.key !== 'string') || (request.feature !== undefined && !FEATURES.includes(request.feature))) return Promise.reject(Error('无效的模型类型'));
  manualCompleted = 0; manualTotal = 0; manualError = undefined;
  manualRunning.clear();
  manualActive = (async () => {
    // Wait for a scheduled batch before touching its cache or persistence file.
    if (active) await active;
    const cache = await load();
    const settings = await readSettings();
    await syncShared(cache, settings);
    const report = await getProbeReport();
    const rows = report.rows.filter(row => row.available && (!request.excludeChat || row.feature !== 'chat') && (request.key ? row.key === request.key && (!request.feature || row.feature === request.feature) : row.supported === undefined));
    manualTotal = rows.length;
    for (const row of rows) {
      if (stopped) break;
      const runningKey = `${row.key}\0${row.feature}`;
      manualRunning.add(runningKey);
      const candidates: Array<{ conn: Connection; provider: ModelProvider }> = [];
      for (const provider of settings.modelProviders ?? []) {
        if (!provider.enabled || provider.kind === 'composite') continue;
        for (const model of provider.models) {
          if (modelCapabilityKey(provider, model) !== row.key) continue;
          try { const conn = connection(settings, provider, model); if (conn.baseUrl && ['openai', 'anthropic'].includes(conn.protocol)) candidates.push({ conn, provider }); } catch { /* relay unavailable */ }
        }
      }
      const entry = cache[row.key] ??= { attempts: 0, nextAt: 0 };
      // Try alternative providers if a gateway cannot establish evidence.
      for (const { conn, provider } of candidates) {
        if (stopped) break;
        const outcome = await sharedProbe(settings, row.key, row.feature, conn, !!request.key);
        appendLog(entry,row.feature,outcome.log,provider.id,provider.name || provider.id);
        if (outcome.skipped) break;
        if (outcome.shared) { applyShared(cache, outcome.shared); break; }
        (entry.records ??= {})[row.feature] = { providerId: provider.id, providerName: provider.name || provider.id, checkedAt: Date.now(), source: 'local' };
        delete entry[row.feature];
        if (outcome.result !== undefined) { entry[row.feature] = outcome.result; break; }
      }
      entry.nextAt = Date.now() + 600_000;
      manualCompleted++;
      manualRunning.delete(runningKey);
      await persist(cache);
    }
  })().catch(error => { manualError = String(error); }).finally(() => { manualRunning.clear(); manualActive = undefined; });
  return getProbeReport();
}

let registered = false;
/**
 * Automatic probes are intentionally lower priority than user work: require no
 * Sage task, no focused main window, and at least one minute of OS idle time.
 * Manual retries bypass this gate.
 */
function automaticProbeAllowed(): boolean {
  try {
    return backgroundTaskIdle()
      && BrowserWindow.getAllWindows().every(win => !win.isFocused())
      && powerMonitor.getSystemIdleTime() >= 60;
  } catch { return false; }
}

export function registerModelProbeHandlers(isTaskIdle: () => boolean = () => true): void {
  if (registered) return;
  registered = true;
  backgroundTaskIdle = isTaskIdle;
  const kick = async () => {
    if (!automaticProbeAllowed()) return;
    try { if((await readSettings()).modelAutoVerifyEnabled===false)return; } catch { return; }
    audit({ ts:new Date().toISOString(), source:'tool', tool:'ModelCapabilityProbe', action:'review', stage:'execution', category:'模型能力验证', detail:{reason:'空闲且无任务时自动开始模型能力验证'} });
    void probeModels().then(() => audit({ ts:new Date().toISOString(), source:'tool', tool:'ModelCapabilityProbe', action:'allow', stage:'execution', category:'模型能力验证', detail:{reason:'空闲自动模型能力验证完成'} })).catch(error => {
      console.warn('[model-types]', String(error));
      audit({ ts:new Date().toISOString(), source:'tool', tool:'ModelCapabilityProbe', action:'deny', stage:'execution', category:'模型能力验证', detail:{reason:`空闲自动模型能力验证失败：${String(error)}`} });
    });
  };
  ipcMain.handle('model-caps-report', () => getProbeReport());
  ipcMain.handle('model-caps-retry', (_e, request: ProbeRetry) => retryProbeReport(request));
  ipcMain.handle('model-caps-get', () => getCachedCaps());
  ipcMain.handle('model-caps-probe', () => { kick(); return getCachedCaps(); });
  const unsubscribe = onRelayConnected(kick);
  const startup = setTimeout(kick, 100); startup.unref();
  const timer = setInterval(kick, 60_000); timer.unref();
  app.once('before-quit', () => { stopped = true; unsubscribe(); clearTimeout(startup); clearInterval(timer); });
}
