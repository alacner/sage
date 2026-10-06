/**
 * 配置模块 - 校验器
 *
 * 对合并后的配置进行结构校验。若缺失必要字段或格式错误，
 * 抛出带有明确提示的 Error，阻断启动流程。
 *
 * 依据: US-1.AC-1.2
 */

import type { AppConfig, AppEnv, LogLevel } from './types';

/** 有效的日志级别集合 */
const VALID_LOG_LEVELS: ReadonlySet<LogLevel> = new Set([
  'debug',
  'info',
  'warn',
  'error',
]);

/** 有效的运行环境集合 */
const VALID_ENVS: ReadonlySet<AppEnv> = new Set([
  'development',
  'test',
  'production',
]);

/**
 * 校验配置对象的结构与字段类型。
 *
 * @param config - 待校验的配置对象
 * @throws Error 当配置缺失必要字段或格式错误时抛出
 */
export function validateConfig(config: unknown): AppConfig {
  if (config === null || config === undefined || typeof config !== 'object') {
    throw new Error(
      '[ConfigValidator] 配置数据无效：期望一个非空对象，实际收到 ' +
        (config === null ? 'null' : typeof config),
    );
  }

  const cfg = config as Record<string, unknown>;
  const errors: string[] = [];

  // ── appName ──────────────────────────────────────────────
  if (typeof cfg.appName !== 'string' || cfg.appName.trim().length === 0) {
    errors.push('缺少或无效的 "appName"：期望非空字符串');
  }

  // ── version ──────────────────────────────────────────────
  if (typeof cfg.version !== 'string' || cfg.version.trim().length === 0) {
    errors.push('缺少或无效的 "version"：期望非空字符串');
  }

  // ── env ──────────────────────────────────────────────────
  if (typeof cfg.env !== 'string' || !VALID_ENVS.has(cfg.env as AppEnv)) {
    errors.push(
      `缺少或无效的 "env"：期望 ${[...VALID_ENVS].join(' | ')} 之一，实际收到 "${String(cfg.env)}"`,
    );
  }

  // ── logLevel ─────────────────────────────────────────────
  if (
    typeof cfg.logLevel !== 'string' ||
    !VALID_LOG_LEVELS.has(cfg.logLevel as LogLevel)
  ) {
    errors.push(
      `缺少或无效的 "logLevel"：期望 ${[...VALID_LOG_LEVELS].join(' | ')} 之一，实际收到 "${String(cfg.logLevel)}"`,
    );
  }

  // ── dataDir ──────────────────────────────────────────────
  if (typeof cfg.dataDir !== 'string' || cfg.dataDir.trim().length === 0) {
    errors.push('缺少或无效的 "dataDir"：期望非空字符串');
  }

  // ── timeout ──────────────────────────────────────────────
  const timeoutErrors = validateTimeout(cfg.timeout);
  errors.push(...timeoutErrors);

  // ── retry ────────────────────────────────────────────────
  const retryErrors = validateRetry(cfg.retry);
  errors.push(...retryErrors);

  // ── 汇总 ─────────────────────────────────────────────────
  if (errors.length > 0) {
    throw new Error(
      `[ConfigValidator] 配置校验失败（共 ${errors.length} 项错误）：\n  - ${errors.join('\n  - ')}`,
    );
  }

  return config as AppConfig;
}

/**
 * 校验 timeout 子配置。
 */
function validateTimeout(value: unknown): string[] {
  const errors: string[] = [];

  if (value === null || value === undefined || typeof value !== 'object') {
    errors.push('缺少或无效的 "timeout"：期望一个对象');
    return errors;
  }

  const t = value as Record<string, unknown>;

  if (typeof t.requestMs !== 'number' || t.requestMs < 0) {
    errors.push(
      `缺少或无效的 "timeout.requestMs"：期望非负数字，实际收到 "${String(t.requestMs)}"`,
    );
  }

  if (typeof t.startupMs !== 'number' || t.startupMs < 0) {
    errors.push(
      `缺少或无效的 "timeout.startupMs"：期望非负数字，实际收到 "${String(t.startupMs)}"`,
    );
  }

  return errors;
}

/**
 * 校验 retry 子配置。
 */
function validateRetry(value: unknown): string[] {
  const errors: string[] = [];

  if (value === null || value === undefined || typeof value !== 'object') {
    errors.push('缺少或无效的 "retry"：期望一个对象');
    return errors;
  }

  const r = value as Record<string, unknown>;

  if (typeof r.maxRetries !== 'number' || r.maxRetries < 0 || !Number.isInteger(r.maxRetries)) {
    errors.push(
      `缺少或无效的 "retry.maxRetries"：期望非负整数，实际收到 "${String(r.maxRetries)}"`,
    );
  }

  if (typeof r.delayMs !== 'number' || r.delayMs < 0) {
    errors.push(
      `缺少或无效的 "retry.delayMs"：期望非负数字，实际收到 "${String(r.delayMs)}"`,
    );
  }

  return errors;
}
