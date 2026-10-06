/**
 * 中继站点 Token 申请页（<站点地址>/apply）自检。
 *
 * 设置页只有在申请页真的可访问（HTTP 200）时才显示「申请」入口：
 * 自建/旧版中继可能压根没有这个页面，给一个点了必挂的按钮不如不给。
 * 探测走主进程（渲染层 fetch 受 CORS 限制，读不到状态码），与反馈/更新自检同口径。
 */
import { relayFetch } from './relay-tls';
import { readSettings } from './main';
import { probeHttp, isHttpUrl, type ProbeResult } from './net-probe';
import { relayApplyUrl } from '../shared/relay-url';

/** 生效的申请页地址：回调服务地址优先，其次连接地址（推导口径见 shared/relay-url）。 */
export async function effectiveApplyUrl(): Promise<string> {
  const settings = await readSettings();
  return relayApplyUrl(settings.relayHookBaseUrl, settings.relayUrl);
}

/**
 * 探测申请页。urlOverride 为设置页当前输入的地址（优先于已保存配置，供边改边探测）；
 * 地址不完整（半截输入、没有协议前缀）按未配置处理：不发请求，界面也就不显示入口。
 */
export async function probeRelayApply(urlOverride?: string): Promise<ProbeResult> {
  const custom = urlOverride?.trim();
  const url = custom ? relayApplyUrl(custom) : await effectiveApplyUrl();
  if (!isHttpUrl(url)) return { ok: false, url: '', error: 'not-configured' };
  const settings=await readSettings();
  const certificate=settings.relayCertificate;
  return probeHttp(url,8000,undefined,relayFetch({origin:new URL(url).origin,certificate:certificate?.origin===new URL(url).origin?certificate:undefined}));
}
