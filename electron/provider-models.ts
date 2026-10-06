/**
 * 提供商模型清单获取（OpenAI / Anthropic 的 models.list）+「测试连接」。
 *
 * 清单接口只证明「这个端点活着且这把 key 能读」，不证明任何模型可用：
 * 大量自建/代理端点根本不提供枚举（404），于是能正常干活的提供商被误判「连接失败」。
 * 所以测试口径分两层（见 testProviderKeys）：
 * 1. 提供商已填模型 → 拿第一个模型发一次最小补全请求（真实调用，与运行时同路径）；
 * 2. 没填模型 → 只能退化成接口连通性测试，且结果必须写清「只测了连通性」。
 *
 * 清单获取同时供主进程定时同步（provider-model-sync）使用。
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getApiHeaders } from './utils/api-user-agent';
import { optionalKeyFetch } from './optional-api-key';
import { splitApiKeys } from '../shared/model-providers';
import type { ApiKeyTestResult, ModelProvider } from '../shared/types';

export type NamedProviderModel = NonNullable<ModelProvider['relayModels']>[number];

export interface ProviderModelListResult {
  /** 模型清单获取成功。 */
  ok: boolean;
  /**
   * 提供商是否支持「获取模型清单」接口。
   * false = 清单请求明确失败（服务可能不支持枚举），UI 应保留手工编辑；
   * undefined = 连接层错误，能力未知（不要据此改写探测结果）。
   */
  listSupported?: boolean;
  models: string[];
  /** 带显示名的模型清单（写回 provider.relayModels 供 modelLabel 使用）。 */
  named: NamedProviderModel[];
  error?: string;
  /** 清单请求失败时的上游 HTTP 状态码（无响应则为 undefined）：用来区分「密钥不对」与「服务不支持枚举」。 */
  status?: number;
}

/**
 * 只能说明「这把密钥不行」的失败：认证/额度/限流。
 * 这类失败不能拿来判定提供商不支持模型枚举接口（否则一把坏 key 就会把整个提供商刷成手工编辑模式）。
 */
const CREDENTIAL_FAILURE_STATUS = new Set([400, 401, 402, 403, 407, 429]);

/** 单把密钥的探测结果能否作为「清单接口能力」结论。 */
function listCapability(res: ProviderModelListResult): boolean | undefined {
  if (res.ok) return res.listSupported;
  if (res.listSupported === false && res.status !== undefined && CREDENTIAL_FAILURE_STATUS.has(res.status)) return undefined;
  return res.listSupported;
}

/** 清单接口不可用时的提示（主进程文案 → 中英双份）。 */
export function describeListFailure(status: number | undefined, lang: 'zh' | 'en'): string {
  return lang === 'en'
    ? `Model list unavailable (${status ?? 'network error'}); the service may not support model enumeration - you can enter model IDs manually`
    : `模型列表获取失败（${status ?? '网络错误'}）；服务可能不支持模型枚举，可手动填写模型 ID`;
}

/** 拉取一个提供商的模型清单。apiKey 必须是已解密的明文（或空串=匿名端点）。 */
export async function fetchProviderModelList(conn: {
  apiKey: string;
  baseUrl?: string;
  protocol: 'anthropic' | 'openai';
  lang?: 'zh' | 'en';
}): Promise<ProviderModelListResult> {
  const { apiKey, baseUrl, protocol, lang = 'zh' } = conn;
  const unsupported = (e: any): ProviderModelListResult => ({
    ok: false,
    listSupported: false,
    models: [],
    named: [],
    status: typeof e?.status === 'number' ? e.status : undefined,
    error: describeListFailure(typeof e?.status === 'number' ? e.status : undefined, lang),
  });
  try {
    if (protocol === 'openai') {
      const client = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: baseUrl || undefined, defaultHeaders: await getApiHeaders('openai'), fetch: optionalKeyFetch(apiKey) });
      const models: string[] = [];
      try {
        const list = await client.models.list();
        for await (const m of list) {
          if (m.id) models.push(m.id);
        }
      } catch (e: any) {
        return unsupported(e);
      }
      return { ok: true, listSupported: true, models, named: models.map(id => ({ id, name: id, protocol: 'openai' as const })) };
    }
    const client = new Anthropic({
      apiKey: apiKey || 'not-needed',
      fetch: optionalKeyFetch(apiKey),
      baseURL: baseUrl || undefined,
      defaultHeaders: await getApiHeaders('anthropic'),
    });
    const models: string[] = [];
    const names = new Map<string, string>();
    try {
      const list = await client.models.list();
      for await (const m of list) {
        if (m.id) {
          models.push(m.id);
          const display = (m as { display_name?: string }).display_name;
          if (display) names.set(m.id, display);
        }
      }
    } catch (e: any) {
      return unsupported(e);
    }
    return { ok: true, listSupported: true, models, named: models.map(id => ({ id, name: names.get(id) ?? id, protocol: 'anthropic' as const })) };
  } catch (err: any) {
    // 连接层异常（client 构造等）：能力未知，不改写 modelsListSupported。
    return { ok: false, listSupported: undefined, models: [], named: [], error: err?.message ?? String(err) };
  }
}

