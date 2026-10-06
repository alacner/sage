/**
 * 配置模块 - 类型定义
 *
 * 定义应用启动所需的配置数据结构。
 */

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 运行环境 */
export type AppEnv = 'development' | 'test' | 'production';

/** 重试策略配置 */
export interface RetryConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试间隔（毫秒） */
  delayMs: number;
}

/** 超时配置 */
export interface TimeoutConfig {
  /** 请求超时（毫秒） */
  requestMs: number;
  /** 启动超时（毫秒） */
  startupMs: number;
}

/** 应用配置（最终合并并校验后的结构） */
export interface AppConfig {
  /** 应用名称 */
  appName: string;
  /** 应用版本 */
  version: string;
  /** 运行环境 */
  env: AppEnv;
  /** 日志级别 */
  logLevel: LogLevel;
  /** 数据目录路径 */
  dataDir: string;
  /** 超时配置 */
  timeout: TimeoutConfig;
  /** 重试配置 */
  retry: RetryConfig;
}

/** 外部传入的环境变量覆盖项（所有字段可选） */
export type EnvOverrides = Partial<AppConfig> & {
  timeout?: Partial<TimeoutConfig>;
  retry?: Partial<RetryConfig>;
};
