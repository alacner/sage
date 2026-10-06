/**
 * 配置模块 - 加载器
 *
 * 负责读取默认配置文件，并覆盖/合并外部传入的环境变量。
 *
 * 依据: US-1.AC-1.1
 */

import type { AppConfig, EnvOverrides } from './types';
import { validateConfig } from './validator';

/**
 * 内置的默认配置。
 * 当没有外部配置文件或环境变量覆盖时使用此默认值。
 */
const DEFAULT_CONFIG: AppConfig = {
  appName: 'sage',
  version: '0.0.0',
  env: 'production',
  logLevel: 'info',
  dataDir: './data',
  timeout: {
    requestMs: 30_000,
    startupMs: 10_000,
  },
  retry: {
    maxRetries: 3,
    delayMs: 1_000,
  },
};

/**
 * 深度合并两个对象。`source` 中的值会覆盖 `target` 中对应键的值，
 * 嵌套对象会被递归合并而非直接替换。
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (
      sourceVal !== null &&
      sourceVal !== undefined &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      targetVal !== undefined &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }

  return result as T;
}

/**
 * 加载配置：读取默认配置并与外部传入的环境变量覆盖项进行合并，
 * 最后对合并结果进行校验。
 *
 * @param envOverrides - 外部传入的环境变量覆盖项（可选）
 * @returns 校验通过后的完整配置
 * @throws Error 当配置文件缺失或格式校验失败时抛出
 */
export function loadConfig(envOverrides?: EnvOverrides): AppConfig {
  // Step 1: 以默认配置为基底
  let merged: Record<string, unknown> = { ...DEFAULT_CONFIG };

  // Step 2: 合并外部传入的环境变量覆盖
  if (envOverrides) {
    merged = deepMerge(merged, envOverrides as Record<string, unknown>);
  }

  // Step 3: 校验合并后的配置
  const validated = validateConfig(merged);

  return validated;
}

/**
 * 获取默认配置的副本（仅供测试或外部参考使用）。
 */
export function getDefaultConfig(): AppConfig {
  return { ...DEFAULT_CONFIG, timeout: { ...DEFAULT_CONFIG.timeout }, retry: { ...DEFAULT_CONFIG.retry } };
}
