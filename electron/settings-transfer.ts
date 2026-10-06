import { selectBackupGroups, includedBackupGroups, type BackupGroup } from '../shared/settings-backup';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings } from '../shared/types';
import { validateSettings } from './settings-repository';

import { PROTECTED, policyUnion, protectionFor, exportProtection, type FieldProtection } from '../shared/settings-protection';
export { PROTECTED, policyUnion };
export type SecretPolicy = FieldProtection;
const deriveKey = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
function fields(s: AppSettings, policy: SecretPolicy, visit: (o: any, k: string, id?: string, list?: string) => void) {
  if (policy.apiKey) { visit(s, 'anthropicApiKey'); visit(s, 'SAGE_ANTHROPIC_API_KEY'); }
  if (policy.apiHost) visit(s, 'anthropicBaseUrl');
  for (const list of ['modelProviders', 'modelProfiles'] as const) for (const p of s[list] ?? []) {
    const entryPolicy = protectionFor(s, p.id, list);
    if (entryPolicy.apiKey) visit(p, 'apiKey', p.id, list);
    if (entryPolicy.apiHost) visit(p, 'baseUrl', p.id, list);
  }
}
export function publicSettings(s: AppSettings, systemLocale?:string): AppSettings {
  const result = structuredClone(s);
  delete result._systemLocale;
  if(systemLocale!==undefined)result._systemLocale=systemLocale;
  for (const p of result.modelProviders ?? []) if (p.kind === 'relay') p.name = s.language === 'en' ? 'Relay provider' : '中继提供商';
  fields(result, policyUnion(s._secretPolicy), (o, k) => { if (o[k]) o[k] = PROTECTED; });
  for (const [name, value] of Object.entries(result.mcpEnvironmentVariables ?? {})) if (value) result.mcpEnvironmentVariables![name] = PROTECTED;
  delete result.pluginSecrets;
  delete result._integrity;
  result._revision ??= 'legacy';
  return result;
}
export function applyPublicPatch(cur: AppSettings, patch: Partial<AppSettings>): AppSettings {
  if ('_systemLocale' in patch || '_backupSections' in patch || '_modelMigrationVersion' in patch || '_schemaVersion' in patch || '_revision' in patch || '_secretPolicy' in patch || '_integrity' in patch || '_recovery' in patch || 'pluginSecrets' in patch) throw new Error('不能通过普通设置修改保护策略');
  const next = { ...cur, ...structuredClone(patch) };
  fields(next, policyUnion(cur._secretPolicy), (o, k, id, list) => {
    const old: any = id ? (cur as any)[list!]?.find((p: any) => p.id === id) : cur;
    if (!old?.[k]) { if (o[k] === PROTECTED) throw new Error('无法引用其他提供商的凭证'); return; }
    if (o[k] !== PROTECTED && o[k] !== old[k]) throw new Error('受保护凭证和目标地址不可修改；请新建提供商');
    o[k] = old[k];
  });
  if (patch.mcpEnvironmentVariables !== undefined) {
    const incoming = patch.mcpEnvironmentVariables;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('MCP 环境变量配置无效');
    const restored: Record<string, string> = {};
    for (const [name, value] of Object.entries(incoming)) {
      if (value === PROTECTED) {
        const old = cur.mcpEnvironmentVariables?.[name];
        if (!old) throw new Error(`MCP 环境变量 ${name} 的受保护值不存在`);
        restored[name] = old;
      } else if (typeof value === 'string' && value) restored[name] = value;
      else throw new Error(`MCP 环境变量 ${name} 不能为空`);
    }
    next.mcpEnvironmentVariables = restored;
  }
  // Visibility and destination binding are separate: a visible Host must still
  // be immutable when the associated key is use-only.
  if (cur._secretPolicy?.apiKey && (cur.anthropicApiKey || (cur as AppSettings & { SAGE_ANTHROPIC_API_KEY?: string }).SAGE_ANTHROPIC_API_KEY) && next.anthropicBaseUrl !== cur.anthropicBaseUrl) throw new Error('受保护 Key 的目标地址不可修改；请新建提供商');
  for (const list of ['modelProviders', 'modelProfiles'] as const) for (const old of cur[list] ?? []) {
    const entry = next[list]?.find(p => p.id === old.id);
    if (entry && old.apiKey && protectionFor(cur, old.id, list).apiKey && entry.baseUrl !== old.baseUrl) throw new Error('受保护 Key 的目标地址不可修改；请新建提供商');
  }
  // Never save a placeholder as a credential, including copied/renamed providers.
  const check = (v: any): void => {
    if (v === PROTECTED) throw new Error('无效的受保护字段引用');
    if (v && typeof v === 'object') Object.values(v).forEach(check);
  };
  check(next);
  return next;
}

