import { listAllSkills } from './skills';
import { pluginTool } from './plugins';
import { loadEnabledChatMcpTools, refreshEnabledChatMcpTools } from './mcp-chat-tools';
import type { ChatCapabilities } from '../shared/chat-capabilities';
export async function chatCapabilities(project: string, refresh = false): Promise<ChatCapabilities> {
  if (typeof project !== 'string' || !project.trim()) throw Error('Select a project first');
  const results = await Promise.allSettled([
    listAllSkills(project), pluginTool(project, {action:'list'}),
    (async()=>{ if(refresh)await refreshEnabledChatMcpTools(true); return loadEnabledChatMcpTools(); })(),
  ]);
  const result: ChatCapabilities = {items:[],unavailable:[]};
  const [skills,plugins,mcp] = results;
  if (skills.status==='fulfilled') for(const skill of skills.value) result.items.push({id:`skill:${skill.name}`,kind:'skill',name:skill.name,source:skill.absPath.startsWith('plugin://')?skill.fileName.split('/')[0]:skill.scope,description:skill.description,request:`Skill ${JSON.stringify({skill_name:skill.name})}`});
  else result.unavailable.push('Skills');
  if (plugins.status==='fulfilled') for(const plugin of (plugins.value as any).plugins??[]) {
    for(const [service, definition] of Object.entries(plugin.services??{}) as Array<[string,any]>) {
      for(const [method, spec] of Object.entries(definition.methods??{}) as Array<[string,any]>) {
        if(!spec.tool)continue;
        result.items.push({id:`plugin:${plugin.id}:${service}:${method}`,kind:'plugin',name:`${service}.${method}`,source:plugin.id,description:spec.description??plugin.description??'',request:`Plugin ${JSON.stringify({action:'call',plugin:plugin.id,service,method})}`});
      }
    }
  } else result.unavailable.push('Plugins');
  if(mcp.status==='fulfilled') {
    for(const tool of mcp.value.catalog)result.items.push({id:tool.name,kind:'mcp',name:tool.tool,source:tool.server,description:tool.description,request:tool.name});
    result.unavailable.push(...mcp.value.unavailable);
  } else result.unavailable.push('MCP');
  result.items.sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name));
  return result;
}
