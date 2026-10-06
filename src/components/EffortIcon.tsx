import type {ThinkingEffort} from '../../shared/types';
export function EffortIcon({ effort }: {effort: ThinkingEffort}) {
  return <svg className="model-combo-icon" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
    {effort === 'xhigh' ? <circle cx="10" cy="10" r="7" fill="currentColor"/> : <>
      {effort === 'low' && <path d="M10 10V3a7 7 0 0 1 7 7Z" fill="currentColor"/>}
      {effort === 'medium' && <path d="M10 3a7 7 0 0 1 0 14Z" fill="currentColor"/>}
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.6"/>
    </>}
  </svg>;
}
