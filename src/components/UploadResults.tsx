import { Globe } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import type { ToolCall } from '../../shared/types';
import { MarkdownImage } from './MarkdownImage';
import { CopyImageAddress, isTemporaryImageUrl } from './CopyImageAddress';

interface UploadRow { name: string; url: string; expiresAt: string }
export function uploadResults(calls: ToolCall[] = []): UploadRow[] {
  const rows = new Map<string, UploadRow>();
  for (const call of calls) {
    const input = call.input;
    if (call.isError || input?.plugin !== 'sage.temp-image-upload' || input?.service !== 'images' || input?.method !== 'upload' || !call.result) continue;
    try {
      const result = JSON.parse(call.result);
      if (typeof result.name === 'string' && isTemporaryImageUrl(result.url) && typeof result.expiresAt === 'string' && Number.isFinite(Date.parse(result.expiresAt))) rows.set(result.url, result);
    } catch { /* Incomplete or failed tool responses never become success rows. */ }
  }
  return [...rows.values()];
}
/** Hide duplicate upload presentation, keeping unrelated prose and error messages. */
export function withoutUploadSummary(text: string, rows: UploadRow[]) {
  return text.split(/\n\s*\n/).filter(block => {
    if (rows.some(row => block.includes(row.url))) return false;
    if (/持有链接的人都可以查看|链接持有者.{0,8}查看|请妥善使用/.test(block)) return false;
    if (/到期|过期/.test(block) && rows.some(row => block.includes(row.name)) && !/失败|错误/.test(block)) return false;
    return true;
  }).join('\n\n');
}
export function UploadResults({ calls }: { calls?: ToolCall[] }) {
  const rows = uploadResults(calls);
  if (!rows.length) return null;
  return <div className="upload-results"><table aria-label="图片上传结果">
    <thead><tr><th>缩略图</th><th>名称</th><th>地址</th><th>到期时间（本地时间）</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.url}>
      <td><MarkdownImage src={row.url} alt={row.name}/></td><td className="upload-result-name">{row.name}</td>
      <td><div className="upload-result-actions"><CopyImageAddress url={row.url}/><button type="button" className="copy-image-address" title="在内置浏览器打开" aria-label="在内置浏览器打开" onClick={() => useAppStore.getState().openBrowserTab(row.url)}><Globe size={16}/></button></div></td>
      <td><time dateTime={row.expiresAt}>{new Date(row.expiresAt).toLocaleString(undefined, {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</time></td>
    </tr>)}</tbody>
  </table></div>;
}
