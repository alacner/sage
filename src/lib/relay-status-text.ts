/**
 * 中继连接状态文案本地化。
 *
 * 主进程（relay-client）只发两类 error：
 * 1) 机器码 `relay:<code>[:<arg>]` —— 由这里翻译成随语言的人话；
 * 2) 原始诊断信息（网络异常 message 等）—— 保持原样展示，便于排查。
 */
import { translate } from '../i18n';

const RELAY_CODE_RE = /^relay:([a-z_]+)(?::([^]*))?$/;

export function relayErrorLabel(error: string | undefined): string | undefined {
  if (!error) return error;
  const m = RELAY_CODE_RE.exec(error);
  if (!m) return error;
  const [, code, arg] = m;
  if (code === 'replaced') return translate('settings.relay.replaced');
  if (code === 'retrying') return translate('settings.relay.retrying');
  if (code === 'reconnect_limit') {
    return translate('settings.relay.reconnectLimit', { count: arg ?? '?' });
  }
  // 未知机器码：去掉前缀兜底展示，不让内部码直接漏给用户
  return code;
}
