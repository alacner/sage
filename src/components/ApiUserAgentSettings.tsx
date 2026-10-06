import { useEffect, useId, useRef, useState } from 'react';
import packageInfo from '../../package.json';
import {
  DEFAULT_CLAUDE_USER_AGENT_VERSION,
  DEFAULT_CODEX_USER_AGENT_VERSION,
  normalizeApiUserAgentPreset,
  resolveApiUserAgent,
  validApiUserAgentCustom,
  type ApiUserAgentVersions,
} from '../../shared/api-user-agent';
import type { AppSettings } from '../../shared/types';
import { useT } from '../i18n';
import './api-user-agent.css';

type UserAgentSettings = Pick<Partial<AppSettings>, 'apiUserAgentPreset' | 'apiUserAgentCustom' | 'claudeBinaryPath' | 'codexBinaryPath'>;

/** API header preferences live independently of the selected execution engine. */
export function ApiUserAgentSettings({ settings, onChange }: {
  settings: UserAgentSettings;
  onChange: (patch: Pick<Partial<AppSettings>, 'apiUserAgentPreset' | 'apiUserAgentCustom'>) => void;
}) {
  const t = useT();
  const selectId = useId();
  const inputId = useId();
  const hintId = useId();
  const [preset, setPreset] = useState(() => normalizeApiUserAgentPreset(settings.apiUserAgentPreset));
  const [custom, setCustom] = useState(settings.apiUserAgentCustom ?? '');
  const [versions, setVersions] = useState<ApiUserAgentVersions>({
    sage: packageInfo.version,
    claude: DEFAULT_CLAUDE_USER_AGENT_VERSION,
    codex: DEFAULT_CODEX_USER_AGENT_VERSION,
  });
  const request = useRef(0);

  useEffect(() => { setPreset(normalizeApiUserAgentPreset(settings.apiUserAgentPreset)); }, [settings.apiUserAgentPreset]);
  useEffect(() => {
    // An autosave result for another setting must not discard an invalid draft.
    setCustom(current => validApiUserAgentCustom(current) ? settings.apiUserAgentCustom ?? '' : current);
  }, [settings.apiUserAgentCustom]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      const revision = ++request.current;
      void window.api.apiUserAgentVersions().then(result => {
        if (active && revision === request.current) setVersions(result);
      }).catch(() => { /* Keep usable presets when CLI version detection is unavailable. */ });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [settings.claudeBinaryPath, settings.codexBinaryPath]);

  const invalid = !validApiUserAgentCustom(custom);
  const empty = !custom.trim();
  const showHint = invalid || empty;
  return <>
  <div className="settings-row-item stacked settings-api-user-agent-row">
    <label className="settings-row-label" htmlFor={selectId}>User-Agent</label>
    <div className="settings-row-control settings-api-user-agent">
      <select id={selectId} aria-label="User-Agent" value={preset} onChange={event => {
        const value = normalizeApiUserAgentPreset(event.target.value);
        setPreset(value);
        onChange({ apiUserAgentPreset: value });
      }}>
        <option value="sage">{resolveApiUserAgent({ apiUserAgentPreset: 'sage' }, versions)}</option>
        <option value="claude-cli">{resolveApiUserAgent({ apiUserAgentPreset: 'claude-cli' }, versions)}</option>
        <option value="codex-cli">{resolveApiUserAgent({ apiUserAgentPreset: 'codex-cli' }, versions)}</option>
        <option value="custom">{t('settings.backend.userAgent.custom')}</option>
      </select>
    </div>
  </div>
  {preset === 'custom' ? <div className="settings-row-item stacked settings-api-user-agent-custom-row">
    <label className="settings-row-label" htmlFor={inputId}>{t('settings.backend.userAgent.custom')}</label>
    <div className="settings-row-control settings-api-user-agent-custom">
        <input id={inputId} aria-label={t('settings.backend.userAgent.custom')} placeholder="my-user-agent"
          value={custom} aria-invalid={invalid} aria-describedby={showHint ? hintId : undefined}
          spellCheck={false} autoCapitalize="none" autoCorrect="off"
          onChange={event => {
            const value = event.target.value;
            setCustom(value);
            if (validApiUserAgentCustom(value)) onChange({ apiUserAgentCustom: value });
          }} />
        {showHint ? <div id={hintId} className={`settings-api-user-agent-hint muted small${invalid ? ' settings-inline-warning' : ''}`}
          role={invalid ? 'alert' : undefined}>{t(invalid ? 'settings.backend.userAgent.invalid' : 'settings.backend.userAgent.empty')}</div> : null}
    </div>
  </div> : null}
  </>;
}
