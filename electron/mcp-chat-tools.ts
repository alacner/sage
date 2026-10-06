import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { McpServerEntry } from '../shared/types';
import { readSettings } from './main';
import { configuredMcp } from './mcp-sdk-client';
import { runtimeConfig } from '../shared/runtime-config';

export interface ChatMcpToolSet {
  tools: Anthropic.Tool[];
  catalog: Array<{name:string; server:string; tool:string; description:string}>;
  unavailable: string[];
  call(name: string, input: unknown): Promise<{ result: string; isError: boolean } | undefined>;
}

let cacheSignature = '';
let refreshedAt = 0;
let cachedTools: ChatMcpToolSet | undefined;
let refreshPromise: Promise<ChatMcpToolSet> | undefined;

function signature(settings: Awaited<ReturnType<typeof readSettings>>): string {
  return createHash('sha256').update(JSON.stringify({ servers: settings.mcpServers ?? [], env: settings.mcpEnvironmentVariables ?? {} })).digest('hex');
}

function toolAlias(server: McpServerEntry, remoteName: string): string {
  const readable = `${server.name}_${remoteName}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 42) || 'tool';
  const digest = createHash('sha256').update(`${server.id}\0${remoteName}`).digest('hex').slice(0, 12);
  return `mcp_${readable}_${digest}`;
}

function resultText(result: any): string {
  if (typeof result === 'string') return result;
  const content = Array.isArray(result?.content) ? result.content.map((part: any) => {
    if (part?.type === 'text') return String(part.text ?? '');
    if (part?.type === 'image') return '[MCP returned an image]';
    if (part?.type === 'resource') return JSON.stringify(part.resource ?? part);
    return JSON.stringify(part);
  }).filter(Boolean).join('\n') : '';
  return content || JSON.stringify(result ?? null);
}

async function discover(settings: Awaited<ReturnType<typeof readSettings>>): Promise<ChatMcpToolSet> {
  const enabled = (settings.mcpServers ?? []).filter((server) => server.enabled);
  const entries: Array<{ alias: string; serverId: string; remoteName: string; serverSignature: string }> = [];
  const tools: Anthropic.Tool[] = [];
  const catalog: ChatMcpToolSet['catalog'] = [];
  const unavailable: string[] = [];
  const discovered = await Promise.all(enabled.map(async (server) => {
    try {
      const listed = await configuredMcp(server) as { tools?: any[] };
      return { server, tools: listed.tools ?? [] };
    } catch (error) {
      unavailable.push(server.name);
      console.warn(`[mcp] Could not load tools from ${server.name}`);
      return { server, tools: [] };
    }
  }));
  for (const { server, tools: remoteTools } of discovered) {
    for (const remote of remoteTools) {
      if (tools.length >= 128) break;
      if (typeof remote?.name !== 'string' || !remote.name) continue;
      const alias = toolAlias(server, remote.name);
      const schema = remote.inputSchema && typeof remote.inputSchema === 'object'
        ? remote.inputSchema : { type: 'object', properties: {} };
      tools.push({
        name: alias,
        description: `[MCP: ${server.name} / ${remote.name}] ${String(remote.description ?? 'Configured MCP tool').slice(0, 2000)}`,
        input_schema: schema as Anthropic.Tool.InputSchema,
      });
      entries.push({ alias, serverId: server.id, remoteName: remote.name, serverSignature: signature({mcpServers:[server],mcpEnvironmentVariables:settings.mcpEnvironmentVariables} as any) });
      catalog.push({ name:alias,server:server.name,tool:remote.name,description:String(remote.description??'').slice(0,2000) });
    }
  }
  const byAlias = new Map(entries.map((entry) => [entry.alias, entry]));
  return {
    tools, catalog, unavailable,
    async call(name, input) {
      const entry = byAlias.get(name);
      if (!entry) return undefined;
      const current = await readSettings();
      const server = (current.mcpServers ?? []).find((candidate) => candidate.id === entry.serverId && candidate.enabled);
      if (!server) return { result: 'MCP server is no longer enabled. Reload the conversation tools and try again.', isError: true };
      if (signature({mcpServers:[server],mcpEnvironmentVariables:current.mcpEnvironmentVariables} as any) !== entry.serverSignature) return {result:'MCP configuration changed. Refresh tools before calling this server.',isError:true};
      try {
        const result: any = await configuredMcp(server, entry.remoteName, input);
        const maxBytes = runtimeConfig(current.runtimeConfig).maxToolOutputBytes;
        let text = resultText(result);
        if (Buffer.byteLength(text, 'utf8') > maxBytes) {
          text = `${Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')}\n[Output truncated at ${maxBytes} bytes]`;
        }
        return { result: text, isError: result?.isError === true };
      } catch (error: any) {
        return { result: error?.message ?? String(error), isError: true };
      }
    },
  };
}

/** Warm the in-memory tool catalogue after startup or MCP settings changes. */
export async function refreshEnabledChatMcpTools(force = false): Promise<void> {
  const settings = await readSettings();
  const nextSignature = signature(settings);
  if (!force && cachedTools && cacheSignature === nextSignature && Date.now()-refreshedAt < (cachedTools.unavailable.length ? 10000 : 60000)) return;
  if (refreshPromise) {
    await refreshPromise;
    if (cacheSignature !== nextSignature) await refreshEnabledChatMcpTools();
    return;
  }
  refreshPromise = discover(settings).then((result) => {
    refreshedAt = Date.now();
    cachedTools = result;
    cacheSignature = nextSignature;
    return result;
  }).finally(() => { refreshPromise = undefined; });
  await refreshPromise;
}

/** Conversation sends use the warmed catalogue and only discover as a first-run fallback. */
export async function loadEnabledChatMcpTools(): Promise<ChatMcpToolSet> {
  const settings = await readSettings();
  const currentSignature = signature(settings);
  if (cachedTools && cacheSignature === currentSignature) {
    if (Date.now()-refreshedAt >= (cachedTools.unavailable.length ? 10000 : 60000)) void refreshEnabledChatMcpTools().catch(()=>{});
    return cachedTools;
  }
  if (refreshPromise) {
    await refreshPromise;
    return loadEnabledChatMcpTools();
  }
  refreshPromise = discover(settings).then((result) => {
    refreshedAt = Date.now();
    cachedTools = result;
    cacheSignature = currentSignature;
    return result;
  }).finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}
