import { createHash } from 'node:crypto';
import { readSettings } from './main';
import { pluginManager } from './plugins';
/** Bind reused grants to the installed code, effective plugin configuration and MCP destinations. */
export async function scheduledCapabilityDigest(project: string): Promise<string> {
  const settings=await readSettings();
  const plugins=pluginManager().snapshot(project).plugins.filter(plugin=>plugin.enabled).map(plugin=>({
    id:plugin.manifest.id,digest:plugin.digest,granted:plugin.granted,
  })).sort((a,b)=>a.id.localeCompare(b.id));
  const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
  return createHash('sha256').update(JSON.stringify(stable({plugins,mcp:settings.mcpServers,env:settings.mcpEnvironmentVariables,global:settings.pluginSettings,project:settings.projectPluginSettings?.[project]}))).digest('hex');
}
