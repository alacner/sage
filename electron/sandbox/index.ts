/**
 * Sandbox 安全机制统一入口。
 *
 * 把所有 AI 触发的危险操作（Bash / 文件读写 / 网络）收口到一个带策略的执行层，
 * 阻止 AI 读取项目外的密钥、外传数据、留持久化后门。
 *
 * 设计文档见 docs/SANDBOX_DESIGN.md。
 *
 * 子模块：
 * - env.ts        环境变量脱敏（白名单 + 硬剥离 20 种密钥）
 * - fs-policy.ts  文件路径强约束（deny 路径表借鉴 Claude Code scrubSandboxConfig）
 * - bash-policy.ts Bash 命令沙箱（危险模式黑名单 + 路径强制约束）
 * - net-policy.ts 网络出口域名白名单
 * - audit-log.ts  不可篡改审计日志
 * - secrets.ts    密钥加密存储（safeStorage / Keychain）
 */

export { buildSandboxEnv, DEFAULT_STRIP_ENV_KEYS } from './env';
export {
  enforceInsideProject,
  isDeniedRead,
  isDeniedWrite,
  isPathInsideProject,
  SandboxError,
  DEFAULT_DENY_READ_PREFIXES,
  DEFAULT_DENY_WRITE_PREFIXES,
  DEFAULT_DENY_WRITE_SEGMENTS,
  DEFAULT_SAFE_SYSTEM_PREFIXES,
} from './fs-policy';
export { checkBashCommand, DEFAULT_HARD_DENIED_PATTERNS } from './bash-policy';
export { checkUrl, getAllowedHosts, DEFAULT_ALLOWED_HOSTS } from './net-policy';
export { audit, type AuditEntry } from './audit-log';
export { encryptSecret, decryptSecret, isEncrypted, hasEncryptedSecrets } from './secrets';