/** 测试连接聚合结果：整体结论 + 每把密钥的独立结果。 */
export interface ProviderKeyTestResult extends ProviderModelListResult {
  /** 逐把密钥的结果，顺序与 splitApiKeys(apiKey) 一致（渲染层按索引对回密钥行）。 */
  keys: ApiKeyTestResult[];
  /** 本次到底测了什么：'model' = 真调了一个模型，'connectivity' = 只测了接口。 */
  tested: 'model' | 'connectivity';
  /** tested='model' 时被调的那个模型 id。 */
  model?: string;
}

/** 一次「最小补全」请求的结果（真实调用，max_tokens=1）。 */
export interface ModelProbeResult {
  ok: boolean;
  /** 上游 HTTP 状态码；网络错/超时没有响应时为 undefined（不可判定，不等于模型不能用）。 */
  status?: number;
  error?: string;
}

/** 只说明「这把 key 不行」的状态码（与清单探测同一口径）。 */
const AUTH_FAILURE_STATUS = new Set([401, 402, 403, 407, 429]);

/** 单次补全探测的等待上限：超时也算「没到达服务」，不能把界面卡死。 */
const PROBE_TIMEOUT = 30_000;

/** 失败文案：必须说清「测的是哪个模型」+「失败说明什么」，且主进程文案要双语。 */
export function describeModelProbeFailure(status: number | undefined, model: string, raw: string, lang: 'zh' | 'en'): string {
  const at = status === undefined ? '' : `（HTTP ${status}）`;
  const enAt = status === undefined ? '' : ` (HTTP ${status})`;
  if (status === undefined) {
    return lang === 'en'
      ? `Request to model "${model}" never reached the service (network/timeout): ${raw}`
      : `模型「${model}」的请求没到达服务（网络/超时）：${raw}`;
  }
  if (AUTH_FAILURE_STATUS.has(status)) {
    return lang === 'en'
      ? `Model "${model}" call failed${enAt}: this API key is unauthorized, out of quota or rate-limited`
      : `模型「${model}」调用失败${at}：这把 API Key 无权限、额度不足或被限流`;
  }
  if (status === 404) {
    return lang === 'en'
      ? `Model "${model}" does not exist or is not available to this account${enAt}: check the model ID`
      : `模型「${model}」不存在或该账号不可用${at}：请核对模型 ID`;
  }
  if (status >= 500) {
    return lang === 'en'
      ? `Model "${model}" upstream service error${enAt}: ${raw}`
      : `模型「${model}」上游服务异常${at}：${raw}`;
  }
  return lang === 'en'
    ? `Model "${model}" rejected the request${enAt}: ${raw}`
    : `模型「${model}」拒绝了本次请求${at}：${raw}`;
}

/**
 * 对单个模型发一次最小补全请求（与 model-probe 同一口径：max_tokens=1）。
 * apiKey 必须是已解密明文；走 SDK 以保证 URL/鉴权头与真实运行时一致。
 * 关掉 SDK 重试：这是用户在设置页手动等待的交互式探测，重试只会把「失败」变成「转半天才失败」。
 */
