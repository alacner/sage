import {BookOpen,FileText} from 'lucide-react';
import {PluginView,usePluginSnapshot} from './PluginWorkbench';
import {WindowOverlay} from '../WindowOverlay';
import type {SidebarTab} from '../../plugins/types';
export function WorkflowView({plugin,view,onClose}:{plugin:'specs'|'docs';view:string;onClose?:()=>void}){return <PluginView plugin={`sage.${plugin}`} contribution={view} onClose={onClose}/>;}
function WorkflowModal({view,onClose}:{view:string;onClose:()=>void}){return <WindowOverlay className="modal-backdrop"><div style={{width:'min(1000px,95vw)',height:'85vh',display:'flex',position:'relative'}}><WorkflowView plugin="specs" view={view} onClose={onClose}/><button className="icon-btn" aria-label="Close" style={{position:'absolute',right:6,top:6}} onClick={onClose}>×</button></div></WindowOverlay>;}
export const NewSpecForm=({onClose}:{onClose:()=>void})=><WorkflowModal view="new" onClose={onClose}/>;
export const AnalyzeDialog=({onClose}:{onClose:()=>void})=><WorkflowModal view="analyze" onClose={onClose}/>;
export const TimelineView=({onClose}:{onClose:()=>void;onSelectSpec?:(id:string)=>void})=><WorkflowView plugin="specs" view="timeline" onClose={onClose}/>;
export function useWorkflowTabs():SidebarTab[]{const {snapshot}=usePluginSnapshot();return (['specs','docs'] as const).filter(id=>snapshot?.plugins.some(p=>p.manifest.id===`sage.${id}`&&p.enabled)).map(id=>({id,labelKey:`sidebar.${id}`,icon:id==='specs'?FileText:BookOpen,render:()=> <WorkflowView plugin={id} view="sidebar"/>}));}
export function useSpecsEnabled(){const {snapshot}=usePluginSnapshot();return !!snapshot?.plugins.some(p=>p.manifest.id==='sage.specs'&&p.enabled);}