export async function exportSettings(s: AppSettings, password: string, policy: SecretPolicy, groups?: BackupGroup[]): Promise<string> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('备份口令须为 12–1024 个字符');
  const data = groups ? selectBackupGroups(s, groups) : structuredClone(s);
  delete data._revision; delete data._integrity; delete data._recovery; delete data._systemLocale;
  if (!groups || groups.includes('models')) data._secretPolicy = exportProtection(data, policy);
  const version = groups ? 2 : 1;
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = await deriveKey(password, salt);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`sage-settings:${version}:scrypt-N32768-r8-p1:aes-256-gcm`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return JSON.stringify({ format: 'sage-settings', version, kdf: 'scrypt-N32768-r8-p1', cipher: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }, null, 2);
  } finally { key.fill(0); }
}
export async function importSettings(raw: string, password: string): Promise<AppSettings> {
  if (Buffer.byteLength(raw) > 10 * 1024 * 1024 || typeof password !== 'string' || password.length > 1024) throw new Error('备份或口令超过限制');
  try {
    const e = JSON.parse(raw);
    if (e.format !== 'sage-settings' || ![1, 2].includes(e.version) || e.kdf !== 'scrypt-N32768-r8-p1' || e.cipher !== 'aes-256-gcm') throw new Error();
    const decode = (v: any, size?: number) => {
      if (typeof v !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new Error();
      const b = Buffer.from(v, 'base64');
      if (b.toString('base64') !== v || (size && b.length !== size)) throw new Error();
      return b;
    };
    const salt = decode(e.salt, 16), iv = decode(e.iv, 12), tag = decode(e.tag, 16), data = decode(e.data);
    const key = await deriveKey(password, salt);
    try {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`sage-settings:${e.version}:scrypt-N32768-r8-p1:aes-256-gcm`));
      cipher.setAuthTag(tag);
      const settings = JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
      validateSettings(settings);
      includedBackupGroups(settings);
      if(e.version===2 && !(settings as AppSettings & { _backupSections?: unknown })._backupSections)throw new Error();
      const secrets: unknown[] = [settings.anthropicApiKey, settings.anthropicBaseUrl, settings.relayToken, settings.relayWebhookToken, ...Object.values(settings.mcpEnvironmentVariables ?? {}), ...Object.values(settings.pluginSecrets??{}).flatMap(fields=>Object.values(fields))];
      for (const p of [...settings.modelProviders ?? [], ...settings.modelProfiles ?? []]) secrets.push(p.apiKey, p.baseUrl);
      if (secrets.some(v => typeof v === 'string' && (/^(aes:|enc:)/.test(v) || v === PROTECTED))) throw new Error('备份含本机密文或占位符');
      delete settings._revision; delete settings._integrity; delete settings._recovery; delete settings._systemLocale;
      return settings;
    } finally { key.fill(0); }
  } catch { throw new Error('导入失败：口令错误、文件损坏或格式不受支持；现有配置未修改'); }
}
export function mergeImport(cur: AppSettings, incoming: AppSettings): AppSettings {
  const next = { ...cur, ...incoming, _secretPolicy: policyUnion(cur._secretPolicy, incoming._secretPolicy) };
  // Default merge is non-destructive: keep existing IDs and add imported providers.
  for (const list of ['modelProviders', 'modelProfiles'] as const) {
    if (!incoming[list]) continue;
    const merged = new Map((cur[list] ?? []).map(p => [p.id, p]));
    for (const p of incoming[list]!) if (!merged.has(p.id)) merged.set(p.id, p as any);
    (next as any)[list] = [...merged.values()];
  }
  return next;
}

/** Publish a complete backup exclusively; a failed export never truncates an existing backup. */
export async function writeEncryptedExport(file: string, encrypted: string): Promise<void> {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const h = await fs.open(tmp, 'wx', 0o600);
    try { await h.writeFile(encrypted, 'utf8'); await h.sync(); } finally { await h.close(); }
    await fs.link(tmp, file);
    const dir = await fs.open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch (e: any) {
    if (e.code === 'EEXIST') throw new Error('同名备份已存在，为避免覆盖请使用新文件名');
    throw e;
  } finally { await fs.rm(tmp, {force:true}); }
}
