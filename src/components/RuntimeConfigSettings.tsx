import { resolveLanguage } from '../../shared/language';
import { useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import {
  DEFAULT_RUNTIME_CONFIG,
  RUNTIME_CONFIG_LIMITS,
  runtimeConfig,
  validateRuntimeConfig,
  type RuntimeConfig,
} from '../../shared/runtime-config';

type RuntimeKey = keyof RuntimeConfig;

/** Editable safety/time limits used by the main-process workers. */
export function RuntimeConfigSettings() {
  const settings = useAppStore((s) => s.settings);
  const lang = resolveLanguage(settings?.language,settings?._systemLocale);
  const copy = (zh: string, en: string) => (lang === 'en' ? en : zh);
  const config = runtimeConfig(settings?.runtimeConfig);
  const [error, setError] = useState('');
  const queue = useRef(Promise.resolve());

  const save = (key: RuntimeKey, raw: string) => {
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      setError(copy('运行时配置必须是整数。', 'Runtime values must be integers.'));
      return;
    }
    const next = { ...runtimeConfig(useAppStore.getState().settings?.runtimeConfig), [key]: value };
    try {
      validateRuntimeConfig(next);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      return;
    }
    queue.current = queue.current.catch(() => undefined).then(async () => {
      await useAppStore.getState().saveSettings({ runtimeConfig: next });
      setError('');
    }).catch((e: any) => setError(e?.message ?? String(e)));
  };

  const reset = () => {
    queue.current = queue.current.catch(() => undefined).then(async () => {
      await useAppStore.getState().saveSettings({ runtimeConfig: { ...DEFAULT_RUNTIME_CONFIG } });
      setError('');
    }).catch((e: any) => setError(e?.message ?? String(e)));
  };

  const field = (key: RuntimeKey, zh: string, en: string, unit: string) => {
    const label = copy(zh, en);
    const limits = RUNTIME_CONFIG_LIMITS[key];
    return (
      <label className="retention-field" key={key}>
        <span>{label}{unit ? ` (${unit})` : ''}</span>
        <input
          aria-label={label}
          type="number"
          min={limits.min}
          max={limits.max}
          step={1}
          key={`${key}-${config[key]}`}
          defaultValue={config[key]}
          onBlur={(e) => save(key, e.target.value)}
        />
      </label>
    );
  };

  return (
    <section className="data-retention-settings runtime-config-settings">
      <div className="settings-group-title">
        {copy('统一运行时配置', 'Unified runtime configuration')}
        <span className="muted small">
          {copy('修改后对新请求、任务和插件调用生效；留空字段使用默认值。', 'Changes apply to new requests, tasks and plugin calls; defaults are used for omitted fields.')}
        </span>
      </div>
      <div className="settings-card">
        <div className="settings-row-item">
          <strong>{copy('Agent 与模型请求', 'Agent and model requests')}</strong>
          <div className="retention-fields">
            {field('maxAgenticIterations', 'Agent 最大迭代次数', 'Maximum Agent iterations', '次')}
            {field('apiRequestTimeoutMs', 'API 请求超时', 'API request timeout', 'ms')}
          </div>
        </div>
        <div className="settings-row-item">
          <strong>{copy('工具与上下文', 'Tools and context')}</strong>
          <div className="retention-fields">
            {field('maxToolOutputBytes', '工具输出大小限制', 'Tool output limit', 'bytes')}
            {field('maxFileReadBytes', '文件读取大小限制', 'File read limit', 'bytes')}
            {field('contextCompressionThresholdTokens', '上下文压缩阈值', 'Context compaction threshold', copy('词元', 'tokens'))}
          </div>
        </div>
        <div className="settings-row-item">
          <strong>{copy('插件、MCP 与调度', 'Plugins, MCP and scheduler')}</strong>
          <div className="retention-fields">
            {field('maxPluginPackageBytes', '插件包大小限制', 'Plugin package limit', 'bytes')}
            {field('mcpRequestTimeoutMs', 'MCP 请求超时', 'MCP request timeout', 'ms')}
            {field('schedulerIntervalMs', '调度器周期', 'Scheduler interval', 'ms')}
          </div>
        </div>
        <div className="settings-row-item">
          <strong>{copy('渠道连接', 'Channel connections')}</strong>
          <div className="retention-fields">
            {field('channelRetryCount', '渠道重试次数', 'Channel retries', '次')}
            {field('channelConnectionTimeoutMs', '渠道连接超时', 'Channel connection timeout', 'ms')}
          </div>
        </div>
        <div className="settings-row-item muted small">
          {copy('数值会在保存时校验安全范围；单位为毫秒、字节、词元或次数。', 'Values are validated against safe bounds when saved; units are milliseconds, bytes, tokens or counts.')}
        </div>
        <div className="settings-row-item">
          <button type="button" className="btn-secondary" onClick={reset}>
            {copy('恢复默认运行时配置', 'Restore runtime defaults')}
          </button>
        </div>
      </div>
      {error ? <p role="alert" className="security-error">{error}</p> : null}
    </section>
  );
}
