/**
 * Channel Registry — 插件注册表
 *
 * 统一注册、查询、调用 channel 插件。
 * 新增渠道时：实现 ChannelPlugin 接口，在 registry 中 import 并注册即可。
 */

import type { ChannelPlugin, ChannelMessage, ChannelSendResult } from './types';
import { recordChannelDiag, registerChannelProjects } from './diagnostics';
import { emailChannel } from './email';
import { wechatChannel } from './wechat';
import { dingtalkChannel } from './dingtalk';
import { feishuWebhookChannel } from './feishu-webhook';
import { feishuAppChannel } from './feishu-app';
import { telegramChannel } from './telegram';

const plugins = new Map<string, ChannelPlugin>();

/** 注册一个 channel 插件。 */
export function registerChannel(plugin: ChannelPlugin): void {
  plugins.set(plugin.type, plugin);
}

/** 获取指定类型的插件。 */
export function getChannel(type: string): ChannelPlugin | undefined {
  return plugins.get(type);
}

/** 获取所有已注册的插件。 */
export function listChannels(): ChannelPlugin[] {
  return Array.from(plugins.values());
}

/** 判断插件是否已注册。 */
export function hasChannel(type: string): boolean {
  return plugins.has(type);
}

/** 未自己埋点的插件由注册表兑一条出站结论（否则面板对它们永远是“没数据”）。 */
function recordGenericOutbound(type: string, config: Record<string, string>, result: ChannelSendResult, projectPath?: string): void {
  const network = /timeout|timed out|ENOTFOUND|ECONN|EHOSTUNREACH|ETIMEDOUT|网络|超时/i.test(result.error ?? '');
  recordChannelDiag({
    stage: 'outbound', ok: result.ok,
    reason: result.ok ? 'ok' : network ? 'network' : 'api-error',
    channelType: type, config, projectPath, detail: result.error ? { error: result.error } : undefined,
  });
}

/**
 * 通过插件发送消息。
 * @param type 渠道类型
 * @param config 渠道配置
 * @param message 消息内容
 * @param projectPath 渠道所属项目（诊断日志按项目隔离；定时任务/广播都拿得到）
 */
export async function sendViaChannel(
  type: string,
  config: Record<string, string>,
  message: ChannelMessage,
  projectPath?: string,
): Promise<ChannelSendResult> {
  const plugin = getChannel(type);
  if (!plugin) {
    recordChannelDiag({ stage: 'config', ok: false, reason: 'invalid-config', channelType: type, config, projectPath, detail: { error: `未知的渠道类型: ${type}` } });
    return { ok: false, error: `未知的渠道类型: ${type}` };
  }
  const err = plugin.validate(config);
  if (err) {
    recordChannelDiag({ stage: 'config', ok: false, reason: 'invalid-config', channelType: type, config, projectPath, detail: { error: err } });
    return { ok: false, error: err };
  }
  // 自埋点插件（如飞书应用）的 send 签名里只有 config，拿不到项目；先登记归属，
  // 它自己记的那几条才能落进对应项目的日志文件。
  if (projectPath) registerChannelProjects([{ type, config, projectPath }]);
  const result = await plugin.send(config, message);
  if (!plugin.reportsOwnDiagnostics) recordGenericOutbound(type, config, result, projectPath);
  return result;
}

/**
 * 测试渠道连通性。
 *
 * 注意：这里**不**拦住校验失败的配置（保持原有行为），但会把校验结果记进诊断——
 * 于是“配置少填一项”与“平台拒收”在面板上是两个不同环节，不会揉成一句“测试失败”。
 */
export async function testChannel(
  type: string,
  config: Record<string, string>,
  projectPath?: string,
): Promise<ChannelSendResult> {
  const plugin = getChannel(type);
  if (!plugin) {
    recordChannelDiag({ stage: 'config', ok: false, reason: 'invalid-config', channelType: type, config, projectPath, detail: { error: `未知的渠道类型: ${type}` } });
    return { ok: false, error: `未知的渠道类型: ${type}` };
  }
  const err = plugin.validate(config);
  if (err) recordChannelDiag({ stage: 'config', ok: false, reason: 'invalid-config', channelType: type, config, projectPath, detail: { error: err } });
  if (projectPath) registerChannelProjects([{ type, config, projectPath }]);
  const result = await plugin.test(config);
  if (!plugin.reportsOwnDiagnostics) recordGenericOutbound(type, config, result, projectPath);
  return result;
}

// ─── 注册内置插件 ────────────────────────────────────────────────────────────
// 每个内置渠道在此注册，未来扩展第三方渠道只需追加一行。

registerChannel(emailChannel);
registerChannel(wechatChannel);
registerChannel(dingtalkChannel);
registerChannel(feishuWebhookChannel);
registerChannel(feishuAppChannel);
registerChannel(telegramChannel);
