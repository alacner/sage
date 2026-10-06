/** GitHub-style heading fragments, preserving Chinese and other Unicode letters. */
export function headingSlug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\-\s]/gu, '').replace(/\s/g, '-');
}

export function scrollMarkdownAnchor(link: Element, href: string): boolean {
  if (!href.startsWith('#')) return false;
  const root = link.closest('[data-markdown-document]');
  if (!root) return false;
  let fragment: string;
  try { fragment = decodeURIComponent(href.slice(1)); } catch { return false; }
  const used = new Set<string>();
  let target: Element | undefined;
  for (const heading of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const base = headingSlug(heading.textContent ?? '');
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    if (!target && (heading.id === fragment || slug === fragment)) target = heading;
  }
  target ??= Array.from(root.querySelectorAll('[id],a[name]')).find(el => el.id === fragment || el.getAttribute('name') === fragment);
  if (!fragment) target = root;
  if (!target) return false;
  target.scrollIntoView({ block: 'start', behavior: 'auto' });
  return true;
}
