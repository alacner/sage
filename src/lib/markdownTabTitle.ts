import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { isMarkdownFile } from './lang';

type FileContent = { relPath: string; content: string; binary?: boolean };
const titles = new WeakMap<FileContent, { content: string; path: string; title: string }>();

export function markdownTabTitle(file: FileContent): string {
  const fallback = file.relPath.split('/').pop() || file.relPath;
  if (file.binary || !isMarkdownFile(file.relPath)) return fallback;
  const cached = titles.get(file);
  if (cached?.content === file.content && cached.path === file.relPath) return cached.title;
  let title = fallback;
  // Bound parsing work for large files. A document title normally lives near the beginning.
  const source = file.content.slice(0, 65536).replace(/^\uFEFF/, '')
    .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
  for (const node of fromMarkdown(source).children) {
    if (node.type !== 'heading' || node.depth !== 1) continue;
    const text = toString(node, { includeHtml: false }).replace(/\s+/g, ' ').trim();
    if (text) { title = text; break; }
  }
  titles.set(file, { content: file.content, path: file.relPath, title });
  return title;
}
