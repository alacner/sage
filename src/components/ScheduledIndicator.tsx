import {useAppStore} from '../stores/appStore';
import {resolveLanguage} from '../../shared/language';

export { conversationScheduleState } from '../../shared/conversation-status';
/** Sand drains, the empty glass turns, then starts again. */
export function ScheduledIndicator({animated=false,stopped=false,size=14}:{animated?:boolean;stopped?:boolean;size?:number}){
 const en=resolveLanguage(useAppStore(s=>s.settings?.language),useAppStore.getState().settings?._systemLocale)==='en';
 const label=stopped?(en?'Scheduled task stopped or failed':'定时任务已停用或执行失败'):animated?(en?'Scheduled task active':'定时任务已启用'):(en?'Scheduled task waiting':'定时任务等待执行');
 return <span className={`scheduled-indicator${animated&&!stopped?' is-animated':''}${stopped?' is-stopped':''}`} title={label} role="img" aria-label={label}>
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
   <g className="scheduled-glass">
    <path d="M3 3h18M3 21h18M5 3v3c0 3 4 4 7 6-3 2-7 3-7 6v3M19 3v3c0 3-4 4-7 6 3 2 7 3 7 6v3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
    <path className="scheduled-sand-top" d="M6.5 6h11L12 10.5z" fill="currentColor"/>
    <path className="scheduled-sand-bottom" d="m6.5 19 5.5-4 5.5 4z" fill="currentColor"/>
    <path className="scheduled-sand-stream" d="M12 11v4" stroke="currentColor" strokeWidth=".7" strokeDasharray="1 1"/>
   </g>
  </svg>
 </span>;
}
