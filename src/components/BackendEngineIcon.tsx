import { TerminalSquare } from 'lucide-react';
import type { PluginIcon } from '../../shared/plugins/icons';
import { legacyEngineIcons } from '../lib/engine-icon-compat';

const sageIcon: PluginIcon = {
  paths: [
    'M12 22V5',
    'M12 17c-4 0-7-2-8-6 4 0 7 2 8 6Z',
    'M12 17c4 0 7-2 8-6-4 0-7 2-8 6Z',
    'M12 10c-3 0-5-2-6-5 3 0 5 2 6 5Z',
    'M12 10c3 0 5-2 6-5-3 0-5 2-6 5Z',
  ],
};

/** Installed plugin artwork wins; older official packages retain their recognizable glyph. */
export function BackendEngineIcon({ engineId, icon }: { engineId: string; icon?: PluginIcon }) {
  const legacyIcon = Object.hasOwn(legacyEngineIcons, engineId) ? legacyEngineIcons[engineId] : undefined;
  const glyph = engineId === 'api' ? sageIcon : icon ?? legacyIcon;
  if (!glyph) return <TerminalSquare size={14} aria-hidden="true" />;
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fillRule="evenodd" fill={glyph.filled ? 'currentColor' : 'none'} stroke={glyph.filled ? 'none' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-engine-icon={engineId}>
      {glyph.paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
