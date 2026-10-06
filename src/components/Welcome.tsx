import { useCodexStatus } from '../hooks/useCodexStatus';
import { useAppStore } from '../stores/appStore';
import { useT } from '../i18n';

export function Welcome() {
  const t = useT();
  const pickProject = useAppStore((s) => s.pickProject);
  const claudeStatus = useAppStore((s) => s.claudeStatus);
  const backend = useAppStore((s) => s.settings?.backendEngine);
  const codexStatus = useCodexStatus();
  const status = backend === 'codex' ? codexStatus : claudeStatus;
  const settings = useAppStore((s) => s.settings);
  const hasApi = !!settings?.anthropicApiKey || !!settings?.modelProviders?.some((p) => p.enabled);
  // Auto mode uses CLI availability, matching the backend routing policy.
  const showCliStatus = false;

  return (
    <div className="welcome">
      <h1>Sage</h1>
      <p className="muted">{t('welcome.tagline')}</p>

      {showCliStatus && (
        <div className="welcome-card">
          <h3>{backend === 'codex' ? 'Codex CLI' : t('welcome.cliTitle')}</h3>
          {status?.available ? (
            <div className="ok">
              ✓ {backend === 'codex' ? '' : t('welcome.cliOk')} <code>{status.path}</code> ({status.version})
            </div>
          ) : (
            <div className="warn">
              ✗ {status?.error ?? t('welcome.cliChecking')}
              <p className="muted small">{t(backend === 'codex' ? 'settings.codexHelp' : 'welcome.cliHint')}</p>
            </div>
          )}
        </div>
      )}

      {!showCliStatus && (
        <div className="welcome-card">
          <h3>{t('welcome.apiTitle')}</h3>
          <div className={hasApi ? "muted" : "warn"}>{t(hasApi ? 'welcome.apiConfigured' : 'welcome.apiMissing')}</div>
          <p className="muted small">{t('welcome.apiNote')}</p>
        </div>
      )}

      <div className="welcome-actions">
        <button className="btn-primary" onClick={pickProject}>{t('welcome.pickProject')}</button>
      </div>

      <div className="welcome-flow">
        <h3>{t('welcome.workflowTitle')}</h3>
        <ol>
          <li>{t('welcome.wf1a')}</li>
          <li>{t('welcome.setup')}</li>
          <li>{t('welcome.plugins')}</li>
        </ol>
      </div>
    </div>
  );
}
