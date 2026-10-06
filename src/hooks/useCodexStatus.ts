import { useEffect, useState } from 'react';
import type { ClaudeBridgeStatus } from '../../shared/types';
import { useAppStore } from '../stores/appStore';

export function useCodexStatus() {
  const backend = useAppStore(s => s.settings?.preferredBackend);
  const path = useAppStore(s => s.settings?.codexBinaryPath);
  const [status, setStatus] = useState<ClaudeBridgeStatus>();
  useEffect(() => {
    if (backend !== 'codex') return;
    let active = true;
    setStatus(undefined);
    void window.api.codexStatus().then(value => { if (active) setStatus(value); }).catch(() => {
      if (active) setStatus({ available: false, error: 'Codex CLI unavailable' });
    });
    return () => { active = false; };
  }, [backend, path]);
  return status;
}
