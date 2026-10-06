/**
 * 密钥加密存储：密钥不以明文落盘 settings.json。
 *
 * 历史方案用 Electron safeStorage（macOS Keychain），但 Keychain 条目的
 * 访问权限绑定"创建它的那次代码签名"。ad-hoc 重签 / dev 与打包版混用都会
 * 换身份 → 新构建解不开旧密文 → 密钥静默变空串 → 全线 401。
 *
 * 现方案：master key 文件（userData/sage-master.key，0600）+ AES-256-GCM。
 * 与签名身份无关，dev / 打包 / 任何重签构建共享同一 master key。
 *
 * 前缀约定：
 *   - "aes:"  新方案密文（iv(12) + authTag(16) + ciphertext，base64）
 *   - "enc:"  旧 safeStorage 密文（只读迁移：解密成功后下次写盘自动转 aes:）
 *   - 其他    视为旧明文，原样使用并自动加密回写
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

const AES_PREFIX = 'aes:';
/** 旧 safeStorage 密文前缀，仅用于迁移读取。 */
const ENC_PREFIX = 'enc:';
const MASTER_KEY_FILE = 'sage-master.key';

/**
 * 判断一个存储值是否已加密（任一方案的密文）。
 */
export function isEncrypted(value: string | undefined | null): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith(AES_PREFIX) || value.startsWith(ENC_PREFIX))
  );
}

// ─── Master key（与签名身份无关的本地密钥）─────────────────────────────


function masterKeyPath(): string | null {
  try {
    if (!app || typeof app.getPath !== 'function') return null;
    return path.join(app.getPath('userData'), MASTER_KEY_FILE);
  } catch {
    return null;
  }
}

