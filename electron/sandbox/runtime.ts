import { isIP } from 'node:net';
import type { NetworkEndpoint } from './network-scope';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { ExecutionMode } from './command-decision';
import type { SandboxOverrides } from '../../shared/types';

export const BUILD_OUTPUTS = ['dist', 'dist-electron', 'build', '.next', '.nuxt', '.output', '.cache', 'coverage', 'node_modules/.cache'];
export function runtimeAvailable(): boolean {
  return process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
}
const quote = (value: string) => JSON.stringify(value);
const canonical = (value: string) => { try { return realpathSync(value); } catch { return resolve(value); } };

/** Deny by default. Children inherit Seatbelt; network and arbitrary IPC have no grants. */
export function runtimeProfile(project: string, scratch: string, mode: ExecutionMode, toolPaths: string[] = [], policy: SandboxOverrides = {}, endpoints: NetworkEndpoint[] = []): string {
  if (mode === 'project-network' && (!endpoints.length || endpoints.some(e=>isIP(e.address)!==4 || !Number.isInteger(e.port) || e.port<1 || e.port>65535))) throw Error('缺少有效的精确联网授权');
  const root = canonical(project);
  const temp = canonical(scratch);
  const reads = [root, temp, '/bin', '/sbin', '/usr/bin', '/usr/lib', '/usr/libexec', '/usr/share',
    '/usr/local/bin', '/usr/local/lib', '/usr/local/share', '/System/Library', '/Library/Apple',
    '/Library/Developer/CommandLineTools', '/opt/homebrew/bin', '/opt/homebrew/lib',
    '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/share', ...toolPaths.map(canonical)];
  const writes = [temp, ...((mode === 'project' || mode === 'project-network') ? [root] : mode === 'build' ? BUILD_OUTPUTS.map(p => join(root, p)) : [])];
  // These restrictions win even inside a writable project. Protect ancestors too:
  // denying mutation of .git/.sage prevents renaming the directory around a deny.
  const protectedNames = ['.git/hooks', '.git/config', '.git/info/exclude', '.sage', '.claude', '.codex', '.agents', '.ssh', '.aws', '.gnupg', '.npmrc', '.netrc',
    '.github/workflows', ...(policy.fs?.denyWriteSegments ?? ['.gitmodules', 'package.json', 'package-lock.json', 'bunfig.toml'])];
  const protectedPaths = protectedNames.map(p => join(root, p));
  const expand = (p: string) => canonical(p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(root, p));
  const immovable = new Set<string>();
  for (const target of [...protectedPaths, ...(policy.fs?.denyRead ?? []).map(expand), ...(policy.fs?.denyWrite ?? []).map(expand)]) {
    for (let p = target; p.startsWith(root + sep); p = dirname(p)) immovable.add(p);
  }
  return [
    '(version 1)', '(deny default)',
    '(allow process-exec process-fork)', '(allow signal (target same-sandbox))',
    '(allow mach-priv-task-port (target same-sandbox))',
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.logd") (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow process-info* (target same-sandbox))', '(allow sysctl-read)',
    ...(mode === 'project-network' ? [
      ...endpoints.map(e => `(allow network-outbound (remote ip ${quote(`${e.address}:${e.port}`)}))`),
      '(allow file-read* (subpath "/private/etc/ssl"))',
      ...['/private/etc/resolv.conf','/private/var/run/resolv.conf','/private/etc/hosts','/private/etc/services','/private/etc/protocols'].map(p => `(allow file-read* (literal ${quote(p)}))`),
      '(allow mach-lookup (global-name "com.apple.mDNSResponder"))',
    ] : []),
    '(allow file-read-metadata)',
    // dyld opens the root directory while initializing the shared cache.
    '(allow file-read-data (literal "/"))',
    ...Array.from(new Set(reads)).map(p => `(allow file-read* (subpath ${quote(p)}))`),
    ...writes.map(p => `(allow file-write* (subpath ${quote(p)}))`),
    '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-write* (literal "/dev/null"))',
    ...protectedPaths.map(p => `(deny file-write* (subpath ${quote(p)}))`),
    ...[...immovable].map(p => `(deny file-write-unlink (literal ${quote(p)}))`),
    ...['.git', '.git/info', '.github'].map(p => `(deny file-write-unlink (literal ${quote(join(root, p))}))`),
    ...['.sage', '.ssh', '.aws', '.gnupg', '.npmrc', '.netrc'].map(p => `(deny file-read-data (subpath ${quote(join(root, p))}))`),
    ...(policy.fs?.denyWrite ?? []).map(p => `(deny file-write* (subpath ${quote(expand(p))}))`),
    ...(policy.fs?.denyRead ?? []).flatMap(p => [
      `(deny file-read-data (subpath ${quote(expand(p))}))`,
      `(deny file-write-unlink (subpath ${quote(expand(p))}))`,
    ]),
  ].join('\n');
}

/** No unsandboxed fallback, including when sandbox-exec itself cannot initialize. */
export async function prepareRuntime(project: string, command: string, mode: ExecutionMode, env: Record<string, string>, policy: SandboxOverrides = {}, endpoints: NetworkEndpoint[] = []) {
  if (mode === 'full' && policy.runtime?.fullAccess) return {file:'/bin/sh',args:['-c',command],env,cleanup:async()=>{}};
  if (mode === 'project-network' && !policy.runtime?.networkApproval) throw new Error('单次联网审批策略已关闭');
  if (!runtimeAvailable()) throw new Error('运行时沙箱不可用：当前仅支持 macOS sandbox-exec，命令未执行');
  const scratch = await mkdtemp(join(tmpdir(), 'sage-command-'));
  try {
    const home = join(scratch, 'home');
    await mkdir(home);
    // Node installed through nvm/asdf needs its toolchain, not the real HOME.
    const toolPaths = (env.PATH ?? '').split(':').filter(p => p && !p.startsWith(project))
      .filter(p => /\/(?:bin|sbin)$/.test(p)).map(p =>
        /\/(?:\.nvm\/versions\/node|\.asdf\/installs\/nodejs|\.volta\/tools\/image\/node)\/[^/]+\/bin$/.test(p)
          ? resolve(p, '..') : p);
    const profile = runtimeProfile(project, scratch, mode, toolPaths, policy, endpoints);
    return { file: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/sh', '-c', command],
      env: { ...env, HOME: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
        npm_config_cache: join(scratch, 'npm-cache'), GIT_OPTIONAL_LOCKS: '0' },
      cleanup: () => rm(scratch, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
