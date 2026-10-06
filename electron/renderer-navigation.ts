/** Only the document shipped with Sage may keep the privileged preload. */
export function isRendererNavigation(target: string, entry: string): boolean {
  try {
    const url = new URL(target), expected = new URL(entry);
    return ['http:', 'https:', 'file:'].includes(expected.protocol)
      && url.protocol === expected.protocol && url.host === expected.host
      && !url.username && !url.password && url.pathname === expected.pathname
      && url.search === expected.search;
  } catch { return false; }
}
