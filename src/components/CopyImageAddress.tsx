import { useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { copyMarkdown } from '../lib/clipboard';

export function isTemporaryImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && /^\/temp-images\/[a-f0-9]{48}$/.test(url.pathname) && !url.search && !url.hash; }
  catch { return false; }
}
export function CopyImageAddress({ url }: { url: string }) {
  const [status, setStatus] = useState('');
  useEffect(() => { if (!status) return; const timer = setTimeout(() => setStatus(''), 2000); return () => clearTimeout(timer); }, [status]);
  return <button type="button" className="copy-image-address" onClick={async () => setStatus(await copyMarkdown(url) ? '已复制' : '复制失败，请重试')}>
    {status === '已复制' ? <Check size={14}/> : <Copy size={14}/>}<span role="status">{status || '复制地址'}</span>
  </button>;
}
