import { Plus } from 'lucide-react';
import { useState } from 'react';
import { usePluginSnapshot } from './PluginWorkbench';
import { useAppStore } from '../../stores/appStore';
import {hostExtensionPoints} from '../../../shared/plugins/extensions';

export function ExtensionOptions({point,selected}:{point:string;selected?:string}) {
  const {snapshot}=usePluginSnapshot();
  const permission=hostExtensionPoints[point as keyof typeof hostExtensionPoints]?.permission;
  const entries=snapshot?.plugins.filter(p=>p.enabled&&(!permission||p.granted?.includes(permission))).flatMap(p=>(p.manifest.extensions??[]).filter(e=>e.point===point).map(e=>({key:`${p.manifest.id}/${e.id}`,title:`${e.title} (${p.manifest.name})`})))??[];
  return <>{selected&&!entries.some(e=>e.key===selected)&&<option value={selected} disabled>{selected} (不可用 / Unavailable)</option>}{entries.map(e=><option key={e.key} value={e.key}>{e.title}</option>)}</>;
}
export function ModelRoutingExtensions() {
  const [key,setKey]=useState(''),[error,setError]=useState('');
  const {snapshot}=usePluginSnapshot();
  const add=async()=>{
    try{
      const state=useAppStore.getState();
      const entry=snapshot?.plugins.flatMap(p=>(p.manifest.extensions??[]).map(e=>({...e,key:`${p.manifest.id}/${e.id}`}))).find(e=>e.key===key);
      if(!entry)return;
      await state.saveSettings({modelProviders:[...(state.settings?.modelProviders??[]),{id:crypto.randomUUID(),name:entry.title,kind:'normal',routingExtension:key,protocol:'openai',apiKey:'',baseUrl:'',models:['auto'],enabled:true}]});
      setKey('');setError('');
    }catch(e){setError(String(e));}
  };
  const available=snapshot?.plugins.some(p=>p.enabled&&p.manifest.extensions?.some(e=>e.point==='sage/models.route'));
  if(!available)return null;
  return <div className="extension-controls"><select aria-label="提供商扩展 / Provider extension" value={key} onChange={e=>setKey(e.target.value)}><option value="">提供商扩展 / Provider extension</option><ExtensionOptions point="sage/models.route"/></select><button className="icon-btn" title="添加提供商 / Add provider" disabled={!key} onClick={()=>void add()}><Plus size={16}/></button>{error&&<p role="alert">{error}</p>}</div>;
}
