import {useAppStore} from '../../stores/appStore';
import {workflowActions,workflowSnapshot} from '../../../shared/plugins/workflow';
/** Called only for messages from the owned sandbox frame; authorization is rechecked in main. */
export async function workflowRequest(project:string,plugin:string,request:any) {
 await window.api.plugins('workflow-authorize',{project,id:plugin});
 const state=useAppStore.getState();
 if(!project||state.currentProject?.path!==project)throw Error('Project changed or unavailable');
 if(!request||typeof request.action!=='string'||!Array.isArray(request.args)||JSON.stringify(request).length>2*1024*1024)throw Error('Invalid workflow request');
 const {action,args}=request;
 if(action==='snapshot')return workflowSnapshot(plugin,state);
 if(plugin==='sage.docs'&&action==='toggleDeepwiki')return state.openDeepwikiExternal();
 const specIds=new Set(state.specs.filter(s=>s.projectPath===project).map(s=>s.id));
 if(plugin==='sage.specs'){
  if(['selectSpec','deleteSpec','api.listSpecChat','api.refineSpecChat'].includes(action)&&!specIds.has(args[0]))throw Error('Spec does not belong to this project');
  if(action==='api.listSpecChat')return window.api.listSpecChat(args[0],args[1]);
  if(action==='api.refineSpecChat')return window.api.refineSpecChat(args[0],args[1],args[2],args[3]);
  if(action==='api.openInFinder'||action==='openFile'){
   const file=args[0];if(typeof file!=='string'||!file.startsWith(project+'/')||file.split('/').includes('..')||file.includes('\0'))throw Error('Path outside project');
   if(action==='api.openInFinder')return window.api.openInFinder(file);
  }
  if(action==='openSingletonTab'&&args[0]!=='steering')throw Error('Unsupported tab');
  if(action==='closeTab'&&args[0]!=='steering')throw Error('Unsupported tab');
  if(action==='clearLoopView'){useAppStore.setState({loopStream:{byIteration:{},log:[]},loopMetricHistory:[],loopPlans:{}});return true;}
 }
 if(!workflowActions[plugin]?.includes(action))throw Error('Unsupported workflow action');
 if(plugin==='sage.specs'&&state.currentSpec&&state.currentSpec.meta.projectPath!==project)throw Error('Spec project mismatch');
 return (state as any)[action](...args);
}
