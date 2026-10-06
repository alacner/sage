/** Keep synthetic probe diagnostics useful without persisting credentials or image payloads. */
export function sanitizeProbeText(value: unknown, secret = '', limit = 4000): string {
  let text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  if (secret) text = text.split(secret).join('[REDACTED]');
  text = text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi,'[test image: 64×64 PNG]')
    .replace(/((?:authorization|x-api-key|api[_-]?key|access[_-]?token)\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/gi,'$1[REDACTED]')
    .replace(/Bearer\s+[^\s,"'}]+/gi,'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g,'[REDACTED]');
  return text.length > limit ? text.slice(0,limit)+'… [truncated]' : text;
}
export function probeEndpoint(url: string): string {
  try { const u=new URL(url);u.username='';u.password='';u.search='';u.hash='';return u.href; } catch { return '[invalid endpoint]'; }
}
