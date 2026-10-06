import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
export type NetworkTarget = { host: string; port: number };
export type NetworkEndpoint = { address: string; port: number };
/** IPv4-only initially: unrepresentable targets fail closed rather than broadening Seatbelt. */
export async function resolveNetworkScope(value: unknown): Promise<NetworkEndpoint[]> {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw Error('请通过 networkTargets 指定 1–16 个目标主机和端口；不支持任意联网');
  const endpoints: NetworkEndpoint[] = [];
  await Promise.all(value.map(async (target: NetworkTarget) => {
    if (!target || typeof target.host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(target.host) || target.host.includes('..') || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw Error('联网目标必须是准确的主机名/IPv4 和 1–65535 端口，不支持通配符');
    const addresses = isIP(target.host)===4 ? [{address:target.host}] : await lookup(target.host,{family:4,all:true});
    if (!addresses.length) throw Error('联网目标没有可用的 IPv4 地址');
    for (const {address} of addresses) {
      // Cloud metadata, link-local, multicast and unspecified destinations are never capabilities.
      const [a,b]=address.split('.').map(Number);
      if (isIP(address)!==4 || (a===100 && b>=64 && b<=127) || (a===198 && [18,19].includes(Number(address.split('.')[1]))) || a===0 || a>=224 || (a===169 && b===254) || address==='100.100.100.200') throw Error('联网目标属于禁止访问的元数据或特殊地址');
      endpoints.push({address,port:target.port});
    }
  }));
  const unique=[...new Map(endpoints.map(e=>[`${e.address}:${e.port}`,e])).values()];
  if (unique.length>64) throw Error('联网地址过多，请缩小申请范围');
  return unique.sort((a,b)=>a.address.localeCompare(b.address)||a.port-b.port);
}
export async function boundedNetworkScope(value: unknown, signal?: AbortSignal): Promise<NetworkEndpoint[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (()=>void) | undefined;
  try {
    return await Promise.race([resolveNetworkScope(value),new Promise<never>((_,reject)=>{
      cancel=()=>reject(Error('联网目标解析已取消'));
      signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted)cancel();
      timer=setTimeout(()=>reject(Error('联网目标解析超时，请重试')),5000);
    })]);
  } finally { if(timer)clearTimeout(timer);if(cancel)signal?.removeEventListener('abort',cancel); }
}