export async function probeProviderModel(conn: {
  apiKey: string;
  baseUrl?: string;
  protocol: 'anthropic' | 'openai';
  model: string;
  lang?: 'zh' | 'en';
}): Promise<ModelProbeResult> {
  const { apiKey, baseUrl, protocol, model, lang = 'zh' } = conn;
  try {
    if (protocol === 'openai') {
      const client = new OpenAI({ apiKey: apiKey || 'not-needed', baseURL: baseUrl || undefined, defaultHeaders: await getApiHeaders('openai'), fetch: optionalKeyFetch(apiKey), maxRetries: 0, timeout: PROBE_TIMEOUT });
      await client.chat.completions.create({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    } else {
      const client = new Anthropic({
        apiKey: apiKey || 'not-needed',
        fetch: optionalKeyFetch(apiKey),
        baseURL: baseUrl || undefined,
        defaultHeaders: await getApiHeaders('anthropic'),
        maxRetries: 0,
        timeout: PROBE_TIMEOUT,
      });
      await client.messages.create({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    }
    return { ok: true };
  } catch (e: any) {
    const status = typeof e?.status === 'number' ? e.status : undefined;
    return { ok: false, status, error: describeModelProbeFailure(status, model, e?.message ?? String(e), lang) };
  }
}

/**
 * 逐把验证提供商密钥池（「测试连接」的实现）。
 *
 * 为什么必须逐把：apiKey 是逗号分隔的密钥池，运行时 pickApiKey 随机取一把做负载均衡，
 * 所以只要有一把失效，调用就会「偶发 401」——只验第一把（旧行为是把整串
 * "k1,k2" 当成一把 key 发出去，等于多 key 提供商永远测不过）看不出这个风险。
 *
 * 测什么（conn.models）：
 * · 有模型 → 拿第一个模型真调一次补全，通过与否只看这次调用；清单接口仍会试一次，
 *   但只作为「能不能自动同步模型列表」的附加信息（404 不再把能用的提供商判成连接失败）；
 * · 无模型 → 只能拿清单接口当连通性探针（tested='connectivity'），界面要如实说明。
 *
 * 聚合规则：
 * · ok = 至少一把通过（提供商可用）；
 * · 模型清单/named 取「第一把清单成功的」，不并集：并集会把只有部分账号能服务的模型说成全都可用；
 * · listSupported 只由「成功的那把」或「非认证类失败」决定，一把坏 key 不得把提供商刷成手工编辑模式；
 * · 全部失败时：单把保留原始错误文案，多把只报失败、原因逐把列。
 *
 * conn.apiKey 必须是已解密明文（多 key 是整串一起加密的，解密在拆分之前，由调用方保证）。
 */
export async function testProviderKeys(
  conn: {
    apiKey: string;
    baseUrl?: string;
    protocol: 'anthropic' | 'openai';
    /** 提供商已配置的模型；取第一个做真实补全测试，空 = 只测接口连通性。 */
    models?: string[];
    /** 主进程文案语言（失败提示要跟着界面语言走）。 */
    lang?: 'zh' | 'en';
  },
  fetchList: (c: { apiKey: string; baseUrl?: string; protocol: 'anthropic' | 'openai'; lang?: 'zh' | 'en' }) => Promise<ProviderModelListResult> = fetchProviderModelList,
  probeModel: (c: { apiKey: string; baseUrl?: string; protocol: 'anthropic' | 'openai'; model: string; lang?: 'zh' | 'en' }) => Promise<ModelProbeResult> = probeProviderModel,
): Promise<ProviderKeyTestResult> {
  const keys = splitApiKeys(conn.apiKey);
  // 第一个「真填了」的模型：手工编辑列表时开头可能留了空行，不能因此退化成只测连通性。
  const model = conn.models?.find((m) => typeof m === 'string' && m.trim())?.trim();
  const tested: 'model' | 'connectivity' = model ? 'model' : 'connectivity';
  // 空池（只剩空行占位）：不报文案，由渲染层按当前语言提示「API Key 为空」。
  if (keys.length === 0) return { ok: false, models: [], named: [], keys: [], tested, model };
  // 并行：一把死掉的 key 不该把总耗时叠成 N 倍（SDK 自带重试，串行会很难等）。
  const results = await Promise.all(keys.map(async (key) => {
    const list = await fetchList({ ...conn, apiKey: key });
    const probe = model ? await probeModel({ ...conn, apiKey: key, model, lang: conn.lang }) : null;
    return { list, probe };
  }));
  const perKey: ApiKeyTestResult[] = results.map(({ list, probe }) => {
    // 有模型时结论以真调用为准；没模型时退回清单接口（= 连通性）。
    const ok = probe ? probe.ok : list.ok;
    return {
      ok,
      error: ok ? undefined : (probe ? probe.error : list.error),
      models: list.models.length,
      listSupported: listCapability(list),
      tested: probe ? 'model' : 'connectivity',
      model,
    };
  });
  const anyOk = perKey.some((k) => k.ok);
  const primary = results.find((r) => r.list.ok)?.list;
  if (anyOk) {
    const listOk = results.find((r) => r.probe ? r.probe.ok : r.list.ok)?.list;
    return {
      ok: true,
      models: listOk?.models ?? [],
      named: listOk?.named ?? [],
      listSupported: perKey.find((k) => k.listSupported !== undefined)?.listSupported,
      keys: perKey,
      tested,
      model,
    };
  }
  return {
    ok: false,
    error: keys.length === 1 ? perKey[0].error : undefined,
    models: [],
    named: [],
    listSupported: perKey.find((k) => k.listSupported !== undefined)?.listSupported,
    keys: perKey,
    tested,
    model,
  };
}
