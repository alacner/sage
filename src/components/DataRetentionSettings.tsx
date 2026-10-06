import {resolveLanguage} from '../../shared/language';
import {useRef,useState} from 'react';
import {useAppStore} from '../stores/appStore';
import {dataRetention,validateDataRetention,RETENTION_MAX,type DataRetention} from '../../shared/data-retention';
export function DataRetentionSettings(){
 const settings=useAppStore(s=>s.settings),config=dataRetention(settings?.dataRetention);
 const copy=(zh:string,en:string)=>resolveLanguage(settings?.language,settings?._systemLocale)==='en'?en:zh;
 const [error,setError]=useState('');const queue=useRef(Promise.resolve());
 const field=(key:keyof DataRetention,label:string)=> <label className="retention-field" key={key}><span>{label}</span><input aria-label={label} type="number" min={1} max={RETENTION_MAX[key]} step={1} key={key+config[key]} defaultValue={config[key]} onBlur={e=>{
  const value=Number(e.target.value);if(value===config[key])return;
  queue.current=queue.current.catch(()=>{}).then(async()=>{const next={...dataRetention(useAppStore.getState().settings?.dataRetention),[key]:value};validateDataRetention(next);await useAppStore.getState().saveSettings({dataRetention:next});setError('');}).catch(e=>{setError(e.message);});
 }}/></label>;
 return <section className="data-retention-settings"><h3 className="settings-group-title">{copy('历史与日志清理','History and log cleanup')}</h3><div className="settings-card">
 <div className="settings-row-item"><strong>settings.json.history</strong><div className="retention-fields">{field('settingsHistoryDays',copy('设置历史保留天数','Settings history days'))}{field('settingsHistoryCount',copy('设置历史最少保留份数','Minimum settings snapshots'))}</div></div>
 <div className="settings-row-item"><strong>projects.json.history</strong><div className="retention-fields">{field('projectsHistoryDays',copy('项目列表历史保留天数','Project history days'))}{field('projectsHistoryCount',copy('项目列表历史最少保留份数','Minimum project snapshots'))}</div></div>
 <div className="settings-row-item"><strong>{copy('决策日志（原 decisions.log）','Decision logs (formerly decisions.log)')}</strong><div className="retention-fields">{field('decisionDays',copy('决策日志保留天数','Decision log days'))}{field('decisionFileMB',copy('单文件上限（MB）','Shard size (MB)'))}{field('decisionTotalMB',copy('日志总大小上限（MB）','Total log size (MB)'))}</div></div>
 <div className="settings-row-item muted small">{copy('历史快照仅在超过保留天数、且不属于最近保留份数时删除；损坏备份不自动删除。决策日志按日期和项目拆分，超过天数或总大小任一上限时清理最旧文件。保存清理配置或新增历史记录时检查快照；日志写入、查询时检查清理（通常每小时一次，新分片和配置变更立即检查）。','Snapshots are deleted only when both older than the retention period and outside the newest minimum count; corrupt backups are preserved. Decision logs split by date and project; exceeding either age or total size removes the oldest files. Snapshots are checked on settings/history saves. Log writes and queries check cleanup hourly, immediately on new shards or changed settings.')}</div>
 </div>{error?<p role="alert" className="security-error">{error}</p>:null}</section>;
}
