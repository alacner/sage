import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { existsSync, statSync } from 'node:fs';
import type { ClaudeBridgeStatus, MonitorContext } from '../../../../shared/types';
import { beginRecord } from '@sage/engine-host/request-monitor';
import { buildSandboxEnv } from '@sage/engine-host/sandbox/env';

const execFileP = promisify(execFile);

let binaryOverride: string | undefined;

export function setBinaryOverride(p?: string) {
  const next = p && p.trim() ? p.trim() : undefined;
  if (next === binaryOverride) return;
  binaryOverride = next;
  // Override changed → cache is stale; let next detect re-probe.
  cachedDetection = undefined;
}

const CANDIDATE_PATHS = [
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  path.join(os.homedir(), '.claude/local/claude'),
  path.join(os.homedir(), '.local/bin/claude'),
];

async function findClaudeBinary(): Promise<string | null> {
  if (binaryOverride && existsSync(binaryOverride)) return binaryOverride;

  // Try `which claude` against a login shell so PATH from ~/.zshrc is available.
  try {
    const { stdout } = await execFileP('/bin/zsh', ['-l', '-c', 'command -v claude'], {
      timeout: 4000,
    });
    const p = stdout.trim();
    if (p && existsSync(p)) return p;
  } catch {
    /* ignore */
  }

  for (const c of CANDIDATE_PATHS) {
    if (existsSync(c)) return c;
  }

  return null;
}

/**
 * Cached `detectClaude` — every chat send used to spawn a login zsh +
 * claude --version (4-5s in the worst case). The binary path almost never
 * changes between sends, so cache after first success and re-detect only
 * when (a) caller passes `force=true`, or (b) we never had a successful
 * detection (so failures naturally keep retrying).
 *
 * `setBinaryOverride` clears the cache so the next detect picks up the
 * new path immediately.
 */
let cachedDetection: ClaudeBridgeStatus | undefined;
let detectionInflight: Promise<ClaudeBridgeStatus> | undefined;

async function doDetectClaude(): Promise<ClaudeBridgeStatus> {
  const bin = await findClaudeBinary();
  if (!bin) {
    return {
      available: false,
      error: '未找到 claude 命令。请先安装 Claude Code，或在「设置」中手动指定二进制路径。',
    };
  }
  try {
    const { stdout } = await execFileP(bin, ['--version'], { timeout: 5000 });
    return { available: true, version: stdout.trim(), path: bin };
  } catch (e: any) {
    return { available: false, path: bin, error: e?.message ?? String(e) };
  }
}

export async function detectClaude(force = false): Promise<ClaudeBridgeStatus> {
  if (!force && cachedDetection?.available) return cachedDetection;
  // Single-flight: concurrent callers (e.g. main.ts warmup + first user
  // send) share one detection promise instead of racing two zsh spawns.
  if (detectionInflight) return detectionInflight;
  detectionInflight = doDetectClaude().finally(() => {
    detectionInflight = undefined;
  });
  const r = await detectionInflight;
  if (r.available) cachedDetection = r;
  return r;
}

