import { relayFetch } from './relay-tls';
import type { RelayCertificatePolicy } from '../shared/relay-certificate';
import { getConnectedRelay } from './channels/relay-client';
import { isPrivateHost } from './sandbox/net-policy';

/** Credentials are restricted to the currently connected relay, never renderer URLs. */
export function relayService(settings: {relayUrl?: string; relayToken?: string;relayCertificate?:RelayCertificatePolicy}) {
  const connected = getConnectedRelay();
  if (!settings.relayToken?.trim() || !connected || connected.token !== settings.relayToken || connected.url !== settings.relayUrl) {
    throw Error('请先连接中继并配置有效客户端 Token / Connect the relay with a valid Client Token');
  }
  const url = new URL(connected.url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.protocol === 'http:' && !isPrivateHost(url.hostname))) {
    throw Error('Relay services require HTTPS (HTTP is allowed only on private hosts)');
  }
  url.search = ''; url.hash = '';
  return {request:relayFetch({origin:url.origin,certificate:settings.relayCertificate}),base: url.toString().replace(/\/+$/, ''), headers: {authorization: `Bearer ${connected.token}`, 'x-sage-client': 'sage-desktop'}};
}
