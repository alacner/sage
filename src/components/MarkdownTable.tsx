import {useEffect, useRef, useState, type ComponentPropsWithoutRef} from 'react';
import type {Element, RootContent} from 'hast';
import {Check, Copy, Image as ImageIcon} from 'lucide-react';
import {copyMarkdown} from '../lib/clipboard';
import {copyElementToClipboard} from '../lib/exportImage';

function inline(node: RootContent): string {
  if (node.type === 'text') return node.value.replace(/\n/g, ' ').replace(/([\\|])/g, '\\$1');
  if (node.type !== 'element') return '';
  const text = node.children.map(inline).join('');
  switch (node.tagName) {
    case 'strong': return `**${text}**`;
    case 'em': return `*${text}*`;
    case 'del': return `~~${text}~~`;
    case 'br': return '<br>';
    case 'code': {
      const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map(s => s.length)) + 1);
      return `${fence} ${text} ${fence}`;
    }
    case 'a': return `[${text}](<${String(node.properties.href ?? '').replace(/\|/g, '%7C').replace(/>/g, '%3E')}>)`;
    default: return text;
  }
}

export function tableMarkdown(node?: Element): string {
  if (!node) return '';
  const rows: Element[] = [];
  const walk = (el: Element) => {
    if (el.tagName === 'tr') rows.push(el);
    else el.children.forEach(child => { if (child.type === 'element') walk(child); });
  };
  walk(node);
  const cells = rows.map(row => row.children.filter((c): c is Element => c.type === 'element' && ['th','td'].includes(c.tagName)));
  if (!cells.length) return '';
  const lines = cells.map(row => `| ${row.map(cell => cell.children.map(inline).join('').trim()).join(' | ')} |`);
  const separator = cells[0].map(cell => {
    const style = String(cell.properties.style ?? '');
    return /center/.test(style) ? ':---:' : /right/.test(style) ? '---:' : /left/.test(style) ? ':---' : '---';
  });
  lines.splice(1, 0, `| ${separator.join(' | ')} |`);
  return lines.join('\n');
}

export function MarkdownTable({node, children, ...props}: ComponentPropsWithoutRef<'table'> & {node?: Element}) {
  const ref = useRef<HTMLTableElement>(null);
  const [status,setStatus] = useState('');
  const [busy,setBusy] = useState(false);
  useEffect(() => {
    if (!status) return;
    const timer=setTimeout(()=>setStatus(''),2000);
    return ()=>clearTimeout(timer);
  },[status]);
  const copy = async (kind: 'image' | 'markdown') => {
    setBusy(true);
    const ok = kind === 'image' ? !!ref.current && await copyElementToClipboard(ref.current) : await copyMarkdown(tableMarkdown(node));
    setStatus(ok ? '已复制' : '复制失败，请重试');
    setBusy(false);
  };
  return <div className="markdown-table-wrap">
    <div className="markdown-table-actions" data-no-copy>
      <span role="status">{status}</span>
      <button type="button" title="复制表格图片" aria-label="复制表格图片" disabled={busy} onClick={()=>void copy('image')}><ImageIcon size={14}/></button>
      <button type="button" title="复制 Markdown 表格" aria-label="复制 Markdown 表格" disabled={busy} onClick={()=>void copy('markdown')}>{status==='已复制' ? <Check size={14}/> : <Copy size={14}/>}</button>
    </div>
    <table ref={ref} {...props}>{children}</table>
  </div>;
}
