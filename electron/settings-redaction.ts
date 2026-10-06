import { protectionFor } from '../shared/settings-protection';
import type { AppSettings } from '../shared/types';
// Keep past protected values too: pending requests and old monitor records may contain them.
const protectedValues = new Set<string>();
export function registerProtectedSettings(s: AppSettings) {
  const policy = s._secretPolicy;
  const key = (v?: string) => { if (v) for (const part of v.split(',')) if (part.trim()) protectedValues.add(part.trim()); };
  const host = (v?: string) => {
    if (!v) return;
    protectedValues.add(v);
    try { protectedValues.add(new URL(v).hostname); } catch { /* legacy non-URL value */ }
  };
  if (policy?.apiKey) { key(s.anthropicApiKey); key((s as any).SAGE_ANTHROPIC_API_KEY); }
  if (policy?.apiHost || policy?.apiKey) host(s.anthropicBaseUrl);
  for (const list of ['modelProviders', 'modelProfiles'] as const) for (const p of s[list] ?? []) {
    const protectedFields = protectionFor(s, p.id, list);
    if (protectedFields.apiKey) key(p.apiKey);
    if (protectedFields.apiHost) host(p.baseUrl);
  }
  for (const value of Object.values(s.mcpEnvironmentVariables ?? {})) if (value) protectedValues.add(value);
}
export function redactSettingsSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    let result: string = value;
    for (const secret of [...protectedValues].sort((a, b) => b.length - a.length)) result = result.split(secret).join('[protected]');
    return result as T;
  }
  if (Array.isArray(value)) return value.map(redactSettingsSecrets) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSettingsSecrets(v)])) as T;
  return value;
}
