import {useState} from 'react';
import {PluginWorkbench,PluginConfiguration,PluginSlot,ProjectPluginActivation} from './PluginWorkbench';

/** Skill packages share installation, development and lifecycle controls with plugins. */
export function SkillWorkbench({projectScope=false}:{projectScope?:boolean}){
 const [configured,setConfigured]=useState<string|null>(null);
 return <section className="skill-workbench">
  <PluginSlot slot="settings.skills"/>
  {projectScope?<ProjectPluginActivation skillsOnly/>:configured
   ?<PluginConfiguration skills pluginId={configured} onBack={()=>setConfigured(null)}/>
   :<PluginWorkbench kind="skill" onConfigure={setConfigured}/>}
 </section>;
}
