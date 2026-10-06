import { app } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { AppSettings } from '../../shared/types';
import {
  DEFAULT_CLAUDE_USER_AGENT_VERSION, DEFAULT_CODEX_USER_AGENT_VERSION,
  normalizeApiUserAgentPreset, parseApiUserAgentVersion, resolveApiUserAgent,
  type ApiUserAgentVersions,
} from '../../shared/api-user-agent';

const versions = new Map<string, { expires: number; value: Promise<string> }>();
const readSettings = async () => (await import('../main')).readSettings();

/** No shell and a bounded timeout; concurrent UI/request lookups share a result. */
function cliVersion(binary: string, fallback: string): Promise<string> {
  const cliPath = [...new Set([
    process.env.PATH ?? '', path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  ])].join(path.delimiter);
  const key = `${binary}\0${cliPath}\0${fallback}`;
  const cached = versions.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (versions.size >= 8) versions.delete(versions.keys().next().value!);
  const entry = { expires: Date.now() + 5 * 60_000, value: Promise.resolve(fallback) };
  entry.value = new Promise(resolve => {
    let settled = false;
    let child: ReturnType<typeof execFile> | undefined;
    const finish = (detected?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (!detected) entry.expires = Date.now() + 30_000;
      resolve(detected ?? fallback);
    };
    // Resolving must not depend on exit/stdout callbacks from an unresponsive CLI.
    const deadline = setTimeout(() => {
      finish();
      try { child?.kill('SIGKILL'); } catch { /* The lookup has already fallen back. */ }
    }, 1500);
    try {
      child = execFile(binary, ['--version'], { timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 4096, env: { ...process.env, PATH: cliPath } }, (error, stdout) => {
        finish(error ? undefined : parseApiUserAgentVersion(stdout));
      });
    } catch { finish(); }
  });
  versions.set(key, entry);
  return entry.value;
}

/** The settings preview and outgoing headers resolve versions in the same process. */
export async function getApiUserAgentVersions(settings?: AppSettings): Promise<ApiUserAgentVersions> {
  const saved = settings ?? await readSettings();
  const [claude, codex] = await Promise.all([
    cliVersion(saved.claudeBinaryPath?.trim() || 'claude', DEFAULT_CLAUDE_USER_AGENT_VERSION),
    cliVersion(saved.codexBinaryPath?.trim() || 'codex', DEFAULT_CODEX_USER_AGENT_VERSION),
  ]);
  return { sage: app.getVersion(), claude, codex };
}

/** Read current preferences whenever a direct API client is created. */
export async function getApiHeaders(protocol: 'anthropic' | 'openai'): Promise<Record<string, string>> {
  const settings = await readSettings();
  const preset = normalizeApiUserAgentPreset(settings.apiUserAgentPreset);
  const current: Partial<ApiUserAgentVersions> & { sage: string } = { sage: app.getVersion() };
  if (preset === 'claude-cli') current.claude = await cliVersion(settings.claudeBinaryPath?.trim() || 'claude', DEFAULT_CLAUDE_USER_AGENT_VERSION);
  if (preset === 'codex-cli') current.codex = await cliVersion(settings.codexBinaryPath?.trim() || 'codex', DEFAULT_CODEX_USER_AGENT_VERSION);
  return {
    ...(protocol === 'anthropic' ? { 'x-app': 'cli' } : {}),
    'User-Agent': resolveApiUserAgent(settings, current),
  };
}