function getMasterKey(create = false): Buffer | null {
  const p = masterKeyPath();
  if (!p) return null;
  try {
    if (fs.existsSync(p)) {
      const buf = Buffer.from(fs.readFileSync(p, 'utf-8').trim(), 'base64');
      if (buf.length === 32) {
        return buf;
      }
      throw new Error('master key 损坏，拒绝重新生成');
    }
  } catch (err) {
    console.error('[sandbox:secrets] 读取 master key 失败:', err);
    return null;
  }
  if (!create) return null;
  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(p, 'wx', 0o600);
    try { fs.writeFileSync(fd, key.toString('base64')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const dir = fs.openSync(path.dirname(p), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    try {
      fs.chmodSync(p, 0o600); // 兜底：文件已存在时确保权限
    } catch {
      /* ignore */
    }
    return key;
  } catch (err) {
    console.error('[sandbox:secrets] 写入 master key 失败:', err);
    return null;
  }
}

function aesEncrypt(plain: string): string {
  const key = getMasterKey(true);
  if (!key) throw new Error('master key unavailable');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return AES_PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

/** 解密 aes: 密文；失败返回 null（不抛错）。 */
function aesDecrypt(stored: string): string | null {
  try {
    const key = getMasterKey();
    if (!key) return null;
    const raw = Buffer.from(stored.slice(AES_PREFIX.length), 'base64');
    if (raw.length < 28) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  } catch (err) {
    console.error('[sandbox:secrets] aes decrypt failed:', err);
    return null;
  }
}

// ─── 旧 safeStorage 路径（仅迁移读取）──────────────────────────────────

function legacyDecrypt(stored: string): string {
  if (!safeStorage || typeof safeStorage.decryptString !== 'function') {
    console.warn('[sandbox:secrets] safeStorage 不可用，无法解密旧密文');
    return '';
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[sandbox:secrets] safeStorage 解密不可用');
    return '';
  }
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch (err) {
    // 典型场景：旧密文由其他签名身份的构建写入，当前构建无权读取 Keychain。
    // 不把暂时不可解密判定为永久丢失；保留原密文，允许用户解锁后恢复。
    console.error('[sandbox:secrets] 旧 safeStorage 密文暂时不可解密（已保留原数据）:', err);
    return '';
  }
}

// ─── 对外 API ──────────────────────────────────────────────────────────

/**
 * 加密一个明文密钥。已加密值原样返回（幂等）。
 * 仅使用 AES；主密钥不可用时拒绝保存，绝不降级明文。
 */
export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  if (isEncrypted(plain)) return plain; // 已加密，幂等
  return aesEncrypt(plain); // Fail closed: never downgrade to plaintext or another key backend.
}

/**
 * 解密一个密钥。非加密值（旧明文 / 空值）原样返回。
 * 解密失败抛错，保留磁盘密文。
 *
 * 嵌套防御：历史上曾出现过"密文套密文"（解密一次得到的仍是 aes:/enc:
 * 密文，被当明文直接发给服务端 → 401）。这里循环解到结果不再是密文为止，
 * 从根上保证返回值绝不带密文前缀。
 */
export function decryptSecret(stored: string | undefined | null): string {
  let value = stored ?? '';
  for (let i = 0; i < 5 && isEncrypted(value); i++) {
    const next = value.startsWith(AES_PREFIX) ? aesDecrypt(value) : legacyDecrypt(value);
    if (next === null || next === '') throw new Error('敏感配置解密失败；原始密文已保留，请恢复主密钥或解锁钥匙串');
    value = next;
  }
  if (isEncrypted(value)) throw new Error('敏感配置嵌套加密超过限制');
  return value;
}

/**
 * 检查 settings 的敏感字段中是否残留密文（aes:/enc: 前缀）。
 * 用于 readSettings 解密之后的二次校验：正常情况解密结果应为纯明文，
 * 若仍是密文（历史上出现过“密文套密文”），则触发自愈回写拍平，
 * 避免密文被当 API key 发出导致 401。
 */
export function hasEncryptedSecrets(settings: Record<string, any>): boolean {
  if (!settings || typeof settings !== 'object') return false;
  for (const field of SECRET_SETTING_FIELDS) {
    if (isEncrypted((settings as any)[field])) return true;
  }
  for (const list of [(settings as any).modelProviders, (settings as any).modelProfiles]) {
    if (Array.isArray(list)) {
      for (const p of list) {
        if (p && isEncrypted(p.apiKey)) return true;
      }
    }
  }
  const mcpEnvironmentVariables = (settings as any).mcpEnvironmentVariables;
  if (mcpEnvironmentVariables && typeof mcpEnvironmentVariables === 'object' && Object.values(mcpEnvironmentVariables).some(value => isEncrypted(value as string))) return true;
  const pluginSecrets = (settings as any).pluginSecrets;
  if (pluginSecrets && typeof pluginSecrets === 'object' && Object.values(pluginSecrets).some((fields:any) => fields && typeof fields === 'object' && Object.values(fields).some(value => isEncrypted(value as string)))) return true;
  return false;
}

/** 需要加密的 settings 顶层字段。 */
export const SECRET_SETTING_FIELDS: readonly string[] = [
  'anthropicApiKey',
  'anthropicBaseUrl',
  'relayToken',
  'relayWebhookToken',
  'SAGE_ANTHROPIC_API_KEY',
];

/**
 * 加密 settings 对象中的所有敏感字段（原地修改并返回）。
 * modelProviders[].apiKey / modelProfiles[].apiKey 也一并处理。
 */
export function encryptSettings<T extends Record<string, any>>(settings: T): T {
  if (!settings || typeof settings !== 'object') return settings;

  for (const field of SECRET_SETTING_FIELDS) {
    const v = (settings as any)[field];
    if (typeof v === 'string' && v) {
      (settings as any)[field] = encryptSecret(v);
    }
  }

  const pluginSecrets = (settings as any).pluginSecrets;
  if (pluginSecrets && typeof pluginSecrets === 'object') for (const fields of Object.values(pluginSecrets) as any[]) if (fields && typeof fields === 'object') for (const key of Object.keys(fields)) if (typeof fields[key] === 'string' && fields[key]) fields[key] = encryptSecret(fields[key]);

  // modelProviders[].apiKey
  const providers = (settings as any).modelProviders;
  if (Array.isArray(providers)) {
    for (const p of providers) {
      for (const field of ['apiKey', 'baseUrl']) {
        if (p && typeof p[field] === 'string' && p[field]) p[field] = encryptSecret(p[field]);
      }
    }
  }

  // modelProfiles[].apiKey（向后兼容）
  const profiles = (settings as any).modelProfiles;
  if (Array.isArray(profiles)) {
    for (const p of profiles) {
      for (const field of ['apiKey', 'baseUrl']) {
        if (p && typeof p[field] === 'string' && p[field]) p[field] = encryptSecret(p[field]);
      }
    }
  }

  const mcpEnvironmentVariables = (settings as any).mcpEnvironmentVariables;
  if (mcpEnvironmentVariables && typeof mcpEnvironmentVariables === 'object') {
    for (const key of Object.keys(mcpEnvironmentVariables)) {
      const value = mcpEnvironmentVariables[key];
      if (typeof value === 'string' && value) mcpEnvironmentVariables[key] = encryptSecret(value);
    }
  }

  return settings;
}

/**
 * 解密 settings 对象中的所有敏感字段（原地修改并返回）。
 */
export function decryptSettings<T extends Record<string, any>>(settings: T): T {
  if (!settings || typeof settings !== 'object') return settings;

  for (const field of SECRET_SETTING_FIELDS) {
    const v = (settings as any)[field];
    if (typeof v === 'string' && v) {
      (settings as any)[field] = decryptSecret(v);
    }
  }

  const providers = (settings as any).modelProviders;
  if (Array.isArray(providers)) {
    for (const p of providers) {
      for (const field of ['apiKey', 'baseUrl']) {
        if (p && typeof p[field] === 'string' && p[field]) p[field] = decryptSecret(p[field]);
      }
    }
  }

  const profiles = (settings as any).modelProfiles;
  if (Array.isArray(profiles)) {
    for (const p of profiles) {
      for (const field of ['apiKey', 'baseUrl']) {
        if (p && typeof p[field] === 'string' && p[field]) p[field] = decryptSecret(p[field]);
      }
    }
  }

  const mcpEnvironmentVariables = (settings as any).mcpEnvironmentVariables;
  if (mcpEnvironmentVariables && typeof mcpEnvironmentVariables === 'object') {
    for (const key of Object.keys(mcpEnvironmentVariables)) {
      const value = mcpEnvironmentVariables[key];
      if (typeof value === 'string' && value) mcpEnvironmentVariables[key] = decryptSecret(value);
    }
  }

  const pluginSecrets = (settings as any).pluginSecrets;
  if (pluginSecrets && typeof pluginSecrets === 'object') for (const fields of Object.values(pluginSecrets) as any[]) if (fields && typeof fields === 'object') for (const key of Object.keys(fields)) if (typeof fields[key] === 'string' && fields[key]) fields[key] = decryptSecret(fields[key]);

  return settings;
}
