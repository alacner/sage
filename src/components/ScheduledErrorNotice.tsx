import {scheduledError,scheduledErrorSummary} from '../lib/scheduled-error';
export function ScheduledErrorNotice({message,en,onConfigure}:{message:string;en:boolean;onConfigure?:()=>void}){
 const text=scheduledError(message,en),summary=scheduledErrorSummary(message,en);
 return <div className="scheduled-error-notice">
  {text===summary.text?<p>{summary.text}</p>:<details><summary><span>{summary.text}</span><small>{en?'Details':'详情'}</small></summary><p>{text}</p></details>}
  {summary.permission&&onConfigure&&<button type="button" onClick={onConfigure}>{en?'Configure authorization':'调整授权'}</button>}
 </div>;
}
