import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {runtimeConfig} from '../shared/runtime-config';
import type {McpServerEntry} from '../shared/types';
import {getMcpEnvironmentVariable} from './mcp-environment';

export interface McpServerConfig {command:string;args?:string[];env?:Record<string,string>;envPassThrough?:string[];cwd?:string}
export interface McpHttpConfig {url:string;headers?:Record<string,string>}
interface SessionEntry {
 client:Client;
 ready:Promise<Client>;
 active:number;
 retained:boolean;
 failed:boolean;
 closing?:Promise<void>;
 cleanupError?:unknown;
}
const sessions=new Map<string,SessionEntry>();
const MAX_SESSIONS=32;
async function timeout(){try{const {readSettings}=await import('./main');return runtimeConfig((await readSettings()).runtimeConfig).mcpRequestTimeoutMs;}catch{return runtimeConfig().mcpRequestTimeoutMs;}}
async function retire(key:string,entry:SessionEntry){
 if(entry.closing)return entry.closing;
 entry.closing=(async()=>{
  await entry.ready.catch(()=>{});
  try{await entry.client.close();if(sessions.get(key)===entry)sessions.delete(key);}
  catch(error){entry.cleanupError=error;throw error;}
 })();
 return entry.closing;
}
/** A temporary test owns a lease, not a permanent cached connection. */
async function usingClient<T>(key:string,factory:()=>Transport,temporary:boolean,run:(client:Client)=>Promise<T>):Promise<T>{
 let entry=sessions.get(key);
 if(entry?.closing){await entry.closing;entry=sessions.get(key);}
 if(entry?.cleanupError)throw Error('MCP session cleanup failed; restart Sage before reconnecting');
 if(!entry){
  if(sessions.size>=MAX_SESSIONS)throw Error('MCP session limit reached');
  const client=new Client({name:'Sage',version:'1.0.0'});
  entry={client,ready:Promise.resolve(client),active:0,retained:false,failed:false};
  const created=entry;
  sessions.set(key,created);
  client.onclose=()=>{if(sessions.get(key)===created)sessions.delete(key);};
  created.ready=(async()=>{try{await client.connect(factory(),{timeout:await timeout()});return client;}catch(error){created.failed=true;throw error;}})();
 }
 const leased=entry;
 leased.active++;if(!temporary)leased.retained=true;
 try{return await run(await leased.ready);}
 finally{
  leased.active--;
  if(leased.active===0&&(!leased.retained||leased.failed)&&sessions.get(key)===leased)await retire(key,leased);
 }
}
function stdio<T>(config:McpServerConfig,run:(client:Client)=>Promise<T>,temporary=false){
 if(!config.command?.trim())throw Error('MCP server command is required');
 const env={...getDefaultEnvironment(),...config.env};
 for(const name of config.envPassThrough??[])if(process.env[name]!==undefined)env[name]=process.env[name]!;
 return usingClient(JSON.stringify(['stdio',config,env]),()=>new StdioClientTransport({...config,env,stderr:'ignore'}),temporary,run);
}
function http<T>(config:McpHttpConfig,run:(client:Client)=>Promise<T>,temporary=false){
 const url=new URL(config.url);if(!['http:','https:'].includes(url.protocol))throw Error('MCP requires HTTP(S)');
 return usingClient(JSON.stringify(['http',config]),()=>new StreamableHTTPClientTransport(url,{requestInit:{headers:config.headers}}),temporary,run);
}
async function list(client:Client){
 const tools:unknown[]=[];let cursor:string|undefined;const seen=new Set<string>();
 do{const page=await client.listTools(cursor?{cursor}:undefined,{timeout:await timeout()});tools.push(...page.tools);cursor=page.nextCursor;if(tools.length>10000||cursor&&seen.has(cursor))throw Error('MCP pagination limit exceeded');if(cursor)seen.add(cursor);}while(cursor);
 return {tools};
}
export async function mcpListTools(config:McpServerConfig){return stdio(config,list);}
export async function mcpCallTool(config:McpServerConfig,name:string,args:unknown){return stdio(config,async client=>client.callTool({name,arguments:(args??{}) as Record<string,unknown>},undefined,{timeout:await timeout()}));}
export async function mcpListToolsHttp(config:McpHttpConfig){return http(config,list);}
export async function mcpCallToolHttp(config:McpHttpConfig,name:string,args:unknown){return http(config,async client=>client.callTool({name,arguments:(args??{}) as Record<string,unknown>},undefined,{timeout:await timeout()}));}
export async function mcpTestConnection(config:McpServerConfig|McpHttpConfig){return 'url' in config?http(config,list,true):stdio(config,list,true);}
export async function mcpCloseAll(){
 const entries=[...sessions.entries()];
 await Promise.allSettled(entries.map(([key,entry])=>retire(key,entry)));
}
export async function configuredMcp(server:McpServerEntry,name?:string,args?:unknown){
 if(server.transport==='http'){
  const headers={...server.headers};
  for(const [key,env] of Object.entries(server.headersFromEnv??{})){const value=getMcpEnvironmentVariable(env);if(!value)throw Error(`MCP 环境变量未配置：${env}`);headers[key]=value;}
  if(server.bearerTokenEnv){const value=getMcpEnvironmentVariable(server.bearerTokenEnv);if(!value)throw Error(`MCP 环境变量未配置：${server.bearerTokenEnv}`);headers.authorization=`Bearer ${value}`;}
  const config={url:server.url!,headers};return name?mcpCallToolHttp(config,name,args):mcpListToolsHttp(config);
 }
 const config={command:server.command!,args:server.args,env:server.env,envPassThrough:server.envPassThrough,cwd:server.cwd};
 return name?mcpCallTool(config,name,args):mcpListTools(config);
}
